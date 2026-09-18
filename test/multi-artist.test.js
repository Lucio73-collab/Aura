/* multi-artist.test.js — regression test for the "Kanye West" bug: downloaded
   files often jam every collaborator into one artist tag ("Kanye West, Pusha
   T", "Kanye West feat. Rihanna"), which used to fragment one real artist and
   one real album into a dozen near-duplicates. Verifies the fix groups them
   back into a single artist/album while still showing the full raw credit
   on each track, and that every featured name (even one who owns nothing of
   their own) gets a real `appearsOnly` artist entry so it's clickable. */
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

// mirrors the real tags found in a yt-dlp-ripped "Yoink" folder: same album,
// same real primary artist, but a different collaborator string every time
// and no albumartist tag at all.
const TRACKS = [
  { file: 't1.wav', title: 'I Wonder', artist: 'Kanye West', album: 'Graduation' },
  { file: 't2.wav', title: 'Flashing Lights', artist: 'Kanye West, Dwele', album: 'Graduation' },
  { file: 't3.wav', title: 'Homecoming', artist: 'Kanye West, Chris Martin', album: 'Graduation' },
  { file: 't4.wav', title: 'Good Night', artist: 'Kanye West, Mos Def, Al Be Back', album: 'Graduation' },
  { file: 't5.wav', title: 'Runaway', artist: 'Kanye West feat. Pusha T', album: 'My Beautiful Dark Twisted Fantasy' },
  // Chris Martin also has a track of his own in this library, so he's a real,
  // pre-existing artist and should pick up an "appears on" credit for
  // Homecoming; Dwele/Mos Def/Al Be Back/Pusha T never own anything here.
  { file: 't6.wav', title: 'Clocks', artist: 'Chris Martin', album: 'Parachutes' },
  // YouTube Music's DONDA 2 rip credits the prequel's name first; that's not
  // a performer, the album belongs to Kanye West
  { file: 't7.wav', title: 'True Love', artist: 'DONDA, Kanye West, Ye', album: 'DONDA 2' },
  // ...but a self-titled album by a real group keeps its group as the owner
  { file: 't8.wav', title: 'Feel The Love', artist: 'KIDS SEE GHOSTS, Pusha T', album: 'KIDS SEE GHOSTS' }
];

