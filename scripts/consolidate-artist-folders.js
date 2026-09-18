/* consolidate-artist-folders.js — one-time cleanup: merges Artist-folder
   variants like "Kanye West, Dwele" and "Kanye West, Chris Martin" into the
   single "Kanye West" folder, using the same primaryArtist() rule the app
   now uses for grouping. Moves files (keeps every file), merges same-named
   album subfolders, renames on any real collision instead of overwriting.
   Run with: node scripts/consolidate-artist-folders.js <musicRoot> */
const fs = require('fs');
const path = require('path');
const { primaryArtist } = require('../electron/lib/library');

const ROOT = process.argv[2];
if (!ROOT) { console.error('usage: node consolidate-artist-folders.js <musicRoot>'); process.exit(1); }

function mergeDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    if (entry.isDirectory()) {
      mergeDir(s, path.join(dest, entry.name));
      continue;
    }
    let d = path.join(dest, entry.name);
    if (fs.existsSync(d)) {
      const ext = path.extname(entry.name);
      const base = path.basename(entry.name, ext);
      let i = 2;
      while (fs.existsSync(d)) { d = path.join(dest, `${base} (${i})${ext}`); i++; }
    }
    fs.renameSync(s, d);
    console.log('  moved', entry.name, '->', path.relative(ROOT, d));
  }
}

const topDirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory());
let merged = 0;
for (const dirent of topDirs) {
  const name = dirent.name;
  const primary = primaryArtist(name);
  if (primary === name) continue;
  console.log('merging', JSON.stringify(name), '->', JSON.stringify(primary));
  mergeDir(path.join(ROOT, name), path.join(ROOT, primary));
  fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  merged++;
}
console.log('\nconsolidated', merged, 'collaborator-variant folder(s).');
