/* store.js — JSON persistence. Pure Node, initialized with a data dir. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DIR = null;
const FILES = {};
const mem = {};

// A file that exists but won't parse (a typo from fixing it by hand) would
// otherwise load as defaults and be overwritten by the next save, wiping
// playlists or every album edit. Set the broken copy aside first.
function loadStoreFile(f) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { return null; }
  try { return JSON.parse(text); } catch (e) {
    const aside = f.replace(/\.json$/, '') + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    try { fs.copyFileSync(f, aside); } catch {}
    console.warn('store: could not parse', f, '(' + e.message + '), kept a copy at', aside);
    return null;
  }
}
// Written to a temp file and renamed over the real one, so a crash or power
// cut mid-write can never leave a half-written (unparseable) JSON file behind.
const writeJSON = (f, d, pretty) => {
  try {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, pretty ? JSON.stringify(d, null, 2) : JSON.stringify(d));
    fs.renameSync(tmp, f);
  } catch (e) { console.warn('store write failed:', f, e.message); }
};
// Files people open and fix by hand stay indented; the machine-only ones
// (lyrics.json alone is over a megabyte) are written compact.
const PRETTY = new Set(['settings', 'playlists', 'overrides']);

const DEFAULTS = {
  settings: {
    musicFolders: [],
    crossfade: 5,
    automix: true,
    normalize: true,
    fetchArt: true,
    autoLyrics: true,
    autoplay: true,
    volume: 0.9,
    repeat: 'off',
    djVoiceEnabled: true,
    djVoice: 'af_heart', // grade A per hexgrad/Kokoro-82M's own VOICES.md - the old default, am_onyx, is grade D
    djModel: null,
    djEvery: 4,
    autoLaunchOllama: true,
    ollamaUrl: 'http://127.0.0.1:11434',
    // app + window
    openAtLogin: false,
    startHidden: false,       // only applies to a launch-at-login start (--hidden)
    closeToTray: true,
    mediaKeys: true,
    miniOnTop: true,
    miniBounds: null,         // { x, y } where the mini player was last dragged
    notifyTrackChange: false,
    zoom: 1,
    windowBounds: null,       // { x, y, width, height, maximized }
    // playback
    resumeOnLaunch: false,
    fadePause: true,
    prevRestartSec: 3,        // 0 = Previous always goes back a song
    seekStep: 5,
    volumeStep: 5,
    monoAudio: false,
    // interface
    startPage: 'home',        // a route name, or 'last'
    lastRoute: null,
    accent: 'blue',
    reduceMotion: 'system',   // 'system' | 'on' | 'off'
    npVisuals: true,
    lyricsSize: 'm',
    showRemaining: false,
    // library
    watchFolders: true
  },
  playlists: [],            // { id, name, createdAt, items:[{trackId, addedAt}] }
  liked: [],                // [{ trackId, addedAt }]
  plays: { counts: {}, events: [] }, // events: [{trackId, ts, ms}] capped
  overrides: { tracks: {}, albums: {}, customAlbums: [], artists: [] },
  lyrics: {},               // trackId -> { synced: [[sec,text],...] | null, plain: string | null, source }
  loudness: {},             // trackId -> linear gain compensation factor, measured client-side
  // last-played state, restored (paused, never auto-audible) on next launch
  // so closing and reopening Aura doesn't lose your place. `ctx` mirrors just
  // enough of the renderer's queue context (P.ctx) to keep browsing forward
  // from the same list; recommendations/autoplay tails are not persisted.
  session: { trackId: null, positionSec: 0, ctx: null, shuffle: false, repeat: 'off', updatedAt: 0 }
};

function init(dataDir) {
  DIR = dataDir;
  fs.mkdirSync(path.join(DIR, 'covers'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'art'), { recursive: true });
  for (const k of Object.keys(DEFAULTS)) {
    FILES[k] = path.join(DIR, k + '.json');
    const loaded = loadStoreFile(FILES[k]);
    mem[k] = loaded === null
      ? JSON.parse(JSON.stringify(DEFAULTS[k]))
      : (Array.isArray(DEFAULTS[k]) ? loaded : { ...JSON.parse(JSON.stringify(DEFAULTS[k])), ...loaded });
  }
}

// Re-reads every JSON file back off disk into mem, discarding whatever was
// there in memory. For picking up edits made outside Aura (a hand-fixed
// overrides.json, a restored backup) without a full app restart - same
// merge-with-defaults logic as init(), just skipped the dir/FILES setup.
function reload() {
  flush(); // changes made in Aura before the reload were already on disk before this batching existed
  for (const k of Object.keys(DEFAULTS)) {
    const loaded = loadStoreFile(FILES[k]);
    mem[k] = loaded === null
      ? JSON.parse(JSON.stringify(DEFAULTS[k]))
      : (Array.isArray(DEFAULTS[k]) ? loaded : { ...JSON.parse(JSON.stringify(DEFAULTS[k])), ...loaded });
  }
}

/* Saves are coalesced: a burst of changes (a volume drag, a batch of
   overrides, loudness measured across an album) becomes one write shortly
   after the last change, instead of re-serializing the whole file on the main
   thread for every single one. main.js flushes on quit. */
