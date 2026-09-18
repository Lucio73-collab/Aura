/* artistName.js — shared primary-artist normalization.
   Downloaded/ripped files (yt-dlp and friends) routinely jam every credited
   performer into one tag or folder name: "Kanye West, Pusha T", "Kanye West
   feat. Rihanna". Taken at face value, every distinct collaborator
   combination becomes its own album, its own artist, and (on import) its own
   folder. This picks out just the primary (first-listed) name for grouping
   and organizing; callers that just display something to a person should
   keep using the raw string as-is. */
// "&" is also folded in here (not just comma/feat/ft): in practice it shows up
// far more often as a collab join ("Kanye West & Kendrick Lamar") than as part
// of a single act's own name, and leaving it out let exactly this kind of
// combo slip through as its own distinct "primary artist" - the same
// fragmentation bug this module exists to prevent, just for "&" instead of a
// comma. The rare duo that really is named with an "&" (Simon & Garfunkel)
// gets misread as two people; that's an accepted trade-off given how much
// more common the collab case is.
const SPLIT_RE = /\s*,\s*|\s*&\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+vs\.?\s+|\s+x\s+/i;

function primaryArtist(name) {
  if (!name) return name;
  const primary = name.split(SPLIT_RE)[0].trim();
  return primary || name;
}

/* Every individually credited name on the raw tag, in order, deduped.
   Used to look up whether a featured name is *also* a real artist elsewhere
   in the library (see library.js) - never to manufacture a new artist out of
   someone who only ever shows up as a feature. */
function splitArtists(name) {
  if (!name) return [];
  const seen = new Set();
  const out = [];
  for (const part of name.split(SPLIT_RE)) {
    const n = part.trim();
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  }
  return out;
}

module.exports = { primaryArtist, splitArtists };
