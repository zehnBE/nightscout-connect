/*
 * Eversense DMS connector fuer nightscout-connect
 *
 * Login via OAuth2 Password-Grant:
 *   POST https://ousiamapialpha.eversensedms.com/connect/token
 *   grant_type=password, client_id=dms
 *
 * Daten via:
 *   GET https://ousalphaapiservices.eversensedms.com/api/dashboard/GetDashboardUserDeviceInfo_New
 *
 * Env-Vars (CONNECT_  camelCase):
 *   CONNECT_SOURCE=eversense
 *   CONNECT_EVERSENSE_EMAIL=...           input.eversenseEmail
 *   CONNECT_EVERSENSE_PASSWORD=...        input.eversensePassword
 *   CONNECT_EVERSENSE_REGION=ous|us       input.eversenseRegion  (default: ous)
 *   CONNECT_EVERSENSE_TIMEZONE_OFFSET=    input.eversenseTimezoneOffset (minutes, default: -120)
 *   CONNECT_EVERSENSE_TIMEZONE_NAME=      input.eversenseTimezoneName (default: Europe/Berlin)
 */

'use strict';

var helper = require('./convert');

//  Endpunkte nach Region 

var ENDPOINTS = {
  ous: {
    iamBase:   'https://ousiamapialpha.eversensedms.com',
    apiBase:   'https://ousalphaapiservices.eversensedms.com',
    origin:    'https://global.eversensedms.com',
    clientId:  'dms',
    grantType: 'password'
  },
  us: {
    iamBase:   'https://usiamapi.eversensedms.com',
    apiBase:   'https://usapialpha.eversensedms.com',
    origin:    'https://us.eversensedms.com',
    clientId:  'dms_2fa',
    grantType: '2fa_password'
  }
};

var CLIENT_ID     = 'dms';
var CLIENT_SECRET = 'secret';
var TOKEN_SCOPE   = 'email openid profile EversenseIdentityAPI';
var USER_AGENT    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

//  Hilfsfunktionen 

