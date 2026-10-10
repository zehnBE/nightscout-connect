/*
* lib/sources/rightest/index.js
* Rightest/Bionime CGM follower source for zehnBE/nightscout-connect.
*
* v0.2 (2026-10-09)
*   - CONNECT_RIGHTEST_REFRESH_TOKEN_FILE support (Docker-Secret pattern):
*     reads the Cognito RefreshToken from a mounted file instead of ENV
*     when _TOKEN itself is empty.
*
* v0.1 (2026-10-09)
*   - initial implementation
*   - Cognito refresh-token based auth (no password / no SMS in container)
*   - full endpoint set lifted from rightest-probe-v1.js (reverse-engineered)
*   - index-based CGM data fetch; last ~15 indices per cycle
*   - follower share-link decode
*   - session refresh every ~23h (IdToken valid 24h; RefreshToken survives)
*
* Env wiring (via Nightscout core -> env.extendedSettings.connect):
*   CONNECT_RIGHTEST_REFRESH_TOKEN       required - Cognito RefreshToken from
*                                        1st-time SMS-login done by the
*                                        companion probe tool. Alternatively
*                                        provide CONNECT_RIGHTEST_REFRESH_TOKEN_FILE.
*   CONNECT_RIGHTEST_REFRESH_TOKEN_FILE  optional - absolute path to a file
*                                        inside the container that holds the
*                                        RefreshToken (mount via volume). Takes
*                                        precedence over _TOKEN when set.
*   CONNECT_RIGHTEST_SHARE_LINK          required - the follower share URL
*                                        (https://s.rightest.com/XXXX).
*   CONNECT_RIGHTEST_REGION              optional - "TW" (default) or any Cognito
*                                        pool region. Picks the host + client id.
*
* No DB writeback: Cognito does NOT rotate the RefreshToken on refresh, so the
* ENV value stays valid for the container's lifetime (pool TTL ~30d from last
* use). If authFromCredentials throws (invalid_grant / NotAuthorizedException),
* the container exits via the normal AUTHENTICATION_ERROR path and the PHP side
* re-prompts for an SMS login.
*/

var url    = require('url');
var fs     = require('fs');
var crypto = require('crypto');
var helper = require('./convert');

// Per-region defaults. For now only TW is wired (Taiwan patient tested).
// Partner app binary carries all three; port the others on demand.
var REGIONS = {
  TW: {
    cognitoHost: 'cognito-idp.ap-northeast-1.amazonaws.com',
    clientId:    'pakk4qjedpqvmcrrbbhbqc9bp',
    authApi:     'https://auth-api.rightest.com',
    coreApi:     'https://cgm-core-api.rightest.com',
    shareApi:    'https://data-share-api.rightest.com',
  }
  // CN / INTL / ... pending RE
};

var UA = 'rightest-connect/0.1';
var MIME = 'application/json';

