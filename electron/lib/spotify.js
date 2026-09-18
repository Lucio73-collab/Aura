/* spotify.js - Spotify Web API client: rate-limited request queue,
   on-disk metadata cache, and normalization into Aura's track/album/artist
   shape. Everything here runs in the main process; the renderer only ever
   sees already-normalized JSON over IPC, never a token.

   Endpoint surface re-verified live against developer.spotify.com on
   2026-09-16. Limits that matter here (several dropped in Feb 2026):
     GET /search                  limit max 10
     GET /artists/{id}/albums     limit max 10
     GET /albums/{id}/tracks      limit max 50
     GET /playlists/{id}/items    limit max 50, each entry's object is `item` (`track` is deprecated)
     DELETE /playlists/{id}/items body is { items: [{ uri }] }
     GET /me/playlists, /me/tracks limit max 50
     PUT/DELETE /me/library, GET /me/library/contains  max 40 URIs
   Since July 2026 a quota hit comes back as 429 with reason QUOTA_EXCEEDED. */
const fs = require('fs');
const path = require('path');
const auth = require('./spotifyAuth');

const API = 'https://api.spotify.com/v1';
const DAY = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 30 * DAY;          // catalogue metadata barely changes
const DISCOGRAPHY_TTL_MS = DAY / 2;     // an artist's release list does change
const REQUEST_TIMEOUT_MS = 15000;
const MAX_INLINE_RETRY_AFTER_S = 8;     // longer than this and we fail fast instead of freezing the UI

class SpotifyError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/* ---------- rate-limited request queue ---------- */

const MAX_CONCURRENT = 4;
let activeReqs = 0;
const waiters = [];
let pausedUntil = 0;

function acquireSlot() {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const wait = pausedUntil - Date.now();
      if (wait > MAX_INLINE_RETRY_AFTER_S * 1000) {
        reject(new SpotifyError('RATE_LIMITED', `Spotify asked Aura to wait ${Math.ceil(wait / 1000)}s`));
        return;
      }
      if (wait > 0) { setTimeout(attempt, wait); return; }
      if (activeReqs < MAX_CONCURRENT) { activeReqs++; resolve(); }
      else waiters.push(attempt);
    };
    attempt();
  });
}
function releaseSlot() { activeReqs--; const next = waiters.shift(); if (next) next(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function safeJson(res) {
  try { const text = await res.text(); return text ? JSON.parse(text) : {}; } catch { return {}; }
}
function errInfo(j) {
  const e = j && j.error;
  if (!e) return { message: null, reason: null };
  if (typeof e === 'string') return { message: j.error_description || e, reason: null };
  return { message: e.message || null, reason: e.reason || null };
}

async function request(method, apiPath, { query, body, isPlayer } = {}) {
  const url = new URL(API + apiPath);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v));

  let attempt = 0;
  let forceFreshToken = false;
  while (true) {
    attempt++;
    let token;
    try { token = await auth.getAccessToken(forceFreshToken); }
    catch (e) {
      if (e.code === 'OFFLINE') throw new SpotifyError('OFFLINE', 'No connection to Spotify');
      if (e.code === 'SERVER_ERROR') throw new SpotifyError('SERVER_ERROR', e.message);
      throw new SpotifyError('REAUTH_REQUIRED', 'Not connected to Spotify');
    }

    await acquireSlot();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (e) {
      releaseSlot();
      if (e.name === 'TimeoutError' && attempt < 2) continue;
      throw new SpotifyError('OFFLINE', e.name === 'TimeoutError' ? 'Spotify did not respond in time' : e.message);
    }
    releaseSlot();

    if (res.status === 429) {
      const j = await safeJson(res);
      const { message, reason } = errInfo(j);
      if (reason === 'QUOTA_EXCEEDED') throw new SpotifyError('QUOTA_EXCEEDED', message);
      const retryAfter = Math.max(1, parseInt(res.headers.get('retry-after') || '1', 10) || 1);
      pausedUntil = Math.max(pausedUntil, Date.now() + retryAfter * 1000);
      if (retryAfter > MAX_INLINE_RETRY_AFTER_S || attempt > 3) {
        throw new SpotifyError('RATE_LIMITED', `Spotify asked Aura to wait ${retryAfter}s`);
      }
      await sleep(retryAfter * 1000);
      continue;
    }
    if (res.status === 401) {
      if (attempt === 1) { forceFreshToken = true; continue; }
      throw new SpotifyError('REAUTH_REQUIRED', 'Session expired, please reconnect Spotify');
    }
    if (res.status >= 500) {
      if (attempt < 3 && method === 'GET') { await sleep(400 * attempt); continue; }
      throw new SpotifyError('SERVER_ERROR', 'Spotify HTTP ' + res.status);
    }
    if (res.status === 204) return null;
    if (!res.ok) {
      const j = await safeJson(res);
      const { message, reason } = errInfo(j);
      if (res.status === 403) {
        if (reason === 'PREMIUM_REQUIRED' || /premium/i.test(message || '')) throw new SpotifyError('PREMIUM_REQUIRED', message);
        if (isPlayer) throw new SpotifyError('PLAYER_REFUSED', message || reason || 'That device refused the command');
        throw new SpotifyError('FORBIDDEN', message);
      }
      if (res.status === 404) {
        if (isPlayer) throw new SpotifyError('NO_ACTIVE_DEVICE', message || 'No active Spotify device');
        throw new SpotifyError('NOT_FOUND', message || 'Not found on Spotify');
      }
      if (res.status === 400) throw new SpotifyError('BAD_REQUEST', message || 'Spotify rejected the request');
      throw new SpotifyError('UNKNOWN', message || ('HTTP ' + res.status));
    }
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }
}

