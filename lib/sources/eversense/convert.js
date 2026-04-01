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

function extractEntries(raw)
{
  var entries  = [];
  var sgvList  = raw.sgvList || [];

  sgvList.forEach(function(r)
  {
    // EventTypeID 0 = CGM-Wert
    if (r.EventTypeID !== 0 && r.EventTypeID !== undefined) { return; }

    var sgv = parseFloat(r.Value || r.convertedValue);
    if (!sgv || sgv <= 0) { return; }

    // EventDateUTC ist UTC-ISO-String
    var ms = isoToMs(r.EventDateUTC) || isoToMs(r.EventDate);
    if (!ms) { return; }

    entries.push({
      type:       'sgv',
      sgv:        sgv,
      date:       ms,
      dateString: new Date(ms).toISOString(),
      direction:  'NOT COMPUTABLE',
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
        transmitterID:   di.TransmitterID || di.TransmitterSNo,
        transmitterModel: di.TransmitterModelNo,
        sensorID:        di.SensorID,
        insertionDate:   di.InsertionDateTime
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