// Daily rotating HS256 secret for /rightest-member endpoints:
// base64url(sha256("CoCa" + yyyyMMdd)).rstrip("=")   (seen in Dart RE JWTUtil.getToken)
function dailySecret () {
  var d = new Date();
  var y = d.getUTCFullYear();
  var m = String(d.getUTCMonth() + 1).padStart(2, '0');
  var day = String(d.getUTCDate()).padStart(2, '0');
  var raw = crypto.createHash('sha256').update('CoCa' + y + m + day).digest();
  return raw.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode (s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function decodeIdToken (idToken) {
  try {
    var parts = idToken.split('.');
    if (parts.length < 2) return {};
    return JSON.parse(b64urlDecode(parts[1]));
  } catch (err) {
    return {};
  }
}

// Follow the s.rightest.com shortlink one hop and parse its base64 payload.
// Returns { app_id, uid, data_owner_name, gp900_uid } or throws.
function decodeShareLink (axios, shareLink) {
  return axios.get(shareLink, {
    maxRedirects: 0,
    validateStatus: function (s) { return s === 302 || s === 301 || (s >= 200 && s < 400); },
  }).then(function (resp) {
    var loc = resp.headers && resp.headers.location;
    if (!loc) throw new Error('RIGHTEST SHARE: no Location header on ' + shareLink);
    // Payload is the query string after "?" - base64url of key=val&... .
    var qmark = loc.indexOf('?');
    if (qmark < 0) throw new Error('RIGHTEST SHARE: no payload in ' + loc);
    var payload = loc.substring(qmark + 1);
    var decoded = b64urlDecode(payload);
    var out = {};
    decoded.split('&').forEach(function (kv) {
      var eq = kv.indexOf('=');
      if (eq < 0) return;
      out[kv.substring(0, eq)] = decodeURIComponent(kv.substring(eq + 1));
    });
    if (!out.uid) throw new Error('RIGHTEST SHARE: no uid in decoded payload');
    return out;
  });
}

function rightestSource (opts, axios) {
  console.log('RIGHTEST SOURCE v0.7: region=' + opts.rightestRegion + ' share=' + (opts.rightestShareLink || '(none)') + ' patientUid=' + (opts.rightestPatientUid || '(none)'));
  var region = REGIONS[opts.rightestRegion];
  if (!region) throw new Error('RIGHTEST: unknown region ' + opts.rightestRegion);

  // Shared axios used for /rightest-member etc. (needs JWT header).
  var http = axios.create({
    headers: {
      'User-Agent':   UA,
      'Content-Type': MIME,
      'Accept':       MIME,
    },
  });

  function cognitoCall (target, body) {
    return axios.post('https://' + region.cognitoHost + '/', body, {
      headers: {
        'Content-Type':    'application/x-amz-json-1.1',
        'X-Amz-Target':    'AWSCognitoIdentityProviderService.' + target,
        'User-Agent':      UA,
        'Accept-Encoding': 'identity',
      },
    }).then(function (r) { return r.data; });
  }

  function memberHeaders (session) {
    return {
      'Authorization': 'Bearer ' + session.idToken,
      'JWT':           dailySecret(),
      'Content-Type':  MIME,
      'Accept':        MIME,
      'User-Agent':    UA,
    };
  }

  var impl = {
    // 1) Refresh the Cognito tokens. On NotAuthorizedException the parent
    //    machine's AUTHENTICATION_ERROR path kicks in and the container exits.
    authFromCredentials: function () {
      if (!opts.rightestRefreshToken) {
        return Promise.reject(new Error('AUTHENTICATION_ERROR: CONNECT_RIGHTEST_REFRESH_TOKEN missing'));
      }
      console.log('RIGHTEST AUTH: refreshing Cognito tokens on ' + region.cognitoHost);
      return cognitoCall('GetTokensFromRefreshToken', {
        RefreshToken: opts.rightestRefreshToken,
        ClientId:     region.clientId,
      }).then(function (data) {
        var auth = data && data.AuthenticationResult;
        if (!auth || !auth.AccessToken || !auth.IdToken) {
          throw new Error('AUTHENTICATION_ERROR: Cognito refresh returned no AuthenticationResult');
        }
        var claims = decodeIdToken(auth.IdToken);
        console.log('RIGHTEST AUTH: refresh OK; expires_in=' + auth.ExpiresIn + 's uid=' + claims.sub);
        return {
          accessToken:   auth.AccessToken,
          idToken:       auth.IdToken,
          // Cognito does NOT rotate - keep the ENV value as fallback.
          refreshToken:  auth.RefreshToken || opts.rightestRefreshToken,
          expiresIn:     auth.ExpiresIn,
          issuedAt:      Math.floor(Date.now() / 1000),
          uid:           claims.sub,
          userName:      claims['cognito:username'],
          gp900Uid:      claims['custom:gp900_uid'],
        };
      }).catch(function (err) {
        if (err.response) {
          var errType = err.response.data && err.response.data.__type;
          console.log('RIGHTEST AUTH FAIL: HTTP ' + err.response.status + ' ' + errType);
        } else {
          console.log('RIGHTEST AUTH FAIL: ' + err.message);
        }
        throw err;
      });
    },

    // 2) Resolve the share-link once, bind the patient uid onto the session.
    //    No "verify-sharing-link" / "create-association" calls - we are a
    //    FOLLOWER-ONLY source and expect the user to have accepted sharing
    //    already in the real Partner app. list-following-users is used as a
    //    sanity probe and logs a warning if the patient is not in the list.
    sessionFromAuth: function (auth) {
      // v0.6: wenn patient_uid gesetzt und share_link leer -> list-following-users
      // als Primaer-Quelle statt decodeShareLink. Beide Pfade enden mit gleichem
      // Session-Shape {idToken, patientUid, patientName, patientGp900, appId, measureSession}.
      if (opts.rightestPatientUid && !opts.rightestShareLink) {
        console.log('RIGHTEST SESSION: patient_uid mode (' + opts.rightestPatientUid + '), skipping share-link resolve');
        var listBody = { app_id: 'GP926', watcher_id: auth.uid };
        var provisional = Object.assign({}, auth);
        return http.post(region.shareApi + '/sharing-authorization/api/v2/watcher/list-following-users',
          listBody, { headers: memberHeaders(provisional) }
        ).then(function (resp) {
          var list = (resp.data && resp.data.data && resp.data.data.following_user_list) || [];
          var hit  = list.find(function (p) { return p.uid === opts.rightestPatientUid; });
          if (!hit) {
            throw new Error('RIGHTEST SESSION: patient_uid ' + opts.rightestPatientUid + ' not in follower list of watcher ' + auth.uid + ' - sharing revoked or wrong uid');
          }
          if (hit.stop_sharing) {
            throw new Error('RIGHTEST SESSION: patient_uid ' + opts.rightestPatientUid + ' has stop_sharing=true - follower stopped sharing');
          }
          console.log('RIGHTEST SESSION: patient ' + hit.display_name + ' (gp900=' + hit.gp900_uid + ' app=' + hit.app_id + ') resolved via list-following-users');
          return Object.assign({}, auth, {
            patientUid:   hit.uid,
            patientName:  hit.display_name,
            patientGp900: hit.gp900_uid,
            appId:        hit.app_id || 'GP922',
            measureSession: null,
          });
        });
      }
      return decodeShareLink(axios, opts.rightestShareLink).then(function (sl) {
        console.log('RIGHTEST SESSION: share-link decoded. patient uid=' + sl.uid + ' name=' + sl.data_owner_name);
        var session = Object.assign({}, auth, {
          patientUid:   sl.uid,
          patientName:  sl.data_owner_name,
          patientGp900: sl.gp900_uid,
          appId:        sl.app_id || 'GP922',
          // measure-session cache; populated on first dataFromSesssion().
          measureSession: null,
        });
        // Sanity check: list-following-users should contain patientUid.
        var body = { app_id: 'GP926', watcher_id: auth.uid };
        return http.post(region.shareApi + '/sharing-authorization/api/v2/watcher/list-following-users',
          body, { headers: memberHeaders(session) }
        ).then(function (resp) {
          var list = (resp.data && resp.data.data && resp.data.data.following_user_list) || [];
          var hit  = list.find(function (p) { return p.uid === session.patientUid; });
          if (!hit) {
            console.log('RIGHTEST SESSION WARN: patient ' + session.patientUid + ' not in follower list - sharing may be revoked');
          } else {
            console.log('RIGHTEST SESSION: patient ' + hit.display_name + ' confirmed in follower list');
          }
          return session;
        }).catch(function (err) {
          console.log('RIGHTEST SESSION WARN: list-following-users failed; proceeding anyway: ' + err.message);
          return session;
        });
      });
    },

    // 3) Each tick: refresh measure-session, then pull cgm-data from the
    //    index of the last entry we delivered (or the last 15 indices on
    //    cold start).
    dataFromSesssion: function (session, last_known) {
      var headers = memberHeaders(session);

      // Resume index: prefer _rightestIndex of last delivered entry; fall
      // back to lastConsecutiveIndex - 15 on cold start.
      var lastIndex = null;
      if (last_known && last_known.entries) {
        // last_known.entries may be a timestamp (number) OR an array -
        // older framework builds pass only the last-entry date. We stuff
        // _rightestIndex into entry objects, so if we see one, use it.
        if (Array.isArray(last_known.entries)) {
          var withIdx = last_known.entries.filter(function (e) { return typeof e._rightestIndex === 'number'; });
          if (withIdx.length) lastIndex = Math.max.apply(null, withIdx.map(function (e) { return e._rightestIndex; }));
        }
      }

      return http.post(region.coreApi + '/app/api/v1/measure-session/get/latest',
        { uid: session.patientUid, status: 'all' },
        { headers: headers }
      ).then(function (resp) {
        if (!resp.data || resp.data.result !== 0 || !resp.data.data) {
          throw new Error('RIGHTEST SESSION: get-latest returned ' + JSON.stringify(resp.data));
        }
        var meas = resp.data.data;
        session.measureSession = {
          id:                      meas.id,
          startDate:               meas.start_date,
          lastConsecutiveIndex:    meas.last_consecutive_index,
          lastUploadIndex:         meas.last_upload_index,
          isMeasureSessionEnd:     meas.is_measure_session_end,
          timeZone:                meas.detail_info && meas.detail_info.time_zone,
          deviceModel:             meas.detail_info && meas.detail_info.device_module,
          sensorSerial:            meas.detail_info && meas.detail_info.sensor_serial_number,
        };
        var maxIdx = session.measureSession.lastConsecutiveIndex;
        var minIdx;
        if (lastIndex && lastIndex >= 0 && lastIndex < maxIdx) {
          minIdx = Math.max(0, lastIndex + 1);  // resume from first new index
        } else {
          minIdx = Math.max(0, maxIdx - 15);    // cold start: last 15 min
        }
        if (minIdx >= maxIdx) {
          // Nothing new yet; return empty rows but still a well-formed payload.
          return { session_meta: session.measureSession, cgm_rows: [] };
        }
        return http.post(region.coreApi + '/app/api/v1/measure-data/get/cgm',
          {
            uid:            session.patientUid,
            session_id:     meas.id,
            min_index:      minIdx,
            max_index:      maxIdx,
            is_consecutive: true,
          },
          { headers: headers }
        ).then(function (dresp) {
          if (!dresp.data || !dresp.data.data) {
            throw new Error('RIGHTEST DATA: get-cgm returned ' + JSON.stringify(dresp.data));
          }
          var rows = dresp.data.data.measure_data || [];
          console.log('RIGHTEST DATA: ' + rows.length + ' row(s) fetched (indices ' + minIdx + '..' + maxIdx + ')');
          return { session_meta: session.measureSession, cgm_rows: rows };
        });
      });
    },

    align_to_glucose: function (last_known) {
      // Rightest uploads once per minute by the index model, but Nightscout
      // consumers expect one entry every ~5 minutes. We let the framework
      // tick on its own 5-min schedule and only nudge once per cycle.
      if (!last_known || !last_known.entries) return;
      var last_at;
      if (Array.isArray(last_known.entries) && last_known.entries.length) {
        last_at = Math.max.apply(null, last_known.entries.map(function (e) { return e.date; }));
      } else if (last_known.entries instanceof Date) {
        last_at = last_known.entries.getTime();
      } else {
        return;
      }
      var buffer_lag = 68000;
      var jitter     = Math.floor(Math.random() * 18000);
      return last_at + (5 * 60 * 1000) + buffer_lag + jitter;
    },

    transformData: function (data, last_known) {
      if (!data || !data.cgm_rows) return { entries: [], treatments: [] };
      var entries = helper.toNightscoutEntries(data.session_meta, data.cgm_rows);
      console.log('RIGHTEST TRANSFORM: emitting ' + entries.length + ' entries');
      return { entries: entries, treatments: [] };
    },
  };

  function tracker_for () {
    var AxiosTracer = require('../../trace-axios');
    return AxiosTracer(http);
  }

  function generate_driver (builder) {
    // IdToken is valid 24h; refresh every ~23h to stay well inside that
    // window. RefreshToken itself has ~30d pool TTL from last use - as long
    // as the container keeps running (= keeps refreshing) the ENV token
    // stays valid indefinitely. No DB writeback needed.
    var reloginMs = 23 * 60 * 60 * 1000;

    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize:    impl.sessionFromAuth,
      // refresh: not wired - re-run full authFromCredentials each cycle instead.
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: reloginMs - 60000,
        EXPIRE_SESSION_DELAY:          reloginMs,
      },
    });

    builder.register_loop('Rightest', {
      tracker: tracker_for,
      frame: {
        impl:           impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform:      impl.transformData,
        backoff: { interval_ms: 2.5 * 60 * 1000 },
        maxRetries: 2,
      },
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: { interval_ms: 2.5 * 60 * 1000 },
    });
    return builder;
  }

  impl.generate_driver = generate_driver;
  return impl;
}