/* ---------- on-disk metadata cache ---------- */

let cacheFile = null;
const emptyCache = () => ({ tracks: {}, albums: {}, artists: {}, albumTracks: {}, discography: {} });
let cache = emptyCache();
let saveTimer = null;

function loadCache() {
  try { cache = { ...emptyCache(), ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')) }; } catch { cache = emptyCache(); }
  // Drop expired catalogue entries, but never tracks: custom albums and
  // local playlists resolve their Spotify songs from this cache offline.
  const now = Date.now();
  for (const kind of ['albums', 'artists', 'albumTracks']) {
    for (const [id, e] of Object.entries(cache[kind])) if (!e || now - e.at > CACHE_TTL_MS) delete cache[kind][id];
  }
  for (const [id, e] of Object.entries(cache.discography)) if (!e || now - e.at > DISCOGRAPHY_TTL_MS) delete cache.discography[id];
}
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, cacheFile);
    } catch {}
  }, 800);
}
function cacheGet(kind, id, ttl = CACHE_TTL_MS, allowStale = false) {
  const e = cache[kind][id];
  if (!e) return null;
  if (!allowStale && Date.now() - e.at > ttl) return null;
  return e.data;
}
function cachePut(kind, id, data) { cache[kind][id] = { data, at: Date.now() }; saveCache(); return data; }

/* ---------- normalization: Spotify's raw shape -> Aura's track/album/artist shape ---------- */

const bestImage = images => (images && images[0] && images[0].url) || null;

function normalizeTrack(raw, albumOverride) {
  if (!raw || !raw.id || (raw.type && raw.type !== 'track')) return null;
  const album = albumOverride || raw.album || null;
  const artistRefs = (raw.artists || []).filter(a => a && a.name).map(a => ({ id: a.id ? 'sp:' + a.id : null, name: a.name }));
  const artists = artistRefs.map(a => a.name);
  const prev = cacheGet('tracks', raw.id, Infinity, true);
  const t = {
    id: 'sp:' + raw.id, source: 'spotify', uri: raw.uri || ('spotify:track:' + raw.id),
    title: raw.name, fileName: null,
    artist: artists.join(', '), albumArtist: artists[0] || 'Unknown Artist',
    artistKey: artists[0] || 'Unknown Artist', artists, artistRefs,
    artistId: artistRefs[0] ? artistRefs[0].id : null,
    album: album ? album.name : '', albumId: album && album.id ? 'sp:' + album.id : null,
    trackNo: raw.track_number || 1, discNo: raw.disc_number || 1,
    year: album && album.release_date ? +String(album.release_date).slice(0, 4) : null,
    genre: null,
    duration: Math.round((raw.duration_ms || 0) / 1000),
    dateAdded: prev ? prev.dateAdded : Date.now(), hasArt: false,
    cover: album ? bestImage(album.images) : null,
    explicit: !!raw.explicit,
    playable: raw.is_playable !== false,
    spotifyUrl: raw.external_urls ? raw.external_urls.spotify : ('https://open.spotify.com/track/' + raw.id)
  };
  // Simplified tracks (album tracklists) carry no album of their own; don't
  // let one of those wipe the cover/album a fuller copy already cached.
  if (!t.cover && prev && prev.cover) t.cover = prev.cover;
  if (!t.album && prev && prev.album) { t.album = prev.album; t.albumId = prev.albumId; t.year = prev.year; }
  cachePut('tracks', raw.id, t);
  return t;
}

