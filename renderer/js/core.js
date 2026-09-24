/* core.js — state, utils, icons, indexing, recommendations */

const S = {
  tracks: [], albums: [], artists: [],
  byId: new Map(), albumById: new Map(), artistByName: new Map(),
  playlists: [], liked: new Map(), counts: {},
  settings: {},
  route: { name: 'home', arg: null, q: '' },
  ctxRegistry: {}, needsSetup: false,
  songSort: { key: 'title', dir: 1 }, plSort: {}, discoFilter: null,
  lyricsCache: new Map(),
  spTracks: new Map(),
  nas: { configured: false, state: 'unconfigured' }, // NAS connection status, see nas.js
  taste: { artistWeights: {}, genreWeights: {}, recentIds: [] },
  recentPlayed: []
};

/* Spotify calls go through here, never window.aura.sp* directly: a failure
   arrives as { __spotifyError, code, message } (see preload.js) and becomes
   a thrown Error with .code on this side of the bridge, where it survives. */
const spApi = new Proxy({}, {
  get: (_, name) => async (...args) => {
    const r = await window.aura[name](...args);
    if (r && r.__spotifyError) { const e = new Error(r.message || r.code); e.code = r.code; throw e; }
    return r;
  }
});

/* NAS calls go through here (window.aura.nas*): a failure arrives as
   { __nasError, code, message } and is thrown as an Error with .code. */
const nasApi = new Proxy({}, {
  get: (_, name) => async (...args) => {
    const r = await window.aura['nas' + name[0].toUpperCase() + name.slice(1)](...args);
    if (r && r.__nasError) { const e = new Error(r.message || r.code); e.code = r.code; throw e; }
    return r;
  }
});
// A NAS song that can't be played right now: the NAS is unreachable and it
// hasn't been downloaded for offline. Local (and Spotify) songs never are.
const isUnavailable = t => !!t && t.source === 'navidrome' && !t.offline && !!S.nas.configured && (S.nas.state === 'offline' || S.nas.state === 'auth-failed');

let ctxSeq = 0;
function listCtx(ids, name, sourceType, sourceId) {
  const k = 'c' + (++ctxSeq);
  S.ctxRegistry[k] = { ids, name, sourceType: sourceType || 'list', sourceId: sourceId || null };
  return k;
}

/* ---------- artist credit splitting ----------
   Mirrors electron/lib/artistName.js's SPLIT_RE - kept in sync by hand since
   this only needs to prefill the tag editor's Main/Featured fields, not
   decide any real grouping (that's still done server-side on rescan). */
const ARTIST_SPLIT_RE = /\s*,\s*|\s*&\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+vs\.?\s+|\s+x\s+/i;
function splitArtistCredit(name) {
  if (!name) return { main: '', featured: [] };
  const parts = name.split(ARTIST_SPLIT_RE).map(p => p.trim()).filter(Boolean);
  return { main: parts[0] || '', featured: parts.slice(1) };
}
function joinArtistCredit(main, featured) {
  main = (main || '').trim();
  const feats = featured.map(f => f.trim()).filter(Boolean);
  return feats.length ? `${main} feat. ${feats.join(', ')}` : main;
}

/* ---------- dom + format ---------- */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = s => { s = Math.max(0, Math.round(s || 0)); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };
const fmtLong = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? h + ' hr ' + m + ' min' : m + ' min'; };
const fmtDate = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtRelease = d => {
  if (!d) return '';
  if (/^\d{4}$/.test(d)) return d;
  const dt = new Date(d + 'T00:00:00');
  return isNaN(dt) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const TYPE_LABEL = { album: 'Album', single: 'Single', ep: 'EP', mixtape: 'Mixtape' };

// English Kokoro voices worth offering, best training-quality grade first
// (per hexgrad/Kokoro-82M's own VOICES.md). "am_onyx", Aura's old hardcoded
// default, is grade D - one of the weakest voices in the whole set, kept
// here only so it's still selectable, not as a good option.
const KOKORO_VOICES = [
  ['af_heart', 'A'], ['af_bella', 'A-'], ['af_nicole', 'B-'], ['bf_emma', 'B-'],
  ['af_aoede', 'C+'], ['af_sarah', 'C+'], ['af_kore', 'C+'], ['am_fenrir', 'C+'], ['am_michael', 'C+'], ['am_puck', 'C+'],
  ['bm_fable', 'C'], ['bm_george', 'C'], ['af_alloy', 'C'], ['af_nova', 'C'],
  ['af_sky', 'C-'], ['am_onyx', 'D']
];

// action: optional { label, act } - renders a clickable Undo-style button
// inside the toast and holds it onscreen longer so there's time to use it.
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label || 'Undo';
    btn.addEventListener('click', () => { clearTimeout(t._h); t.classList.remove('show'); action.act(); });
    t.appendChild(btn);
  }
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2400);
}

