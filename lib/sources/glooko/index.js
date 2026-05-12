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
* MODIFIED: CONNECT_GLOOKO_CGM=0/off skips v3 fetch (treatments only)
* MODIFIED: Diff via updatedAt - only fetch new records, fallback to full 2-day fetch
* MODIFIED: updatedAt advanced by 1ms after each diff to avoid re-fetching same records
* MODIFIED: Apply glookoTimezoneOffset to v3 CGM timestamps (Glooko stores local time as UTC)
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
 * Glooko stores local time as UTC in point.x (Unix seconds).
 * Apply timestampDelta to correct to real UTC.
 *
 * @param {object} series - v3 series object
 * @param {number} timestampDelta - ms offset to apply (e.g. -7200000 for UTC+2)
 */
function v3SeriesToEntries(series, timestampDelta) {
  if (!series) return [];

  var delta = timestampDelta || 0;

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
    var point  = all[i];
    // Apply timezone offset: Glooko stores local time as UTC
    var dateMs = (point.x * 1000) + delta;
    var sgv    = Math.round(point.value / 100);
    var direction = calcDirection(prevSgv, sgv);
    prevSgv = sgv;
    entries.push({
      type:       'sgv',
      sgv:        sgv,
      date:       dateMs,
      dateString: new Date(dateMs).toISOString(),
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

  // Per-endpoint updatedAt tracking for diff fetching.
  // Stored outside dataFromSesssion so it persists across loops within a session.
  var lastUpdatedAt = {
    scheduledBasals: null,
    normalBoluses:   null,
  };
  // Auto-detect timezone offset from userLogin.utcOffset on first frame.
  // Set once per session, used by transformData for v2 pumpTimestamp correction.
  var timezoneResolved = false;

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
      var endISO       = now.toISOString();
      var startISO     = new Date(two_days_ago).toISOString();

      var glookoCode = session.user.userLogin.glookoCode;
      // Auto-detect treatments timezone offset from userLogin.utcOffset (e.g. "+02:00").
      // Manual override via CONNECT_GLOOKO_TIMEZONE_OFFSET (non-zero in ENV) takes precedence.
      // Runs once per session, mutates opts.glookoTimezoneOffset (ms) for use in transformData.
      if (!timezoneResolved) {
        timezoneResolved = true;
        if (!opts.glookoTimezoneOffset) {
          var utcOffsetStr = session.user.userLogin && session.user.userLogin.utcOffset;
          var m = utcOffsetStr && utcOffsetStr.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
          if (m) {
            var sign = m[1] === '-' ? -1 : 1;
            var hh = parseInt(m[2], 10);
            var mm = parseInt(m[3] || '0', 10);
            var hoursDecimal = sign * (hh + mm / 60);
            opts.glookoTimezoneOffset = hoursDecimal * -60 * 60 * 1000;
            console.log('GLOOKO: auto-detected timezone from userLogin.utcOffset:', utcOffsetStr, '-> offset ms:', opts.glookoTimezoneOffset);
          } else {
            console.log('GLOOKO: could not auto-detect timezone (userLogin.utcOffset =', JSON.stringify(utcOffsetStr) + ') - using offset 0');
          }
        } else {
          console.log('GLOOKO: using manually-configured CONNECT_GLOOKO_TIMEZONE_OFFSET -> offset ms:', opts.glookoTimezoneOffset);
        }
      }

      function makeHeaders() {
        var h = Object.assign({}, default_headers);
        h['Cookie']         = session.cookies;
        h['Host']           = opts.glookoServer;
        h['Sec-Fetch-Dest'] = 'empty';
        h['Sec-Fetch-Mode'] = 'cors';
        h['Sec-Fetch-Site'] = 'same-site';
        return h;
      }

      function buildV2Url(endpoint, lastUpdatedAtFilter) {
        return endpoint
          + '?patient='       + encodeURIComponent(glookoCode)
          + '&startDate='     + encodeURIComponent(startISO)
          + '&endDate='       + encodeURIComponent(endISO)
          + '&lastGuid='      + encodeURIComponent(Defaults.lastGuid)
          + '&lastUpdatedAt=' + encodeURIComponent(lastUpdatedAtFilter)
          + '&limit=1000';
      }

      /**
       * Extract max updatedAt from a list of records, advanced by 1ms.
       * Glooko API uses >= filter on lastUpdatedAt, so we advance by 1ms
       * to avoid re-fetching the same records on the next diff.
       */
      function maxUpdatedAtAdvanced(items) {
        var max = null;
        items.forEach(function(item) {
          if (item.updatedAt) {
            var d = new Date(item.updatedAt);
            if (!max || d > max) max = d;
          }
        });
        return max ? new Date(max.getTime() + 1).toISOString() : null;
      }

      /**
       * Fetch v2 endpoint with diff support.
       * Uses stored lastUpdatedAt if available, falls back to full 2-day fetch.
       * If diff fetch returns 0 results, falls back to full fetch as safety net.
       */
      function fetcherV2Diff(endpoint, itemsKey, storedKey) {
        var filter  = lastUpdatedAt[storedKey] || startISO;
        var isDiff  = !!lastUpdatedAt[storedKey];
        var headers = makeHeaders();
        var fullUrl = buildV2Url(endpoint, filter);
        console.log('GLOOKO FETCHER V2', isDiff ? 'DIFF' : 'FULL', fullUrl);

        return http.get(fullUrl, { headers }).then(function(resp) {
          var data  = resp.data;
          var items = data[itemsKey] || [];
          console.log('GLOOKO V2', isDiff ? 'DIFF' : 'FULL',
            '- got', items.length, itemsKey,
            '- lastPage:', data.lastPage);

          // If diff returned 0 results, fall back to full fetch as safety net
          if (isDiff && items.length === 0) {
            console.log('GLOOKO V2 DIFF empty - falling back to full fetch');
            var fbHeaders = makeHeaders();
            var fbUrl     = buildV2Url(endpoint, startISO);
            return http.get(fbUrl, { headers: fbHeaders }).then(function(resp2) {
              var data2  = resp2.data;
              var items2 = data2[itemsKey] || [];
              console.log('GLOOKO V2 FULL FALLBACK - got', items2.length, itemsKey);
              var newMax = maxUpdatedAtAdvanced(items2);
              if (newMax) {
                lastUpdatedAt[storedKey] = newMax;
                console.log('GLOOKO updatedAt[' + storedKey + '] =', newMax);
              }
              return items2;
            });
          }

          // Update stored updatedAt  only advance, never go back
          var newMax = maxUpdatedAtAdvanced(items);
          if (newMax) {
            if (!lastUpdatedAt[storedKey] || new Date(newMax) > new Date(lastUpdatedAt[storedKey])) {
              lastUpdatedAt[storedKey] = newMax;
              console.log('GLOOKO updatedAt[' + storedKey + '] =', newMax);
            }
          }

          return items;
        });
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

      // CONNECT_GLOOKO_CGM=0 or =off disables CGM fetching (treatments only)
      var cgmEnvVal  = process.env.CONNECT_GLOOKO_CGM;
      var cgmEnabled = !(cgmEnvVal === '0' || (cgmEnvVal && cgmEnvVal.toLowerCase() === 'off'));

      var v3Url = buildV3Url(glookoCode, startISO, endISO);
      console.log('GLOOKO glookoCode:', glookoCode);
      if (cgmEnabled) {
        console.log('GLOOKO V3 URL:', v3Url);
      } else {
        console.log('GLOOKO CGM disabled via CONNECT_GLOOKO_CGM - skipping v3');
      }

      return Promise.all([
        fetcherV2Diff(Defaults.LatestPumpBasals, 'scheduledBasals', 'scheduledBasals'),
        fetcherV2Diff(Defaults.LatestPumpBolus,  'normalBoluses',   'normalBoluses'),
        cgmEnabled ? fetcherV3(v3Url) : Promise.resolve(null),
      ]).then(function(results) {
        var some = {
          scheduledBasals: results[0] || [],
          normalBoluses:   results[1] || [],
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
      var cgmEnvVal  = process.env.CONNECT_GLOOKO_CGM;
      var cgmEnabled = !(cgmEnvVal === '0' || (cgmEnvVal && cgmEnvVal.toLowerCase() === 'off'));
      // Apply user timezone offset to v3 CGM timestamps - some pump setups
      // (CamAPS+Libre3) stamp v3 sgvs as local-as-UTC just like v2 pumpTimestamps.
      var entries    = cgmEnabled ? v3SeriesToEntries(batch.cgmSeriesV3, opts.glookoTimezoneOffset) : [];
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