function normalizeAlbum(raw) {
  if (!raw || !raw.id) return null;
  const artistRefs = (raw.artists || []).filter(a => a && a.name).map(a => ({ id: a.id ? 'sp:' + a.id : null, name: a.name }));
  const a = {
    id: 'sp:' + raw.id, source: 'spotify', uri: raw.uri || ('spotify:album:' + raw.id),
    title: raw.name, artist: artistRefs.map(x => x.name).join(', '), artistRefs,
    artistId: artistRefs[0] ? artistRefs[0].id : null,
    releaseDate: raw.release_date || null, albumType: raw.album_type || 'album',
    totalTracks: raw.total_tracks || (raw.tracks ? raw.tracks.total : 0),
    cover: bestImage(raw.images),
    spotifyUrl: raw.external_urls ? raw.external_urls.spotify : ('https://open.spotify.com/album/' + raw.id)
  };
  cachePut('albums', raw.id, a);
  return a;
}

function normalizeArtist(raw) {
  if (!raw || !raw.id) return null;
  const a = {
    id: 'sp:' + raw.id, source: 'spotify', uri: raw.uri || ('spotify:artist:' + raw.id),
    name: raw.name, image: bestImage(raw.images), genres: raw.genres || [],
    spotifyUrl: raw.external_urls ? raw.external_urls.spotify : ('https://open.spotify.com/artist/' + raw.id)
  };
  cachePut('artists', raw.id, a);
  return a;
}

function normalizePlaylist(raw, meId) {
  if (!raw || !raw.id) return null;
  const itemsObj = raw.items && !Array.isArray(raw.items) ? raw.items : raw.tracks;
  const owner = raw.owner || {};
  return {
    id: raw.id, uri: raw.uri, name: raw.name || 'Untitled playlist',
    description: raw.description || '', cover: bestImage(raw.images),
    ownerName: owner.display_name || owner.id || '', ownerId: owner.id || null,
    isOwn: !!(meId && owner.id === meId) || !!raw.collaborative,
    total: itemsObj && typeof itemsObj.total === 'number' ? itemsObj.total : null,
    snapshotId: raw.snapshot_id || null,
    spotifyUrl: raw.external_urls ? raw.external_urls.spotify : ('https://open.spotify.com/playlist/' + raw.id)
  };
}

const stripSp = id => String(id || '').replace(/^sp:/, '');

/* sync cache reads, used by library.js to merge sp: ids into the curated
   library without ever blocking on a network call */
const getCachedTrack = id => cacheGet('tracks', stripSp(id), Infinity, true);
const getCachedAlbum = id => cacheGet('albums', stripSp(id));
const getCachedArtist = id => cacheGet('artists', stripSp(id));
const hasCachedTrack = id => !!getCachedTrack(id);

/* ---------- init ---------- */

function init(store) {
  cacheFile = path.join(store.dir(), 'spotify-cache.json');
  loadCache();
}

/* ---------- search ---------- */

async function search(q, types = ['track', 'album', 'artist'], limit = 10, offset = 0) {
  const json = await request('GET', '/search', { query: { q, type: types.join(','), limit: Math.min(10, Math.max(1, limit)), offset } });
  const list = (part, fn) => part ? { total: part.total || 0, items: (part.items || []).map(x => fn(x)).filter(Boolean) } : { total: 0, items: [] };
  return {
    tracks: list(json && json.tracks, t => normalizeTrack(t)),
    albums: list(json && json.albums, normalizeAlbum),
    artists: list(json && json.artists, normalizeArtist)
  };
}

