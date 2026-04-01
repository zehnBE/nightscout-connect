/*
 * Eversense DMS  Nightscout Mapping
 *
 * raw.dashboard  = GetDashboardUserDeviceInfo_New
 *   .UserSetting   - Grenzwerte, Einheiten (GlucoseUnitOfMeasureID: 1=mgdl)
 *   .UserDeviceInfo - DeviceID, SensorID, DaysSinceInsertion, TransmitterSNo
 *
 * raw.agp        = AgpReportV5/GetDetailsOnDateFilter
 *   .GlucoseValues[] - {Value, EventDate, EventDateUTCUnix, EventTypeID}
 *     EventTypeID: 1=CGM, 2=BG
 *   .Statistics    - AverageBG, A1C, WearPercent, ...
 */

'use strict';

var CGM_TYPE = 1;
var BG_TYPE  = 2;

var TREND_MAP = {
  'FALLING_FAST':   'DoubleDown',
  'FALLING':        'SingleDown',
  'FALLING_SLOW':   'FortyFiveDown',
  'STABLE':         'Flat',
  'RISING_SLOW':    'FortyFiveUp',
  'RISING':         'SingleUp',
  'RISING_FAST':    'DoubleUp',
  'NOT_COMPUTABLE': 'NOT COMPUTABLE',
  'NONE':           'NOT COMPUTABLE'
};

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
  var readings = (raw.agp && raw.agp.GlucoseValues) ? raw.agp.GlucoseValues : [];

  readings.forEach(function(r)
  {
    if (r.EventTypeID !== CGM_TYPE) { return; }
    var sgv = parseFloat(r.Value);
    if (!sgv || sgv <= 0) { return; }
    var ms = r.EventDateUTCUnix ? parseFloat(r.EventDateUTCUnix) : isoToMs(r.EventDate);
    if (!ms) { return; }
    entries.push({
      type:       'sgv',
      sgv:        sgv,
      date:       ms,
      dateString: new Date(ms).toISOString(),
      direction:  TREND_MAP[r.Trend || r.trend || ''] || 'NOT COMPUTABLE',
      device:     'Eversense DMS'
    });
  });

  return entries;
}

function extractTreatments(raw)
{
  var treatments = [];
  var readings   = (raw.agp && raw.agp.GlucoseValues) ? raw.agp.GlucoseValues : [];

  readings.forEach(function(r)
  {
    if (r.EventTypeID !== BG_TYPE) { return; }
    var bg = parseFloat(r.Value);
    if (!bg || bg <= 0) { return; }
    var ms = r.EventDateUTCUnix ? parseFloat(r.EventDateUTCUnix) : isoToMs(r.EventDate);
    if (!ms) { return; }
    treatments.push({
      eventType:   'BG Check',
      created_at:  new Date(ms).toISOString(),
      date:        ms,
      glucose:     bg,
      glucoseType: 'Finger',
      units:       'mg/dl',
      device:      'Eversense DMS'
    });
  });

  return treatments;
}

function extractDevicestatus(raw)
{
  var di   = (raw.dashboard && raw.dashboard.UserDeviceInfo) ? raw.dashboard.UserDeviceInfo : {};
  var stat = (raw.agp && raw.agp.Statistics) ? raw.agp.Statistics : {};

  if (!di.DeviceID) { return []; }

  var now = Date.now();
  return [{
    device:     'Eversense ' + (di.TransmitterName || di.TransmitterSNo || di.DeviceID),
    created_at: new Date(now).toISOString(),
    date:       now,
    pump: {
      sensor: {
        age:   (di.DaysSinceInsertion || 0) * 24,
        state: 'active'
      },
      extended: {
        transmitterSNo:   di.TransmitterSNo,
        transmitterModel: di.TransmitterModelNo,
        sensorID:         di.SensorID,
        insertionDate:    di.InsertionDateTime,
        wearPercent:      stat.WearPercent,
        averageBG:        stat.AverageBG,
        a1c:              stat.A1C
      }
    }
  }];
}

function toNightscout(rawData)
{
  if (!rawData) { return { entries: [], devicestatus: [], treatments: [] }; }
  var entries      = extractEntries(rawData);
  var treatments   = extractTreatments(rawData);
  var devicestatus = extractDevicestatus(rawData);
  console.log('EVERSENSE convert: ' + entries.length + ' SGV, '
    + treatments.length + ' BG-Checks, ' + devicestatus.length + ' devicestatus');
  return { entries: entries, devicestatus: devicestatus, treatments: treatments };
}

module.exports = { toNightscout: toNightscout };