/* Local art at the size it's drawn at: mediaServer.js downscales /art and
   /cover images (?w=) so a 40px row thumbnail doesn't decode a 3000px
   original. Pick the width for the largest on-screen size at ~2x density.
   Spotify CDN urls and anything else pass through untouched. */
function artUrl(url, w) {
  if (!url || !/^\/(art|cover|nascover)\//.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'w=' + w;
}
const ART_SM = 128, ART_MD = 400, ART_LG = 640, ART_XL = 1024;

function avgColor(url) {
  url = artUrl(url, ART_SM);
  return new Promise(resolve => {
    if (!url) return resolve([88, 88, 104]);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 12;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, 12, 12);
        const d = x.getImageData(0, 0, 12, 12).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        resolve([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
      } catch { resolve([88, 88, 104]); }
    };
    img.onerror = () => resolve([88, 88, 104]);
    img.src = url;
  });
}

/* The plain average of a cover is usually mud. This weights every sampled
   pixel by saturation x brightness (so the colourful parts of the art win),
   then lifts the result into a range that glows on a near-black page. */
const vibrantCache = new Map();
function vibrantColor(url) {
  if (!url) return Promise.resolve([106, 165, 255]);
  url = artUrl(url, ART_SM); // sampled down to 28px anyway
  if (vibrantCache.has(url)) return vibrantCache.get(url);
  const job = new Promise(resolve => {
    const img = new Image();
    // remote (Spotify CDN) covers need CORS or the canvas read below throws
    if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const N = 28, c = document.createElement('canvas'); c.width = c.height = N;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, N, N);
        const d = x.getImageData(0, 0, N, N).data;
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let i = 0; i < d.length; i += 4) {
          const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2]);
          const sat = max ? (max - min) / max : 0, val = max / 255;
          const w = sat * sat * val + 0.002;
          r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; wsum += w;
        }
        let rgb = [r / wsum, g / wsum, b / wsum];
        // normalize brightness: scale so the strongest channel lands ~235,
        // then pull a little toward its own grey to keep it from going neon
        const peak = Math.max(...rgb) || 1;
        rgb = rgb.map(v => v * 235 / peak);
        const grey = (rgb[0] + rgb[1] + rgb[2]) / 3;
        resolve(rgb.map(v => Math.round(Math.max(40, v * 0.85 + grey * 0.15))));
      } catch { resolve([106, 165, 255]); }
    };
    img.onerror = () => resolve([106, 165, 255]);
    img.src = url;
  });
  vibrantCache.set(url, job);
  return job;
}