/* ---------- catalogue browsing ---------- */

async function getTrack(id) {
  id = stripSp(id);
  const cached = cacheGet('tracks', id);
  if (cached && cached.album) return cached;
  return normalizeTrack(await request('GET', `/tracks/${id}`));
}

async function getArtist(id) {
  id = stripSp(id);
  const cached = getCachedArtist(id);
  if (cached) return cached;
  try { return normalizeArtist(await request('GET', `/artists/${id}`)); }
  catch (e) { const stale = cacheGet('artists', id, 0, true); if (stale && e.code === 'OFFLINE') return stale; throw e; }
}

/* The whole discography, not just one page: limit is capped at 10 now, so
   this pages through (in parallel, through the rate-limited queue) and
   caches the result for half a day. */
const DISCOGRAPHY_CAP = 300;
async function getArtistAlbums(id) {
  id = stripSp(id);
  const cached = cacheGet('discography', id, DISCOGRAPHY_TTL_MS);
  if (cached) return cached;
  const PAGE = 10;
  const include_groups = 'album,single,compilation';
  try {
    const first = await request('GET', `/artists/${id}/albums`, { query: { limit: PAGE, offset: 0, include_groups } });
    const total = Math.min((first && first.total) || 0, DISCOGRAPHY_CAP);
    const pages = [first];
    const offsets = [];
    for (let off = PAGE; off < total; off += PAGE) offsets.push(off);
    const rest = await Promise.all(offsets.map(off => request('GET', `/artists/${id}/albums`, { query: { limit: PAGE, offset: off, include_groups } })));
    pages.push(...rest);
    const seen = new Set();
    const items = [];
    for (const p of pages) for (const raw of ((p && p.items) || [])) {
      if (!raw || seen.has(raw.id)) continue;
      seen.add(raw.id);
      const a = normalizeAlbum(raw);
      if (a) items.push(a);
    }
    const out = { total: (first && first.total) || items.length, items };
    cachePut('discography', id, out);
    return out;
  } catch (e) {
    const stale = cacheGet('discography', id, 0, true);
    if (stale && (e.code === 'OFFLINE' || e.code === 'RATE_LIMITED' || e.code === 'QUOTA_EXCEEDED')) return stale;
    throw e;
  }
}

async function getAlbum(id) {
  id = stripSp(id);
  const cached = getCachedAlbum(id);
  if (cached) return cached;
  const raw = await request('GET', `/albums/${id}`);
  const album = normalizeAlbum(raw);
  // /albums/{id} already embeds the first page of tracks; keep them so the
  // album page does not need a second request for most albums.
  if (album && raw.tracks && Array.isArray(raw.tracks.items) && raw.tracks.total <= raw.tracks.items.length) {
    const ref = { id, name: raw.name, images: raw.images, release_date: raw.release_date };
    const ids = raw.tracks.items.map(t => normalizeTrack(t, ref)).filter(Boolean).map(t => t.id);
    cachePut('albumTracks', id, ids);
  }
  return album;
}

async function getAlbumTracks(id) {
  id = stripSp(id);
  const album = await getAlbum(id);
  const cachedIds = cacheGet('albumTracks', id);
  if (cachedIds) {
    const items = cachedIds.map(getCachedTrack).filter(Boolean);
    if (items.length === cachedIds.length) return { total: items.length, album, items };
  }
  const albumRef = album ? { id, name: album.title, images: album.cover ? [{ url: album.cover }] : [], release_date: album.releaseDate } : null;
  const PAGE = 50;
  const items = [];
  let offset = 0, total = Infinity;
  while (offset < total && offset < 1000) {
    const json = await request('GET', `/albums/${id}/tracks`, { query: { limit: PAGE, offset } });
    if (!json) break;
    total = json.total || 0;
    const page = (json.items || []).map(t => normalizeTrack(t, albumRef)).filter(Boolean);
    items.push(...page);
    if (!json.items || !json.items.length) break;
    offset += PAGE;
  }
  cachePut('albumTracks', id, items.map(t => t.id));
  return { total: items.length, album, items };
}

