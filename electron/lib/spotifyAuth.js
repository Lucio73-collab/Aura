/* spotifyAuth.js - Authorization Code with PKCE, no client secret.
   Runs entirely in the main process. The renderer never sees a token; it
   only ever gets status() back over IPC. Refresh token is encrypted at
   rest with Electron's safeStorage (DPAPI on Windows); the access token
   lives in memory only. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { shell, safeStorage } = require('electron');

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

// Only what Aura actually asks the user to grant per the brief - no
// following/follower scopes, no episode/show scopes, nothing unused.
const SCOPES = [
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'user-read-recently-played', 'user-top-read',
  'user-library-read', 'user-library-modify',
  'playlist-read-private', 'playlist-modify-private', 'playlist-modify-public'
].join(' ');

let clientId = '';
let clientIdFile = null;
let tokenFile = null;
let accountFile = null;
let inFlightServer = null;
let pendingReject = null;

let access = { token: null, expiresAt: 0 };
let refreshToken = null;
let account = { displayName: null, accountId: null, userId: null, connectedAt: null };
let refreshLock = null; // single-flight promise so concurrent calls never race a refresh
let needsReauth = false;

const listeners = new Set();
const emit = () => { for (const fn of listeners) { try { fn(status()); } catch {} } };

function b64url(buf) { return buf.toString('base64url'); }

// Checked in order: whatever was saved from inside Aura (userData, always
// writable, works in a packaged build) first, then spotify.config.json next
// to the app (dev-only convenience - that path sits inside the asar once
// packaged, which is read-only, so it can never be the write target).
function loadClientId() {
  try {
    clientId = (JSON.parse(fs.readFileSync(clientIdFile, 'utf8')).clientId || '').trim();
    if (clientId) return;
  } catch {}
  try {
    const p = path.join(__dirname, '..', '..', 'spotify.config.json');
    clientId = (JSON.parse(fs.readFileSync(p, 'utf8')).clientId || '').trim();
  } catch { clientId = ''; }
}

function setClientId(id) {
  const trimmed = (id || '').trim();
  if (!trimmed) { const e = new Error('Client ID cannot be empty'); e.code = 'EMPTY_CLIENT_ID'; throw e; }
  clientId = trimmed;
  try { fs.writeFileSync(clientIdFile, JSON.stringify({ clientId: trimmed })); }
  catch (e) { console.warn('spotify: could not persist client id:', e.message); }
  emit();
  return status();
}

function readAccount() {
  try { account = { ...account, ...JSON.parse(fs.readFileSync(accountFile, 'utf8')) }; } catch {}
}
function writeAccount() { try { fs.writeFileSync(accountFile, JSON.stringify(account)); } catch {} }

function readRefreshToken() {
  try {
    const buf = fs.readFileSync(tokenFile);
    if (!buf.length) return null;
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch { return null; }
}
function writeRefreshToken(token) {
  try {
    const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8');
    fs.writeFileSync(tokenFile, buf);
  } catch (e) { console.warn('spotify: could not persist refresh token:', e.message); }
}
function clearRefreshToken() { try { fs.unlinkSync(tokenFile); } catch {} }

function init(store) {
  tokenFile = path.join(store.dir(), 'spotify-token.bin');
  accountFile = path.join(store.dir(), 'spotify-account.json');
  clientIdFile = path.join(store.dir(), 'spotify-client.json');
  loadClientId();
  readAccount();
  refreshToken = readRefreshToken();
  if (refreshToken) needsReauth = false;
}

function configured() { return !!clientId; }
function isConnected() { return !!refreshToken; }

function status() {
  return {
    configured: configured(),
    clientId, // not secret in a PKCE flow - fine to hand back for the Settings input
    connected: isConnected(),
    needsReauth,
    displayName: account.displayName,
    userId: account.userId || null,
    connectedAt: account.connectedAt
  };
}

function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/* ---------- PKCE login ---------- */

