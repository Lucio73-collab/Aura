/* album-key-normalize.test.js -- two rips of the same album tagged with a
   different apostrophe/quote style, letter case or stray whitespace must
   land in one album, not silently split into two because of a cosmetic tag
   difference. */
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

module.exports = async function run() {
  delete require.cache[require.resolve('../electron/lib/normalize')];
  const { normalizeForKey } = require('../electron/lib/normalize');

  // Unicode folding, tested directly (a WAV RIFF INFO chunk isn't a
  // realistic vehicle for non-ASCII text; real Vorbis/ID3/MP4 tags are).
  assert.strictEqual(
    normalizeForKey("808's & Heartbreak"), normalizeForKey('808’s & Heartbreak'),
    'straight vs curly apostrophe must fold to the same key'
  );
  assert.strictEqual(
    normalizeForKey('Cafe'), normalizeForKey('Café'),
    'plain vs accented letter must fold to the same key'
  );
  assert.strictEqual(
    normalizeForKey('  Late   Registration '), normalizeForKey('late registration'),
    'case and stray whitespace must fold to the same key'
  );

  // End-to-end through the real scan+merge pipeline, with an ASCII-safe
  // case/whitespace variant (two rip sessions tagging the same album
  // slightly differently is the actual real-world trigger).
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-albumkey-music-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-albumkey-data-'));
  fs.writeFileSync(path.join(musicDir, 't1.wav'), buildWav({ INAM: 'Say You Will', IART: 'Kanye West', IPRD: '808s & Heartbreak' }));
  fs.writeFileSync(path.join(musicDir, 't2.wav'), buildWav({ INAM: 'Welcome To Heartbreak', IART: 'kanye west', IPRD: '  808S  & Heartbreak' }));

  for (const m of ['store', 'library']) delete require.cache[require.resolve('../electron/lib/' + m)];
  const store = require('../electron/lib/store');
  const library = require('../electron/lib/library');
  store.init(dataDir);
  store.setSettings({ musicFolders: [musicDir] });
  library.init(store);
  await library.rescan();

  const lib = library.getLibrary();
  const t1 = lib.tracks.find(t => t.title === 'Say You Will');
  const t2 = lib.tracks.find(t => t.title === 'Welcome To Heartbreak');
  assert.ok(t1 && t2);
  assert.strictEqual(t1.albumId, t2.albumId, 'a case/whitespace difference in the album tag must not split one album into two');

  const album = lib.albums.find(a => a.id === t1.albumId);
  assert.strictEqual(album.trackIds.length, 2, 'both tracks should be grouped under the one album');

  fs.rmSync(musicDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  return 'library.js album-key normalization: ok';
};
