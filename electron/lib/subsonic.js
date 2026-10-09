/* subsonic.js - Subsonic 1.16.1 / OpenSubsonic API client. Pure Node (global
   fetch, injectable for tests), no Electron. Talks to Navidrome but sticks to
   the documented API:
     https://www.subsonic.org/pages/api.jsp
     https://opensubsonic.netlify.app/docs/opensubsonic-api/

   Auth is either OpenSubsonic API key (`apiKey`), or Subsonic token auth:
   t = md5(password + s), s = a fresh random salt per request. The plain
   password is never put on the wire. Every URL or message that leaves this
   module for logging goes through maskSecrets(). */
const crypto = require('crypto');

const CLIENT_NAME = 'Aura';
const DEFAULT_API_VERSION = '1.16.1';
const DEFAULT_TIMEOUT_MS = 8000;

const SECRET_PARAMS = ['u', 't', 's', 'p', 'apiKey', 'jwt', 'password'];

class SubsonicError extends Error {
  /* code: OFFLINE | TIMEOUT | HTTP | BAD_RESPONSE | AUTH | FORBIDDEN | NOT_FOUND | VERSION | API
     apiCode: the numeric Subsonic error code when the server sent one */
  constructor(code, message, apiCode) {
    super(maskSecrets(message || code));
    this.code = code;
    if (apiCode != null) this.apiCode = apiCode;
  }
}

/* Strips credential query params (and anything that looks like one) from a
   URL or message so it is safe to log or show. */
function maskSecrets(text) {
  let out = String(text == null ? '' : text);
  for (const k of SECRET_PARAMS) out = out.replace(new RegExp('([?&]' + k + '=)[^&\\s"\']*', 'g'), '$1***');
  return out;
}

const md5hex = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const randomSalt = () => crypto.randomBytes(8).toString('hex'); // 16 hex chars, spec asks for >= 6

/* The auth-related query params for one request. */
function authParams({ user, password, apiKey, salt } = {}) {
  if (apiKey) return { apiKey };
  if (!user || password == null || password === '') throw new SubsonicError('AUTH', 'Missing username or password');
  const s = salt || randomSalt();
  return { u: user, t: md5hex(String(password) + s), s };
}

/* "192.168.2.210:4533" -> "http://192.168.2.210:4533", trailing slashes dropped. */
function normalizeBaseUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

