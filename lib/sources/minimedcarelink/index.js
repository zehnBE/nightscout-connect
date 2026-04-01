/*
 * Medtronic CareLink connector fuer nightscout-connect
 *
 * Auth0-Flow basierend auf domien-f/carelink-bridge (MIT)
 *
 * Env-Vars (CONNECT_  camelCase):
 *   CONNECT_SOURCE=minimedcarelink
 *   CONNECT_CARELINK_USERNAME=...         input.carelinkUsername
 *   CONNECT_CARELINK_PASSWORD=...         input.carelinkPassword
 *   CONNECT_CARELINK_REGION=eu|us         input.carelinkRegion   (default: eu)
 *   CONNECT_CARELINK_COUNTRY=de           input.carelinkCountry  (default: gb)
 *   CONNECT_CARELINK_PATIENT_USERNAME=    input.carelinkPatientUsername (optional)
 */

'use strict';

var fs     = require('fs');
var crypto = require('crypto');
var qs     = require('qs');
var helper = require('./convert');

//  Discovery

function discoveryUrl(region)
{
  return region === 'us'
    ? 'https://clcloud.minimed.com/connect/carepartner/v13/discover/android/3.6'
    : 'https://clcloud.minimed.eu/connect/carepartner/v13/discover/android/3.6';
}

function serverName(region)
{
  return region === 'us' ? 'carelink.minimed.com' : 'carelink.minimed.eu';
}

//  Hilfsfunktionen

