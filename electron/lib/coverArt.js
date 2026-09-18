/* coverArt.js — optional online cover-art lookup (iTunes Search API: free,
   unauthenticated, no key) for tag-derived albums with no embedded or
   user-set art. Never touches custom (user-created) albums - those already
   have an explicit drop/paste cover flow, and are usually unreleased/personal
   projects that wouldn't have a commercial-catalog match anyway. */
const HEADERS = { 'User-Agent': 'Aura/1.0 (local music player)' };

async function findAlbumArtUrl(artist, album) {
  const term = `${artist || ''} ${album || ''}`.trim();
  if (!term) return null;
  const qs = new URLSearchParams({ term, entity: 'album', limit: '1' });
  try {
    const r = await fetch('https://itunes.apple.com/search?' + qs, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const hit = j.results && j.results[0];
    return hit && hit.artworkUrl100 ? hit.artworkUrl100.replace('100x100bb', '600x600bb') : null;
  } catch { return null; }
}

async function download(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    const ext = type.includes('png') ? 'png' : 'jpg';
    return { buf: Buffer.from(await r.arrayBuffer()), ext };
  } catch { return null; }
}

module.exports = { findAlbumArtUrl, download };