const SAVE_DELAY = 400;
const dirty = new Set();
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  for (const k of dirty) writeJSON(FILES[k], mem[k], PRETTY.has(k));
  dirty.clear();
}
const save = k => { dirty.add(k); if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY); };
const id16 = s => crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 16);
const newId = () => id16('x' + Date.now() + Math.random());

module.exports = {
  init, reload, flush, id16, newId,
  dir: () => DIR,
  coversDir: () => path.join(DIR, 'covers'),
  artDir: () => path.join(DIR, 'art'),

  settings: () => mem.settings,
  setSettings(patch) { Object.assign(mem.settings, patch || {}); save('settings'); return mem.settings; },
  // Back to defaults for preferences only: library folders, the NAS server
  // setup, the DJ model pick, volume/repeat and window placement are state,
  // not preferences.
  resetSettings() {
    const keep = {};
    for (const k of ['musicFolders', 'nas', 'djModel', 'djModelChosen', 'volume', 'repeat', 'windowBounds', 'miniBounds', 'lastRoute']) {
      if (k in mem.settings) keep[k] = mem.settings[k];
    }
    mem.settings = { ...JSON.parse(JSON.stringify(DEFAULTS.settings)), ...keep };
    save('settings'); return mem.settings;
  },

  playlists: () => mem.playlists,
  plCreate(name) {
    const pl = { id: newId(), name: (name || 'New Playlist').trim() || 'New Playlist', createdAt: Date.now(), items: [] };
    mem.playlists.push(pl); save('playlists'); return pl;
  },
  plUpdate(plId, patch) {
    const pl = mem.playlists.find(p => p.id === plId); if (!pl) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) pl.name = patch.name.trim();
    if (Array.isArray(patch.items)) pl.items = patch.items.filter(i => i && i.trackId);
    if (typeof patch.coverFile === 'string') pl.coverFile = patch.coverFile;
    save('playlists'); return pl;
  },
  plDelete(plId) { mem.playlists = mem.playlists.filter(p => p.id !== plId); save('playlists'); return true; },
  plAdd(plId, trackIds) {
    const pl = mem.playlists.find(p => p.id === plId); if (!pl) return null;
    for (const tid of [].concat(trackIds)) {
      if (tid && !pl.items.some(i => i.trackId === tid)) pl.items.push({ trackId: tid, addedAt: Date.now() });
    }
    save('playlists'); return pl;
  },
  plRemove(plId, trackId) {
    const pl = mem.playlists.find(p => p.id === plId); if (!pl) return null;
    pl.items = pl.items.filter(i => i.trackId !== trackId);
    save('playlists'); return pl;
  },

  liked: () => mem.liked,
  likedToggle(trackId) {
    const i = mem.liked.findIndex(l => l.trackId === trackId);
    if (i >= 0) mem.liked.splice(i, 1); else mem.liked.unshift({ trackId, addedAt: Date.now() });
    save('liked'); return mem.liked;
  },

  plays: () => mem.plays,
  logPlay({ trackId, ms, counted }) {
    if (!trackId || !ms) return mem.plays;
    mem.plays.events.push({ trackId, ts: Date.now(), ms: Math.round(ms) });
    if (mem.plays.events.length > 25000) mem.plays.events = mem.plays.events.slice(-20000);
    if (counted) mem.plays.counts[trackId] = (mem.plays.counts[trackId] || 0) + 1;
    save('plays'); return mem.plays;
  },
  resetPlays() { mem.plays = { counts: {}, events: [] }; save('plays'); return mem.plays; },

  overrides: () => mem.overrides,
  overrideTrack(trackId, patch) {
    const cur = mem.overrides.tracks[trackId] || {};
    const next = { ...cur, ...patch };
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null) delete next[k];
    if (Object.keys(next).length) mem.overrides.tracks[trackId] = next; else delete mem.overrides.tracks[trackId];
    save('overrides'); return next;
  },
  overrideAlbum(albumKey, patch) {
    const cur = mem.overrides.albums[albumKey] || {};
    mem.overrides.albums[albumKey] = { ...cur, ...patch };
    save('overrides'); return mem.overrides.albums[albumKey];
  },
  albumUpsert(data) {
    let al = data.id ? mem.overrides.customAlbums.find(a => a.id === data.id) : null;
    if (!al) {
      al = { id: newId(), createdAt: Date.now(), trackIds: [], type: 'album', unreleased: false };
      mem.overrides.customAlbums.push(al);
    }
    for (const k of ['title', 'artist', 'releaseDate', 'type', 'unreleased', 'coverFile']) {
      if (data[k] !== undefined) al[k] = data[k];
    }
    if (Array.isArray(data.trackIds)) al.trackIds = data.trackIds;
    save('overrides'); return al;
  },
  albumDelete(albumId) {
    mem.overrides.customAlbums = mem.overrides.customAlbums.filter(a => a.id !== albumId);
    save('overrides'); return true;
  },
  albumSetTracks(albumId, trackIds) {
    const al = mem.overrides.customAlbums.find(a => a.id === albumId); if (!al) return null;
    al.trackIds = [...new Set(trackIds)];
    save('overrides'); return al;
  },
  artistUpsert(data) {
    let ar = data.id ? mem.overrides.artists.find(a => a.id === data.id) : null;
    if (!ar) { ar = { id: newId(), createdAt: Date.now() }; mem.overrides.artists.push(ar); }
    for (const k of ['name', 'imageFile']) if (data[k] !== undefined) ar[k] = data[k];
    save('overrides'); return ar;
  },
  artistDelete(artistId) {
    mem.overrides.artists = mem.overrides.artists.filter(a => a.id !== artistId);
    save('overrides'); return true;
  },

  lyrics: () => mem.lyrics,
  lyricsSave(trackId, data) { mem.lyrics[trackId] = data; save('lyrics'); return data; },
  // drops only what was looked up online (LRCLIB), never lyrics typed in by hand
  lyricsClearFetched() {
    let n = 0;
    for (const [id, v] of Object.entries(mem.lyrics)) if (!v || v.source === 'lrclib') { delete mem.lyrics[id]; n++; }
    save('lyrics'); return n;
  },

  loudness: () => mem.loudness,
  loudnessSet(trackId, factor) { mem.loudness[trackId] = factor; save('loudness'); return factor; },
  loudnessClear() { const n = Object.keys(mem.loudness).length; mem.loudness = {}; save('loudness'); return n; },

  session: () => mem.session,
  sessionSave(patch) { mem.session = { ...mem.session, ...patch, updatedAt: Date.now() }; save('session'); return mem.session; }
};