function login() {
  return new Promise((resolve, reject) => {
    if (!configured()) return reject(codedError('NO_CLIENT_ID', 'Add a Spotify Client ID first'));
    // A second click while the browser tab is still open restarts the flow
    // instead of failing forever until the 5 minute timeout.
    if (inFlightServer) { closeLoginServer(); if (pendingReject) pendingReject(codedError('LOGIN_RESTARTED', 'Login restarted')); }
    pendingReject = reject;

    const verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = crypto.randomBytes(16).toString('hex');

    const server = http.createServer(async (req, res) => {
      let u;
      try { u = new URL(req.url, REDIRECT_URI); } catch { res.writeHead(400); res.end(); return; }
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

      const gotState = u.searchParams.get('state');
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      const finish = (html, ok, error) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        closeLoginServer();
        if (ok) resolve(true); else reject(error || new Error('LOGIN_FAILED'));
      };

      if (err) return finish(page('Spotify login was cancelled.'), false, codedError('LOGIN_CANCELLED', err));
      if (!code || gotState !== state) return finish(page('Something went wrong. Try connecting again from Aura.'), false, codedError('STATE_MISMATCH', 'Login state mismatch'));

      try {
        const tok = await exchangeCode(code, verifier);
        applyTokenResponse(tok);
        await fetchAndStoreProfile();
        finish(page('Spotify connected. You can close this tab and go back to Aura.'), true);
      } catch (e) {
        finish(page('Could not finish connecting Spotify: ' + String(e.message).replace(/[<>&]/g, '')), false, codedError('LOGIN_FAILED', e.message));
      }
    });

    inFlightServer = server;
    server.once('error', e => {
      if (inFlightServer === server) inFlightServer = null;
      reject(e.code === 'EADDRINUSE' ? codedError('PORT_IN_USE', `Port ${REDIRECT_PORT} is already in use by another program`) : e);
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const authUrl = new URL(AUTH_URL);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('scope', SCOPES);
      shell.openExternal(authUrl.toString());
    });

    // Give up if the user never completes the browser flow.
    setTimeout(() => { if (inFlightServer === server) { closeLoginServer(); reject(codedError('LOGIN_TIMEOUT', 'Spotify login timed out')); } }, 5 * 60 * 1000);
  });
}

function closeLoginServer() {
  if (inFlightServer) { try { inFlightServer.close(); } catch {} inFlightServer = null; }
}

function page(msg) {
  return `<!doctype html><html><body style="font-family:system-ui;background:#0c0c10;color:#f5f5f7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p style="max-width:420px;text-align:center">${msg}</p></body></html>`;
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
    client_id: clientId, code_verifier: verifier
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || ('HTTP ' + res.status));
  return json;
}

function applyTokenResponse(tok) {
  access.token = tok.access_token;
  access.expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  // Spotify doesn't always re-issue a refresh token on refresh; only overwrite
  // (and re-persist) when one actually comes back.
  if (tok.refresh_token) { refreshToken = tok.refresh_token; writeRefreshToken(refreshToken); }
  needsReauth = false;
}

async function fetchAndStoreProfile() {
  try {
    const res = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + access.token } });
    if (!res.ok) return;
    const me = await res.json();
    account = { displayName: me.display_name || me.id || 'Spotify account', accountId: me.account_id || me.id, userId: me.id || null, connectedAt: Date.now() };
    writeAccount();
  } catch {}
  emit();
}

/* ---------- refresh ---------- */

const codedError = (code, message) => { const e = new Error(message || code); e.code = code; return e; };

async function refresh() {
  if (!refreshToken) throw codedError('NOT_CONNECTED');
  if (refreshLock) return refreshLock;
  refreshLock = (async () => {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    let res;
    // A network blip is not a reason to drop the session: report it as
    // OFFLINE and keep the refresh token for the next attempt.
    try { res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw codedError('OFFLINE', e.message); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (json.error === 'invalid_grant' || json.error === 'invalid_client') { disconnect(); needsReauth = true; emit(); throw codedError('REAUTH_REQUIRED', json.error_description || json.error); }
      if (res.status >= 500 || res.status === 429) throw codedError('SERVER_ERROR', 'Spotify accounts HTTP ' + res.status);
      throw codedError('REAUTH_REQUIRED', json.error_description || json.error || ('HTTP ' + res.status));
    }
    applyTokenResponse(json);
    emit();
    return access.token;
  })();
  try { return await refreshLock; } finally { refreshLock = null; }
}

/* Ensures a valid access token, refreshing proactively 60s before expiry.
   `force` skips the cache even if Aura's own clock still thinks the token
   is valid - spotify.js passes this on a 401, since Spotify itself is the
   authority on whether a token is still good (revoked elsewhere, clock
   skew...), not the locally computed expiry. Without honoring it here, a
   401 retry just re-sent the exact same stale token, got 401 again, and
   forced a full re-login for something a real refresh would have fixed. */
async function getAccessToken(force) {
  if (!refreshToken) throw codedError('NOT_CONNECTED');
  if (!force && access.token && Date.now() < access.expiresAt - 60000) return access.token;
  return refresh();
}

function disconnect() {
  refreshToken = null;
  access = { token: null, expiresAt: 0 };
  account = { displayName: null, accountId: null, userId: null, connectedAt: null };
  clearRefreshToken();
  writeAccount();
  needsReauth = false;
  emit();
}

module.exports = { init, login, disconnect, getAccessToken, isConnected, configured, setClientId, status, onChange, REDIRECT_URI };
