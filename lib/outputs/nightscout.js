var qs = require('querystring');
var url = require('url');
var crypto = require('crypto');

function encode_api_secret(plain) {
  return plain;
}

function nightscoutRestAPI (config, axios) {
  console.log("SETTING UP nightscoutRestAPI", config);
  var endpoint = url.parse(config.url);
  var baseURL = url.format({
    protocol: endpoint.protocol
  , host: endpoint.host
  , pathname: endpoint.pathname
  });
  var params = qs.parse(endpoint.query);
  var apiSecret = config.apiSecret;
  var apiHash = apiSecret;
  var http = axios.create({ baseURL });

  var bookmark = null;

  function record_glucose (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    console.log("NS POST entries: posting", data.length, "sgvs to /api/v1/entries.json");
    if (data.length > 0) {
      console.log("NS POST entries: first sgv:", JSON.stringify(data[0]));
      console.log("NS POST entries: last  sgv:", JSON.stringify(data[data.length - 1]));
    }
    return http.post('/api/v1/entries.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total entries", resp.data ? resp.data.length : 'NULL', "HTTP", resp.status);
      if (!resp.data || resp.data.length === 0) {
        console.log("NS UPLOAD WARN: server returned empty array - sgvs NOT persisted!");
      } else {
        // Log each uploaded sgv with timestamp + sgv value
        resp.data.forEach(function(e) {
          if (e && e.type === 'sgv') {
            console.log('NS UPLOAD OK: sgv', e.dateString || e.date, '| value:', e.sgv, '| direction:', e.direction);
          } else if (e && e._id) {
            console.log('NS UPLOAD OK: entry', JSON.stringify(e).substring(0, 200));
          } else {
            console.log('NS UPLOAD ??: unknown response item:', JSON.stringify(e).substring(0, 200));
          }
        });
      }
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR entries:", err.message, "HTTP", err.response && err.response.status);
      if (err.response && err.response.data) {
        console.log("RECORDING ERROR entries response body:", JSON.stringify(err.response.data).substring(0, 500));
      }
    });
  }

  function record_treatments (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/treatments.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total treatments", resp.data.length);
      // Log each uploaded treatment with timestamp
      resp.data.forEach(function(t) {
        var ts = t.created_at || t.eventTime;
        if (t.eventType === 'Meal Bolus') {
          console.log('NS UPLOAD OK: Meal Bolus', ts, '| insulin:', t.insulin, 'U | carbs:', t.carbs, 'g');
        } else if (t.eventType === 'Temp Basal') {
          console.log('NS UPLOAD OK: Temp Basal', ts, '| rate:', t.rate, 'U/h | duration:', t.duration, 'min');
        } else if (t.eventType) {
          console.log('NS UPLOAD OK:', t.eventType, ts);
        }
      });
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR treatments:", err.message, err.response && err.response.status);
    });
  }

  function bookmark_glucose (data) {
    var readings = data;
    if (readings && readings.length) {
      // FIX: use newest dateString, not readings[0]. Upstream sort order is not guaranteed
      // and on Glooko the entries are sorted oldest-first => readings[0] = oldest, which
      // resets the bookmark backwards every cycle. Take max and only advance, never go back.
      var latest = null;
      readings.forEach(function(r) {
        if (!r || !r.dateString) return;
        var d = new Date(r.dateString);
        if (!latest || d > latest) latest = d;
      });
      if (latest && (!bookmark.entries || latest > bookmark.entries)) {
        bookmark.entries = latest;
      }
    }
    return Promise.resolve(data);
  }

  // Update bookmark from treatments if treatment timestamp is newer
  function bookmark_from_treatments (data) {
    if (data && data.length) {
      var latest = null;
      data.forEach(function(t) {
        var ts = t.created_at || t.eventTime;
        if (ts) {
          var d = new Date(ts);
          if (!latest || d > latest) latest = d;
        }
      });
      if (latest && (!bookmark.entries || latest > bookmark.entries)) {
        bookmark.entries = latest;
        console.log("BOOKMARK UPDATED FROM TREATMENTS", bookmark);
      }
    }
    return Promise.resolve(data);
  }

  function record_batch (batch) {
    console.log("RECORD BATCH with", (batch.entries || []).length, 'entries and', (batch.treatments || []).length, 'treatments');
    var { entries, treatments, profiles, devicestatus } = batch;
    entries      = entries      || [ ];
    treatments   = treatments   || [ ];
    profiles     = profiles     || [ ];
    devicestatus = devicestatus || [ ];

    return Promise.all([
        record_glucose(entries).then(bookmark_glucose),
        record_treatments(treatments).then(() => bookmark_from_treatments(treatments))
      ]).then(function update_bookmark (settled) {
        console.log("UPDATE BOOKMARK FROM I/O", bookmark, settled[0], settled.length);
        return bookmark;
    });
  }

  record_batch.gap_for = function ( ) {
    console.log("FETCHING GAPS INFORMATION");
    if (bookmark) {
      return Promise.resolve(bookmark);
    }
    bookmark = { };
    var headers = { 'API-SECRET': apiHash };

    return http.get('/api/v1/entries.json', { params: { count: 1 }, headers }).then((resp) => {
      if (resp.data && resp.data.length) {
        bookmark.entries = new Date(resp.data[0].dateString);
        console.log("UPDATED ENTRIES BOOKMARK", bookmark);
      }
    }).catch((err) => {
      console.log("FAILED TO DETERMINE GAP FROM ENTRIES", err.message);
    }).then(( ) => {
      if (!bookmark.entries) {
        return http.get('/api/v1/treatments.json', { params: { count: 1 }, headers }).then((resp) => {
          if (resp.data && resp.data.length) {
            var ts = resp.data[0].created_at || resp.data[0].eventTime;
            if (ts) {
              bookmark.entries = new Date(ts);
              console.log("UPDATED BOOKMARK FROM TREATMENTS", bookmark);
            }
          }
        }).catch((err) => {
          console.log("FAILED TO DETERMINE GAP FROM TREATMENTS", err.message);
        });
      }
    }).then(( ) => {
      console.log("FINAL GAP", bookmark);
      return bookmark;
    });
  };

  return record_batch;
}

module.exports = nightscoutRestAPI;
