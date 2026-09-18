/* normalize.js — shared tag-cleanup rules used both automatically at scan
   time (title only, never touches files) and by the "Fix tags" album editor
   (title/artist/album/date/genre, only written to files on explicit
   request). Mirrors scripts/normalize-album.py so the two stay in sync;
   the Python script is the standalone CLI form, this is the in-app form. */

// leading \b: "ft" inside a word ("Left Behind", "Swift") is not a feature credit
const FEAT_RE = /\s*[([]?\s*\b(feat\.?|ft\.?|featuring)\b.*$/i;
const JUNK_PAREN_RE = /\s*[([]\s*(official\s*(video|audio|music\s*video)?|lyrics?(\s*video)?|hq|hd|explicit|clean|audio|video|short\s*version|version\s*\d*|extended(\s*version)?|full\s*song|visualizer)\s*[)\]]\s*$/i;
// A trailing "[WHxRd_va950]"-style yt-dlp video-id suffix - NOT just any
// bracketed 6-15 char word. Requires at least one digit inside the
// brackets, since a real video id always has one and a legitimate title
// suffix that happens to be 6-15 letters (like "(Interlude)") never should
// be read as one - that used to strip it down to the same title as the
// album's other, unrelated "(Interlude)"-less track, making two different
// songs collide and look like a duplicate in the tracklist.
const TRAILING_ID_RE = /\s*[([](?=[A-Za-z0-9_-]{6,15}[)\]]\s*$)(?=[^)\]]*\d)[A-Za-z0-9_-]+[)\]]\s*$/;
const LEADING_NUM_RE = /^\s*(\d{1,3})[\s._-]+/;

// yt-dlp / ffmpeg leave these behind on the Ogg family; they don't belong
// on a music file and clutter every tag viewer.
const JUNK_VORBIS_FIELDS = ['PURL', 'SYNOPSIS', 'DESCRIPTION', 'LANGUAGE', 'ENCODER', 'COMMENT'];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Folds case, accents and the handful of "same character, different
// codepoint" variants rippers disagree on (curly vs straight quotes,
// stacked whitespace) into one canonical form. Used ONLY for the grouping
// key, never for anything shown on screen: two rips of the same album
// tagged "808's & Heartbreak" and "808’s & Heartbreak" (straight vs
// curly apostrophe) must land in the same album, not silently split into
// two, just because one ripper's apostrophe differs from another's.
function normalizeForKey(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')       // strip accents
    .replace(/[‘’ʼ＇´`]/g, "'")       // curly/alt apostrophes -> straight
    .replace(/[“”]/g, '"')                          // curly quotes -> straight
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cleanTitle(rawTitle, artist) {
  if (!rawTitle) return rawTitle;
  let t = rawTitle.trim();
  if (artist) {
    const lead = new RegExp('^\\s*' + escapeRe(artist) + '\\s*[-:]\\s*', 'i');
    t = t.replace(lead, '');
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of [FEAT_RE, JUNK_PAREN_RE, TRAILING_ID_RE]) {
      const next = t.replace(re, '').trim();
      if (next !== t) { t = next; changed = true; }
    }
  }
  return t.trim() || rawTitle.trim();
}

function titleFromFilename(filename, artist) {
  const base = filename.replace(/\.[^.]+$/, '').replace(LEADING_NUM_RE, '');
  return cleanTitle(base, artist);
}

function trackNumberFromFilename(filename, fallback) {
  const m = LEADING_NUM_RE.exec(filename);
  return m ? +m[1] : fallback;
}

/* Best-effort MusicBrainz lookup of the earliest official release date for
   an artist + release-group. Returns 'YYYY-MM-DD'/'YYYY' or null. Retries
   once on a transient 503 (MusicBrainz throttles anonymous callers). */
async function lookupReleaseDate(artist, album) {
  const qs = new URLSearchParams({ query: `artist:"${artist}" AND releasegroup:"${album}"`, fmt: 'json', limit: '5' });
  const url = 'https://musicbrainz.org/ws/2/release-group/?' + qs;
  const headers = { 'User-Agent': 'Aura/1.0 (local music player, personal use)' };
  for (const attempt of [1, 2]) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) {
        if (r.status === 503 && attempt === 1) { await new Promise(res => setTimeout(res, 1500)); continue; }
        return null;
      }
      const data = await r.json();
      const groups = data['release-groups'] || [];
      if (!groups.length) return null;
      const exact = groups.filter(g => (g.title || '').toLowerCase() === album.toLowerCase());
      const best = (exact.length ? exact : groups)[0];
      return best['first-release-date'] || null;
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = { cleanTitle, titleFromFilename, trackNumberFromFilename, lookupReleaseDate, normalizeForKey, JUNK_VORBIS_FIELDS };
