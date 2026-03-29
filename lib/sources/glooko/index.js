/*
*
* https://github.com/jonfawcett/glooko2nightscout-bridge/blob/master/index.js#L146
* Authors:
* Jeremy Pollock
* https://github.com/jpollock
* Jon Fawcett
* and others.
*
* MODIFIED: Use v3 graph/data API for CGM readings (v2 returns empty)
* MODIFIED: Keep v2 endpoints for bolus/basal treatments
* MODIFIED: v3 always uses two_days_ago as start (CGM + basalBarAutomated)
* MODIFIED: Add basalBarAutomated to v3 series for Omnipod 5 / AID systems
* MODIFIED: CONNECT_GLOOKO_CGM=0/off disables CGM fetching
*/

var qs = require('qs');
var url = require('url');
var uid = require('uid');
var helper = require('./convert');

_known_servers = {
  default: 'api.glooko.com'
, development: 'api.glooko.work'
, production: 'externalapi.glooko.com'
, eu: 'eu.api.glooko.com'
};

// CGM + Basal series fuer v3
var V3_SERIES = [
  'cgmHigh', 'cgmNormal', 'cgmLow',
  'cgmCalibrationHigh', 'cgmCalibrationNormal', 'cgmCalibrationLow',
  'basalBarAutomated',
].map(s => 'series[]=' + s).join('&');

var Defaults = {
  "applicationId":"d89443d2-327c-4a6f-89e5-496bbb0317db"
, "lastGuid":"1e0c094e-1e54-4a4f-8e6a-f94484b53789"
, login: '/api/v2/users/sign_in'
, mime: 'application/json'
, LatestPumpBasals: '/api/v2/pumps/scheduled_basals'
, LatestPumpBolus: '/api/v2/pumps/normal_boluses'
// v3 graph/data for CGM + Basal - v2 /api/v2/cgm/readings returns empty
, DataV3: '/api/v3/graph/data'
};

function base_for (spec) {
  var server = spec.glookoServer ? spec.glookoServer : _known_servers[spec.glookoEnv || 'default'];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}

var IDX=36, HEX='';
while (IDX--) HEX += IDX.toString(36);

function uids(len) {
  var str='', num = len || 11;
  while (num--) str += HEX[Math.random() * 36 | 0];
  return str;
}

function login_payload (opts) {
  var body = {
    "userLogin": {
      "email": opts.glookoEmail,
      "password": opts.glookoPassword
    },
    "deviceInformation": {
      "applicationType": "logbook",
      "os": "android",
      "osVersion": "33",
      "device": "Google Pixel 4a",
      "deviceManufacturer": "Google",
      "deviceModel": "Pixel 4a",
      "serialNumber": uids(18),
      "clinicalResearch": false,
      "deviceId": uids(16),
      "applicationVersion": "6.1.3",
      "buildNumber": "0",
      "gitHash": "g4fbed2011b"
    }
  };
  return body;
}

/**
 * Build v3 URL fuer CGM + Basal.
 */
function buildV3Url(glookoCode, startDate, endDate) {
  return Defaults.DataV3
    + '?patient=' + encodeURIComponent(glookoCode)
    + '&startDate=' + encodeURIComponent(startDate)
    + '&endDate=' + encodeURIComponent(endDate)
    + '&' + V3_SERIES
    + '&filterBgReadings=true&splitByDay=false';
}

/**
 * Convert direction from consecutive glucose values.
 * delta in mg/dL per 5min
 */
function calcDirection(prev, curr) {
  if (prev === null || prev === undefined) return 'Flat';
  var delta = curr - prev;
  if (delta >  40) return 'DoubleUp';
  if (delta >  20) return 'SingleUp';
  if (delta >   8) return 'FortyFiveUp';
  if (delta >  -8) return 'Flat';
  if (delta > -20) return 'FortyFiveDown';
  if (delta > -40) return 'SingleDown';
  return 'DoubleDown';
}

/**
 * Convert v3 series data (cgmHigh + cgmNormal + cgmLow) to
 * Nightscout sgv entries array.
 *
 * v3 format per point:
 *   x:         Unix timestamp in SECONDS
 *   y:         glucose in mmol/L
 *   value:     glucose in mg/dL * 100 (e.g. 20500 = 205 mg/dL)
 *   timestamp: ISO string
 *
 * NS entry format:
 *   type: "sgv"
 *   sgv: mg/dL (integer)
 *   date: milliseconds
 *   dateString: ISO string
 *   direction: "Flat" etc.
 */