// Three distinct colors from a cover, most present first, for the Now Playing
// backdrop. Pixels go into a coarse RGB grid (vivid ones count extra), then
// buckets are taken in order as long as they differ enough from those taken.
const paletteCache = new Map();
function coverPalette(url) {
  const fallback = [[106, 165, 255], [64, 96, 190], [140, 110, 220]];
  if (!url) return Promise.resolve(fallback);
  url = artUrl(url, ART_SM); // sampled down to 40px anyway
  if (paletteCache.has(url)) return paletteCache.get(url);
  const job = new Promise(resolve => {
    const img = new Image();
    if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const N = 40, c = document.createElement('canvas'); c.width = c.height = N;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, N, N);
        const d = x.getImageData(0, 0, N, N).data;
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2], max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max ? (max - min) / max : 0;
          const w = 0.2 + sat * 1.6 * (max / 255);
          const k = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
          let e = buckets.get(k);
          if (!e) buckets.set(k, e = { r: 0, g: 0, b: 0, w: 0 });
          e.r += r * w; e.g += g * w; e.b += b * w; e.w += w;
        }
        const ranked = [...buckets.values()].sort((a, b) => b.w - a.w).map(e => [e.r / e.w, e.g / e.w, e.b / e.w]);
        const picks = [];
        for (const col of ranked) {
          if (picks.every(p => Math.hypot(p[0] - col[0], p[1] - col[1], p[2] - col[2]) > 72)) picks.push(col);
          if (picks.length === 3) break;
        }
        while (picks.length < 3) picks.push(picks.length ? picks[0].map(v => v * (picks.length === 1 ? 0.6 : 0.35)) : fallback[0]);
        // lift near-black picks just enough to read as color in the backdrop
        resolve(picks.map(p => { const peak = Math.max(...p, 1); return p.map(v => Math.round(peak < 70 ? v * 70 / peak : v)); }));
      } catch { resolve(fallback); }
    };
    img.onerror = () => resolve(fallback);
    img.src = url;
  });
  paletteCache.set(url, job);
  return job;
}

/* ---------- library indexing ---------- */

function indexLibrary(lib) {
  S.tracks = lib.tracks || [];
  S.albums = lib.albums || [];
  S.artists = lib.artists || [];
  S.counts = lib.counts || {};
  S.byId = new Map(S.tracks.map(t => [t.id, t]));
  // Spotify songs seen while browsing (search, artist/album pages, playlists)
  // live outside the scanned library; without re-adding them here, any
  // library refresh mid-song dropped the playing track and its queue.
  for (const [id, t] of S.spTracks) if (!S.byId.has(id)) S.byId.set(id, t);
  S.albumById = new Map(S.albums.map(a => [a.id, a]));
  S.artistByName = new Map(S.artists.map(a => [a.name, a]));
}

async function refreshLibrary(lib) {
  indexLibrary(lib || await window.aura.library());
  queueMissingArt();
}

/* ---------- background cover-art backfill ----------
   Quietly tries to fill in art for albums that have none (no embedded art,
   no user-set cover), one at a time with a gap between requests so it never
   bursts a pile of network calls at once. Each album is only ever attempted
   once per library (electron/lib/coverArt.js persists artFetchTried), and
   this whole thing is a no-op when the "fetch missing artwork online"
   setting is off. */
let artFetchQueue = [], artFetchBusy = false, artFetchSeen = new Set();
const ART_FETCH_SESSION_CAP = 80;

function queueMissingArt() {
  if (S.settings.fetchArt === false) return;
  for (const a of S.albums) {
    if (artFetchSeen.size >= ART_FETCH_SESSION_CAP) break;
    if (a.cover || a.custom || a.source === 'navidrome' || a.artFetchTried || artFetchSeen.has(a.id) || artFetchQueue.includes(a.id)) continue;
    artFetchQueue.push(a.id);
  }
  pumpArtFetch();
}

/* Covers arrive one album at a time; re-render once per batch instead of per
   cover, and hold off while the pointer is on the timeline so a hover preview
   isn't cut off mid-taste. */
const rerenderForArt = debounce(() => {
  if (typeof route !== 'function') return;
  if (document.querySelector('.timeline-wrap:hover')) { rerenderForArt(); return; }
  route();
}, 1200);

async function pumpArtFetch() {
  if (artFetchBusy || !artFetchQueue.length || S.settings.fetchArt === false) return;
  artFetchBusy = true;
  const id = artFetchQueue.shift();
  artFetchSeen.add(id);
  try {
    const res = await window.aura.albumFetchArt(id);
    if (res && res.ok) { indexLibrary(res.library); rerenderForArt(); }
  } catch {}
  setTimeout(() => { artFetchBusy = false; pumpArtFetch(); }, 400);
}

async function refreshTaste() {
  try {
    const [taste, all] = await Promise.all([window.aura.statsTaste(), window.aura.statsGet('all')]);
    S.taste = taste;
    S.recentPlayed = (all.recent || []).map(r => r.trackId);
  } catch { /* stats unavailable: recommend() falls back to no affinity boost, Home just skips Recently Played */ }
}