module.exports = async function run() {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-multiartist-music-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-multiartist-data-'));
  for (const t of TRACKS) {
    fs.writeFileSync(path.join(musicDir, t.file), buildWav({ INAM: t.title, IART: t.artist, IPRD: t.album }));
  }

  for (const m of ['store', 'library']) delete require.cache[require.resolve('../electron/lib/' + m)];
  const store = require('../electron/lib/store');
  const library = require('../electron/lib/library');
  store.init(dataDir);
  store.setSettings({ musicFolders: [musicDir] });
  library.init(store);
  await library.rescan();

  const lib = library.getLibrary();
  assert.strictEqual(lib.tracks.length, 8, 'all 8 files should scan');

  const kanyeArtists = lib.artists.filter(a => a.name.toLowerCase().includes('kanye'));
  assert.strictEqual(kanyeArtists.length, 1, 'every "Kanye West, X" variant should collapse into one artist, got: ' + JSON.stringify(lib.artists.map(a => a.name)));
  assert.strictEqual(kanyeArtists[0].name, 'Kanye West');
  assert.strictEqual(kanyeArtists[0].trackCount, 6, 'the one Kanye West artist should own all 6 tracks, DONDA 2 included');

  const donda2 = lib.albums.find(a => a.title === 'DONDA 2');
  assert.strictEqual(donda2.artist, 'Kanye West', 'a "DONDA" prequel credit must not own DONDA 2');
  assert.ok(kanyeArtists[0].albumIds.includes(donda2.id), 'DONDA 2 should show on the Kanye West artist page');
  const trueLove = lib.tracks.find(t => t.title === 'True Love');
  assert.strictEqual(trueLove.artistKey, 'Kanye West');
  assert.ok(!trueLove.artists.includes('DONDA'), 'the prequel credit should not be a clickable artist either');
  assert.ok(!lib.artists.some(a => a.name === 'DONDA'), 'no phantom DONDA artist should exist, got: ' + JSON.stringify(lib.artists.map(a => a.name)));

  const ksg = lib.albums.find(a => a.title === 'KIDS SEE GHOSTS');
  assert.strictEqual(ksg.artist, 'KIDS SEE GHOSTS', 'a self-titled group album must stay with the group, not go to its feature');
  assert.strictEqual(lib.tracks.find(t => t.title === 'Feel The Love').artistKey, 'KIDS SEE GHOSTS');

  const graduationAlbums = lib.albums.filter(a => a.title === 'Graduation');
  assert.strictEqual(graduationAlbums.length, 1, 'every "Graduation" variant should collapse into one album, got ' + graduationAlbums.length + ' album(s)');
  assert.strictEqual(graduationAlbums[0].trackIds.length, 4, 'all 4 Graduation tracks should be in the single album');
  assert.strictEqual(graduationAlbums[0].artist, 'Kanye West', 'the collapsed album should show the clean primary artist');

  // raw per-track display text must still show the full collaborator credit
  const flashingLights = lib.tracks.find(t => t.title === 'Flashing Lights');
  assert.strictEqual(flashingLights.artist, 'Kanye West, Dwele', 'the raw multi-artist credit must still be shown on the track itself');
  assert.strictEqual(flashingLights.artistKey, 'Kanye West', 'but its grouping identity should be normalized to the primary artist');

  const runaway = lib.tracks.find(t => t.title === 'Runaway');
  assert.strictEqual(runaway.artistKey, 'Kanye West', '"feat." should also be recognized as a collaborator delimiter');

  // a feature credit only ever attaches to someone who is already a real,
  // track-owning artist in this library - it never manufactures a new artist
  // out of a name that only ever shows up in someone else's tag
  const homecoming = lib.tracks.find(t => t.title === 'Homecoming');
  const chrisMartin = lib.artists.find(a => a.name === 'Chris Martin');
  assert.ok(chrisMartin, 'Chris Martin owns "Clocks" so he should be a real artist entry');
  assert.strictEqual(chrisMartin.trackCount, 1, 'Chris Martin should own only his real track, not Homecoming');
  assert.ok(chrisMartin.appearsOn.includes(homecoming.id), 'Chris Martin should be credited as appearing on Homecoming');
  assert.strictEqual(kanyeArtists[0].trackCount, 6, 'crediting a feature must not change the primary artist\'s own track count');

  // a feature-only name (never a primary artist anywhere in the library)
  // still gets a real, clickable artist entry - just flagged `appearsOnly`
  // so it stays out of the main Artists grid/search, reachable only by
  // clicking the name on the track that credits it.
  for (const name of ['Pusha T', 'Dwele', 'Mos Def', 'Al Be Back']) {
    const ar = lib.artists.find(a => a.name === name);
    assert.ok(ar, `"${name}" should still get an artist entry so clicking the credit on a track has somewhere to go`);
    assert.strictEqual(ar.trackCount, 0, `"${name}" owns no track of their own`);
    assert.strictEqual(ar.albumIds.length, 0, `"${name}" owns no album of their own`);
    assert.strictEqual(ar.appearsOnly, true, `"${name}" should be flagged appearsOnly so the directory/search can hide them`);
  }
  const pushaT = lib.artists.find(a => a.name === 'Pusha T');
  assert.ok(pushaT.appearsOn.includes(runaway.id), 'Pusha T should be credited as appearing on Runaway');

  assert.strictEqual(chrisMartin.appearsOnly, false, 'Chris Martin owns a real track, so he is not appearsOnly');
  assert.strictEqual(kanyeArtists[0].appearsOnly, false, 'Kanye West owns real tracks, so he is not appearsOnly');

  fs.rmSync(musicDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  return 'library.js multi-artist collapsing: ok';
};
