/* smart-shuffle.test.js — exercises the real renderer/js/core.js + player.js source
   (not a reimplementation) in a minimal vm sandbox, to check the invariant the brief
   calls out: toggling Smart Shuffle on then off must restore the original order after
   the current track, and must never drop or duplicate a track id. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

module.exports = async function run() {
  const sandbox = {};
  sandbox.console = console;
  sandbox.document = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  sandbox.performance = { now: () => Date.now() };
  sandbox.navigator = {};
  sandbox.AudioEngine = {
    on() {}, setOpts() {}, scheduleNext() {}, playNow() {}, pause() {}, resume() {}, stop() {},
    isPaused: () => true, hasTrack: () => false, seek() {}, pos: () => ({ t: 0, dur: 0 }),
    setVolume() {}, getVolume: () => 1, duck() {}, speak: async () => {}, stopAll() {}
  };
  // player.js talks to Playback (renderer/js/playback.js), not AudioEngine
  // directly, since the Aura Spotify brief's phase S3 refactor - this test
  // only exercises queue/Smart Shuffle logic in player.js, so a bare stub
  // covering the interface is enough.
  sandbox.Playback = {
    on() {}, onDevicePicker() {}, playNow() {}, scheduleNext() {},
    pause() {}, resume() {}, stop() {}, seek() {},
    setVolume() {}, getVolume: () => 1,
    isPaused: () => true, hasTrack: () => false, pos: () => ({ t: 0, dur: 0 }),
    activeSource: () => 'local', speak: async () => {}
  };
  sandbox.DJ = { active: false, onTrackStart() {}, stop() {} };
  sandbox.renderSpotifyNowPlayingNote = () => {};
  sandbox.MediaMetadata = function () {};
  sandbox.SpeechSynthesisUtterance = function () {};
  sandbox.speechSynthesis = { speak() {} };
  sandbox.addEventListener = () => {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'core.js'), 'utf8');
  const playerSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'player.js'), 'utf8');
  vm.runInContext(coreSrc, sandbox, { filename: 'core.js' });
  vm.runInContext(playerSrc, sandbox, { filename: 'player.js' });
  // top-level `const`/`let` bindings live in the context's lexical scope, not as
  // properties of the sandbox object, so pull them out via one more script run
  // in that same context instead of destructuring `sandbox` directly.
  const { S, P, buildContext, injectRecs, stripRecs } =
    vm.runInContext('({ S, P, buildContext, injectRecs, stripRecs })', sandbox);

  S.tracks = Array.from({ length: 20 }, (_, i) => ({
    id: 't' + i, title: 'Track ' + i, artist: 'Artist ' + (i % 4), albumArtist: 'Artist ' + (i % 4),
    genre: i % 2 ? 'Rock' : 'Pop', duration: 180
  }));
  S.byId = new Map(S.tracks.map(t => [t.id, t]));
  S.counts = {};

  const ids = S.tracks.slice(0, 10).map(t => t.id);
  buildContext(ids, ids[2], { name: 'Test', sourceType: 'list' });
  const originalTail = P.ctx.ids.slice(P.ctx.pos + 1);

  P.smart = true;
  injectRecs();
  assert.ok(P.ctx.ids.length > ids.length, 'injectRecs should weave in at least one suggestion');
  const afterInject = new Set(P.ctx.ids);
  for (const id of ids) assert.ok(afterInject.has(id), 'injectRecs must not drop original queued track ' + id);
  const seen = new Set();
  for (const id of P.ctx.ids) {
    assert.ok(!seen.has(id), 'injectRecs must not duplicate track id ' + id);
    seen.add(id);
  }

  P.smart = false;
  stripRecs();
  const afterStrip = P.ctx.ids.slice(P.ctx.pos + 1);
  // spread to plain host-realm arrays first: these values live in the vm sandbox's
  // own realm, and assert.deepStrictEqual's prototype check treats a vm-realm Array
  // as unequal to a same-content host Array even when every element matches.
  assert.deepStrictEqual([...afterStrip], [...originalTail], 'stripRecs must restore the exact original order after the current track');
  assert.strictEqual(P.ctx.recs.size, 0, 'stripRecs should leave no recs marked');

  return 'player.js Smart Shuffle (injectRecs/stripRecs): ok';
};
