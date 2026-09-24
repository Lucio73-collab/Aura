/* subsonicSource.js - SubsonicSource: the NAS (Navidrome) as a music source.
   Main process only. Owns: config + credential (safeStorage), which server URL
   is reachable, the on-disk metadata cache, background sync, the authenticated
   stream / cover-art fetches that mediaServer.js proxies to the renderer, the
   scrobble queue, NAS playlists and offline downloads.

   The password never leaves this module: the renderer plays /track/nd%3A<id>
   and /nascover/<id> from the local media server, and this module adds the
   Subsonic auth when it fetches from the NAS.

   Dependencies are injected (store, fetch, secrets) so the whole thing runs
   under plain node in tests. See sources/index.js for the contract. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const sub = require('../subsonic');

const ID_PREFIX = 'nd:';
const PLAYLIST_PREFIX = 'ndpl:';
const CACHE_VERSION = 1;
const COVER_WIDTHS = [128, 256, 400, 640, 1024];
const QUALITY = {
  original: {},
  'mp3-320': { format: 'mp3', maxBitRate: 320 },
  'mp3-192': { format: 'mp3', maxBitRate: 192 },
  'mp3-128': { format: 'mp3', maxBitRate: 128 }
};
const DEFAULT_CONFIG = { enabled: false, servers: [], username: '', authMode: 'password', qualityHome: 'original', qualityAway: 'original' };
const DEFAULT_TIMING = { probeMs: 2500, apiMs: 8000, streamConnectMs: 10000, offlineRetryMs: 10000, onlineCheckMs: 15000, netPollMs: 5000, staleSyncMs: 10 * 60 * 1000, syncEveryMs: 30 * 60 * 1000, syncConcurrency: 4 };

const stripId = id => String(id || '').replace(/^nd:/, '');
const stripPl = id => String(id || '').replace(/^ndpl:/, '');
const safeName = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
const errText = e => sub.maskSecrets((e && e.message) || String(e));
const IMG_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const EXT_TYPE = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function create({ store, dataDir, fetch: fetchImpl, secrets, timing, log } = {}) {
  const T = { ...DEFAULT_TIMING, ...(timing || {}) };
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const say = (...a) => { if (log) log(...a.map(x => sub.maskSecrets(typeof x === 'string' ? x : errText(x)))); };
  dataDir = dataDir || store.dir();
  const files = {
    credential: path.join(dataDir, 'nas-credential.bin'),
    cache: path.join(dataDir, 'nas-library.json'),
    scrobbles: path.join(dataDir, 'nas-scrobbles.json'),
    offlineIndex: path.join(dataDir, 'nas-offline.json'),
    artDir: path.join(dataDir, 'nas-art'),
    offlineDir: path.join(dataDir, 'nas-offline')
  };

  /* ---------- config + credential ---------- */

  const loadConfig = () => ({ ...DEFAULT_CONFIG, ...((store.settings() || {}).nas || {}) });
  let cfg = loadConfig();
  let secret = null; // the password or API key, in memory only while running

  function readSecret() {
    try {
      if (!secrets || !secrets.available()) return null; // never fall back to plain text
      const buf = fs.readFileSync(files.credential);
      return buf.length ? secrets.decrypt(buf) : null;
    } catch { return null; }
  }
  function writeSecret(text) {
    if (!secrets || !secrets.available()) { const e = new Error('This PC cannot encrypt the password (Windows secure storage is unavailable).'); e.code = 'NO_ENCRYPTION'; throw e; }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(files.credential, secrets.encrypt(text));
  }
  secret = readSecret();

  const configured = () => !!(cfg.enabled && cfg.servers.length && secret && (cfg.username || cfg.authMode === 'apikey'));

  function credsFor(o) {
    return o.authMode === 'apikey' ? { apiKey: o.secret } : { user: o.username, password: o.secret };
  }
  const newClient = (url, o, apiVersion, timeoutMs) => new sub.SubsonicClient({ baseUrl: url, ...credsFor(o), apiVersion, fetch: doFetch, timeoutMs });

  /* ---------- state + events ---------- */

  let conn = { state: 'unconfigured', url: null, index: -1, apiVersion: null, serverType: null, serverVersion: null, openSubsonic: false, extensions: [], error: null, errorCode: null, checkedAt: 0 };
  let client = null;
  let sync = { running: false, done: 0, total: 0 };
  let dl = { active: false, albumId: null, done: 0, total: 0, error: null };
  const statusListeners = new Set(), libListeners = new Set();
  let lastStatusJson = '';

  function status() {
    return {
      configured: configured(), enabled: !!cfg.enabled, state: configured() ? conn.state : 'unconfigured',
      url: conn.url, home: conn.index === 0, apiVersion: conn.apiVersion, serverType: conn.serverType, serverVersion: conn.serverVersion,
      extensions: conn.extensions, apiKeySupported: conn.extensions.includes('apiKeyAuthentication'),
      error: conn.error, errorCode: conn.errorCode, checkedAt: conn.checkedAt,
      sync: { ...sync, syncedAt: cache.syncedAt || 0 },
      counts: { tracks: listTracks().length, albums: Object.keys(cache.albums).length, playlists: Object.keys(cache.playlists).length },
      downloads: { ...dl }, offlineCount: Object.keys(offline).length
    };
  }
  function emitStatus() {
    const s = status(), j = JSON.stringify(s);
    if (j === lastStatusJson) return;
    lastStatusJson = j;
    for (const fn of statusListeners) { try { fn(s); } catch {} }
  }
  function emitLibrary() { flat = null; for (const fn of libListeners) { try { fn(); } catch {} } emitStatus(); }

  /* ---------- metadata cache ---------- */

  const emptyCache = () => ({ v: CACHE_VERSION, user: cfg.username, syncedAt: 0, albums: {}, playlists: {} });
  let cache = emptyCache();
  let flat = null, knownIds = null;
  let saveTimer = null;

  function loadCache() {
    try {
      const c = JSON.parse(fs.readFileSync(files.cache, 'utf8'));
      cache = (c && c.v === CACHE_VERSION && c.user === cfg.username) ? { ...emptyCache(), ...c } : emptyCache();
    } catch { cache = emptyCache(); }
    flat = null;
  }
  function saveCacheSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCacheNow, 800);
    if (saveTimer.unref) saveTimer.unref();
  }
  function saveCacheNow() {
    clearTimeout(saveTimer); saveTimer = null;
    try { const tmp = files.cache + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, files.cache); } catch (e) { say('nas: cache write failed', e); }
  }

  /* ---------- offline downloads (index) ---------- */

  let offline = {}; // songId -> { file, size, suffix, type }
  function loadOffline() { try { offline = JSON.parse(fs.readFileSync(files.offlineIndex, 'utf8')) || {}; } catch { offline = {}; } for (const [id, o] of Object.entries(offline)) if (!fs.existsSync(o.file)) delete offline[id]; }
  function saveOffline() { try { const tmp = files.offlineIndex + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(offline)); fs.renameSync(tmp, files.offlineIndex); } catch (e) { say('nas: offline index write failed', e); } }

  /* ---------- reading the cache (sync, never touches the network) ---------- */

  function listTracks() {
    if (!flat) {
      flat = [];
      for (const a of Object.values(cache.albums)) for (const t of a.tracks) flat.push(offline[t.remoteId] ? { ...t, offline: true } : t);
      knownIds = new Set(flat.map(t => t.remoteId));
    }
    return flat;
  }
  function listPlaylists() {
    listTracks();
    return Object.values(cache.playlists).map(p => ({
      id: PLAYLIST_PREFIX + p.id, source: 'navidrome', remoteId: p.id, name: p.name, createdAt: p.created ? Date.parse(p.created) || 0 : 0,
      items: p.songIds.filter(id => knownIds.has(id)).map(id => ({ trackId: ID_PREFIX + id, addedAt: 0 }))
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /* ---------- connection ---------- */

  const isNetworkError = e => e && (e.code === 'OFFLINE' || e.code === 'TIMEOUT');

  /* Pings every configured URL at once and takes the first one, in the
     configured order (LAN first), that answers. */
  async function probe(o, timeoutMs = T.probeMs) {
    const attempts = o.servers.map(async url => {
      try {
        const c = newClient(url, o, undefined, timeoutMs);
        const ping = await c.ping();
        return { ok: true, url, ping };
      } catch (error) { return { ok: false, url, error }; }
    });
    const failures = [];
    for (let i = 0; i < attempts.length; i++) {
      const r = await attempts[i];
      if (r.ok) return { ok: true, index: i, url: r.url, ping: r.ping };
      failures.push(r.error);
    }
    const auth = failures.find(e => e && (e.code === 'AUTH' || e.code === 'FORBIDDEN'));
    const err = auth || failures[0] || new sub.SubsonicError('OFFLINE', 'No server address is set');
    return { ok: false, error: err };
  }

  let connecting = null, lastConnectAt = 0;
  function connect(reason) {
    if (!configured()) { setUnconfigured(); return Promise.resolve(status()); }
    if (connecting) return connecting;
    lastConnectAt = Date.now();
    connecting = (async () => {
      if (conn.state !== 'online') { conn.state = 'connecting'; emitStatus(); }
      const o = { servers: cfg.servers, username: cfg.username, authMode: cfg.authMode, secret };
      const r = await probe(o);
      if (r.ok) {
        const wasOnline = conn.state === 'online' && conn.url === r.url;
        client = newClient(r.url, o, r.ping.version, T.apiMs);
        conn = { ...conn, state: 'online', url: r.url, index: r.index, apiVersion: r.ping.version, serverType: r.ping.type, serverVersion: r.ping.serverVersion, openSubsonic: r.ping.openSubsonic, error: null, errorCode: null, checkedAt: Date.now() };
        emitStatus();
        if (!wasOnline) {
          say('nas: online via', r.url, '(' + (reason || 'connect') + ')');
          client.getOpenSubsonicExtensions().then(ext => { conn.extensions = ext.map(e => e.name); emitStatus(); }, () => {});
          flushScrobbles().catch(() => {});
        }
        if (Date.now() - (cache.syncedAt || 0) > T.staleSyncMs || !Object.keys(cache.albums).length) syncLibrary().catch(() => {});
      } else {
        client = null;
        const authFailed = r.error.code === 'AUTH' || r.error.code === 'FORBIDDEN';
        conn = { ...conn, state: authFailed ? 'auth-failed' : 'offline', error: errText(r.error), errorCode: r.error.code, checkedAt: Date.now(), url: null, index: -1 };
        emitStatus();
        say('nas: unreachable (' + r.error.code + ')');
      }
      return status();
    })().finally(() => { connecting = null; });
    return connecting;
  }

  function setUnconfigured() {
    client = null;
    conn = { ...conn, state: 'unconfigured', url: null, index: -1, error: null, errorCode: null };
    emitStatus();
  }

  /* A failed stream/API call over the network: re-check soon rather than wait for the timer. */
  function noteFailure() {
    if (conn.state === 'online' && Date.now() - lastConnectAt > 3000) { conn.checkedAt = 0; connect('failure').catch(() => {}); }
  }

  /* Network change detection without a native event: watch the set of
     non-loopback IPv4 addresses. Also called on system resume. */
  const netSignature = () => JSON.stringify(Object.values(os.networkInterfaces()).flat().filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address).sort());
  let lastNet = netSignature(), monitor = null, lastSyncTry = 0;
  function tick() {
    if (!configured()) return;
    const sig = netSignature();
    if (sig !== lastNet) { lastNet = sig; connect('network change').catch(() => {}); return; }
    const age = Date.now() - conn.checkedAt;
    if (conn.state === 'offline' && age > T.offlineRetryMs) connect('retry').catch(() => {});
    else if (conn.state === 'online' && age > T.onlineCheckMs) {
      client.ping().then(() => { conn.checkedAt = Date.now(); }, () => connect('health check').catch(() => {}));
      if (Date.now() - (cache.syncedAt || 0) > T.syncEveryMs && Date.now() - lastSyncTry > T.syncEveryMs) { lastSyncTry = Date.now(); syncLibrary().catch(() => {}); }
    }
  }
  function start() {
    loadCache(); loadOffline(); loadScrobbles();
    if (!monitor) { monitor = setInterval(tick, T.netPollMs); if (monitor.unref) monitor.unref(); }
    emitStatus();
    if (configured()) connect('start').catch(() => {});
  }
  function stop() { clearInterval(monitor); monitor = null; saveCacheNow(); }
  function onNetworkChange() { lastNet = netSignature(); if (configured()) connect('network change').catch(() => {}); }

  /* ---------- library sync ---------- */

  const albumSig = a => [a.songCount, a.duration, a.created, a.year || '', a.name, a.artist].join('|');

  async function syncLibrary({ force } = {}) {
    if (syncing) return syncing;
    if (!client) return null;
    const c = client;
    syncing = (async () => {
      sync = { running: true, done: 0, total: 0 };
      let changed = false;
      try {
        const list = [];
        for (let offset = 0, page = 0; page < 400; page++, offset += 500) {
          const batch = await c.getAlbumList2({ type: 'alphabeticalByName', size: 500, offset });
          list.push(...batch);
          if (batch.length < 500) break;
        }
        const ids = new Set(list.map(a => a.id));
        const todo = list.filter(a => force || !cache.albums[a.id] || cache.albums[a.id].sig !== albumSig(a));
        sync.total = todo.length; emitStatus();
        let next = 0, failed = 0, fatal = null;
        const worker = async () => {
          while (next < todo.length && !fatal) {
            const a = todo[next++];
            try {
              const { tracks } = await c.getAlbum(a.id);
              cache.albums[a.id] = { sig: albumSig(a), tracks };
              changed = true;
            } catch (e) { failed++; if (e.code === 'AUTH' || isNetworkError(e)) fatal = e; }
            sync.done++;
            if (sync.done % 10 === 0) emitStatus();
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, T.syncConcurrency) }, worker));
        if (fatal) throw fatal;
        for (const id of Object.keys(cache.albums)) if (!ids.has(id) && !cache.albums[id].pending) { delete cache.albums[id]; changed = true; }
        if (await syncPlaylists(c)) changed = true;
        if (!failed) cache.syncedAt = Date.now();
        say('nas: sync done,', todo.length, 'albums fetched,', failed, 'failed');
      } catch (e) {
        say('nas: sync failed (' + (e.code || 'ERR') + ')');
        if (isNetworkError(e)) noteFailure();
      } finally {
        sync = { running: false, done: sync.done, total: sync.total };
        saveCacheSoon();
        if (changed) emitLibrary(); else emitStatus();
      }
    })().finally(() => { syncing = null; });
    return syncing;
  }
  let syncing = null;

  async function syncPlaylists(c) {
    let changed = false;
    try {
      const list = await c.getPlaylists();
      const ids = new Set(list.map(p => p.id));
      for (const p of list) {
        const have = cache.playlists[p.id];
        if (have && have.changed === p.changed && have.count === p.songCount) continue;
        const full = await c.getPlaylist(p.id);
        cache.playlists[p.id] = { id: p.id, name: full.name || p.name, changed: p.changed, created: p.created, count: p.songCount, songIds: full.songs.map(s => s.remoteId) };
        changed = true;
      }
      for (const id of Object.keys(cache.playlists)) if (!ids.has(id)) { delete cache.playlists[id]; changed = true; }
    } catch (e) { say('nas: playlist sync failed (' + (e.code || 'ERR') + ')'); }
    return changed;
  }

  /* ---------- search ---------- */

  /* Asks the server (search3) and folds any hits the cache does not know yet
     into it, by fetching their whole album. Returns how many albums were added. */
  async function search(q) {
    if (!client || !String(q || '').trim()) return { added: 0 };
    const c = client;
    const r = await c.search3(q, { artistCount: 0, albumCount: 10, songCount: 30 });
    const want = [...new Set([...r.songs.map(s => s.nasAlbumId), ...r.albums.map(a => a.id)].filter(Boolean))].filter(id => !cache.albums[id]).slice(0, 12);
    let added = 0;
    await Promise.all(want.map(async id => {
      try { const { tracks } = await c.getAlbum(id); cache.albums[id] = { sig: null, tracks }; added++; } catch {}
    }));
    if (added) { saveCacheSoon(); emitLibrary(); }
    return { added };
  }

  /* ---------- streaming + cover art (used by mediaServer.js) ---------- */

  const offlineError = () => new sub.SubsonicError('OFFLINE', 'The NAS is offline');
  const qualityFor = () => QUALITY[conn.index === 0 ? cfg.qualityHome : cfg.qualityAway] || {};

  async function openStream(trackId, { range, signal } = {}) {
    const songId = stripId(trackId);
    const off = offline[songId];
    if (off && fs.existsSync(off.file)) return { kind: 'file', path: off.file, type: off.type };
    if (!client) throw offlineError();
    const q = qualityFor();
    const url = client.streamUrl(songId, q);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => ctrl.abort(), T.streamConnectMs);
    let res;
    try { res = await doFetch(url, { headers: range ? { Range: range } : {}, signal: ctrl.signal }); }
    catch (e) { noteFailure(); throw new sub.SubsonicError(ctrl.signal.aborted && !(signal && signal.aborted) ? 'TIMEOUT' : 'OFFLINE', 'Could not stream from the NAS'); }
    finally { clearTimeout(timer); }
    const type = res.headers.get('content-type') || '';
    // Subsonic servers answer failures with an XML/JSON body, not an HTTP error
    if (![200, 206, 416].includes(res.status) || /json|xml|html|^text\//i.test(type)) {
      try { await res.body.cancel(); } catch {}
      throw new sub.SubsonicError(res.status === 404 ? 'NOT_FOUND' : 'HTTP', 'The NAS could not stream this song (' + res.status + ')');
    }
    return { kind: 'http', response: res };
  }

  const inflightCovers = new Map();
  const coverBase = (id, w) => path.join(files.artDir, safeName(id) + '-' + w);
  function findCover(id, w) {
    for (const ext of Object.keys(EXT_TYPE)) { const p = coverBase(id, w) + ext; if (fs.existsSync(p)) return { path: p, type: EXT_TYPE[ext] }; }
    return null;
  }
  /* Cover art from the on-disk cache, fetched (at a bucketed size) on first use. */
  async function coverArt(ref, size) {
    const id = String(ref || '');
    if (!id) return null;
    const want = COVER_WIDTHS.find(x => x >= (size || 400)) || 1024;
    const hit = findCover(id, want);
    if (hit) return hit;
    if (!client) { // offline: any size we already have beats nothing
      for (const w of [...COVER_WIDTHS].reverse()) { const h = findCover(id, w); if (h) return h; }
      return null;
    }
    const key = id + '@' + want;
    if (inflightCovers.has(key)) return inflightCovers.get(key);
    const job = (async () => {
      try {
        const res = await doFetch(client.coverArtUrl(id, want), { signal: AbortSignal.timeout(10000) });
        const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!res.ok || !IMG_EXT[type]) { try { await res.body.cancel(); } catch {} return null; }
        fs.mkdirSync(files.artDir, { recursive: true });
        const out = coverBase(id, want) + IMG_EXT[type], tmp = out + '.tmp';
        fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
        fs.renameSync(tmp, out);
        return { path: out, type };
      } catch { return null; }
    })().finally(() => inflightCovers.delete(key));
    inflightCovers.set(key, job);
    return job;
  }

  /* ---------- scrobbling ---------- */

  let pendingScrobbles = [];
  function loadScrobbles() { try { pendingScrobbles = JSON.parse(fs.readFileSync(files.scrobbles, 'utf8')) || []; } catch { pendingScrobbles = []; } }
  function saveScrobbles() { try { fs.writeFileSync(files.scrobbles, JSON.stringify(pendingScrobbles.slice(-1000))); } catch {} }

  /* submission=false: "now playing" (dropped if offline). submission=true: a
     counted play, queued on disk when the NAS cannot be reached right now. */
  function scrobble(trackId, { submission = true, time } = {}) {
    const id = stripId(trackId);
    if (!submission) { if (client) client.scrobble(id, { submission: false }).catch(e => { if (isNetworkError(e)) noteFailure(); }); return; }
    const entry = { id, time: time || Date.now() };
    if (!client) { pendingScrobbles.push(entry); saveScrobbles(); return; }
    client.scrobble(id, { submission: true, time: entry.time }).catch(e => {
      if (isNetworkError(e)) { pendingScrobbles.push(entry); saveScrobbles(); noteFailure(); }
    });
  }
  async function flushScrobbles() {
    while (pendingScrobbles.length && client) {
      const e = pendingScrobbles[0];
      try { await client.scrobble(e.id, { submission: true, time: e.time }); }
      catch (err) { if (isNetworkError(err) || err.code === 'AUTH') break; }
      pendingScrobbles.shift();
    }
    saveScrobbles();
  }

  /* ---------- playlists ---------- */

  const needClient = () => { if (!client) throw offlineError(); return client; };
  const songIdsOf = ids => [].concat(ids || []).filter(x => String(x).startsWith(ID_PREFIX)).map(stripId);

  async function refreshPlaylist(id) {
    const c = needClient();
    const full = await c.getPlaylist(id);
    cache.playlists[id] = { id, name: full.name, changed: full.changed, created: full.created, count: full.songCount, songIds: full.songs.map(s => s.remoteId) };
    saveCacheSoon(); emitLibrary();
    return listPlaylists().find(p => p.remoteId === id) || null;
  }
  async function createPlaylist(name, trackIds) {
    const made = await needClient().createPlaylist(name || 'New Playlist', songIdsOf(trackIds));
    if (!made) throw new sub.SubsonicError('BAD_RESPONSE', 'The NAS did not create the playlist');
    return refreshPlaylist(made.id);
  }
  async function renamePlaylist(plId, name) { await needClient().updatePlaylist(stripPl(plId), { name }); return refreshPlaylist(stripPl(plId)); }
  async function addToPlaylist(plId, trackIds) {
    const id = stripPl(plId), have = new Set((cache.playlists[id] || { songIds: [] }).songIds);
    const add = songIdsOf(trackIds).filter(s => !have.has(s));
    if (add.length) await needClient().updatePlaylist(id, { songIdToAdd: add });
    return refreshPlaylist(id);
  }
  async function removeFromPlaylist(plId, trackId) {
    const id = stripPl(plId), i = (cache.playlists[id] || { songIds: [] }).songIds.indexOf(stripId(trackId));
    if (i >= 0) await needClient().updatePlaylist(id, { songIndexToRemove: [i] });
    return refreshPlaylist(id);
  }
  async function setPlaylistItems(plId, trackIds) { await needClient().replacePlaylist(stripPl(plId), songIdsOf(trackIds)); return refreshPlaylist(stripPl(plId)); }
  async function deletePlaylist(plId) {
    await needClient().deletePlaylist(stripPl(plId));
    delete cache.playlists[stripPl(plId)];
    saveCacheSoon(); emitLibrary();
    return true;
  }

  /* ---------- offline downloads ---------- */

  let dlToken = 0;
  const albumRaw = id => String(id || '').replace(/^nd-/, '');
  async function downloadAlbum(albumId) {
    const entry = cache.albums[albumRaw(albumId)];
    if (!entry) throw new sub.SubsonicError('NOT_FOUND', 'That album is not in the NAS library');
    if (dl.active) throw new Error('A download is already running');
    const c = needClient();
    const token = ++dlToken;
    const todo = entry.tracks.filter(t => !offline[t.remoteId]);
    dl = { active: true, albumId: albumRaw(albumId), done: 0, total: todo.length, error: null };
    emitStatus();
    fs.mkdirSync(files.offlineDir, { recursive: true });
    try {
      for (const t of todo) {
        if (token !== dlToken) break;
        const res = await doFetch(c.downloadUrl(t.remoteId), { signal: AbortSignal.timeout(10 * 60 * 1000) });
        const type = res.headers.get('content-type') || '';
        if (!res.ok || /json|xml|html|^text\//i.test(type)) { try { await res.body.cancel(); } catch {} throw new sub.SubsonicError('HTTP', 'The NAS refused to download ' + t.title); }
        const file = path.join(files.offlineDir, safeName(t.remoteId) + '.' + (t.suffix || 'audio')), tmp = file + '.part';
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
        fs.renameSync(tmp, file);
        offline[t.remoteId] = { file, size: fs.statSync(file).size, suffix: t.suffix || null, type: t.contentType || type || 'application/octet-stream' };
        dl.done++;
        flat = null; saveOffline(); emitStatus();
      }
    } catch (e) { dl.error = errText(e); throw e; }
    finally { dl.active = false; flat = null; emitLibrary(); }
    return { downloaded: dl.done };
  }
  function cancelDownload() { dlToken++; }
  function removeDownload(albumId) {
    const entry = cache.albums[albumRaw(albumId)];
    if (!entry) return 0;
    let n = 0;
    for (const t of entry.tracks) { const o = offline[t.remoteId]; if (o) { try { fs.unlinkSync(o.file); } catch {} delete offline[t.remoteId]; n++; } }
    saveOffline(); emitLibrary();
    return n;
  }
  const isAlbumDownloaded = albumId => { const e = cache.albums[albumRaw(albumId)]; return !!(e && e.tracks.length && e.tracks.every(t => offline[t.remoteId])); };

  /* ---------- settings ---------- */

  function getConfig() {
    return { enabled: cfg.enabled, servers: cfg.servers.slice(), username: cfg.username, authMode: cfg.authMode, qualityHome: cfg.qualityHome, qualityAway: cfg.qualityAway,
      hasCredential: !!secret, encryptionAvailable: !!(secrets && secrets.available()) };
  }

  async function setConfig(patch = {}) {
    const next = { ...cfg };
    if ('servers' in patch) {
      const list = (Array.isArray(patch.servers) ? patch.servers : String(patch.servers || '').split(/[\s,]+/)).map(sub.normalizeBaseUrl).filter(Boolean);
      for (const u of list) { try { const p = new URL(u); if (!/^https?:$/.test(p.protocol)) throw 0; } catch { const e = new Error('Not a valid server address: ' + u); e.code = 'BAD_CONFIG'; throw e; } }
      next.servers = [...new Set(list)];
    }
    if ('username' in patch) next.username = String(patch.username || '').trim();
    if ('authMode' in patch) next.authMode = patch.authMode === 'apikey' ? 'apikey' : 'password';
    for (const k of ['qualityHome', 'qualityAway']) if (k in patch) next[k] = QUALITY[patch[k]] ? patch[k] : 'original';
    if ('enabled' in patch) next.enabled = !!patch.enabled;
    const userChanged = next.username !== cfg.username;
    cfg = next;
    store.setSettings({ nas: cfg });
    if (userChanged) { cache = emptyCache(); flat = null; saveCacheNow(); emitLibrary(); }
    await connect('config');
    return getConfig();
  }

  async function setCredential(text) {
    text = String(text || '');
    if (!text) { const e = new Error('The password cannot be empty'); e.code = 'BAD_CONFIG'; throw e; }
    writeSecret(text);
    secret = text;
    if (!cfg.enabled) { cfg.enabled = true; store.setSettings({ nas: cfg }); }
    await connect('credential');
    return getConfig();
  }

  /* Forget the NAS entirely: credential, cached library, downloads. */
  async function forget() {
    dlToken++;
    secret = null;
    try { fs.unlinkSync(files.credential); } catch {}
    cfg = { ...cfg, enabled: false };
    store.setSettings({ nas: cfg });
    cache = emptyCache(); saveCacheNow();
    for (const o of Object.values(offline)) { try { fs.unlinkSync(o.file); } catch {} }
    offline = {}; saveOffline();
    pendingScrobbles = []; saveScrobbles();
    setUnconfigured();
    emitLibrary();
    return getConfig();
  }

  /* "Test connection": tries the values from the form (falling back to the
     saved ones) without touching the live connection. */
  async function test(o = {}) {
    const merged = {
      servers: (o.servers ? [].concat(o.servers) : cfg.servers).map(sub.normalizeBaseUrl).filter(Boolean),
      username: o.username != null ? String(o.username).trim() : cfg.username,
      authMode: o.authMode || cfg.authMode,
      secret: o.credential ? String(o.credential) : secret
    };
    if (!merged.servers.length) return { ok: false, code: 'BAD_CONFIG', message: 'Add at least one server address' };
    if (!merged.secret) return { ok: false, code: 'AUTH', message: 'Enter the password first' };
    if (merged.authMode !== 'apikey' && !merged.username) return { ok: false, code: 'AUTH', message: 'Enter the username first' };
    const r = await probe(merged, T.probeMs + 1500);
    if (!r.ok) return { ok: false, code: r.error.code, message: errText(r.error) };
    let apiKeySupported = false;
    try { apiKeySupported = (await newClient(r.url, merged, r.ping.version, T.apiMs).getOpenSubsonicExtensions()).some(e => e.name === 'apiKeyAuthentication'); } catch {}
    return { ok: true, url: r.url, index: r.index, home: r.index === 0, apiVersion: r.ping.version, serverType: r.ping.type, serverVersion: r.ping.serverVersion, openSubsonic: r.ping.openSubsonic, apiKeySupported };
  }

  return {
    id: 'navidrome', idPrefix: ID_PREFIX, label: 'NAS', playback: 'stream',
    start, stop, status, onStatus: fn => { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    onLibraryChange: fn => { libListeners.add(fn); return () => libListeners.delete(fn); },
    onNetworkChange, connect: () => connect('manual'),
    getConfig, setConfig, setCredential, forget, test,
    listTracks, listPlaylists, syncLibrary, search,
    openStream, coverArt, scrobble,
    createPlaylist, renamePlaylist, addToPlaylist, removeFromPlaylist, setPlaylistItems, deletePlaylist,
    downloadAlbum, cancelDownload, removeDownload, isAlbumDownloaded,
    isConfigured: configured, isOnline: () => conn.state === 'online'
  };
}

module.exports = { create, QUALITY, ID_PREFIX, PLAYLIST_PREFIX };
