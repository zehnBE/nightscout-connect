/*
 * Medtronic CareLink  Nightscout Mapping
 *
 * Basiert auf echter CareLink /display/message Antwortstruktur:
 *   raw.sgs[]          - CGM-Werte (288 Eintraege = 24h)
 *   raw.markers[]      - Events: INSULIN, MEAL, AUTO_BASAL_DELIVERY, CALIBRATION, ...
 *   raw.lastSG         - Letzter CGM-Wert
 *   raw.lastSGTrend    - Aktueller Trend
 *   raw.activeInsulin  - Aktives Insulin (IOB)
 *   raw.reservoirAmount
 *   raw.pumpBatteryLevelPercent
 *   raw.pumpBannerState[]
 *   raw.therapyAlgorithmState
 *   raw.sensorState
 *   raw.sensorDurationHours
 *   raw.clientTimeZoneName
 */

'use strict';

//  Trend-Mapping

var TREND_MAP = {
  'UP_FAST':        'DoubleUp',
  'UP':             'SingleUp',
  'UP_SLOWLY':      'FortyFiveUp',
  'FLAT':           'Flat',
  'DOWN_SLOWLY':    'FortyFiveDown',
  'DOWN':           'SingleDown',
  'DOWN_FAST':      'DoubleDown',
  'NONE':           'NOT COMPUTABLE',
  'NOT_COMPUTABLE': 'NOT COMPUTABLE'
};

//  Timestamp-Handling
//
// sgs[].relativeOffset = Sekunden relativ zu currentServerTime (Unix-ms).
// Timezone-unabhaengig und korrekt fuer BLENGP/NGP.
// Fallback auf isoToMs() fuer aeltere Pumpen ohne relativeOffset.

function isoToMs(ts)
{
  if (!ts) { return null; }
  // "2025-03-11T01:17:00"  als UTC parsen
  var s = ts.replace(' ', 'T');
  if (s.indexOf('Z') === -1 && s.indexOf('+') === -1) { s += 'Z'; }
  var ms = Date.parse(s);
  return isNaN(ms) ? null : ms;
}

function sgToMs(sg, raw)
{
  if (raw.currentServerTime && sg.relativeOffset !== undefined)
  {
    return raw.currentServerTime + sg.relativeOffset * 1000;
  }
  return isoToMs(sg.datetime || sg.timestamp);
}

//  SGV-Entries (CGM)

function extractEntries(raw)
{
  var entries = [];

  // sgs: Array von { kind, sg, sensorState, datetime, relativeOffset }
  var sgs = Array.isArray(raw.sgs) ? raw.sgs : [];
  if (sgs.length === 0)
  {
    // Fallback: nur lastSG wenn kein History
    if (raw.lastSG && raw.lastSG.sg > 0)
    {
      var ts  = isoToMs(raw.lastSG.datetime || raw.lastSG.timestamp) || Date.now();
      var dir = TREND_MAP[raw.lastSGTrend] || 'NOT COMPUTABLE';
      entries.push({
        type:       'sgv',
        sgv:        raw.lastSG.sg,
        date:       ts,
        dateString: new Date(ts).toISOString(),
        direction:  dir,
        device:     'MiniMed CareLink'
      });
    }
    return entries;
  }

  // Neuesten Timestamp bestimmen (fuer Trend-Zuweisung)
  var lastTs = 0;
  sgs.forEach(function(sg)
  {
    if (!sg.sg || sg.sg <= 0) { return; }
    var ms = sgToMs(sg, raw);
    if (!ms) { return; }
    if (ms > lastTs) { lastTs = ms; }
  });

  sgs.forEach(function(sg)
  {
    if (!sg.sg || sg.sg <= 0) { return; }
    var ms = sgToMs(sg, raw);
    if (!ms) { return; }

    var dir = (ms === lastTs)
      ? (TREND_MAP[raw.lastSGTrend] || 'NOT COMPUTABLE')
      : 'NOT COMPUTABLE';

    entries.push({
      type:       'sgv',
      sgv:        sg.sg,
      date:       ms,
      dateString: new Date(ms).toISOString(),
      direction:  dir,
      device:     'MiniMed CareLink'
    });
  });

  return entries;
}

//  Devicestatus

function extractDevicestatus(raw)
{
  var now     = Date.now();
  var created = new Date(now).toISOString();

  var ds = {
    device:     'MiniMed CareLink',
    created_at: created,
    date:       now,
    pump:       {}
  };

  // Reservoir
  if (raw.reservoirAmount !== undefined && raw.reservoirAmount !== null)
  {
    ds.pump.reservoir = raw.reservoirAmount;
  }
  if (raw.reservoirRemainingUnits !== undefined)
  {
    ds.pump.reservoir = raw.reservoirRemainingUnits;
  }

  // Batterie Pumpe
  if (raw.pumpBatteryLevelPercent !== undefined)
  {
    ds.pump.battery = { percent: raw.pumpBatteryLevelPercent };
  }

  // IOB
  if (raw.activeInsulin && raw.activeInsulin.amount !== undefined)
  {
    ds.pump.iob = { bolusiob: parseFloat(raw.activeInsulin.amount) || 0 };
  }

  // Pump-Status (SmartGuard / AutoMode / Suspended)
  if (raw.pumpSuspended)
  {
    ds.pump.status = { status: 'Suspended', bolusing: false };
  }
  else if (Array.isArray(raw.pumpBannerState) && raw.pumpBannerState.length > 0)
  {
    var banner = raw.pumpBannerState[0];
    ds.pump.status = {
      status:   banner.type || 'unknown',
      bolusing: banner.type === 'BOLUS_IN_PROGRESS'
    };
  }

  // Therapy Algorithm (Auto-Mode / Closed-Loop)
  if (raw.therapyAlgorithmState)
  {
    ds.pump.extended = ds.pump.extended || {};
    ds.pump.extended.therapyAlgorithmState = raw.therapyAlgorithmState;
  }

  // CGM Sensor-Status
  if (raw.sensorState)
  {
    ds.pump.sensor = {
      state: raw.sensorState,
      age:   raw.sensorDurationHours
    };
  }

  // Conduit (Uploader-Device)
  if (raw.conduitBatteryLevel !== undefined)
  {
    ds.uploader = { battery: raw.conduitBatteryLevel };
  }

  if (!ds.pump || Object.keys(ds.pump).length === 0) { return []; }
  return [ds];
}