/* ---------- playback (Spotify Connect remote control) ---------- */

const getPlaybackState = () => request('GET', '/me/player', { isPlayer: true });
const getDevices = () => request('GET', '/me/player/devices', { isPlayer: true }).then(j => (j && j.devices) || []);
const transferPlayback = (deviceId, play = false) => request('PUT', '/me/player', { isPlayer: true, body: { device_ids: [deviceId], play: !!play } });
const playUris = (uris, deviceId, positionMs) => request('PUT', '/me/player/play', { isPlayer: true, query: { device_id: deviceId }, body: { uris, position_ms: Math.max(0, Math.round(positionMs || 0)) } });
const playContext = (contextUri, offsetUri, deviceId) => request('PUT', '/me/player/play', { isPlayer: true, query: { device_id: deviceId }, body: { context_uri: contextUri, offset: offsetUri ? { uri: offsetUri } : undefined } });
const pausePlayback = deviceId => request('PUT', '/me/player/pause', { isPlayer: true, query: { device_id: deviceId } });
const resumePlayback = deviceId => request('PUT', '/me/player/play', { isPlayer: true, query: { device_id: deviceId } });
const seek = (ms, deviceId) => request('PUT', '/me/player/seek', { isPlayer: true, query: { position_ms: Math.max(0, Math.round(ms)), device_id: deviceId } });
const skipNext = deviceId => request('POST', '/me/player/next', { isPlayer: true, query: { device_id: deviceId } });
const skipPrevious = deviceId => request('POST', '/me/player/previous', { isPlayer: true, query: { device_id: deviceId } });
const setShuffle = (state, deviceId) => request('PUT', '/me/player/shuffle', { isPlayer: true, query: { state: !!state, device_id: deviceId } });
const setRepeat = (state, deviceId) => request('PUT', '/me/player/repeat', { isPlayer: true, query: { state, device_id: deviceId } });
const setVolume = (pct, deviceId) => request('PUT', '/me/player/volume', { isPlayer: true, query: { volume_percent: Math.max(0, Math.min(100, Math.round(pct))), device_id: deviceId } });
const addToQueue = (uri, deviceId) => request('POST', '/me/player/queue', { isPlayer: true, query: { uri, device_id: deviceId } });

/* ---------- library (unified save/remove/contains, per Feb 2026 changelog) ---------- */

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

const getSavedTracks = async ({ limit = 50, offset = 0 } = {}) => {
  const json = await request('GET', '/me/tracks', { query: { limit: Math.min(50, limit), offset } });
  return {
    total: (json && json.total) || 0,
    items: ((json && json.items) || []).map(it => ({ addedAt: it.added_at, track: normalizeTrack(it.track || it.item) })).filter(it => it.track)
  };
};
const getSavedAlbums = async ({ limit = 50, offset = 0 } = {}) => {
  const json = await request('GET', '/me/albums', { query: { limit: Math.min(50, limit), offset } });
  return {
    total: (json && json.total) || 0,
    items: ((json && json.items) || []).map(it => ({ addedAt: it.added_at, album: normalizeAlbum(it.album || it.item) })).filter(it => it.album)
  };
};
async function saveToLibrary(uris) {
  for (const batch of chunk(uris, 40)) await request('PUT', '/me/library', { query: { uris: batch.join(',') } });
  return true;
}
async function removeFromLibrary(uris) {
  for (const batch of chunk(uris, 40)) await request('DELETE', '/me/library', { query: { uris: batch.join(',') } });
  return true;
}
async function checkLibrary(uris) {
  const out = [];
  for (const batch of chunk(uris, 40)) {
    const res = await request('GET', '/me/library/contains', { query: { uris: batch.join(',') } });
    out.push(...(Array.isArray(res) ? res : batch.map(() => false)));
  }
  return out;
}

/* ---------- playlists (Feb 2026: /tracks renamed to /items throughout) ---------- */

