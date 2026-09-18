/* lyrics.js — embedded tags, .lrc/.txt sidecars, LRCLIB fetch. Pure Node. */
const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');

let store = null;
let library = null;
function init(s, lib) { store = s; library = lib; }

/* "[mm:ss.xx] line" -> [[seconds, text], ...] */
function parseLRC(text) {
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const line = rawLine.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const sec = (+m[1]) * 60 + (+m[2]) + (m[3] ? +('0.' + m[3]) : 0);
      out.push([sec, line]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.length ? out : null;
}

async function getLyrics(trackId) {
  const saved = store.lyrics()[trackId];
  if (saved) return saved;

  const file = library.filePath(trackId);
  if (!file) return null;
  const base = file.replace(/\.[^.]+$/, '');

  for (const ext of ['.lrc', '.txt']) {
    try {
      const text = fs.readFileSync(base + ext, 'utf8');
      const synced = ext === '.lrc' ? parseLRC(text) : null;
      return { synced, plain: synced ? null : text.trim(), source: 'sidecar' };
    } catch {}
  }

  try {
    const meta = await mm.parseFile(file);
    const lyr = meta.common.lyrics && meta.common.lyrics[0];
    const text = typeof lyr === 'string' ? lyr : (lyr && (lyr.text || lyr.syncText)) || null;
    if (text) {
      const synced = parseLRC(text);
      return { synced, plain: synced ? null : String(text).trim(), source: 'embedded' };
    }
  } catch {}
  return null;
}

function saveLyrics(trackId, text) {
  const synced = parseLRC(text);
  const data = { synced, plain: synced ? null : String(text || '').trim(), source: 'manual' };
  store.lyricsSave(trackId, data);
  return data;
}

const LRCLIB_HEADERS = { 'User-Agent': 'Aura/1.0 (local music player)' };

function fromLRCLIBHit(j) {
  const synced = j.syncedLyrics ? parseLRC(j.syncedLyrics) : null;
  const plain = !synced && j.plainLyrics ? j.plainLyrics.trim() : null;
  return synced || plain ? { synced, plain, source: 'lrclib' } : null;
}

async function fetchLRCLIB({ artist, title, album, duration }) {
  const qs = new URLSearchParams({
    artist_name: artist || '', track_name: title || '',
    album_name: album || '', duration: String(duration || '')
  });
  try {
    const r = await fetch('https://lrclib.net/api/get?' + qs, { headers: LRCLIB_HEADERS, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const hit = fromLRCLIBHit(await r.json());
      if (hit) return hit;
    }
  } catch {}
  // /api/get is an exact match keyed on duration; a track with slightly-off
  // tag duration (common with VBR mp3s) misses there even when lyrics exist.
  // /api/search is a fuzzy fallback that doesn't require duration to line up.
  try {
    const qs = new URLSearchParams({ artist_name: artist || '', track_name: title || '' });
    const r = await fetch('https://lrclib.net/api/search?' + qs, { headers: LRCLIB_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const results = await r.json();
    if (!Array.isArray(results) || !results.length) return null;
    for (const j of results) {
      const hit = fromLRCLIBHit(j);
      if (hit) return hit;
    }
    return null;
  } catch { return null; }
}

module.exports = { init, parseLRC, getLyrics, saveLyrics, fetchLRCLIB };
