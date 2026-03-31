/*
 * Medtronic CareLink  Nightscout Mapping
 *
 * Wandelt die CareLink /display/message Antwort in Nightscout-Formate um:
 *   - entries (SGV: CGM-Werte)
 *   - devicestatus (Pump: Reservoir, Batterie, IOB, aktiver Modus)
 *   - treatments (Bolus, Basal-Temp, Mahlzeiten)
 */

'use strict';

// Trend-Mapping: CareLink -> Nightscout direction string
var TREND_MAP = {
  'UP_FAST':   'DoubleUp',
  'UP':        'SingleUp',
  'UP_SLOWLY': 'FortyFiveUp',
  'FLAT':      'Flat',
  'DOWN_SLOWLY': 'FortyFiveDown',
  'DOWN':      'SingleDown',
  'DOWN_FAST': 'DoubleDown',
  'NONE':      'NOT COMPUTABLE',
  'NOT_COMPUTABLE': 'NOT COMPUTABLE'
};

// mgdl/mmol Konvertierung
function mgdlToMmol(mgdl)
{
  return Math.round((mgdl / 18.018) * 10) / 10;
}

// ISO-Timestamp aus CareLink-Datumsfeldern
function toIsoDate(dateStr, timeStr)
{
  // CareLink liefert "2024-12-01" und "14:30:00" getrennt
  if (!dateStr) { return null; }
  var iso = dateStr + (timeStr ? 'T' + timeStr : 'T00:00:00');
  // Kein Timezone-Suffix => als UTC behandeln
  return new Date(iso + 'Z').toISOString();
}

// Millisekunden-Timestamp
function toMs(dateStr, timeStr)
{
  var iso = toIsoDate(dateStr, timeStr);
  return iso ? new Date(iso).getTime() : null;
}

//  SGV-Entries (CGM) 

function extractEntries(raw)
{
  var entries = [];

  // sgs = sensor glucose samples (letzter Wert + History)
  var sgs = (raw.sgs && Array.isArray(raw.sgs)) ? raw.sgs : [];

  sgs.forEach(function(sg) {
    if (!sg.sg || sg.sg <= 0) { return; } // keine Calibration/Fehler-Werte

    var ts  = toMs(sg.datetime, null) || toMs(sg.date, sg.time);
    var dir = TREND_MAP[sg.trend] || 'NOT COMPUTABLE';

    entries.push({
      type:       'sgv',
      sgv:        sg.sg,
      date:       ts,
      dateString: new Date(ts).toISOString(),
      direction:  dir,
      device:     'MiniMed CareLink'
    });
  });

  return entries;
}

//  Devicestatus 

function extractDevicestatus(raw)
{
  var devicestatus = [];

  // Pump-Uebersicht: activeInsulin, reservoirAmount, batteryLevelPercent
  var pump = raw.pump || {};
  var cgs  = raw.conduitSensorStatus || {};

  var now     = Date.now();
  var created = new Date(now).toISOString();

  var ds = {
    device:     'MiniMed CareLink',
    created_at: created,
    date:       now
  };

  // Reservoir
  if (pump.reservoirAmount !== undefined) {
    ds.pump = ds.pump || {};
    ds.pump.reservoir = pump.reservoirAmount;
  }

  // Batterie
  if (pump.batteryLevelPercent !== undefined) {
    ds.pump = ds.pump || {};
    ds.pump.battery = { percent: pump.batteryLevelPercent };
  }

  // IOB (activeInsulin)
  if (raw.activeInsulin && raw.activeInsulin.amount !== undefined) {
    ds.pump = ds.pump || {};
    ds.pump.iob = { bolusiob: raw.activeInsulin.amount };
  }

  // Aktiver Closed-Loop Modus (SmartGuard / Auto-Mode)
  if (raw.pumpBannerState && Array.isArray(raw.pumpBannerState) && raw.pumpBannerState.length > 0) {
    ds.pump = ds.pump || {};
    ds.pump.status = {
      status: raw.pumpBannerState[0].type || 'unknown',
      bolusing: raw.pumpBannerState[0].type === 'BOLUS_IN_PROGRESS'
    };
  }

  // CGM Sensor-Status
  if (cgs.sensorState) {
    ds.pump = ds.pump || {};
    ds.pump.sensor = {
      state: cgs.sensorState,
      age:   cgs.sensorDurationHours
    };
  }

  // Letzter SGV-Wert im Devicestatus
  if (raw.lastSG && raw.lastSG.sg && raw.lastSG.sg > 0) {
    var lastSgTs = toMs(raw.lastSG.datetime, null) || now;
    ds.loop = {
      predicted: {
        values: []
      },
      cob: {
        cob: (raw.lastMeal && raw.lastMeal.amount) || 0
      }
    };
    ds.uploader = {
      battery: pump.batteryLevelPercent || 0
    };
  }

  if (ds.pump) {
    devicestatus.push(ds);
  }

  return devicestatus;
}

//  Treatments 

function extractTreatments(raw)
{
  var treatments = [];

  // ---- Boluses ----
  var markers = (raw.sensorHistory && Array.isArray(raw.sensorHistory)) ? raw.sensorHistory : [];

  markers.forEach(function(m) {
    if (!m.type) { return; }

    var ts = toMs(m.datetime, null);
    if (!ts) { return; }

    // Bolus-Eintraege
    if (m.type === 'BOLUS') {
      var bolusAmount = m.deliveredFastAmount || m.programmedFastAmount || 0;
      var carbsAmount = m.bolusCarb || 0;
      treatments.push({
        eventType:  carbsAmount > 0 ? 'Meal Bolus' : 'Correction Bolus',
        created_at: new Date(ts).toISOString(),
        date:       ts,
        insulin:    bolusAmount,
        carbs:      carbsAmount > 0 ? carbsAmount : undefined,
        notes:      'CareLink: ' + (m.type || ''),
        device:     'MiniMed CareLink'
      });
    }

    // Temp-Basals
    if (m.type === 'TEMP_BASAL') {
      treatments.push({
        eventType:  'Temp Basal',
        created_at: new Date(ts).toISOString(),
        date:       ts,
        rate:       m.rate || 0,
        duration:   m.duration ? Math.round(m.duration / 60) : 0, // sec -> min
        absolute:   m.rate || 0,
        device:     'MiniMed CareLink'
      });
    }

    // Alarme / Ereignisse als Ankuendigungen
    if (m.type === 'ALARM' || m.type === 'ALERT') {
      treatments.push({
        eventType:  'Announcement',
        created_at: new Date(ts).toISOString(),
        date:       ts,
        notes:      'CareLink Alarm: ' + (m.code || m.type || ''),
        device:     'MiniMed CareLink'
      });
    }
  });

  // ---- Basalrate (laufende) ----
  // Falls SmartGuard aktiv, kein manueller Basal-Eintrag noetig

  return treatments;
}

//  Hauptexport 

function toNightscout(rawData)
{
  if (!rawData) { return { entries: [], devicestatus: [], treatments: [] }; }

  var entries       = extractEntries(rawData);
  var devicestatus  = extractDevicestatus(rawData);
  var treatments    = extractTreatments(rawData);

  if (entries.length > 0) {
    console.log('CARELINK: ' + entries.length + ' SGV-Eintraege, '
      + treatments.length + ' Treatments, '
      + devicestatus.length + ' Devicestatus');
  } else {
    console.log('CARELINK: keine neuen SGV-Eintraege');
  }

  return {
    entries:      entries,
    devicestatus: devicestatus,
    treatments:   treatments
  };
}

module.exports = {
  toNightscout: toNightscout
};