let meId = null;
async function getMeId() {
  if (meId) return meId;
  const st = auth.status();
  if (st.userId) return (meId = st.userId);
  try { const me = await request('GET', '/me'); meId = (me && me.id) || null; } catch {}
  return meId;
}
auth.onChange(st => { if (!st.connected) meId = null; });

async function createPlaylist(name, { isPublic = false, description } = {}) {
  const raw = await request('POST', '/me/playlists', { body: { name, public: isPublic, description: description || undefined } });
  return normalizePlaylist(raw, await getMeId());
}
async function getMyPlaylists() {
  const me = await getMeId();
  const out = [];
  let offset = 0, total = Infinity;
  while (offset < total && offset < 500) {
    const json = await request('GET', '/me/playlists', { query: { limit: 50, offset } });
    if (!json || !json.items || !json.items.length) break;
    total = json.total || 0;
    out.push(...json.items.map(p => normalizePlaylist(p, me)).filter(Boolean));
    offset += 50;
  }
  return out;
}
async function getPlaylist(id) {
  // `fields` keeps Spotify from embedding the first 100 items we'd throw away
  const raw = await request('GET', `/playlists/${id}`, { query: { fields: 'id,uri,name,description,images,owner(id,display_name),collaborative,snapshot_id,external_urls,items(total),tracks(total)' } });
  return normalizePlaylist(raw, await getMeId());
}
const playlistEntryTrack = it => it && (it.item || it.track);
async function getPlaylistItems(id, { max = 1000 } = {}) {
  const PAGE = 50;
  const items = [];
  let offset = 0, total = Infinity, skipped = 0;
  while (offset < total && offset < max) {
    const json = await request('GET', `/playlists/${id}/items`, { query: { limit: PAGE, offset } });
    if (!json || !json.items) break;
    total = json.total || 0;
    for (const it of json.items) {
      const t = normalizeTrack(playlistEntryTrack(it));
      if (t) items.push({ addedAt: it.added_at, track: t });
      else skipped++; // episodes, local files, removed tracks
    }
    if (!json.items.length) break;
    offset += PAGE;
  }
  return { total: Number.isFinite(total) ? total : items.length, skipped, items };
}
async function addPlaylistItems(id, uris) {
  for (const batch of chunk(uris, 100)) await request('POST', `/playlists/${id}/items`, { body: { uris: batch } });
  return true;
}
async function removePlaylistItems(id, uris) {
  for (const batch of chunk(uris, 100)) await request('DELETE', `/playlists/${id}/items`, { body: { items: batch.map(uri => ({ uri })) } });
  return true;
}

/* ---------- personalization (no /recommendations, no /related-artists: gone for good) ---------- */

const getRecentlyPlayed = ({ limit = 20 } = {}) => request('GET', '/me/player/recently-played', { query: { limit: Math.min(50, limit) } })
  .then(j => ((j && j.items) || []).map(it => ({ playedAt: it.played_at, track: normalizeTrack(it.track || it.item) })).filter(it => it.track));
const getTopItems = (type, { limit = 20 } = {}) => request('GET', `/me/top/${type}`, { query: { limit: Math.min(50, limit) } })
  .then(j => ((j && j.items) || []).map(x => type === 'tracks' ? normalizeTrack(x) : normalizeArtist(x)).filter(Boolean));

module.exports = {
  init, SpotifyError,
  search, getTrack, getArtist, getArtistAlbums, getAlbum, getAlbumTracks,
  getCachedTrack, getCachedAlbum, getCachedArtist, hasCachedTrack,
  getPlaybackState, getDevices, transferPlayback, playUris, playContext, pausePlayback, resumePlayback,
  seek, skipNext, skipPrevious, setShuffle, setRepeat, setVolume, addToQueue,
  getSavedTracks, getSavedAlbums, saveToLibrary, removeFromLibrary, checkLibrary,
  createPlaylist, getMyPlaylists, getPlaylist, getPlaylistItems, addPlaylistItems, removePlaylistItems,
  getRecentlyPlayed, getTopItems,
  _test: { request, normalizeTrack, normalizePlaylist, resetQueue: () => { pausedUntil = 0; activeReqs = 0; waiters.length = 0; }, resetCache: () => { cache = emptyCache(); meId = null; } }
};