const trackList = ids => ids.map(id => S.byId.get(id)).filter(Boolean);
const albumTracks = a => trackList(a.trackIds || []);
const albumDuration = a => albumTracks(a).reduce((s, t) => s + t.duration, 0);

/* Spotify-style discography sort: dated releases newest first, undated after (by date added) */
function sortByRelease(albums) {
  return [...albums].sort((a, b) => {
    if (a.releaseDate && b.releaseDate) return b.releaseDate.localeCompare(a.releaseDate);
    if (a.releaseDate) return -1;
    if (b.releaseDate) return 1;
    return (b.dateAdded || 0) - (a.dateAdded || 0);
  });
}

function artistAlbums(name) {
  const ar = S.artistByName.get(name);
  if (!ar) return [];
  return sortByRelease(ar.albumIds.map(id => S.albumById.get(id)).filter(Boolean));
}

function artistImage(ar) {
  if (ar.image) return ar.image;
  const withCover = ar.albumIds.map(id => S.albumById.get(id)).filter(a => a && a.cover);
  return withCover.length ? sortByRelease(withCover)[0].cover : null;
}

/* ---------- recommendation engine (Smart Shuffle + DJ) ---------- */

function recommend(seedTracks, excludeIds, n = 1) {
  const w = { artist: new Map(), albumArtist: new Map(), genre: new Map() };
  for (const t of seedTracks) {
    if (!t) continue;
    // credit every named artist on a seed track (primary + features), not just
    // the primary, so a track someone features on can also surface a seed
    for (const name of (t.artists && t.artists.length ? t.artists : [t.artistKey])) {
      w.artist.set(name, (w.artist.get(name) || 0) + 1);
    }
    w.albumArtist.set(t.albumArtist, (w.albumArtist.get(t.albumArtist) || 0) + 1);
    if (t.genre) w.genre.set(t.genre, (w.genre.get(t.genre) || 0) + 1);
  }
  // overall taste (recency-decayed, from real listening history) rather than
  // just what's in the current context - normalized so it scales with the
  // other terms regardless of how much history exists
  const aw = S.taste.artistWeights || {}, gw = S.taste.genreWeights || {};
  const maxAW = Math.max(1, ...Object.values(aw)), maxGW = Math.max(1, ...Object.values(gw));

  const scored = [];
  for (const t of S.tracks) {
    if (excludeIds.has(t.id) || isUnavailable(t)) continue;
    let s = 0;
    const artists = t.artists && t.artists.length ? t.artists : [t.artistKey];
    for (const name of artists) s += (w.artist.get(name) || 0) * 5;
    s += (w.albumArtist.get(t.albumArtist) || 0) * 2.5;
    if (t.genre) s += (w.genre.get(t.genre) || 0) * 2;
    s += Math.max(0, ...artists.map(name => (aw[name] || 0) / maxAW)) * 3;
    if (t.genre) s += ((gw[t.genre] || 0) / maxGW) * 1.5;
    s += Math.min(S.counts[t.id] || 0, 10) * 0.3;
    s += Math.random() * 1.5;
    if (s > 1) scored.push([s, t]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const pool = scored.slice(0, 40);
  const picks = [];
  while (picks.length < n && pool.length) {
    const i = Math.floor(Math.pow(Math.random(), 2) * pool.length);
    picks.push(pool.splice(i, 1)[0][1]);
  }
  return picks;
}

/* Declustered shuffle: plain Fisher-Yates can (and often does) land two or
   three tracks by the same artist back to back, which reads as "not really
   random" (the well-known complaint about naive shuffle). This bucket the
   list by artistKey and round-robins across buckets so the same artist is
   spread out, then does a light randomized pass within that structure so
   it's not mechanically predictable either. */
function declusteredShuffle(arr) {
  const fy = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const buckets = new Map();
  for (const id of arr) {
    const t = S.byId.get(id);
    const key = t ? t.artistKey : '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(id);
  }
  const lists = fy([...buckets.values()].map(fy));
  const out = [];
  while (lists.some(l => l.length)) {
    for (const l of lists) if (l.length) out.push(l.shift());
  }
  return out;
}

/* "Made For You": taste-seeded picks with nothing recently played, using the
   same scoring recommend() already does for Smart Shuffle/DJ - passing no
   seed tracks means only the taste-affinity/genre/popularity terms apply. */
function madeForYou(n = 12) {
  if (!S.tracks.length || !Object.keys(S.taste.artistWeights || {}).length) return [];
  return recommend([], new Set(S.taste.recentIds || []), n);
}

/* Auto-generated genre mixes for Home, closer to Spotify's Daily Mixes than
   a raw "here's what you tagged as Rock" filter: prefers genres actually
   reflected in listening history (taste.genreWeights) over just whichever
   genre happens to have the most files, and falls back to plain frequency
   only when there's no play history yet. */
function topGenreMixes(maxMixes = 3, perMix = 30) {
  const byGenre = new Map();
  for (const t of S.tracks) {
    if (!t.genre) continue;
    if (!byGenre.has(t.genre)) byGenre.set(t.genre, []);
    byGenre.get(t.genre).push(t.id);
  }
  const gw = S.taste.genreWeights || {};
  const genres = [...byGenre.keys()]
    .filter(g => byGenre.get(g).length >= 6)
    .sort((a, b) => (gw[b] || 0) - (gw[a] || 0) || byGenre.get(b).length - byGenre.get(a).length)
    .slice(0, maxMixes);
  return genres.map(genre => ({ genre, ids: declusteredShuffle(byGenre.get(genre)).slice(0, perMix) }));
}

// topGenreMixes() re-shuffles its picks (declusteredShuffle uses Math.random)
// every time it runs, so calling it fresh from both the Home card and a
// mix's own detail page would show two different track lists for "the same"
// mix. Cache the generated set for the session (mirrors S.taste itself,
// which is likewise computed once at startup and never reshuffled mid-
// session) so opening a mix always shows exactly the tracks its card did.
let _homeMixesCache = null;
function homeMixes() {
  if (!_homeMixesCache) { _homeMixesCache = topGenreMixes(3, 30); _madeForYouCache = null; }
  return _homeMixesCache;
}
// Same for Made For You: Home re-renders in the background (covers fetched,
// folder changes), and re-rolling the picks each time reshuffled the list
// under the pointer. Rebuilt whenever the mixes are.
let _madeForYouCache = null;
function homeMadeForYou() {
  homeMixes();
  if (!_madeForYouCache) _madeForYouCache = madeForYou(8);
  return _madeForYouCache.filter(t => S.byId.has(t.id));
}

function topPlayedArtists(n) {
  const counts = new Map();
  for (const [id, c] of Object.entries(S.counts)) {
    const t = S.byId.get(id);
    if (t) counts.set(t.artistKey, (counts.get(t.artistKey) || 0) + c);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name]) => S.artistByName.get(name)).filter(Boolean);
}

