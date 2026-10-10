/*
* lib/sources/rightest/convert.js
* Rightest/Bionime CGM -> Nightscout entry transform
*
* v0.1 (2026-10-09)
*   - initial implementation modelled after glooko/convert.js
*   - timestamps computed from session.start_date + index * 60s in session TZ
*   - trend tag mapping: Rightest uses int (-3..+3) similar to Nightscout slope arrows
*
* v0.7 (2026-10-10)
*   - BUGFIX: Rightest API returns UTC timestamps, NOT device-local time.
*     The time_zone field (Asia/Taipei, etc.) is sensor-location metadata
*     and does NOT describe the timestamp format. Verified via measure-session
*     last_upload_date vs HTTP capture time: delta is seconds, not 8h.
*   - parseRightestDate now interprets input as UTC directly. tz param kept
*     for backward-compat but ignored.
*/

// Rightest trend_tag (per Dart RE):
//   -3 falling fast, -2 falling, -1 falling slow, 0 flat, +1 rising slow, +2 rising, +3 rising fast
// Map to Nightscout direction strings (same semantics as Dexcom).
function mapTrend (t) {
  switch (t) {
    case -3: return 'DoubleDown';
    case -2: return 'SingleDown';
    case -1: return 'FortyFiveDown';
    case  0: return 'Flat';
    case  1: return 'FortyFiveUp';
    case  2: return 'SingleUp';
    case  3: return 'DoubleUp';
    default: return 'NOT COMPUTABLE';
  }
}

// Rightest trend_tag -> integer "direction" used in some Nightscout clients
function trendToDirection (t) {
  switch (t) {
    case -3: return 7;
    case -2: return 6;
    case -1: return 5;
    case  0: return 4;
    case  1: return 3;
    case  2: return 2;
    case  3: return 1;
    default: return 0;
  }
}

// Parse Rightest datetime string "YYYYMMDDHHMMSS".
// v0.7: Rightest API returns UTC - the `tz` arg is kept for API-stability but
// no longer applied. (Previously we subtracted the device-TZ offset, which
// shifted entries by whole-hour amounts, e.g. 8h for Asia/Taipei.)
function parseRightestDate (s, _tz) {
  if (!s || s.length < 14) return null;
  var yyyy = s.substr(0,  4);
  var mo   = s.substr(4,  2);
  var dd   = s.substr(6,  2);
  var hh   = s.substr(8,  2);
  var mm   = s.substr(10, 2);
  var ss   = s.substr(12, 2);
  return Date.UTC(+yyyy, +mo - 1, +dd, +hh, +mm, +ss);
}

/*
* Produce Nightscout entries from a Rightest cgm-data response.
*
*  sessionMeta: { id, startDate: "YYYYMMDDHHMMSS", timeZone, deviceModel, sensorSerial }
*  cgmRows:     array of { index, cgm_glucose_value, trend_tag, battery_voltage, temperature, ... }
*
* Returns [{ sgv, direction, trend, type, date, dateString, device, ... }]
*/
function toNightscoutEntries (sessionMeta, cgmRows) {
  if (!cgmRows || cgmRows.length === 0) return [];
  var startEpochMs = parseRightestDate(sessionMeta.startDate, sessionMeta.timeZone);
  if (!startEpochMs) return [];
  var deviceLabel = ['rightest', sessionMeta.sensorSerial || sessionMeta.deviceModel || '']
    .filter(Boolean).join(' ').trim();

  return cgmRows.map(function (r) {
    // Each index is one minute after session.startDate (confirmed via
    // warm_up_finish_index=121 at 2h warmup).
    var dateMs = startEpochMs + (r.index * 60 * 1000);
    return {
      sgv:         r.cgm_glucose_value,
      direction:   mapTrend(r.trend_tag),
      trend:       trendToDirection(r.trend_tag),
      type:        'sgv',
      date:        dateMs,
      dateString:  new Date(dateMs).toISOString(),
      device:      deviceLabel,
      // Keep Rightest's own index so later diffs can resume from here.
      _rightestIndex:  r.index,
      _rightestAlert:  r.alert_tag,
      _rightestSensor: r.sensor_error,
    };
  });
}

module.exports = {
  toNightscoutEntries: toNightscoutEntries,
  parseRightestDate:   parseRightestDate,
  mapTrend:            mapTrend,
};