/* params values may be arrays (repeated keys, like songId) or null/undefined (skipped). */
function buildUrl(baseUrl, method, params = {}, auth = {}, common = {}) {
  const url = new URL(normalizeBaseUrl(baseUrl) + '/rest/' + method + '.view');
  const all = { ...auth, v: common.apiVersion || DEFAULT_API_VERSION, c: common.clientName || CLIENT_NAME, f: 'json', ...params };
  for (const [k, v] of Object.entries(all)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/* Unwraps { "subsonic-response": { status, ... } } or throws SubsonicError. */
function parseEnvelope(json) {
  const r = json && json['subsonic-response'];
  if (!r || typeof r !== 'object') throw new SubsonicError('BAD_RESPONSE', 'Not a Subsonic response');
  if (r.status === 'ok') return r;
  const err = r.error || {};
  const n = Number(err.code);
  const code = [40, 41, 42, 43, 44].includes(n) ? 'AUTH' : n === 50 ? 'FORBIDDEN' : n === 70 ? 'NOT_FOUND' : (n === 20 || n === 30) ? 'VERSION' : 'API';
  throw new SubsonicError(code, err.message || ('Subsonic error ' + n), Number.isFinite(n) ? n : undefined);
}

const arr = x => (Array.isArray(x) ? x : x == null ? [] : [x]);

/* ---------- normalization: Subsonic/OpenSubsonic -> Aura's track shape ---------- */

const coverPath = id => (id ? '/nascover/' + encodeURIComponent(id) : null);
const pad2 = n => String(n).padStart(2, '0');
function dateParts(d) {
  if (!d || !d.year) return null;
  return d.month ? (d.day ? `${d.year}-${pad2(d.month)}-${pad2(d.day)}` : `${d.year}-${pad2(d.month)}-01`) : `${d.year}-01-01`;
}
const albumType = a => {
  const types = arr(a && a.releaseTypes).map(x => String(x).toLowerCase());
  if (types.includes('single')) return 'single';
  if (types.includes('ep')) return 'ep';
  return 'album';
};

/* `album` is the AlbumID3 the song came from (getAlbum), used for the fields
   a Child does not carry: release date, release type, a stable cover id. */
function normalizeSong(s, album) {
  if (!s || !s.id) return null;
  const artists = arr(s.artists).map(a => a && a.name).filter(Boolean);
  const artist = s.displayArtist || s.artist || artists.join(', ') || 'Unknown Artist';
  const albumArtist = s.displayAlbumArtist || (album && (album.displayArtist || album.artist)) || arr(s.albumArtists).map(a => a.name).filter(Boolean).join(', ') || artists[0] || s.artist || 'Unknown Artist';
  const albumId = s.albumId || (album && album.id) || null;
  const genre = (arr(s.genres)[0] && arr(s.genres)[0].name) || s.genre || null;
  const t = {
    id: 'nd:' + s.id, source: 'navidrome', remoteId: String(s.id), fileName: null,
    title: s.title || 'Untitled',
    artist, artists: artists.length ? artists : [artist], albumArtist,
    album: s.album || (album && album.name) || '',
    albumKey: 'nd-' + (albumId || ('s' + s.id)), nasAlbumId: albumId,
    trackNo: s.track || 0, discNo: s.discNumber || 1,
    year: s.year || (album && album.year) || null,
    genre,
    duration: Math.round(s.duration || 0),
    dateAdded: (s.created && Date.parse(s.created)) || (album && album.created && Date.parse(album.created)) || 0,
    hasArt: false,
    cover: coverPath((album && album.coverArt) || s.coverArt),
    suffix: s.suffix || null, contentType: s.contentType || null, bitRate: s.bitRate || null, size: s.size || null,
    albumType: album ? albumType(album) : albumType(s),
    albumReleaseDate: album ? (dateParts(album.originalReleaseDate) || dateParts(album.releaseDate)) : null
  };
  if (s.bpm) t.bpm = s.bpm;
  if (s.replayGain && (s.replayGain.trackGain != null || s.replayGain.albumGain != null)) {
    t.replayGain = { trackGain: s.replayGain.trackGain ?? null, albumGain: s.replayGain.albumGain ?? null };
  }
  if (s.musicBrainzId) t.musicBrainzId = s.musicBrainzId;
  return t;
}

/* ---------- client ---------- */

class SubsonicClient {
  constructor({ baseUrl, user, password, apiKey, apiVersion, clientName, fetch: f, timeoutMs } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.user = user; this.password = password; this.apiKey = apiKey;
    this.apiVersion = apiVersion || DEFAULT_API_VERSION;
    this.clientName = clientName || CLIENT_NAME;
    this.fetch = f || ((...a) => fetch(...a));
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  auth() { return authParams({ user: this.user, password: this.password, apiKey: this.apiKey }); }

  url(method, params) {
    return buildUrl(this.baseUrl, method, params, this.auth(), { apiVersion: this.apiVersion, clientName: this.clientName });
  }

  /* One API call -> the unwrapped subsonic-response body. */
  async call(method, params, { timeoutMs } = {}) {
    const url = this.url(method, params);
    let res;
    try { res = await this.fetch(url, { signal: AbortSignal.timeout(timeoutMs || this.timeoutMs) }); }
    catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new SubsonicError('TIMEOUT', 'The server did not respond in time');
      const cause = e && e.cause && (e.cause.code || e.cause.message);
      throw new SubsonicError('OFFLINE', 'Could not reach the server' + (cause ? ' (' + cause + ')' : ''));
    }
    if (!res.ok) throw new SubsonicError('HTTP', 'Server answered HTTP ' + res.status);
    let json;
    try { json = JSON.parse(await res.text()); } catch { throw new SubsonicError('BAD_RESPONSE', 'The server did not send JSON'); }
    return parseEnvelope(json);
  }

  async ping() {
    const r = await this.call('ping');
    return { version: r.version, type: r.type || null, serverVersion: r.serverVersion || null, openSubsonic: !!r.openSubsonic };
  }
  async getOpenSubsonicExtensions() {
    try { return arr((await this.call('getOpenSubsonicExtensions')).openSubsonicExtensions); }
    catch (e) { if (e.code === 'AUTH' || e.code === 'OFFLINE' || e.code === 'TIMEOUT') throw e; return []; }
  }

  async getArtists() {
    const r = await this.call('getArtists');
    const out = [];
    for (const idx of arr(r.artists && r.artists.index)) for (const a of arr(idx.artist)) out.push({ id: a.id, name: a.name, albumCount: a.albumCount || 0, coverArt: a.coverArt || null });
    return out;
  }
  async getArtist(id) {
    const a = (await this.call('getArtist', { id })).artist || {};
    return { id: a.id, name: a.name, albums: arr(a.album) };
  }
  /* -> { album (AlbumID3 without songs), tracks (normalized) } */
  async getAlbum(id) {
    const a = (await this.call('getAlbum', { id })).album;
    if (!a) throw new SubsonicError('NOT_FOUND', 'Album not found', 70);
    const { song, ...album } = a;
    return { album, tracks: arr(song).map(s => normalizeSong(s, album)).filter(Boolean) };
  }
  /* One page of albums; size max is 500 (spec). */
  async getAlbumList2({ type = 'alphabeticalByName', size = 500, offset = 0 } = {}) {
    const r = await this.call('getAlbumList2', { type, size: Math.min(500, size), offset });
    return arr(r.albumList2 && r.albumList2.album);
  }
  async search3(query, { artistCount = 20, albumCount = 20, songCount = 40 } = {}) {
    const r = (await this.call('search3', { query, artistCount, albumCount, songCount })).searchResult3 || {};
    return { artists: arr(r.artist), albums: arr(r.album), songs: arr(r.song).map(s => normalizeSong(s, null)).filter(Boolean) };
  }

  async getPlaylists() { return arr(((await this.call('getPlaylists')).playlists || {}).playlist); }
  async getPlaylist(id) {
    const p = (await this.call('getPlaylist', { id })).playlist || {};
    const { entry, ...meta } = p;
    return { ...meta, songs: arr(entry).map(s => normalizeSong(s, null)).filter(Boolean) };
  }
  async createPlaylist(name, songIds = []) {
    const p = (await this.call('createPlaylist', { name, songId: songIds })).playlist;
    return p ? { id: p.id, name: p.name } : null;
  }
  /* Replaces the whole song list of an existing playlist. */
  async replacePlaylist(playlistId, songIds) { await this.call('createPlaylist', { playlistId, songId: songIds }); }
  async updatePlaylist(playlistId, { name, songIdToAdd, songIndexToRemove } = {}) {
    await this.call('updatePlaylist', { playlistId, name, songIdToAdd, songIndexToRemove });
  }
  async deletePlaylist(id) { await this.call('deletePlaylist', { id }); }

  /* submission=false is "now playing"; true records a play. */
  async scrobble(id, { submission = true, time } = {}) {
    await this.call('scrobble', { id, submission: submission ? 'true' : 'false', time });
  }

  /* Direct (authenticated) URLs. These embed a per-request token, so they are
     only ever fetched by the main process, never handed to the renderer. */
  coverArtUrl(id, size) { return this.url('getCoverArt', { id, size }); }
  streamUrl(id, { format, maxBitRate, timeOffset } = {}) {
    const transcode = !!(format && format !== 'raw') || maxBitRate > 0;
    return this.url('stream', { id, format, maxBitRate: maxBitRate || undefined, timeOffset, estimateContentLength: transcode ? 'true' : undefined });
  }
  downloadUrl(id) { return this.url('download', { id }); }
}

module.exports = {
  SubsonicClient, SubsonicError, maskSecrets, authParams, buildUrl, parseEnvelope,
  normalizeSong, normalizeBaseUrl, md5hex, randomSalt, CLIENT_NAME, DEFAULT_API_VERSION
};