/* ---------- icons ---------- */

const _st = i => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + i + '</svg>';
const _fl = i => '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + i + '</svg>';

const icons = {
  play: _fl('<path d="M8 5.14v13.72c0 .84.9 1.36 1.62.92l11.1-6.86a1.08 1.08 0 0 0 0-1.84L9.62 4.22C8.9 3.78 8 4.3 8 5.14Z"/>'),
  pause: _fl('<rect x="6.4" y="4.5" width="3.7" height="15" rx="1.3"/><rect x="13.9" y="4.5" width="3.7" height="15" rx="1.3"/>'),
  next: _fl('<path d="M5.5 5.65v12.7c0 .86.94 1.38 1.66.92L14.5 14.6v3.5a1.1 1.1 0 0 0 2.2 0V5.9a1.1 1.1 0 0 0-2.2 0v3.5L7.16 4.73C6.44 4.27 5.5 4.79 5.5 5.65Z"/>'),
  prev: _fl('<path d="M18.5 5.65v12.7c0 .86-.94 1.38-1.66.92L9.5 14.6v3.5a1.1 1.1 0 0 1-2.2 0V5.9a1.1 1.1 0 0 1 2.2 0v3.5l7.34-4.67c.72-.46 1.66.06 1.66.92Z"/>'),
  shuffle: _st('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>'),
  repeat: _st('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  sparkle: _fl('<path d="M12 2.8 13.9 8.9 20 10.8l-6.1 1.9L12 18.8l-1.9-6.1L4 10.8l6.1-1.9Z"/><path d="M18.6 3.2l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7Z"/>'),
  queue: _st('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>'),
  volume: _st('<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.8 5.2a9.2 9.2 0 0 1 0 13.6"/>'),
  mute: _st('<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m16 9 5 5"/><path d="m21 9-5 5"/>'),
  chevUp: _st('<path d="m6 15 6-6 6 6"/>'),
  chevDown: _st('<path d="m6 9 6 6 6-6"/>'),
  dots: _fl('<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>'),
  plus: _st('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  search: _st('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.2-4.2"/>'),
  home: _st('<path d="m3 10.5 9-7.5 9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>'),
  clock: _st('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  music: _st('<path d="M9 18V5.5L21 3v12.5"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="15.5" r="3"/>'),
  user: _st('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c.8-3.6 3.9-5.5 7.5-5.5s6.7 1.9 7.5 5.5"/>'),
  grid: _st('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
  heart: _st('<path d="M12 20.7S5.6 16.6 3.2 13C1.5 10.3 2.5 7 5.4 6.1c1.8-.5 3.7.2 4.8 1.7L12 9.6l1.8-1.8c1.1-1.5 3-2.2 4.8-1.7 2.9.9 3.9 4.2 2.2 6.9-2.4 3.6-8.8 7.7-8.8 7.7Z"/>'),
  chart: _st('<path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/>'),
  gear: _st('<path d="M4 8h10"/><circle cx="17" cy="8" r="2.5"/><path d="M20 16H10"/><circle cx="7" cy="16" r="2.5"/>'),
  edit: _st('<path d="M17 3.5a2.6 2.6 0 1 1 3.7 3.7L7.5 20.4 2.5 21.5l1.1-5Z"/>'),
  mic: _st('<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.5"/>'),
  image: _st('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m3.5 17.5 5-4.5 4 3.5 3.5-3 4.5 4"/>'),
  x: _st('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  check: _st('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  moon: _st('<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>'),
  refresh: _st('<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5"/><path d="M20 20v-4.5h-4.5"/>'),
  disc: _st('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 5.5a6.5 6.5 0 0 0-6.5 6.5"/>'),
  radio: _st('<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><path d="M19 5a10 10 0 0 1 0 14"/><path d="M5 19A10 10 0 0 1 5 5"/>'),
  copy: _st('<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>'),
  listPlus: _st('<path d="M3.5 6h11"/><path d="M3.5 12h11"/><path d="M3.5 18h7"/><path d="M18 14v7"/><path d="M14.5 17.5h7"/>'),
  playNext: _st('<path d="M3.5 6h10"/><path d="M3.5 12h7"/><path d="M3.5 18h7"/><path d="M15 11.5v8l6-4Z"/>'),
  trash: _st('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5.5 7l1 12.5A2 2 0 0 0 8.5 21h7a2 2 0 0 0 2-1.5L18.5 7"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>'),
  back: _st('<path d="m15 5-7 7 7 7"/>'),
  forward: _st('<path d="m9 5 7 7-7 7"/>'),
  verified: _fl('<path d="M12 2.5l2.3 1.7 2.8-.2.9 2.7 2.4 1.5-.8 2.7.8 2.8-2.4 1.5-.9 2.7-2.8-.2L12 21.5l-2.3-1.7-2.8.2-.9-2.7L3.6 15.8l.8-2.8-.8-2.7L6 8.7l.9-2.7 2.8.2Z"/><path d="m8.6 12.2 2.3 2.3 4.6-4.8" fill="none" stroke="#0e0f12" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  tag: _st('<path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.2 8.2a1.5 1.5 0 0 1 0 2.1l-6.7 6.7a1.5 1.5 0 0 1-2.1 0Z"/><circle cx="8" cy="8" r="1.4"/>'),
  calendar: _st('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>')
};
const icon = n => icons[n] || '';
