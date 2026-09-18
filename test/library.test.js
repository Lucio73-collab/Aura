/* library.test.js — scan + curated-merge logic against the real generated test tracks. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_MUSIC = path.join(__dirname, '..', '.test-music');

module.exports = async function run() {
  if (!fs.existsSync(TEST_MUSIC)) throw new Error('run `node scripts/gen-test-audio.js` first');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-lib-'));
  delete require.cache[require.resolve('../electron/lib/store')];
  delete require.cache[require.resolve('../electron/lib/library')];
  const store = require('../electron/lib/store');
  const library = require('../electron/lib/library');
  store.init(dir);
  store.setSettings({ musicFolders: [TEST_MUSIC] });
  library.init(store);

  const st = await library.rescan();
  assert.strictEqual(st.count, 3, 'should find all 3 generated test tracks');

  let lib = library.getLibrary();
  assert.strictEqual(lib.tracks.length, 3);
  const byTitle = t => lib.tracks.find(x => x.title === t);
  const one = byTitle('Aura Test One'), two = byTitle('Aura Test Two'), three = byTitle('Aura Test Three');
  assert.ok(one && two && three, 'all three tracks should be present with their tagged titles');
  assert.strictEqual(one.artist, 'Aura Test Artist');
  assert.strictEqual(three.artist, 'Aura Test Artist Two');

  const albumOne = lib.albums.find(a => a.id === one.albumId);
  assert.strictEqual(albumOne.trackIds.length, 2, 'the two same-album tracks should share one auto album');
  assert.deepStrictEqual(albumOne.trackIds.map(id => lib.tracks.find(t => t.id === id).title), ['Aura Test One', 'Aura Test Two'], 'auto-album tracks should sort by track number');

  // per-track override
  store.overrideTrack(one.id, { title: 'Overridden Title' });
  lib = library.getLibrary();
  assert.strictEqual(byTitle('Overridden Title').id, one.id, 'track override should apply on top of the scanned tag data');

  // custom album claims tracks away from their auto (tag-derived) album
  const custom = store.albumUpsert({ title: 'My Custom Mix', trackIds: [one.id, three.id] });
  lib = library.getLibrary();
  const customAlbum = lib.albums.find(a => a.id === custom.id);
  assert.strictEqual(customAlbum.trackIds.length, 2, 'custom album should hold the claimed tracks');
  const autoAlbumNow = lib.albums.find(a => a.id === albumOne.id);
  assert.strictEqual(autoAlbumNow.trackIds.length, 1, 'claiming a track into a custom album should remove it from its auto album');
  assert.strictEqual(lib.tracks.find(t => t.id === one.id).album, 'My Custom Mix', 'a claimed track should report the custom album as its display album');

  // rescan should not duplicate or drop tracks (cache-hit path)
  const st2 = await library.rescan();
  assert.strictEqual(st2.count, 3, 'rescanning unchanged files should not duplicate or drop tracks');

  fs.rmSync(dir, { recursive: true, force: true });
  return 'library.js scan + merge: ok';
};