function v3SeriesToEntries(series) {
  if (!series) return [];

  var all = []
    .concat(series.cgmHigh   || [])
    .concat(series.cgmNormal || [])
    .concat(series.cgmLow    || []);

  if (all.length === 0) {
    console.log('GLOOKO: No CGM readings in v3 response');
    return [];
  }

  all.sort(function(a, b) { return a.x - b.x; });

  var entries = [];
  var prevSgv = null;

  for (var i = 0; i < all.length; i++) {
    var point = all[i];
    var dateMs = point.x * 1000;
    // point.value is mg/dL * 100
    var sgv = Math.round(point.value / 100);
    var direction = calcDirection(prevSgv, sgv);
    prevSgv = sgv;
    entries.push({
      type:       'sgv',
      sgv:        sgv,
      date:       dateMs,
      dateString: point.timestamp || new Date(dateMs).toISOString(),
      direction:  direction,
      device:     'Glooko'
    });
  }

  console.log('GLOOKO: converted ' + entries.length + ' CGM entries from v3 API');
  if (entries.length > 0) {
    console.log('GLOOKO: first entry:', JSON.stringify(entries[0]));
    console.log('GLOOKO: last entry:', JSON.stringify(entries[entries.length - 1]));
  }
  return entries;
}

function glookoSource (opts, axios) {
  console.log('GLOOKO SERVER: ' + opts.glookoServer);

  // CONNECT_GLOOKO_CGM=0 or =off disables CGM fetching (treatments/bolus only)
  var cgmEnvVal  = process.env.CONNECT_GLOOKO_CGM;
  var cgmEnabled = !(cgmEnvVal === '0' || (cgmEnvVal && cgmEnvVal.toLowerCase() === 'off'));
  console.log('GLOOKO CGM enabled:', cgmEnabled);

  var default_headers = {
    'Content-Type': Defaults.mime,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
    'Referer': 'https://' + opts.glookoServer + '/',
    'Origin': 'https://' + opts.glookoServer + '/',
    'Connection': 'keep-alive',
    'Accept-Language': 'en-GB,en;q=0.9'
  };

  var baseURL = opts.baseURL;
  var http = axios.create({ baseURL, headers: default_headers });

  var impl = {
    authFromCredentials () {
      var payload = login_payload(opts);
      console.log('GLOOKO AUTH: logging in as', opts.glookoEmail, 'on', opts.glookoServer);
      return http.post(Defaults.login, payload).then((response) => {
        console.log('GLOOKO AUTH: status', response.status);
        var setCookie = response.headers['set-cookie'];
        if (!setCookie || !setCookie[0]) {
          console.log('GLOOKO AUTH ERROR: no set-cookie header in response!');
          console.log('GLOOKO AUTH: response headers:', JSON.stringify(response.headers));
          throw new Error('AUTHENTICATION_ERROR: no session cookie received');
        }
        var userData = response.data;
        console.log('GLOOKO AUTH: glookoCode path check:', JSON.stringify({
          hasUserLogin: !!(userData && userData.userLogin),
          glookoCode:   userData && userData.userLogin && userData.userLogin.glookoCode,
        }));
        return { cookies: setCookie[0], user: userData };
      }).catch((err) => {
        if (err.response) {
          var errData = err.response.data || {};
          var errMsg  = errData.error || JSON.stringify(errData);
          if (errMsg && errMsg.indexOf('two-step') !== -1) {
            console.log('GLOOKO AUTH FAILED: Two-Factor Authentication is enabled - user must disable 2FA in Glooko app');
          } else {
            console.log('GLOOKO AUTH FAILED: HTTP', err.response.status, errMsg);
          }
        } else {
          console.log('GLOOKO AUTH FAILED:', err.message);
        }
        throw err;
      });
    },

    sessionFromAuth (auth) {
      return Promise.resolve(auth);
    },

    dataFromSesssion (session, last_known) {
      var now          = new Date();
      var two_days_ago = now.getTime() - (2 * 24 * 60 * 60 * 1000);
      var last_mills   = Math.max(two_days_ago, (last_known && last_known.entries) ? last_known.entries.getTime() : two_days_ago);
      var maxCount     = Math.ceil((now.getTime() - last_mills) / (1000 * 60 * 5));
      var endISO       = now.toISOString();
      // v2 + v3 beides IMMER 2 Tage zurueck
      // CGM-Duplikate werden von NS per Upsert (date-Feld) aufgeloest
      var startISO     = new Date(two_days_ago).toISOString();

      var glookoCode = session.user.userLogin.glookoCode;

      function makeHeaders() {
        var h = Object.assign({}, default_headers);
        h['Cookie']         = session.cookies;
        h['Host']           = opts.glookoServer;
        h['Sec-Fetch-Dest'] = 'empty';
        h['Sec-Fetch-Mode'] = 'cors';
        h['Sec-Fetch-Site'] = 'same-site';
        return h;
      }

      // v2: URL direkt mit patient+startDate+endDate (axios params wuerden 422 verursachen)
      function buildV2Url(endpoint) {
        return endpoint
          + '?patient='   + encodeURIComponent(glookoCode)
          + '&startDate=' + encodeURIComponent(startISO)
          + '&endDate='   + encodeURIComponent(endISO);
      }

      var v2params = {
        lastGuid:      Defaults.lastGuid,
        lastUpdatedAt: startISO,
        limit:         maxCount,
      };

      function fetcherV2(endpoint) {
        var headers = makeHeaders();
        var fullUrl = buildV2Url(endpoint);
        console.log('GLOOKO FETCHER V2 LOADING', fullUrl);
        return http.get(fullUrl, { headers, params: v2params })
          .then((resp) => resp.data);
      }

      // v3: CGM + basalBarAutomated - IMMER 2 Tage zurueck
      function fetcherV3(fullUrl) {
        var headers = makeHeaders();
        console.log('GLOOKO FETCHER V3 LOADING', fullUrl);
        return http.get(fullUrl, { headers })
          .then((resp) => {
            console.log('GLOOKO V3 response status:', resp.status);
            var data = resp.data;
            if (!data || typeof data !== 'object') {
              console.log('GLOOKO V3 ERROR: unexpected response type:', typeof data, String(data).substring(0, 200));
              return null;
            }
            if (!data.series) {
              console.log('GLOOKO V3 ERROR: no .series in response. Top-level keys:', Object.keys(data));
              console.log('GLOOKO V3 raw (first 500):', JSON.stringify(data).substring(0, 500));
              return null;
            }
            var s = data.series;
            console.log('GLOOKO V3 cgmHigh:', s.cgmHigh ? s.cgmHigh.length : 0,
                        'cgmNormal:', s.cgmNormal ? s.cgmNormal.length : 0,
                        'cgmLow:', s.cgmLow ? s.cgmLow.length : 0,
                        'basalBarAutomated:', s.basalBarAutomated ? s.basalBarAutomated.length : 0);
            if (s.cgmNormal && s.cgmNormal.length > 0) {
              console.log('GLOOKO V3 first cgmNormal point:', JSON.stringify(s.cgmNormal[0]));
            }
            if (s.basalBarAutomated && s.basalBarAutomated.length > 0) {
              console.log('GLOOKO V3 first basalBarAutomated:', JSON.stringify(s.basalBarAutomated[0]));
            }
            return data;
          })
          .catch((err) => {
            if (err.response) {
              console.log('GLOOKO V3 FAILED: HTTP', err.response.status, JSON.stringify(err.response.data || '').substring(0, 200));
            } else {
              console.log('GLOOKO V3 FAILED:', err.message);
            }
            return null;
          });
      }

      var v3Url = buildV3Url(glookoCode, startISO, endISO);
      console.log('GLOOKO glookoCode:', glookoCode);

      // If CGM disabled, skip v3 fetch entirely
      var v3Promise = cgmEnabled
        ? (console.log('GLOOKO V3 URL:', v3Url), fetcherV3(v3Url))
        : (console.log('GLOOKO CGM disabled via CONNECT_GLOOKO_CGM - skipping v3'), Promise.resolve(null));

      return Promise.all([
        fetcherV2(Defaults.LatestPumpBasals),  // v2 - scheduledBasals (Medtronic etc.)
        fetcherV2(Defaults.LatestPumpBolus),   // v2 - normalBoluses (treatments)
        v3Promise,                             // v3 - CGM + basalBarAutomated (or null if disabled)
      ]).then(function(results) {
        var some = {
          scheduledBasals: results[0].scheduledBasals || [],
          normalBoluses:   results[1].normalBoluses   || [],
          cgmSeriesV3:     (results[2] && results[2].series) ? results[2].series : null,
        };

        console.log('GLOOKO DATA FETCH done');
        console.log('GLOOKO normalBoluses:', some.normalBoluses.length);
        console.log('GLOOKO scheduledBasals:', some.scheduledBasals.length);
        console.log('GLOOKO CGM high:',          (some.cgmSeriesV3 && some.cgmSeriesV3.cgmHigh)          ? some.cgmSeriesV3.cgmHigh.length          : 0);
        console.log('GLOOKO CGM normal:',        (some.cgmSeriesV3 && some.cgmSeriesV3.cgmNormal)        ? some.cgmSeriesV3.cgmNormal.length        : 0);
        console.log('GLOOKO CGM low:',           (some.cgmSeriesV3 && some.cgmSeriesV3.cgmLow)           ? some.cgmSeriesV3.cgmLow.length           : 0);
        console.log('GLOOKO basalBarAutomated:', (some.cgmSeriesV3 && some.cgmSeriesV3.basalBarAutomated) ? some.cgmSeriesV3.basalBarAutomated.length : 0);

        return some;
      });
    },

    align_to_glucose () {
      // TODO
    },

    transformData (batch) {
      console.log('GLOOKO passing batch for transforming');
      var entries    = cgmEnabled ? v3SeriesToEntries(batch.cgmSeriesV3) : [];
      var treatments = helper.generate_nightscout_treatments(batch, opts.glookoTimezoneOffset);
      console.log('GLOOKO transform result: entries=' + entries.length + ' treatments=' + treatments.length);
      return { entries, treatments };
    },
  };

  function tracker_for () {
    var AxiosTracer = require('../../trace-axios');
    var tracker = AxiosTracer(http);
    return tracker;
  }

  function generate_driver (builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize:    impl.sessionFromAuth,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: (1000 * 60 * 60 * 24 * 1) - 600000,
        EXPIRE_SESSION_DELAY:          1000 * 60 * 60 * 24 * 1,
      }
    });

    builder.register_loop('Glooko', {
      tracker: tracker_for,
      frame: {
        impl:           impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform:      impl.transformData,
        backoff: {
          interval_ms: 2.5 * 60 * 1000
        },
        maxRetries: 1
      },
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        interval_ms: 2.5 * 60 * 1000
      },
    });
    return builder;
  }

  impl.generate_driver = generate_driver;
  return impl;
}