function toBase64Url(buf)
{
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function sha256B64Url(str)
{
  return toBase64Url(crypto.createHash('sha256').update(str).digest());
}

function decodeJwtPayload(token)
{
  try {
    var b64 = token.split('.')[1];
    var pad = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch (e) { return null; }
}

function isTokenExpired(td)
{
  var p = decodeJwtPayload(td.access_token);
  if (!p || !p.exp) { return true; }
  return (p.exp - 60) < (Date.now() / 1000);
}

//  Token-Cache (Datei)

function tokenFilePath(username, region)
{
  var hash = crypto.createHash('md5')
    .update((username || '') + ':' + (region || '')).digest('hex').substring(0, 8);
  return '/tmp/carelink-auth0-' + hash + '.json';
}

function loadCachedTokens(filePath)
{
  try {
    if (fs.existsSync(filePath)) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  } catch (e) { console.warn('CARELINK: Token-Cache lesen fehlgeschlagen: ' + e.message); }
  return null;
}

function saveCachedTokens(filePath, td)
{
  try { fs.writeFileSync(filePath, JSON.stringify(td, null, 2), 'utf8'); }
  catch (e) { console.warn('CARELINK: Token-Cache schreiben fehlgeschlagen: ' + e.message); }
}

//  Auth0 Discovery

function resolveAuth0Config(axios, region)
{
  console.log('CARELINK: Auth0 Discovery fuer region=' + region);
  return axios.get(discoveryUrl(region)).then(function(r) {
    var disc = r.data;
    var cp   = disc.CP.find(function(c) { return c.region.toLowerCase() === region; });
    if (!cp) { throw new Error('CARELINK: kein CP-Config fuer region ' + region); }

    var ssoKey = cp.UseSSOConfiguration || 'Auth0SSOConfiguration';
    var ssoUrl = cp[ssoKey];
    if (!ssoUrl) { throw new Error('CARELINK: kein SSO-Config-URL gefunden (Key: ' + ssoKey + ')'); }

    return axios.get(ssoUrl).then(function(sr) {
      var sso     = sr.data;
      var baseUrl = 'https://' + sso.server.hostname;
      if (sso.server.port && sso.server.port !== 443) { baseUrl += ':' + sso.server.port; }
      if (sso.server.prefix) { baseUrl += '/' + sso.server.prefix; }

      console.log('CARELINK: Auth0 Config OK, client_id=' + sso.client.client_id);
      return { ssoConfig: sso, baseUrl: baseUrl };
    });
  });
}

//  Headless Login (Auth0 HTML-Form)

function headlessLogin(axios, ssoConfig, baseUrl, username, password, codeVerifier, codeChallenge)
{
  console.log('CARELINK: Headless Login fuer ' + username);

  var client    = ssoConfig.client;
  var endpoints = ssoConfig.system_endpoints;
  var authorizeUrl = baseUrl + endpoints.authorization_endpoint_path;

  // Cookie-Verwaltung
  var cookies = {};

  var httpClient = axios.create({
    maxRedirects: 0,
    timeout: 20000,
    validateStatus: function() { return true; },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  httpClient.interceptors.request.use(function(config) {
    var cookieStr = Object.keys(cookies).map(function(k) { return k + '=' + cookies[k]; }).join('; ');
    if (cookieStr) { config.headers['Cookie'] = cookieStr; }
    return config;
  });
  httpClient.interceptors.response.use(function(resp) {
    var sc = resp.headers['set-cookie'];
    if (sc) {
      sc.forEach(function(c) {
        var m = c.match(/^([^=]+)=([^;]*)/);
        if (m) { cookies[m[1]] = m[2]; }
      });
    }
    return resp;
  });

  var authorizeParams = {
    client_id:             client.client_id,
    response_type:         'code',
    scope:                 client.scope,
    audience:              client.audience,
    redirect_uri:          client.redirect_uri,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
    state:                 toBase64Url(crypto.randomBytes(16))
  };

  var auth0Origin = new URL(authorizeUrl).origin;
  var loginPageUrl = '';

  return httpClient.get(authorizeUrl + '?' + qs.stringify(authorizeParams))
    .then(function followRedirects(resp) {
      var iteration = 0;
      function follow(r) {
        iteration++;
        if (iteration > 10) { return r; }
        if (r.status >= 300 && r.status < 400 && r.headers['location']) {
          var loc = r.headers['location'];
          var next = loc.startsWith('/') ? auth0Origin + loc : loc;
          auth0Origin  = new URL(next).origin;
          loginPageUrl = next;
          return httpClient.get(next).then(follow);
        }
        return r;
      }
      return follow(resp);
    })
    .then(function(resp) {
      if (resp.status !== 200 || typeof resp.data !== 'string') {
        throw new Error('CARELINK: Auth0 Login-Seite nicht erreichbar (HTTP ' + resp.status + ')');
      }

      var html    = resp.data;
      var hidden  = {};
      var hdRegex = /<input[^>]+type=["']hidden["'][^>]*>/gi;
      var match;
      while ((match = hdRegex.exec(html)) !== null) {
        var nm = match[0].match(/name=["']([^"']*)["']/i);
        var vl = match[0].match(/value=["']([^"']*)["']/i);
        if (nm) {
          var val = vl ? vl[1] : '';
          val = val.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          hidden[nm[1]] = val;
        }
      }

      var formMatch = html.match(/<form[^>]*action=["']([^"']*)["']/i);
      var rawAction = formMatch ? formMatch[1] : null;
      if (rawAction) {
        rawAction = rawAction.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      }
      var postUrl = rawAction
        ? (rawAction.startsWith('/') ? auth0Origin + rawAction : rawAction)
        : loginPageUrl;

      console.log('CARELINK: Form-Action=' + postUrl);
      console.log('CARELINK: Hidden-Fields=' + Object.keys(hidden).join(','));

      if (Object.prototype.hasOwnProperty.call(hidden, 'captcha')) {
        throw new Error('CARELINK: Captcha-Pflichtfeld in Login-Form  headless nicht moeglich');
      }

      console.log('CARELINK: Sende Credentials an Auth0');
      return httpClient.post(postUrl, qs.stringify(Object.assign({}, hidden, {
        username: username,
        password: password,
        action:   'default'
      })), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    })
    .then(function(resp) {
      console.log('CARELINK: Credentials-POST Status=' + resp.status);

      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        var body = typeof resp.data === 'string'
          ? resp.data.substring(0, 500)
          : JSON.stringify(resp.data).substring(0, 500);
        console.log('CARELINK: Credentials-POST Fehler-Body=' + body);
        throw new Error('CARELINK: Credentials-POST HTTP-' + resp.status);
      }

      if (resp.status === 200 && typeof resp.data === 'string') {
        if (resp.data.indexOf('Wrong username or password') !== -1 ||
            resp.data.indexOf('wrong-credentials') !== -1) {
          throw new Error('CARELINK: Falscher Benutzername oder Passwort');
        }
        if (resp.data.indexOf('captcha') !== -1 || resp.data.indexOf('arkose') !== -1) {
          throw new Error('CARELINK: Captcha erkannt  standalone Docker (domien-f/carelink-bridge) verwenden');
        }
      }

      var code = null;
      var iteration = 0;

      function extractCode(resp2) {
        iteration++;
        if (iteration > 15 || code) { return resp2; }
        var loc = resp2.headers['location'] || '';
        var m   = loc.match(/[?&]code=([^&]+)/);
        if (m) { code = m[1]; return resp2; }

        if (loc && !loc.startsWith('http')) {
          var m2 = loc.match(/code=([^&]+)/);
          if (m2) { code = m2[1]; return resp2; }
        }

        if (resp2.status >= 300 && resp2.status < 400 && loc) {
          var next = loc.startsWith('/') ? auth0Origin + loc : loc;
          if (next.startsWith('http')) {
            return httpClient.get(next).then(extractCode);
          }
        }
        return resp2;
      }

      return extractCode(resp).then(function() {
        if (!code) {
          throw new Error('CARELINK: Kein Auth-Code in Redirect-Kette');
        }
        return code;
      });
    })
    .then(function(code) {
      console.log('CARELINK: Auth-Code erhalten, tausche gegen Token');
      var tokenUrl = baseUrl + ssoConfig.system_endpoints.token_endpoint_path;

      return axios.post(tokenUrl, qs.stringify({
        grant_type:    'authorization_code',
        client_id:     client.client_id,
        code:          code,
        redirect_uri:  client.redirect_uri,
        code_verifier: codeVerifier
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      .then(function(tr) {
        if (!tr.data || !tr.data.access_token) {
          throw new Error('CARELINK: Token-Antwort ungueltig HTTP-' + tr.status);
        }
        var td = {
          access_token:  tr.data.access_token,
          refresh_token: tr.data.refresh_token,
          scope:         tr.data.scope || client.scope,
          client_id:     client.client_id,
          token_url:     tokenUrl,
          audience:      client.audience
        };
        console.log('CARELINK: Login erfolgreich');
        return td;
      });
    });
}

//  Token-Refresh

function doRefreshToken(axios, td)
{
  console.log('CARELINK: Token-Refresh td=', JSON.stringify({url:td.token_url,client:td.client_id,hasRefresh:!!td.refresh_token,audience:td.audience}));
  return axios.post(td.token_url, qs.stringify({
    grant_type:    'refresh_token',
    client_id:     td.client_id,
    refresh_token: td.refresh_token,
    audience:      td.audience
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
  .then(function(r) {
    if (!r.data || !r.data.access_token) {
      throw new Error('CARELINK: Refresh fehlgeschlagen HTTP-' + r.status);
    }
    td.access_token  = r.data.access_token;
    if (r.data.refresh_token) {
      td.refresh_token = r.data.refresh_token;
      console.log('CARELINK: Token erneuert OK, neuer refresh_token gespeichert');
    } else {
      console.log('CARELINK: Token erneuert OK, refresh_token unveraendert');
    }
    if (td.tokenCallbackUrl) {
      axios.post(td.tokenCallbackUrl, {
        access_token:  td.access_token,
        refresh_token: td.refresh_token
      }).then(function() {
        console.log('CARELINK: Token-Callback OK');
      }).catch(function(e) {
        console.warn('CARELINK: Token-Callback fehlgeschlagen: ' + e.message);
      });
    }
    return td;
  });
}

//  CareLink Daten-API

function buildUrls(srvName, country)
{
  var base = 'https://' + srvName;
  return {
    me:              base + '/patient/users/me',
    countrySettings: base + '/patient/countries/settings?countryCode=' + country + '&language=en',
    monitorData:     base + '/patient/monitor/data',
    connectData:     function(ts) { return base + '/patient/connect/data?cpSerialNumber=NONE&msgType=last24hours&requestTime=' + ts; },
    linkedPatients:  base + '/patient/m2m/links/patients'
  };
}

//  Validation

function validate_inputs(input)
{
  var ok     = false;
  var errors = [];

  var config = {
    carelinkUsername:        input.carelinkUsername,
    carelinkPassword:        input.carelinkPassword,
    carelinkRegion:          (input.carelinkRegion  || 'eu').toLowerCase(),
    carelinkCountry:         (input.carelinkCountry || 'gb').toLowerCase(),
    carelinkPatientUsername: input.carelinkPatientUsername || null,
    carelinkTokenFile:       input.carelinkTokenFile || null,
    carelinkTokenCallbackUrl: (function() {
      var ns  = (input.nightscoutEndpoint || '').match(/https?:\/\/([^.]+)\.ns\.10be\.de/);
      var sec = input.apiSecret || '';
      if (ns && ns[1] && sec) {
        return 'https://ns.10be.de/de/profile/carelink-token-update.php'
          + '?id=' + ns[1] + '&secret=' + encodeURIComponent(sec);
      }
      return null;
    })(),
    kind:                    'minimedcarelink'
  };

  if (!config.carelinkUsername && !input.carelinkAccessToken) {
    errors.push({ desc: 'CONNECT_CARELINK_USERNAME oder CONNECT_CARELINK_ACCESS_TOKEN muss gesetzt sein.', err: new Error('CONNECT_CARELINK_USERNAME') });
  }
  if (!config.carelinkPassword && !input.carelinkAccessToken) {
    errors.push({ desc: 'CONNECT_CARELINK_PASSWORD oder CONNECT_CARELINK_ACCESS_TOKEN muss gesetzt sein.', err: new Error('CONNECT_CARELINK_PASSWORD') });
  }

  ok          = errors.length === 0;
  config.kind = ok ? 'minimedcarelink' : 'disabled';
  return { ok: ok, errors: errors, config: config };
}

//  Hauptfunktion

function minimedCarelinkSource(opts, axios)
{
  var tokenFile = opts.carelinkTokenFile || tokenFilePath(opts.carelinkUsername, opts.carelinkRegion);
  console.log('CARELINK: Token-Datei = ' + tokenFile);
  var srv       = serverName(opts.carelinkRegion);
  var urls      = buildUrls(srv, opts.carelinkCountry);

  var defaultHeaders = {
    'Accept':          'application/json, text/plain, */*',
    'Content-Type':    'application/json',
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  function authAxios(td)
  {
    return axios.create({
      headers: Object.assign({}, defaultHeaders, {
        'Authorization': 'Bearer ' + td.access_token
      }),
      timeout: 15000
    });
  }

  var impl = {

    authFromCredentials: function()
    {
      var region = opts.carelinkRegion;

      var envToken = process.env['CONNECT_CARELINK_ACCESS_TOKEN'];
      if (envToken && !fs.existsSync(tokenFile)) {
        var td = {
          access_token:  envToken,
          refresh_token: process.env['CONNECT_CARELINK_REFRESH_TOKEN'] || '',
          scope:         'openid profile email offline_access',
          client_id:     'PeAhkbhQWlQRxJiQxWfcFBiGus1lxfe9',
          token_url:     'https://mdt-cl-ous-prod1.medtronic-eu.auth0app.com/oauth/token',
          audience:      'personal.patient.ous'
        };
        saveCachedTokens(tokenFile, td);
        console.log('CARELINK: Token aus ENV geschrieben nach ' + tokenFile);
      }

      var cached = loadCachedTokens(tokenFile);

      if (cached && !isTokenExpired(cached)) {
        console.log('CARELINK: gecachten Token verwende');
        return resolveAuth0Config(axios, region).then(function(auth0) {
          return { tokenData: cached, auth0: auth0 };
        });
      }

      return resolveAuth0Config(axios, region).then(function(auth0) {
        var client    = auth0.ssoConfig.client;
        var endpoints = auth0.ssoConfig.system_endpoints;

        var authCode = process.env['CONNECT_CARELINK_AUTH_CODE'];
        if (authCode) {
          console.log('CARELINK: CONNECT_CARELINK_AUTH_CODE gesetzt, tausche gegen Token');
          var tokenUrl = auth0.baseUrl + endpoints.token_endpoint_path;
          var cv       = process.env['CONNECT_CARELINK_CODE_VERIFIER'] || '';
          return axios.post(tokenUrl, qs.stringify({
            grant_type:    'authorization_code',
            client_id:     client.client_id,
            code:          authCode,
            redirect_uri:  client.redirect_uri,
            code_verifier: cv
          }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
          .then(function(tr) {
            if (!tr.data || !tr.data.access_token) {
              throw new Error('CARELINK: Code-Exchange fehlgeschlagen HTTP-' + tr.status + ' (Code abgelaufen? Neu generieren)');
            }
            var td = {
              access_token:  tr.data.access_token,
              refresh_token: tr.data.refresh_token,
              scope:         tr.data.scope || client.scope,
              client_id:     client.client_id,
              token_url:     tokenUrl,
              audience:      client.audience
            };
            saveCachedTokens(tokenFile, td);
            console.log('CARELINK: Token via AUTH_CODE OK  CONNECT_CARELINK_AUTH_CODE aus compose.yml entfernen!');
            return { tokenData: td, auth0: auth0 };
          });
        }

        if (cached && cached.refresh_token) {
          return doRefreshToken(axios, cached)
            .then(function(td) { saveCachedTokens(tokenFile, td); return { tokenData: td, auth0: auth0 }; })
            .catch(function(err) {
              console.error('CARELINK_AUTH_ERROR: LOGIN_NEEDS_REFRESH  Refresh fehlgeschlagen (' + err.message + ')');
              throw new Error('CARELINK_AUTH_ERROR: LOGIN_NEEDS_REFRESH  Token abgelaufen, bitte Setup-Seite aufrufen');
            });
        }

        return doLogin(axios, auth0, opts.carelinkUsername, opts.carelinkPassword)
          .catch(function(err) {
            var msg = err.message || '';
            var isCaptcha = msg.indexOf('Captcha') !== -1 || msg.indexOf('captcha') !== -1 || msg.indexOf('HTTP-400') !== -1;
            var isWrongCredentials = msg.indexOf('Falscher Benutzername') !== -1 || msg.indexOf('Invalid username') !== -1;

            if (isWrongCredentials) {
              console.error('CARELINK_AUTH_ERROR: INVALID_CREDENTIALS');
              throw new Error('CARELINK_AUTH_ERROR: INVALID_CREDENTIALS  Benutzername oder Passwort falsch');
            }
            if (isCaptcha) {
              console.error('CARELINK_AUTH_ERROR: LOGIN_NEEDS_REFRESH');
              console.log('CARELINK: Browser-Login erforderlich (Captcha). Setup-Seite aufrufen.');
              throw new Error('CARELINK_AUTH_ERROR: LOGIN_NEEDS_REFRESH  Browser-Login erforderlich, bitte Setup-Seite aufrufen');
            }

            console.error('CARELINK_AUTH_ERROR: LOGIN_FAILED  ' + msg);
            throw new Error('CARELINK_AUTH_ERROR: LOGIN_FAILED  ' + msg);
          })
          .then(function(td) { saveCachedTokens(tokenFile, td); return { tokenData: td, auth0: auth0 }; });
      });
    },

    sessionFromAuth: function(auth) { return Promise.resolve(auth); },

    dataFromSesssion: function(session, last_known)
    {
      var td  = session.tokenData;
      td.tokenCallbackUrl = opts.carelinkTokenCallbackUrl || null;
      var axs = authAxios(td);

      var tokenPromise = isTokenExpired(td)
        ? doRefreshToken(axios, td).then(function(ntd) {
            saveCachedTokens(tokenFile, ntd);
            session.tokenData = ntd;
            return authAxios(ntd);
          }).catch(function(err) {
            console.error('CARELINK_AUTH_ERROR: TOKEN_EXPIRED  ' + err.message);
            throw new Error('CARELINK_AUTH_ERROR: TOKEN_EXPIRED  Token abgelaufen, bitte Setup-Seite aufrufen');
          })
        : Promise.resolve(axs);

      return tokenPromise.then(function(axs) {
        return axs.get(urls.me).then(function(r) {
          var user = r.data;
          var role = (user.role || '').toUpperCase();
          console.log('CARELINK: role=' + role);

          if (role === 'CARE_PARTNER' || role === 'CARE_PARTNER_OUS') {
            return impl._fetchAsCarepartner(axs, user);
          }
          return impl._fetchAsPatient(axs, user, td);
        });
      });
    },

    _fetchAsCarepartner: function(axs, user)
    {
      var patientUsername = opts.carelinkPatientUsername;

      return axs.get(urls.linkedPatients).then(function(r) {
        var patients = r.data || [];
        if (!patients.length) { throw new Error('CARELINK: keine verlinkten Patienten'); }

        var patient = patientUsername
          ? (patients.find(function(p) { return p.username === patientUsername; }) || patients[0])
          : patients[0];

        var patientId = patient.username || patient.patientId;

        return axs.get(urls.countrySettings).then(function(sr) {
          var bleEndpoint = sr.data && sr.data.blePereodicDataEndpoint;

          var body = {
            username:  user.username || opts.carelinkUsername,
            role:      'carepartner',
            patientId: patientId
          };

          if (bleEndpoint) {
            console.log('CARELINK: BLE-Endpoint (carepartner): ' + bleEndpoint);
            var endpoints = [
              bleEndpoint,
              bleEndpoint.replace('/v6/', '/v5/'),
              bleEndpoint.replace('/v6/', '/v11/'),
              bleEndpoint.replace('/v5/', '/v6/'),
            ].filter(function(v, i, a) { return a.indexOf(v) === i; });

            return endpoints.reduce(function(chain, ep) {
              return chain.catch(function() {
                console.log('CARELINK: versuche ' + ep);
                return axs.post(ep, body).then(function(r) {
                  if (!r.data || Object.keys(r.data).length < 2) {
                    throw new Error('leere Antwort');
                  }
                  return r.data;
                });
              });
            }, Promise.reject(new Error('start')));
          }

          throw new Error('CARELINK: kein blePereodicDataEndpoint in Country-Settings');
        });
      });
    },

    _fetchAsPatient: function(axs, user, td)
    {
      var userCountry = (user && user.country) ? user.country.toLowerCase() : opts.carelinkCountry;
      var countrySettingsUrl = 'https://' + serverName(opts.carelinkRegion)
        + '/patient/countries/settings?countryCode=' + userCountry + '&language=en';

      var jwtPayload = decodeJwtPayload(td.access_token);
      var username   = (jwtPayload && jwtPayload.token_details && jwtPayload.token_details.preferred_username)
        || opts.carelinkUsername;
      console.log('CARELINK: BLE username=' + username + ' country=' + userCountry);

      return axs.get(urls.monitorData, { validateStatus: function() { return true; } })
        .then(function(r) {
          console.log('CARELINK: monitorData HTTP=' + r.status + ' keys=' + (r.data ? Object.keys(r.data).length : 0));
          if (r.status === 200 && r.data && Object.keys(r.data).length > 1) {
            console.log('CARELINK: Daten via monitorData, medicalDeviceFamily=' + (r.data.medicalDeviceFamily || 'n/a'));
            return r.data;
          }
          if (r.status !== 200) {
            console.log('CARELINK: monitorData Fehler HTTP=' + r.status);
          } else {
            console.log('CARELINK: monitorData leer: ' + JSON.stringify(r.data).substring(0, 200));
          }
          throw new Error('monitorData nicht verwendbar');
        })
        .catch(function() {
          console.log('CARELINK: hole Country-Settings fuer BLE-Endpoint, country=' + userCountry);
          return axs.get(countrySettingsUrl, { validateStatus: function() { return true; } })
            .then(function(sr) {
              var bleEndpoint = sr.data && sr.data.blePereodicDataEndpoint;
              console.log('CARELINK: countrySettings HTTP=' + sr.status + ' bleEndpoint=' + (bleEndpoint || 'nicht gefunden'));

              if (bleEndpoint) {
                var body = {
                  username:  username,
                  role:      'patient',
                  patientId: user && user.id
                };
                console.log('CARELINK: BLE-Endpoint (patient): ' + bleEndpoint);

                var endpoints = [
                  bleEndpoint,
                  bleEndpoint.replace('/v6/', '/v5/'),
                  bleEndpoint.replace('/v6/', '/v11/'),
                  bleEndpoint.replace('/v5/', '/v6/'),
                ].filter(function(v, i, a) { return a.indexOf(v) === i; });

                return endpoints.reduce(function(chain, ep) {
                  return chain.catch(function(prevErr) {
                    if (prevErr && prevErr.message === 'BLE_NO_DATA') {
                      return Promise.reject(prevErr);
                    }
                    console.log('CARELINK: versuche BLE ' + ep);
                    return axs.post(ep, body, {
                      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
                      validateStatus: function() { return true; }
                    }).then(function(r) {
                      console.log('CARELINK: BLE POST HTTP=' + r.status + ' keys=' + (r.data ? Object.keys(r.data).length : 0));
                      if (r.status === 204) {
                        console.log('CARELINK: BLE 204 No Content  Pumpe hat gerade keine Daten');
                        var noData = new Error('BLE_NO_DATA');
                        noData.isNoData = true;
                        throw noData;
                      }
                      if (r.status === 200 && r.data && Object.keys(r.data).length > 1) {
                        return r.data;
                      }
                      console.log('CARELINK: BLE Fehler-Body=' + JSON.stringify(r.data).substring(0, 200));
                      throw new Error('BLE HTTP-' + r.status);
                    });
                  });
                }, Promise.reject(new Error('start')))
                .catch(function(err) {
                  if (err && err.isNoData) {
                    console.log('CARELINK: keine aktuellen Daten verfuegbar, naechster Versuch in 15min');
                    return new Promise(function(resolve) {
                      setTimeout(function() { resolve({}); }, 15 * 60 * 1000);
                    });
                  }
                  throw err;
                });
              }

              var url = urls.connectData(Date.now());
              console.log('CARELINK: Fallback auf connectData: ' + url);
              return axs.get(url, { validateStatus: function() { return true; } })
                .then(function(r) {
                  console.log('CARELINK: connectData HTTP=' + r.status);
                  if (r.status !== 200) {
                    console.log('CARELINK: connectData Fehler=' + JSON.stringify(r.data).substring(0, 200));
                    throw new Error('connectData HTTP-' + r.status);
                  }
                  return r.data;
                });
            });
        });
    },

    align_to_glucose: function() { /* TODO */ },

    transformData: function(batch)
    {
      console.log('CARELINK: transformiere Daten');
      return helper.toNightscout(batch);
    }
  };

  function tracker_for()
  {
    var AxiosTracer = require('../../trace-axios');
    return AxiosTracer(axios);
  }

  function generate_driver(builder)
  {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize:    impl.sessionFromAuth,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: (1000 * 60 * 60 * 23),
        EXPIRE_SESSION_DELAY:          1000 * 60 * 60 * 24
      }
    });

    builder.register_loop('CareLink', {
      tracker: tracker_for,
      frame: {
        impl:           impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform:      impl.transformData,
        backoff: { interval_ms: 2.5 * 60 * 1000 },
        maxRetries: 1
      },
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: { interval_ms: 2.5 * 60 * 1000 }
    });

    return builder;
  }

  impl.generate_driver = generate_driver;
  return impl;
}

function doLogin(axios, auth0, username, password)
{
  var codeVerifier  = toBase64Url(crypto.randomBytes(32));
  var codeChallenge = sha256B64Url(codeVerifier);
  return headlessLogin(axios, auth0.ssoConfig, auth0.baseUrl, username, password, codeVerifier, codeChallenge);
}

minimedCarelinkSource.validate = validate_inputs;

module.exports = minimedCarelinkSource;
