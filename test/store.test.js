/* store.test.js — persistence: writes survive a fresh init() against the same dir. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-store-'));
  delete require.cache[require.resolve('../electron/lib/store')];
  let store = require('../electron/lib/store');
  store.init(dir);

  store.setSettings({ crossfade: 7, musicFolders: ['C:\\Music'] });
  const pl = store.plCreate('My Mix');
  store.plAdd(pl.id, ['t1', 't2', 't1']); // dup on purpose
  store.likedToggle('t1');
  store.overrideTrack('t1', { title: 'Renamed' });
  store.overrideTrack('t1', { title: '' }); // empty string should delete the key, not persist ''
  store.lyricsSave('t1', { synced: null, plain: 'la la', source: 'manual' });

  store.flush(); // what main.js does on quit
  // re-init against the same directory, as if the app restarted
  delete require.cache[require.resolve('../electron/lib/store')];
  store = require('../electron/lib/store');
  store.init(dir);

  assert.strictEqual(store.settings().crossfade, 7, 'crossfade should persist');
  assert.deepStrictEqual(store.settings().musicFolders, ['C:\\Music'], 'musicFolders should persist');
  const pl2 = store.playlists().find(p => p.name === 'My Mix');
  assert.ok(pl2, 'playlist should persist');
  assert.strictEqual(pl2.items.length, 2, 'plAdd should de-duplicate track ids within one call');
  assert.ok(store.liked().some(l => l.trackId === 't1'), 'liked should persist');
  assert.strictEqual(store.overrides().tracks.t1, undefined, 'an override cleared back to empty should not persist as a stray key');
  assert.strictEqual(store.lyrics().t1.plain, 'la la', 'manual lyrics should persist');

  fs.rmSync(dir, { recursive: true, force: true });
  return 'store.js persistence: ok';
};
