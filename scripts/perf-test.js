/* perf-test.js — one-off: generates ~10,000 tiny tagged WAV files, then times
   library.rescan() (cold + warm/cached) and getLibrary() (curated merge) against
   them, per the brief's Phase 6 performance-audit ask. Cleans up after itself. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const N = 10000;
const MUSIC_DIR = path.join(os.tmpdir(), 'aura-perf-music');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-perf-data-'));

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
  const pcm = Buffer.alloc(400); // 0.05s of silence - just needs to be a valid, parseable file
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 8);
  fmt.writeUInt16LE(channels * bitsPerSample / 8, 12); fmt.writeUInt16LE(bitsPerSample, 14);
  const body = Buffer.concat([chunk('fmt ', fmt), infoList(tags), chunk('data', pcm)]);
  return chunk('RIFF', Buffer.concat([Buffer.from('WAVE', 'ascii'), body]));
}

async function main() {
  console.log('Generating', N, 'test files in', MUSIC_DIR, '...');
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const album = 'Album ' + (i % 500);
    const artist = 'Artist ' + (i % 120);
    const wav = buildWav({ INAM: 'Track ' + i, IART: artist, IPRD: album, IPRT: String((i % 20) + 1), ICRD: '2020' });
    fs.writeFileSync(path.join(MUSIC_DIR, 'f' + i + '.wav'), wav);
  }
  console.log('  generation:', (Date.now() - t0) + 'ms');

  delete require.cache[require.resolve('../electron/lib/store')];
  delete require.cache[require.resolve('../electron/lib/library')];
  const store = require('../electron/lib/store');
  const library = require('../electron/lib/library');
  store.init(DATA_DIR);
  store.setSettings({ musicFolders: [MUSIC_DIR] });
  library.init(store);

  let t = Date.now();
  const st1 = await library.rescan();
  console.log('cold rescan (' + st1.count + ' tracks):', (Date.now() - t) + 'ms');

  t = Date.now();
  const st2 = await library.rescan();
  console.log('warm rescan (cache hit, ' + st2.count + ' tracks):', (Date.now() - t) + 'ms');

  t = Date.now();
  const lib = library.getLibrary();
  console.log('getLibrary() merge (' + lib.tracks.length + ' tracks, ' + lib.albums.length + ' albums, ' + lib.artists.length + ' artists):', (Date.now() - t) + 'ms');

  t = Date.now();
  library.getLibrary();
  console.log('getLibrary() merge, second call:', (Date.now() - t) + 'ms');

  const mem = process.memoryUsage();
  console.log('process memory: rss=' + (mem.rss / 1048576).toFixed(1) + 'MB heapUsed=' + (mem.heapUsed / 1048576).toFixed(1) + 'MB');

  console.log('\ncleaning up test files...');
  fs.rmSync(MUSIC_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

main().catch(e => { console.error(e); process.exit(1); });
