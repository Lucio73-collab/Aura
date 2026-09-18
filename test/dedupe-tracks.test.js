/* dedupe-tracks.test.js -- regression test for a track ripped/imported twice
   under different paths in the same album (e.g. a drag-drop reimport into
   Aura's managed folder duplicating a file already organized elsewhere).
   Also covers the related title-cleanup bug where a bracketed suffix like
   "(Interlude)" got misread as a yt-dlp video id and stripped, making a
   short interlude collide in name with the album's full-length song. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function chunk(id, data) {
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const size = Buffer.alloc(4); size.writeUInt32LE(data.length, 0);
  return Buffer.concat([Buffer.from(id, 'ascii'), size, data, pad]);
}
function infoList(fields) {
  const subs = Object.entries(fields).map(([id, val]) => chunk(id, Buffer.from(String(val) + '\0', 'ascii')));
  return chunk('LIST', Buffer.concat([Buffer.from('INFO', 'ascii'), ...subs]));
}
function buildWav(tags, pcmBytes = 800) {
  const sampleRate = 8000, channels = 1, bitsPerSample = 16;
  const pcm = Buffer.alloc(pcmBytes);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 8);
  fmt.writeUInt16LE(channels * bitsPerSample / 8, 12); fmt.writeUInt16LE(bitsPerSample, 14);
  const body = Buffer.concat([chunk('fmt ', fmt), infoList(tags), chunk('data', pcm)]);
  return chunk('RIFF', Buffer.concat([Buffer.from('WAVE', 'ascii'), body]));
}

module.exports = async function run() {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-dedupe-music-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-dedupe-data-'));

  // the original, manually organized copy
  const originalDir = path.join(musicDir, 'Kanye Discography', 'Thank God For Drugs');
  fs.mkdirSync(originalDir, { recursive: true });
  const originalFile = path.join(originalDir, '1. I Am Not Home.wav');
  fs.writeFileSync(originalFile, buildWav({ INAM: 'I Am Not Home', IART: 'Kanye West', IPRD: 'Thank God For Drugs' }));

  // a later accidental reimport of the exact same track into a second folder
  const reimportDir = path.join(musicDir, 'Aura', 'Kanye West', 'Thank God For Drugs');
  fs.mkdirSync(reimportDir, { recursive: true });
  const reimportFile = path.join(reimportDir, '1. I Am Not Home.wav');
  fs.writeFileSync(reimportFile, buildWav({ INAM: 'I Am Not Home', IART: 'Kanye West', IPRD: 'Thank God For Drugs' }));

  // make the reimport's mtime clearly newer so dedup has a deterministic
  // "older copy wins" tiebreak to resolve, matching the real scenario
  const old = new Date('2026-06-01T00:00:00Z');
  const recent = new Date('2026-09-14T00:00:00Z');
  fs.utimesSync(originalFile, old, old);
  fs.utimesSync(reimportFile, recent, recent);

  // a genuinely different, much shorter interlude that used to collide in
  // *name* with a same-titled full song after over-aggressive bracket
  // stripping - must NOT be deduped away
  const mbdtfDir = path.join(musicDir, 'My Beautiful Dark Twisted Fantasy');
  fs.mkdirSync(mbdtfDir, { recursive: true });
  fs.writeFileSync(path.join(mbdtfDir, '004 - All Of The Lights (Interlude).wav'),
    buildWav({ INAM: 'All Of The Lights (Interlude)', IART: 'Kanye West', IPRD: 'My Beautiful Dark Twisted Fantasy' }, 80));
  fs.writeFileSync(path.join(mbdtfDir, '005 - All Of The Lights.wav'),
    buildWav({ INAM: 'All Of The Lights', IART: 'Kanye West', IPRD: 'My Beautiful Dark Twisted Fantasy' }, 8000));

  for (const m of ['store', 'library']) delete require.cache[require.resolve('../electron/lib/' + m)];
  const store = require('../electron/lib/store');
  const library = require('../electron/lib/library');
  store.init(dataDir);
  store.setSettings({ musicFolders: [musicDir] });
  library.init(store);
  await library.rescan();

  const lib = library.getLibrary();

  const homeTracks = lib.tracks.filter(t => t.title === 'I Am Not Home');
  assert.strictEqual(homeTracks.length, 1, 'a track imported twice into two folders must only show once, got ' + homeTracks.length);
  assert.ok(homeTracks[0].id.length, 'the kept copy should still be a normal track');
  const filePath = library.filePath(homeTracks[0].id);
  assert.strictEqual(filePath, originalFile, 'the OLDER copy should be the one kept, not the later reimport');

  const album = lib.albums.find(a => a.title === 'Thank God For Drugs');
  assert.ok(album, 'album should exist');
  assert.strictEqual(album.trackIds.length, 1, 'the album should not double-count the duplicated track');

  const interlude = lib.tracks.find(t => t.title === 'All Of The Lights (Interlude)');
  const full = lib.tracks.find(t => t.title === 'All Of The Lights');
  assert.ok(interlude, 'the interlude must keep its own distinct title, not get collapsed into the full song');
  assert.ok(full, 'the full song must still exist as its own track');
  assert.notStrictEqual(interlude.id, full.id);

  fs.rmSync(musicDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  return 'library.js duplicate-track detection + title-cleanup fix: ok';
};