function decodeJwtPayload(token)
{
  try {
    var b64 = token.split('.')[1];
    var pad = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch (e) { return null; }
}

function isTokenExpired(accessToken)
{
  var p = decodeJwtPayload(accessToken);
  if (!p || !p.exp) { return true; }
  return (p.exp - 60) < (Date.now() / 1000);
}

//  Validation 

function validate_inputs(input)
{
  var ok     = false;
  var errors = [];

  var config = {
    eversenseEmail:    input.eversenseEmail,
    eversensePassword: input.eversensePassword,
    eversenseRegion:   (input.eversenseRegion || 'ous').toLowerCase(),
    kind: 'eversense'
  };

  if (!config.eversenseEmail) {
    errors.push({
      desc: 'CONNECT_EVERSENSE_EMAIL muss gesetzt sein.',
      err:  new Error('CONNECT_EVERSENSE_EMAIL')
    });
  }
  if (!config.eversensePassword) {
    errors.push({
      desc: 'CONNECT_EVERSENSE_PASSWORD muss gesetzt sein.',
      err:  new Error('CONNECT_EVERSENSE_PASSWORD')
    });
  }
  if (!ENDPOINTS[config.eversenseRegion]) {
    errors.push({
      desc: 'CONNECT_EVERSENSE_REGION muss "ous" oder "us" sein.',
      err:  new Error('CONNECT_EVERSENSE_REGION')
    });
  }

  ok          = errors.length === 0;
  config.kind = ok ? 'eversense' : 'disabled';
  return { ok: ok, errors: errors, config: config };
}

//  Hauptfunktion 

function eversenseSource(opts, axios)
{
  var ep = ENDPOINTS[opts.eversenseRegion] || ENDPOINTS.ous;

      var defaultHeaders = {
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'de',
        'Content-Type':    'application/json',
        'User-Agent':      USER_AGENT,
        'Origin':          ep.origin,
        'Referer':         ep.origin + '/'
      };

  //  impl 

  var impl = {

    authFromCredentials: function()
    {
      console.log('EVERSENSE: Login fuer ' + opts.eversenseEmail + ' region=' + opts.eversenseRegion);

      var tokenUrl = ep.iamBase + '/connect/token';

      var params = new URLSearchParams({
        username:      opts.eversenseEmail,
        password:      opts.eversensePassword,
        grant_type:    ep.grantType,
        client_id:     ep.clientId,
        client_secret: CLIENT_SECRET,
        otp_factor:    'email',
        otp_mode:      'request'
      });

      return axios.post(tokenUrl, params.toString(), {
        headers: Object.assign({}, defaultHeaders, {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        })
      }).then(function(r) {
        if (!r.data || !r.data.access_token) {
          console.error('EVERSENSE_AUTH_ERROR: LOGIN_FAILED  HTTP ' + r.status);
          throw new Error('EVERSENSE_AUTH_ERROR: LOGIN_FAILED  HTTP ' + r.status);
        }
        console.log('EVERSENSE: Login OK');
        return {
          access_token:  r.data.access_token,
          refresh_token: r.data.refresh_token || null,
          expires_in:    r.data.expires_in || 3600,
          loggedAt:      Date.now()
        };
      }).catch(function(err) {
        if (err.message && err.message.indexOf('EVERSENSE_AUTH_ERROR') !== -1) { throw err; }
        var status = err.response ? err.response.status : 0;
        var data   = err.response ? (err.response.data || {}) : {};
        var body   = JSON.stringify(data).substring(0, 200);
        if (status === 400 || status === 401) {
          if (data.error_code === 5005 || (data.error_description && data.error_description.indexOf('locked') !== -1)) {
            var lockCount = (opts._lockCount || 0) + 1;
            console.error('EVERSENSE_AUTH_ERROR: ACCOUNT_LOCKED (' + lockCount + '/3)  ' + body);
            if (lockCount >= 3) {
              throw new Error('EVERSENSE_AUTH_ERROR: INVALID_CREDENTIALS  Konto dauerhaft gesperrt');
            }
            // 11 Minuten warten, dann neu versuchen
            return new Promise(function(_, reject) {
              setTimeout(function() {
                opts._lockCount = lockCount;
                impl.authFromCredentials().catch(reject);
              }, 11 * 60 * 1000);
            });
          }
          console.error('EVERSENSE_AUTH_ERROR: INVALID_CREDENTIALS  ' + body);
          throw new Error('EVERSENSE_AUTH_ERROR: INVALID_CREDENTIALS  Benutzername oder Passwort falsch');
        }
        console.error('EVERSENSE_AUTH_ERROR: LOGIN_FAILED  ' + body);
        throw new Error('EVERSENSE_AUTH_ERROR: LOGIN_FAILED  ' + body);
      });
    },

    sessionFromAuth: function(auth)
    {
      return Promise.resolve(auth);
    },

    dataFromSesssion: function(session, last_known)
    {
      var td = session;

      // Token erneuern falls abgelaufen
      var tokenPromise;
      if (isTokenExpired(td.access_token)) {
        if (td.refresh_token) {
          console.log('EVERSENSE: Token abgelaufen, versuche Refresh');
          tokenPromise = impl._refreshToken(td).catch(function() {
            console.log('EVERSENSE: Refresh fehlgeschlagen, Re-Login');
            return impl.authFromCredentials();
          });
        } else {
          console.log('EVERSENSE: Token abgelaufen, Re-Login');
          tokenPromise = impl.authFromCredentials();
        }
      } else {
        tokenPromise = Promise.resolve(td);
      }

      return tokenPromise.then(function(td)
      {
        Object.assign(session, td);

        var authHdr = { 'Authorization': 'Bearer ' + td.access_token };

        // Dashboard: Sensor-Info + Settings
        var dashUrl = ep.apiBase
          + '//api/dashboard/GetDashboardUserDeviceInfo_New'
          + '?timeZoneOffset=0&timeZoneName=UTC';

        return axios.get(dashUrl, {
          headers: Object.assign({}, defaultHeaders, authHdr),
          validateStatus: function() { return true; }
        }).then(function(dashR)
        {
          console.log('EVERSENSE: Dashboard HTTP=' + dashR.status
            + ' keys=' + (dashR.data ? Object.keys(dashR.data).length : 0));
          if (dashR.status === 401 || dashR.status === 403) {
            console.error('EVERSENSE_AUTH_ERROR: TOKEN_EXPIRED');
            throw new Error('EVERSENSE_AUTH_ERROR: TOKEN_EXPIRED');
          }

          var dash = (dashR.status === 200 && dashR.data) ? dashR.data : {};

          // Kein aktiver Sensor  leere Daten
          if (!dash.UserDeviceInfo || !dash.UserDeviceInfo.DeviceID) {
            console.log('EVERSENSE: kein aktiver Sensor/Transmitter');
            return { dashboard: dash, sgvList: [] };
          }

          console.log('EVERSENSE: Sensor aktiv, DeviceID=' + dash.UserDeviceInfo.DeviceID
            + ' DaysSince=' + dash.UserDeviceInfo.DaysSinceInsertion);

          var now  = new Date();
          // Seit letztem bekanntem Eintrag abfragen, maximal 24h zurueck
          var lastKnownMs = last_known && last_known.entries
            ? new Date(last_known.entries).getTime()
            : now.getTime() - 24 * 60 * 60 * 1000;
          // 10min Ueberlappung damit mind. 2 SGV fuer Trendberechnung vorliegen
          var from = new Date(Math.max(lastKnownMs - 10 * 60 * 1000, now.getTime() - 24 * 60 * 60 * 1000));

          var sgvBody = {
            startDate:      from.toISOString(),
            endDate:        now.toISOString(),
            FromDateStr:    from.toISOString(),
            ToDateStr:      now.toISOString(),
            TimeZoneOffset: 0,
            timeZoneName:   'UTC'
          };

          return axios.post(ep.apiBase + '/TransmitterLog/GetSensorGlucoseEvents',
            sgvBody,
            {
              headers: Object.assign({}, defaultHeaders, authHdr, { 'Content-Type': 'application/json' }),
              validateStatus: function() { return true; }
            }
          ).then(function(sgvR) {
            console.log('EVERSENSE: SGV HTTP=' + sgvR.status
              + ' count=' + (Array.isArray(sgvR.data) ? sgvR.data.length : 0));
            var sgvList = (sgvR.status === 200 && Array.isArray(sgvR.data)) ? sgvR.data : [];
            return { dashboard: dash, sgvList: sgvList };
          });
        });
      });
    },

    _refreshToken: function(td)
    {
      var tokenUrl = ep.iamBase + '/connect/token';
      var params   = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: td.refresh_token,
        client_id:     CLIENT_ID
      });
      return axios.post(tokenUrl, params.toString(), {
        headers: Object.assign({}, defaultHeaders, {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        })
      }).then(function(r) {
        if (!r.data || !r.data.access_token) { throw new Error('Refresh fehlgeschlagen'); }
        console.log('EVERSENSE: Token erneuert');
        return {
          access_token:  r.data.access_token,
          refresh_token: r.data.refresh_token || td.refresh_token,
          expires_in:    r.data.expires_in || 3600,
          loggedAt:      Date.now()
        };
      });
    },

    align_to_glucose: function() { /* TODO */ },

    transformData: function(batch)
    {
      console.log('EVERSENSE: transformiere Daten');
      return helper.toNightscout(batch);
    }
  };

  //  generate_driver 

  function tracker_for()
  {
    var AxiosTracer = require('../../trace-axios');
    return AxiosTracer(axios);
  }

  function generate_driver(builder)
  {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize:    impl.sessionFromAuth,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: (1000 * 60 * 60 * 11),  // 11h
        EXPIRE_SESSION_DELAY:          1000 * 60 * 60 * 12    // 12h
      }
    });

    builder.register_loop('Eversense', {
      tracker: tracker_for,
      frame: {
        impl:           impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform:      impl.transformData,
        backoff: { interval_ms: 2.5 * 60 * 1000 },
        maxRetries: 1
      },
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: { interval_ms: 2.5 * 60 * 1000 }
    });

    return builder;
  }

  impl.generate_driver = generate_driver;
  return impl;
}

eversenseSource.validate = validate_inputs;

module.exports = eversenseSource;
