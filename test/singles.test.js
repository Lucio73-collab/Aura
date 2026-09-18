/* singles.test.js — regression test for the "everything untagged merges into
   one Unknown Album" bug: files with no album tag at all (common on
   YouTube/SoundCloud rips) must each become their own standalone single,
   named after the track itself, not one shared fake album per artist. */
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
function buildWav(tags) {
  const sampleRate = 8000, channels = 1, bitsPerSample = 16;
  const pcm = Buffer.alloc(800);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 8);
  fmt.writeUInt16LE(channels * bitsPerSample / 8, 12); fmt.writeUInt16LE(bitsPerSample, 14);
  const body = Buffer.concat([chunk('fmt ', fmt), infoList(tags), chunk('data', pcm)]);
  return chunk('RIFF', Buffer.concat([Buffer.from('WAVE', 'ascii'), body]));
}

// two files, same artist, neither has an album tag (IPRD omitted)
const TRACKS = [
  { file: 's1.wav', title: 'Loose Single One', artist: 'No Album Artist' },
  { file: 's2.wav', title: 'Loose Single Two', artist: 'No Album Artist' }
];

module.exports = async function run() {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-singles-music-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-singles-data-'));
  for (const t of TRACKS) {
    fs.writeFileSync(path.join(musicDir, t.file), buildWav({ INAM: t.title, IART: t.artist }));
  }

  for (const m of ['store', 'library']) delete require.cache[require.resolve('../electron/lib/' + m)];
  const store = require('../electron/lib/store');
  const library = require('../electron/lib/library');
  store.init(dataDir);
  store.setSettings({ musicFolders: [musicDir] });
  library.init(store);
  await library.rescan();

  const lib = library.getLibrary();
  assert.strictEqual(lib.tracks.length, 2, 'both untagged files should scan');

  const one = lib.tracks.find(t => t.title === 'Loose Single One');
  const two = lib.tracks.find(t => t.title === 'Loose Single Two');
  assert.ok(one && two);

  assert.strictEqual(one.album, one.title, 'an untagged track should be named as a single after its own song, not "Unknown Album"');
  assert.strictEqual(two.album, two.title, 'same for the second untagged track');
  assert.notStrictEqual(one.albumId, two.albumId, 'two different untagged tracks by the same artist must not collapse into one shared album');

  const albumOfOne = lib.albums.find(a => a.id === one.albumId);
  const albumOfTwo = lib.albums.find(a => a.id === two.albumId);
  assert.strictEqual(albumOfOne.trackIds.length, 1, 'the single should own exactly its own track');
  assert.strictEqual(albumOfTwo.trackIds.length, 1, 'same for the other single');

  fs.rmSync(musicDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  return 'library.js untagged-single handling: ok';
};
