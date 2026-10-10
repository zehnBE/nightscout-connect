/*
* smoke.js - run the rightest source in isolation against the real API.
*
* Usage (von Hand lokal gegen den TW-Testpatient):
*   export CONNECT_RIGHTEST_REFRESH_TOKEN="$(cat ~/Downloads/rights-tw.token)"
*   export CONNECT_RIGHTEST_SHARE_LINK='https://s.rightest.com/vezehd3'
*   node smoke.js
*
* Erwartete Ausgabe:
*   - AUTH: refresh OK, expires_in 86400
*   - SESSION: share-link decoded + patient confirmed
*   - DATA:  N rows  (0..15 je nach Zeitpunkt)
*   - transform: N entries  (sgv/direction/dateString/_rightestIndex)
*
* Exit 0 bei Erfolg, 1 bei Fehler.
*/
var axios  = require('axios');
var source = require('./index');

var config = {
  rightestRefreshToken: process.env.CONNECT_RIGHTEST_REFRESH_TOKEN,
  rightestShareLink:    process.env.CONNECT_RIGHTEST_SHARE_LINK,
  rightestRegion:       process.env.CONNECT_RIGHTEST_REGION || 'TW',
};

var v = source.validate(config);
if (!v.ok) {
  console.log('VALIDATE FAIL:', v.errors.map(function (e) { return e.desc; }));
  process.exit(1);
}

var impl = source(v.config, axios);

impl.authFromCredentials()
  .then(function (auth) {
    console.log('AUTH OK:', { uid: auth.uid, userName: auth.userName, expiresIn: auth.expiresIn });
    return impl.sessionFromAuth(auth);
  })
  .then(function (session) {
    console.log('SESSION OK:', { patientUid: session.patientUid, patientName: session.patientName });
    return impl.dataFromSesssion(session, null);
  })
  .then(function (payload) {
    console.log('DATA OK: rows=' + (payload.cgm_rows || []).length +
                '  session=' + payload.session_meta.id +
                '  tz=' + payload.session_meta.timeZone);
    var out = impl.transformData(payload, null);
    console.log('TRANSFORM: entries=' + out.entries.length);
    if (out.entries.length) {
      var f = out.entries[0], l = out.entries[out.entries.length - 1];
      console.log('  first:', f.sgv, 'mg/dL', f.direction, 'at', f.dateString, 'idx=' + f._rightestIndex);
      console.log('  last: ', l.sgv, 'mg/dL', l.direction, 'at', l.dateString, 'idx=' + l._rightestIndex);
    }
    process.exit(0);
  })
  .catch(function (err) {
    console.log('SMOKE FAIL:', err.message);
    if (err.response) console.log('  response:', JSON.stringify(err.response.data));
    process.exit(1);
  });