glookoSource.validate = function validate_inputs (input) {
  var ok      = false;
  var baseURL = base_for(input);

  const offset = !isNaN(input.glookoTimezoneOffset) ? input.glookoTimezoneOffset * -60 * 60 * 1000 : 0;
  console.log('GLOOKO using ms offset:', offset, input.glookoTimezoneOffset);

  var config = {
    glookoEnv:            input.glookoEnv,
    glookoServer:         input.glookoServer,
    glookoEmail:          input.glookoEmail,
    glookoPassword:       input.glookoPassword,
    glookoTimezoneOffset: offset,
    baseURL
  };

  var errors = [];
  if (!config.glookoEmail) {
    errors.push({ desc: "The Glooko User Login Email is required. CONNECT_GLOOKO_EMAIL must be an email belonging to an active Glooko User to log in.", err: new Error('CONNECT_GLOOKO_EMAIL') });
  }
  if (!config.glookoPassword) {
    errors.push({ desc: "Glooko User Login Password is required. CONNECT_GLOOKO_PASSWORD must be the password for the Glooko User Login.", err: new Error('CONNECT_GLOOKO_PASSWORD') });
  }

  ok          = errors.length == 0;
  config.kind = ok ? 'glooko' : 'disabled';
  return { ok, errors, config };
};

module.exports = glookoSource;
