var moment = require('moment');
/**
 * Convert v3 basalBarAutomated series to NS Temp Basal treatments.
 */
function v3BasalToTreatments(basalSeries) {
  if (!basalSeries || basalSeries.length === 0) return [];
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
    treatments.push({
      eventType:  'Temp Basal',
      created_at: new Date(x * 1000).toISOString(),
      rate:       rate,
      absolute:   rate,
      duration:   durMin,
    });
  }
  console.log('GLOOKO v3 basal: converted', treatments.length, 'Temp Basal treatments');
  return treatments;
}
function generate_nightscout_treatments(batch, timestampDelta) {
  const foods           = batch.foods;
  const insulins        = batch.insulins;
  const pumpBoluses     = batch.normalBoluses;
  const scheduledBasals = batch.scheduledBasals;
  const cgmSeriesV3     = batch.cgmSeriesV3;
  var treatments = [];

  if (foods) {
    foods.forEach(function(element) {
      var treatment = {};
      var f_date   = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime() + timestampDelta - 45*60000);
      var now      = moment(f_date);
      var end      = moment(f_s_date);
      var duration = moment.duration(now.diff(end));
      var minutes  = duration.asMinutes();
      var i_date = new Date();
      var result = insulins.filter(function(el) {
        i_date = new Date(el.timestamp);
        var i_moment = moment(i_date);
        var duration = moment.duration(now.diff(i_moment));
        var minutes  = duration.asMinutes();
        return Math.abs(minutes) < 46;
      });
      var insulin = result[0];
      if (insulin != undefined) {
        var i_date = moment(insulin.timestamp);
        treatment.eventType = 'Meal Bolus';
        treatment.eventTime = new Date(i_date).toISOString();
        treatment.insulin   = insulin.value;
        treatment.preBolus  = moment.duration(moment(f_date).diff(moment(i_date))).asMinutes();
      } else {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Carb Correction';
        treatment.eventTime = new Date(f_date).toISOString();
      }
      treatment.carbs = element.carbs;
      treatments.push(treatment);
    });
  }
  if (insulins) {
    insulins.forEach(function(element) {
      var treatment = {};
      var f_date   = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime() + timestampDelta - 45*60000);
      var now      = moment(f_date);
      var end      = moment(f_s_date);
      var duration = moment.duration(now.diff(end));
      var minutes  = duration.asMinutes();
      var i_date = new Date();
      var result = foods.filter(function(el) {
        i_date = new Date(el.timestamp);
        var i_moment = moment(i_date);
        var duration = moment.duration(now.diff(i_moment));
        var minutes  = duration.asMinutes();
        return Math.abs(minutes) < 46;
      });
      if (result[0] == undefined) {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Correction Bolus';
        treatment.eventTime = new Date(f_date).toISOString();
        treatment.insulin   = element.value;
        treatments.push(treatment);
      }
    });
  }
  // v2 pumpBoluses (normalBoluses) -> Meal Bolus
  // v2 pumpBoluses (normalBoluses) -> Meal Bolus
  // pumpTimestamp is stored as local time with +00:00 marker - apply timestampDelta to correct.
  if (pumpBoluses) {
    pumpBoluses.forEach(function(element) {
      var treatment       = {};
      var ts              = new Date(new Date(element.pumpTimestamp).getTime() + timestampDelta).toISOString();
      treatment.eventType = 'Meal Bolus';
      treatment.eventTime = ts;
      treatment.insulin   = element.insulinDelivered;
      treatment.carbs     = element.carbsInput;
      treatments.push(treatment);
      console.log('GLOOKO Bolus:', ts,
        '| insulin:', element.insulinDelivered, 'U',
        '| carbs:', element.carbsInput, 'g');
    });
  }
  // v2 scheduledBasals -> Temp Basal (Medtronic, Ypsopump etc.)
  // pumpTimestamp is local time stamped as UTC - apply timestampDelta to correct.
  if (scheduledBasals) {
    scheduledBasals.forEach(function(element) {
      var treatment        = {};
      var ts               = new Date(new Date(element.pumpTimestamp).getTime() + timestampDelta).toISOString();
      treatment.eventType  = 'Temp Basal';
      treatment.created_at = ts;
      treatment.rate       = element.rate;
      treatment.absolute   = element.rate;
      treatment.duration   = element.duration / 60;
      treatments.push(treatment);
      console.log('GLOOKO Basal:', ts,
        '| rate:', element.rate, 'U/h',
        '| duration:', Math.round(element.duration / 60), 'min');
    });
  }
  // v3 basalBarAutomated -> Temp Basal (Omnipod 5 etc.)
  // v3 timestamps are real UTC - no offset needed
  if (cgmSeriesV3 && cgmSeriesV3.basalBarAutomated) {
    var basalTreatments = v3BasalToTreatments(cgmSeriesV3.basalBarAutomated);
    basalTreatments.forEach(function(t) { treatments.push(t); });
  }
  console.log('GLOOKO data transformation complete, returning', treatments.length, 'treatments');
  return treatments;
}
module.exports.generate_nightscout_treatments = generate_nightscout_treatments;
