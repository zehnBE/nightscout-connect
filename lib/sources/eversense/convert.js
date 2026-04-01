/*
 * Eversense DMS  Nightscout Mapping
 *
 * raw.dashboard.UserDeviceInfo - DeviceID, SensorID, DaysSinceInsertion
 * raw.sgvList[] - TransmitterLog/GetSensorGlucoseEvents
 *   {Value, EventDateUTC, EventTypeID: 0=SGV}
 */

'use strict';

function isoToMs(ts)
{
  if (!ts) { return null; }
  var s = (ts.indexOf('Z') === -1 && ts.indexOf('+') === -1) ? ts + 'Z' : ts;
  var ms = Date.parse(s);
  return isNaN(ms) ? null : ms;
}

/**
 * Convert direction from consecutive glucose values.
 * delta in mg/dL per 5min
 */
function calcDirection(prev, curr)
{
  if (prev === null || prev === undefined) { return 'Flat'; }
  var delta = curr - prev;
  if (delta >  40) { return 'DoubleUp'; }
  if (delta >  20) { return 'SingleUp'; }
  if (delta >   8) { return 'FortyFiveUp'; }
  if (delta >  -8) { return 'Flat'; }
  if (delta > -20) { return 'FortyFiveDown'; }
  if (delta > -40) { return 'SingleDown'; }
  return 'DoubleDown';
}

function extractEntries(raw)
{
  var sgvList = raw.sgvList || [];

  // Gueltige Eintraege sammeln + nach Zeit sortieren (aelteste zuerst)
  var valid = [];
  sgvList.forEach(function(r)
  {
    if (r.EventTypeID !== 0 && r.EventTypeID !== undefined) { return; }
    var sgv = parseFloat(r.Value || r.convertedValue);
    if (!sgv || sgv <= 0) { return; }
    var ms = isoToMs(r.EventDateUTC) || isoToMs(r.EventDate);
    if (!ms) { return; }
    valid.push({ sgv: sgv, ms: ms });
  });

  valid.sort(function(a, b) { return a.ms - b.ms; });

  var entries = [];
  valid.forEach(function(r, i)
  {
    var prevSgv = (i > 0) ? valid[i - 1].sgv : null;
    // Nur berechnen wenn Abstand <= 10min (600000ms)
    var dtOk = (i > 0) ? (r.ms - valid[i - 1].ms) <= 600000 : false;
    var dir  = dtOk ? calcDirection(prevSgv, r.sgv) : 'NOT COMPUTABLE';

    entries.push({
      type:       'sgv',
      sgv:        r.sgv,
      date:       r.ms,
      dateString: new Date(r.ms).toISOString(),
      direction:  dir,
      device:     'Eversense DMS'
    });
  });

  return entries;
}

function extractDevicestatus(raw)
{
  var di = (raw.dashboard && raw.dashboard.UserDeviceInfo) ? raw.dashboard.UserDeviceInfo : {};
  if (!di.DeviceID) { return []; }

  var now = Date.now();
  return [{
    device:     'Eversense ' + (di.TransmitterName || di.TransmitterID || di.DeviceID),
    created_at: new Date(now).toISOString(),
    date:       now,
    pump: {
      sensor: {
        age:   (di.DaysSinceInsertion || 0) * 24,
        state: 'active'
      },
      extended: {
        transmitterID:    di.TransmitterID || di.TransmitterSNo,
        transmitterModel: di.TransmitterModelNo,
        sensorID:         di.SensorID,
        insertionDate:    di.InsertionDateTime
      }
    }
  }];
}

function toNightscout(rawData)
{
  if (!rawData) { return { entries: [], devicestatus: [], treatments: [] }; }
  var entries      = extractEntries(rawData);
  var devicestatus = extractDevicestatus(rawData);
  console.log('EVERSENSE convert: ' + entries.length + ' SGV, '
    + devicestatus.length + ' devicestatus');
  return { entries: entries, devicestatus: devicestatus, treatments: [] };
}

module.exports = { toNightscout: toNightscout };
