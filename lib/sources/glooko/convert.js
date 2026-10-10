/**
 * Glooko -> Nightscout treatment converter
 *
 * TIMESTAMP RULES:
 * - v2 pumpTimestamp: local time stored with false +00:00 UTC marker
 * - v3 point.x (CGM + basalBarAutomated): Unix seconds, local time stored as UTC
 * - Both need timestampDelta correction: new Date(raw + delta) for real UTC
 * - timestampDelta = CONNECT_GLOOKO_TIMEZONE_OFFSET * -60 * 60 * 1000
 *   e.g. UTC+2 -> offset_hours=2 -> delta=-7200000ms
 *   e.g. UTC-5 -> offset_hours=-5 -> delta=+18000000ms
 */

/**
 * Convert v3 basalBarAutomated series to NS Temp Basal treatments.
 *
 * v3 timestamps (point.x) are Unix seconds in LOCAL time stored as UTC.
 * Apply timestampDelta (ms) to correct to real UTC.
 *
 * @param {Array} basalSeries - v3 basalBarAutomated data points
 * @param {number} timestampDelta - ms offset to apply (e.g. -7200000 for UTC+2)
 */
function v3BasalToTreatments(basalSeries, timestampDelta) {
  if (!basalSeries || basalSeries.length === 0) return [];
  var delta = timestampDelta || 0;
  var rateMap = {};
  basalSeries.forEach(function(point) {
    if (rateMap[point.x] === undefined || point.y > rateMap[point.x]) {
      rateMap[point.x] = point.y;
    }
  });
  var times = Object.keys(rateMap).map(Number).sort(function(a, b) { return a - b; });
  var treatments = [];
  for (var i = 0; i < times.length; i++) {
    var x      = times[i];
    var rate   = rateMap[x];
    var nextX  = times[i + 1] || (x + 300);
    var durMin = Math.round((nextX - x) / 60);
    if (durMin < 1) durMin = 1;
    // Apply timezone correction: local-as-UTC -> real UTC
    var dateMs = (x * 1000) + delta;
    treatments.push({
      eventType:  'Temp Basal',
      created_at: new Date(dateMs).toISOString(),
      date:       dateMs,
      rate:       rate,
      absolute:   rate,
      duration:   durMin,
    });
  }
  console.log('GLOOKO v3 basal: converted', treatments.length, 'Temp Basal treatments',
    delta ? '(offset ' + delta + 'ms applied)' : '(no offset)');
  if (treatments.length > 0) {
    console.log('GLOOKO v3 basal: first:', treatments[0].created_at, 'rate:', treatments[0].rate);
    console.log('GLOOKO v3 basal: last:', treatments[treatments.length - 1].created_at, 'rate:', treatments[treatments.length - 1].rate);
  }
  return treatments;
}

/**
 * Generate Nightscout treatments from Glooko v2 + v3 data.
 *
 * @param {object} batch - { normalBoluses, scheduledBasals, cgmSeriesV3 }
 * @param {number} timestampDelta - ms offset (negative for positive UTC offsets)
 */
function generate_nightscout_treatments(batch, timestampDelta) {
  var pumpBoluses     = batch.normalBoluses;
  var scheduledBasals = batch.scheduledBasals;
  var cgmSeriesV3     = batch.cgmSeriesV3;
  var delta = timestampDelta || 0;
  var treatments = [];

  // v2 pumpBoluses (normalBoluses) -> Meal Bolus / Correction Bolus
  // pumpTimestamp is stored as local time with +00:00 marker - apply timestampDelta to correct.
  if (pumpBoluses) {
    pumpBoluses.forEach(function(element) {
      var treatment       = {};
      var rawMs           = new Date(element.pumpTimestamp).getTime();
      var correctedMs     = rawMs + delta;
      var ts              = new Date(correctedMs).toISOString();
      var hasCarbs        = element.carbsInput && element.carbsInput > 0;
      treatment.eventType = hasCarbs ? 'Meal Bolus' : 'Correction Bolus';
      treatment.eventTime  = ts;
      treatment.created_at = ts;
      treatment.date       = correctedMs;
      treatment.insulin    = element.insulinDelivered;
      if (hasCarbs) {
        treatment.carbs = element.carbsInput;
      }
      treatments.push(treatment);
      console.log('GLOOKO Bolus:', ts,
        '| type:', treatment.eventType,
        '| insulin:', element.insulinDelivered, 'U',
        '| carbs:', element.carbsInput || 0, 'g',
        delta ? '| raw:' + element.pumpTimestamp : '');
    });
  }

  // v2 scheduledBasals -> Temp Basal (Medtronic, Ypsopump etc.)
  // pumpTimestamp is local time stamped as UTC - apply timestampDelta to correct.
  if (scheduledBasals) {
    scheduledBasals.forEach(function(element) {
      var treatment        = {};
      var rawMs            = new Date(element.pumpTimestamp).getTime();
      var correctedMs      = rawMs + delta;
      var ts               = new Date(correctedMs).toISOString();
      treatment.eventType  = 'Temp Basal';
      treatment.created_at = ts;
      treatment.date       = correctedMs;
      treatment.rate       = element.rate;
      treatment.absolute   = element.rate;
      treatment.duration   = element.duration / 60;
      treatments.push(treatment);
      console.log('GLOOKO Basal:', ts,
        '| rate:', element.rate, 'U/h',
        '| duration:', Math.round(element.duration / 60), 'min',
        delta ? '| raw:' + element.pumpTimestamp : '');
    });
  }

  // v3 basalBarAutomated -> Temp Basal (Omnipod 5 etc.)
  // v3 timestamps are local-as-UTC (same as v2 pumpTimestamp) - apply timestampDelta.
  if (cgmSeriesV3 && cgmSeriesV3.basalBarAutomated) {
    var basalTreatments = v3BasalToTreatments(cgmSeriesV3.basalBarAutomated, delta);
    basalTreatments.forEach(function(t) { treatments.push(t); });
  }

  console.log('GLOOKO data transformation complete, returning', treatments.length, 'treatments');
  return treatments;
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;
