/* importer.js — copies external audio files into Aura's managed library
   folder, organized as <root>/<Artist>/<Album>/<filename>, so you can build
   a library from scratch by just picking files rather than manually
   organizing folders yourself first. Pure Node. */
const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');
const { primaryArtist } = require('./artistName');

function sanitizeSegment(name) {
  return String(name || 'Unknown').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120) || 'Unknown';
}

/* files: absolute paths to copy in. target: { artist, album } to force a
   destination (used when importing "into" a specific artist/album page),
   or null/undefined to sort each file by its own existing tags. */
async function importFiles(files, root, target) {
  const results = [];
  for (const file of files) {
    try {
      let artist = target && target.artist, album = target && target.album;
      if (!artist || !album) {
        const meta = await mm.parseFile(file, { duration: false }).catch(() => null);
        const c = meta && meta.common;
        artist = artist || (c && (c.albumartist || c.artist)) || 'Unknown Artist';
        album = album || (c && c.album) || 'Unknown Album';
      }
      // fold "Kanye West, Pusha T" style collaborator tags onto the same
      // folder as plain "Kanye West" so importing doesn't refragment an
      // artist across a dozen folders the way it used to.
      const destDir = path.join(root, sanitizeSegment(primaryArtist(artist)), sanitizeSegment(album));
      fs.mkdirSync(destDir, { recursive: true });
      const ext = path.extname(file);
      const base = path.basename(file, ext);
      let dest = path.join(destDir, base + ext);
      let i = 2;
      while (fs.existsSync(dest)) { dest = path.join(destDir, `${base} (${i})${ext}`); i++; }
      fs.copyFileSync(file, dest);
      results.push({ file, ok: true, dest, artist, album, forced: !!(target && target.artist && target.album) });
    } catch (e) {
      results.push({ file, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { importFiles, sanitizeSegment };
