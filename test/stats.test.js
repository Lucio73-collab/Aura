/* stats.test.js — listening-stats aggregation maths, against real scanned tracks. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_MUSIC = path.join(__dirname, '..', '.test-music');

module.exports = async function run() {
  if (!fs.existsSync(TEST_MUSIC)) throw new Error('run `node scripts/gen-test-audio.js` first');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-stats-'));
  for (const m of ['store', 'library', 'stats']) delete require.cache[require.resolve('../electron/lib/' + m)];
  const store = require('../electron/lib/store');
  const library = require('../electron/lib/library');
  const stats = require('../electron/lib/stats');
  store.init(dir);
  store.setSettings({ musicFolders: [TEST_MUSIC] });
  library.init(store);
  stats.init(store, library);
  await library.rescan();

  const lib = library.getLibrary();
  const one = lib.tracks.find(t => t.title === 'Aura Test One');
  const two = lib.tracks.find(t => t.title === 'Aura Test Two');
  const three = lib.tracks.find(t => t.title === 'Aura Test Three');

  const now = Date.now();
  store.logPlay({ trackId: one.id, ms: 60000, counted: true });
  store.logPlay({ trackId: one.id, ms: 30000, counted: false });
  store.logPlay({ trackId: two.id, ms: 45000, counted: true });
  // backdate one event past the 7-day window to prove range filtering works
  store.plays().events.at(-1).ts = now - 30 * 864e5;
  // a second, differently-artisted old play, for the taste-decay comparison below
  store.logPlay({ trackId: three.id, ms: 45000, counted: true });
  store.plays().events.at(-1).ts = now - 30 * 864e5;

  const all = stats.getStats('all');
  assert.strictEqual(all.plays, 4, 'all-time should count every event');
  assert.strictEqual(all.minutes, Math.round((60000 + 30000 + 45000 + 45000) / 60000), 'total minutes should sum all event ms');
  const topOne = all.topTracks.find(t => t.id === one.id);
  assert.strictEqual(topOne.ms, 90000, 'per-track ms should sum across multiple events for the same track');
  // note: stats.js counts every logged listen event toward `plays`, regardless of
  // the `counted` flag (events aren't persisted with that flag at all) - it's a
  // session count, not a "qualifying play" count. See report for detail.
  assert.strictEqual(topOne.plays, 2, 'plays should count every logged listen event for the track');

  const week = stats.getStats('7d');
  assert.strictEqual(week.plays, 2, '7d range should exclude the backdated 30-day-old event');

  const evAll = stats.getEvents('all');
  assert.strictEqual(evAll.events.length, 4, 'getEvents(all) should return every event');
  assert.deepStrictEqual(evAll.events[0].slice(1), [60000, one.id], 'event rows are [ts, ms, trackId]');
  assert.strictEqual(stats.getEvents('7d').events.length, 2, 'getEvents(7d) should drop the backdated events');
  assert.strictEqual(stats.getEvents('90d').events.length, 4, '90d range should include 30-day-old events');
  assert.strictEqual(stats.getStats('90d').plays, 4, 'getStats should know the 90d range');
  assert.ok(evAll.first <= evAll.events[0][0], 'first is the oldest event timestamp');

  const taste = stats.getTasteProfile();
  assert.ok(taste.artistWeights[one.artistKey] > 0, 'taste profile should build up weight for a played artist');
  assert.ok(!taste.recentIds.includes(two.id), 'a play older than the recent window should not count as recently played');
  assert.ok(taste.recentIds.includes(one.id), 'a recent play should be in recentIds');
  const oldWeight = taste.artistWeights[three.artistKey] || 0;
  const freshWeight = taste.artistWeights[one.artistKey] || 0;
  assert.ok(freshWeight > oldWeight, 'a fresh play should end up with more taste weight than a decayed 30-day-old one of similar length');

  fs.rmSync(dir, { recursive: true, force: true });
  return 'stats.js aggregation: ok';
};
