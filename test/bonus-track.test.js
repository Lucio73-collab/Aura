/* bonus-track.test.js -- regression test for detecting a leaked/bonus track
   that sits in an existing album's own folder but has no album tag of its
   own (e.g. "Graduation/015 - Bittersweet Poetry..."). It must merge into
   that album and be flagged `bonus`, not spin out into its own single. */
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
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-bonus-music-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-bonus-data-'));

  const albumDir = path.join(musicDir, 'Graduation');
  fs.mkdirSync(albumDir);
  const tracks = [
    { file: '001 - Good Morning.wav', title: 'Good Morning', album: 'Graduation' },
    { file: '002 - Stronger.wav', title: 'Stronger', album: 'Graduation' },
    { file: '003 - Flashing Lights.wav', title: 'Flashing Lights', album: 'Graduation' }
  ];
  for (const t of tracks) {
    fs.writeFileSync(path.join(albumDir, t.file), buildWav({ INAM: t.title, IART: 'Kanye West', IPRD: t.album }));
  }
  // the bonus cut: same folder, no IPRD at all
  fs.writeFileSync(path.join(albumDir, '015 - Bittersweet Poetry.wav'), buildWav({ INAM: 'Bittersweet Poetry', IART: 'Kanye West' }));

  // a genuinely standalone single, alone in its own folder with no tagged
  // neighbours at all, must NOT get swept into anything.
  const singleDir = path.join(musicDir, 'Loosie');
  fs.mkdirSync(singleDir);
  fs.writeFileSync(path.join(singleDir, 'Loosie Track.wav'), buildWav({ INAM: 'Loosie Track', IART: 'Kanye West' }));

  // a small EP: only ONE tagged track, but the untagged bonus cut's own
  // filename number continues its numbering directly - strong signal even
  // with just one tagged neighbour.
  const epDir = path.join(musicDir, 'Cruel Summer EP');
  fs.mkdirSync(epDir);
  fs.writeFileSync(path.join(epDir, '01 - Mercy.wav'), buildWav({ INAM: 'Mercy', IART: 'Kanye West', IPRD: 'Cruel Summer EP' }));
  fs.writeFileSync(path.join(epDir, '02 - Bonus Freestyle.wav'), buildWav({ INAM: 'Bonus Freestyle', IART: 'Kanye West' }));

  // same shape, but the untagged track's number does NOT continue the
  // tagged track's numbering - too weak a signal with only one tagged
  // neighbour, must stay its own single.
  const weakDir = path.join(musicDir, 'Weak Signal EP');
  fs.mkdirSync(weakDir);
  fs.writeFileSync(path.join(weakDir, '01 - Real Track.wav'), buildWav({ INAM: 'Real Track', IART: 'Kanye West', IPRD: 'Weak Signal EP' }));
  fs.writeFileSync(path.join(weakDir, '47 - Unrelated Loosie.wav'), buildWav({ INAM: 'Unrelated Loosie', IART: 'Kanye West' }));

  // a yt-dlp playlist rip where only the first track got an album tag: the
  // rest continue its numbering one after another, so they all belong to it
  const dondaDir = path.join(musicDir, 'Donda');
  fs.mkdirSync(dondaDir);
  fs.writeFileSync(path.join(dondaDir, '001 - Donda Chant.wav'), buildWav({ INAM: 'Donda Chant', IART: 'Kanye West', IPRD: 'Donda' }));
  const dondaRest = ['Jail', 'God Breathed', 'Off The Grid', 'No Child Left Behind'];
  dondaRest.forEach((title, i) => {
    const file = String(i + 2).padStart(3, '0') + ' - Kanye West - ' + title + ' (Audio).wav';
    fs.writeFileSync(path.join(dondaDir, file), buildWav({ INAM: 'Kanye West - ' + title + ' (Audio)', IART: 'Kanye West' }));
  });

  for (const m of ['store', 'library']) delete require.cache[require.resolve('../electron/lib/' + m)];
  const store = require('../electron/lib/store');
  const library = require('../electron/lib/library');
  store.init(dataDir);
  store.setSettings({ musicFolders: [musicDir] });
  library.init(store);
  await library.rescan();

  const lib = library.getLibrary();
  const bonus = lib.tracks.find(t => t.title === 'Bittersweet Poetry');
  assert.ok(bonus, 'bonus track should still scan');
  assert.strictEqual(bonus.album, 'Graduation', 'untagged track in an album folder should adopt that album, not become its own single');
  assert.strictEqual(bonus.bonus, true, 'it should be flagged as a bonus track');

  const graduation = lib.albums.find(a => a.title === 'Graduation');
  assert.ok(graduation, 'Graduation album should exist');
  assert.strictEqual(graduation.trackIds.length, 4, 'Graduation should own all 3 tagged tracks plus the bonus cut');
  assert.ok(graduation.trackIds.includes(bonus.id), 'the bonus track must be part of the Graduation album');

  const loosie = lib.tracks.find(t => t.title === 'Loosie Track');
  assert.ok(loosie);
  assert.strictEqual(loosie.album, loosie.title, 'a lone untagged track with no tagged neighbours must stay its own single');
  assert.ok(!loosie.bonus, 'it must not be flagged as a bonus track');

  const epBonus = lib.tracks.find(t => t.title === 'Bonus Freestyle');
  assert.ok(epBonus);
  assert.strictEqual(epBonus.album, 'Cruel Summer EP', 'a track numbered right after one tagged neighbour should still attach to that album');
  assert.strictEqual(epBonus.bonus, true, 'it should be flagged as a bonus track');

  const weakSignal = lib.tracks.find(t => t.title === 'Unrelated Loosie');
  assert.ok(weakSignal);
  assert.strictEqual(weakSignal.album, weakSignal.title, 'a non-adjacent track number with only one tagged neighbour is too weak a signal, must stay its own single');
  assert.ok(!weakSignal.bonus, 'it must not be flagged as a bonus track');

  const donda = lib.albums.filter(a => a.title === 'Donda');
  assert.strictEqual(donda.length, 1, 'the Donda rip should be one album, not one per song');
  assert.strictEqual(donda[0].trackIds.length, 5, 'Donda should own the tagged track plus every contiguously numbered untagged one');
  const dondaTracks = donda[0].trackIds.map(id => lib.tracks.find(t => t.id === id));
  assert.deepStrictEqual(dondaTracks.map(t => t.title), ['Donda Chant', 'Jail', 'God Breathed', 'Off The Grid', 'No Child Left Behind'],
    'tracklist order follows filename numbers, and "Left" must not be read as a "ft" credit');
  assert.ok(dondaTracks.every(t => !t.bonus), 'tracks that make up most of the album are not bonus cuts');

  // a second scan off the cache must give the same grouping
  await library.rescan();
  const again = library.getLibrary().albums.filter(a => a.title === 'Donda');
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].trackIds.length, 5, 'cached rescan should keep the same Donda grouping');

  fs.rmSync(musicDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  return 'library.js bonus-track detection: ok';
};