//  Treatments

function extractTreatments(raw)
{
  var treatments = [];

  var markers = Array.isArray(raw.markers) ? raw.markers : [];

  markers.forEach(function(m)
  {
    if (!m.type || !m.timestamp) { return; }

    var ts  = isoToMs(m.timestamp);
    var dv  = (m.data && m.data.dataValues) ? m.data.dataValues : {};
    var iso = ts ? new Date(ts).toISOString() : null;
    if (!ts || !iso) { return; }

    switch (m.type)
    {
      case 'INSULIN':
        // Bolus (FAST / DUAL / SQUARE)
        var insulin = parseFloat(dv.deliveredFastAmount || dv.programmedFastAmount || 0);
        if (insulin > 0)
        {
          treatments.push({
            eventType:   'Correction Bolus',
            created_at:  iso,
            date:        ts,
            insulin:     insulin,
            notes:       'CareLink: ' + (dv.bolusType || 'FAST')
              + (dv.activationType ? ' / ' + dv.activationType : ''),
            device:      'MiniMed CareLink'
          });
        }
        break;

      case 'MEAL':
        // Mahlzeit (Kohlenhydrate)
        var carbs = parseFloat(dv.amount || 0);
        if (carbs > 0)
        {
          treatments.push({
            eventType:  'Carb Correction',
            created_at: iso,
            date:       ts,
            carbs:      carbs,
            notes:      'CareLink Meal',
            device:     'MiniMed CareLink'
          });
        }
        break;

      case 'AUTO_BASAL_DELIVERY':
        // Automatische Basalabgabe (SmartGuard / Auto-Mode)
        var basal = parseFloat(dv.bolusAmount || 0);
        if (basal > 0)
        {
          treatments.push({
            eventType:   'Temp Basal',
            created_at:  iso,
            date:        ts,
            rate:        parseFloat(dv.maxAutoBasalRate || 0),
            absolute:    basal,
            duration:    5,           // Auto-Basal = 5min Zyklen
            notes:       'CareLink AutoBasal',
            device:      'MiniMed CareLink'
          });
        }
        break;

      case 'CALIBRATION':
        // Kalibrierung
        var bgVal = parseFloat(dv.unitValue || 0);
        if (bgVal > 0)
        {
          treatments.push({
            eventType:   'BG Check',
            created_at:  iso,
            date:        ts,
            glucose:     bgVal,
            glucoseType: 'Finger',
            units:       (dv.bgUnits === 'MMOL') ? 'mmol/L' : 'mg/dl',
            device:      'MiniMed CareLink'
          });
        }
        break;

      case 'LOW_GLUCOSE_SUSPENDED':
        treatments.push({
          eventType:  'Announcement',
          created_at: iso,
          date:       ts,
          notes:      'CareLink: Low Glucose Suspended',
          device:     'MiniMed CareLink'
        });
        break;

      case 'AUTO_MODE_STATUS':
        treatments.push({
          eventType:  'Announcement',
          created_at: iso,
          date:       ts,
          notes:      'CareLink: Auto Mode Status',
          device:     'MiniMed CareLink'
        });
        break;
    }
  });

  // INSULIN + MEAL mit gleichem Timestamp zusammenfuehren  Meal Bolus
  var mealMap = {};
  treatments.forEach(function(t)
  {
    if (t.eventType === 'Carb Correction') { mealMap[t.date] = t; }
  });
  treatments.forEach(function(t)
  {
    if (t.eventType === 'Correction Bolus' && mealMap[t.date])
    {
      t.eventType = 'Meal Bolus';
      t.carbs     = mealMap[t.date].carbs;
      mealMap[t.date]._merged = true;
    }
  });

  return treatments.filter(function(t) { return !t._merged; });
}

//  Export

function toNightscout(rawData)
{
  if (!rawData) { return { entries: [], devicestatus: [], treatments: [] }; }

  var entries      = extractEntries(rawData);
  var devicestatus = extractDevicestatus(rawData);
  var treatments   = extractTreatments(rawData);

  console.log('CARELINK convert: '
    + entries.length      + ' SGV, '
    + treatments.length   + ' treatments, '
    + devicestatus.length + ' devicestatus');

  return { entries: entries, devicestatus: devicestatus, treatments: treatments };
}

module.exports = { toNightscout: toNightscout };