rightestSource.validate = function validate_inputs (input) {
  var token = input.rightestRefreshToken;
  var tokenSrc = token ? 'env' : null;

  // Docker-Secret pattern: _TOKEN_FILE wins over _TOKEN when set and readable.
  // Mount the file read-only via `volumes: [/root/rights-tw.token:/run/secrets/rightest-refresh-token:ro]`
  // and set CONNECT_RIGHTEST_REFRESH_TOKEN_FILE=/run/secrets/rightest-refresh-token.
  if (input.rightestRefreshTokenFile) {
    try {
      var raw = fs.readFileSync(input.rightestRefreshTokenFile, 'utf8').trim();
      if (raw) {
        token    = raw;
        tokenSrc = 'file:' + input.rightestRefreshTokenFile;
      }
    } catch (err) {
      console.log('RIGHTEST: cannot read token file ' + input.rightestRefreshTokenFile + ': ' + err.message);
    }
  }

  var config = {
    rightestRefreshToken: token,
    rightestShareLink:    input.rightestShareLink,
    rightestPatientUid:   input.rightestPatientUid,
    rightestRegion:       (input.rightestRegion || 'TW').toUpperCase(),
    rightestPollMin:      input.rightestPollMin,
  };
  if (token) {
    console.log('RIGHTEST: refresh token loaded from ' + tokenSrc + ' (' + token.length + ' chars)');
  }
  var errors = [];
  if (!config.rightestRefreshToken) {
    errors.push({ desc: 'CONNECT_RIGHTEST_REFRESH_TOKEN or CONNECT_RIGHTEST_REFRESH_TOKEN_FILE missing. Run the rightest-probe tool once (SMS login) to obtain it.', err: new Error('CONNECT_RIGHTEST_REFRESH_TOKEN') });
  }
  if (!config.rightestShareLink && !config.rightestPatientUid) {
    errors.push({ desc: 'CONNECT_RIGHTEST_SHARE_LINK or CONNECT_RIGHTEST_PATIENT_UID missing. Either the follower URL (https://s.rightest.com/XXXX) OR the patient UUID must be configured.', err: new Error('CONNECT_RIGHTEST_SHARE_LINK_OR_PATIENT_UID') });
  }
  if (!REGIONS[config.rightestRegion]) {
    errors.push({ desc: 'CONNECT_RIGHTEST_REGION ' + config.rightestRegion + ' not supported yet. Only TW is wired currently.', err: new Error('CONNECT_RIGHTEST_REGION') });
  }
  var ok = errors.length === 0;
  config.kind = ok ? 'rightest' : 'disabled';
  return { ok: ok, errors: errors, config: config };
};

module.exports = rightestSource;
