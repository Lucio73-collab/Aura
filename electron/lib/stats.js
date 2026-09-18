/* stats.js — listening stats from the play event log. Pure Node. */
let store = null;
let library = null;
function init(s, lib) { store = s; library = lib; }

const SPANS = { '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5, all: Infinity };

function getStats(range) {
  const now = Date.now();
  const span = SPANS[range] || Infinity;
  const events = store.plays().events.filter(e => now - e.ts <= span);

  const lib = library.getLibrary();
  const byId = new Map(lib.tracks.map(t => [t.id, t]));

  const trackMs = new Map(), artistMs = new Map(), albumMs = new Map(), trackPlays = new Map();
  let totalMs = 0;
  for (const e of events) {
    const t = byId.get(e.trackId);
    if (!t) continue;
    totalMs += e.ms;
    trackMs.set(t.id, (trackMs.get(t.id) || 0) + e.ms);
    trackPlays.set(t.id, (trackPlays.get(t.id) || 0) + 1);
    artistMs.set(t.artistKey, (artistMs.get(t.artistKey) || 0) + e.ms);
    if (t.albumId) albumMs.set(t.albumId, (albumMs.get(t.albumId) || 0) + e.ms);
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  const recent = [];
  const seen = new Set();
  for (let i = store.plays().events.length - 1; i >= 0 && recent.length < 20; i--) {
    const e = store.plays().events[i];
    if (seen.has(e.trackId) || !byId.has(e.trackId)) continue;
    seen.add(e.trackId);
    recent.push({ trackId: e.trackId, ts: e.ts });
  }

  return {
    range,
    minutes: Math.round(totalMs / 60000),
    plays: events.length,
    topTracks: top(trackMs, 12).map(([id, ms]) => ({ id, ms, plays: trackPlays.get(id) || 0 })),
    topArtists: top(artistMs, 10).map(([name, ms]) => ({ name, ms })),
    topAlbums: top(albumMs, 10).map(([id, ms]) => ({ id, ms })),
    recent
  };
}

/* Raw play events in a range, for the Stats page's time-based charts (weekday x
   hour terrain, 24h clock, per-album streamgraph). Compact rows [ts, ms, trackId],
   oldest first; read-only. `first` is the oldest event overall, so "All time"
   knows where its x-axis starts. */
function getEvents(range) {
  const now = Date.now();
  const span = SPANS[range] || Infinity;
  const all = store.plays().events;
  const events = [];
  for (const e of all) if (now - e.ts <= span) events.push([e.ts, e.ms, e.trackId]);
  return { range, now, first: all.length ? all[0].ts : null, events };
}

/* Recency-decayed taste profile: unlike topArtists/topAlbums (a flat sum over
   a fixed window), this weighs a play by how long ago it happened so a genre
   you binged two years ago doesn't outrank what you've actually been playing
   this month. Feeds the recommender (renderer's core.js recommend()) so Smart
   Shuffle/DJ picks reflect overall taste, not just the current queue's seeds. */
const HALF_LIFE_MS = 21 * 864e5;
const RECENT_WINDOW_MS = 14 * 864e5;

function getTasteProfile() {
  const now = Date.now();
  const lib = library.getLibrary();
  const byId = new Map(lib.tracks.map(t => [t.id, t]));
  const artistWeights = {}, genreWeights = {};
  const recentIds = new Set();

  for (const e of store.plays().events) {
    const t = byId.get(e.trackId);
    if (!t) continue;
    const ageMs = now - e.ts;
    const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
    const w = e.ms * decay;
    for (const name of (t.artists && t.artists.length ? t.artists : [t.artistKey])) {
      artistWeights[name] = (artistWeights[name] || 0) + w;
    }
    if (t.genre) genreWeights[t.genre] = (genreWeights[t.genre] || 0) + w;
    if (ageMs <= RECENT_WINDOW_MS) recentIds.add(t.id);
  }

  return { artistWeights, genreWeights, recentIds: [...recentIds] };
}

module.exports = { init, getStats, getEvents, getTasteProfile };
