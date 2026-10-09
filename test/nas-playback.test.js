/* nas-playback.test.js - the renderer-side NAS rules, run against the real
   renderer/js/core.js and playback.js in a minimal vm sandbox: when a NAS song
   counts as unavailable, that recommendations never pick one while the NAS is
   down, and that Playback refuses / gives up on / reports failed NAS songs
   (offline, stalled start, failed stream, failed preload) instead of hanging.
   Local songs must be completely unaffected. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

module.exports = async function run() {
  const handlers = {};
  const calls = { playNow: [], scheduleNext: [] };
  const timers = [];
  let pos = { t: 0, dur: 8 };
  let paused = false;
  const sandbox = { console, performance: { now: () => Date.now() }, navigator: {} };
  sandbox.document = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  sandbox.window = { aura: {} };
  sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0;
  sandbox.AudioEngine = {
    on(ev, fn) { (handlers[ev] || (handlers[ev] = [])).push(fn); },
    playNow(id) { calls.playNow.push(id); }, scheduleNext(id) { calls.scheduleNext.push(id); },
    loadPaused() {}, pause() {}, resume() {}, stop() {}, fadeOutAndStop: async () => {}, seek() {},
    setVolume() {}, getVolume: () => 1, isPaused: () => paused, hasTrack: () => true, pos: () => pos
  };
  sandbox.window.aura.spPlaybackState = async () => null;
  vm.createContext(sandbox);
  const load = f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', f), 'utf8'), sandbox, { filename: f });
  load('core.js');
  load('playback.js');
  const run = code => vm.runInContext(code, sandbox);

  const local = { id: 'aaaaaaaaaaaaaaaa', title: 'Local', artist: 'L', artistKey: 'L', artists: ['L'], albumArtist: 'L', genre: 'Rock', duration: 200 };
  const nas = { id: 'nd:s1', source: 'navidrome', title: 'Nas', artist: 'L', artistKey: 'L', artists: ['L'], albumArtist: 'L', genre: 'Rock', duration: 200 };
  const nasSaved = { ...nas, id: 'nd:s2', title: 'Downloaded', offline: true };
  sandbox.__tracks = [local, nas, nasSaved];
  run(`S.tracks = __tracks; S.byId = new Map(S.tracks.map(t => [t.id, t]));`);
  const setNas = (configured, state) => run(`S.nas = { configured: ${configured}, state: '${state}' }`);

  /* --- when is a NAS song unavailable --- */
  const un = t => run(`isUnavailable(S.byId.get('${t.id}'))`);
  setNas(true, 'online');
  assert.deepStrictEqual([un(local), un(nas), un(nasSaved)], [false, false, false]);
  setNas(true, 'connecting');
  assert.strictEqual(un(nas), false, 'connecting is not "down": no dimming flash at startup');
  for (const state of ['offline', 'auth-failed']) {
    setNas(true, state);
    assert.deepStrictEqual([un(local), un(nas), un(nasSaved)], [false, true, false], state + ': only the NAS song that is not downloaded');
  }
  setNas(false, 'unconfigured');
  assert.strictEqual(un(nas), false);

  /* --- recommendations skip unavailable songs --- */
  const pick = () => run(`recommend([S.byId.get('${local.id}')], new Set(), 30).map(t => t.id)`);
  setNas(true, 'online');
  assert.ok(pick().includes('nd:s1'), 'a reachable NAS song can be recommended');
  setNas(true, 'offline');
  const offlinePicks = pick();
  assert.ok(!offlinePicks.includes('nd:s1'), 'an unreachable NAS song is never recommended');
  assert.ok(offlinePicks.includes('nd:s2'), 'a downloaded one still can be');

  /* --- Playback.playNow --- */
  const events = [];
  sandbox.__evt = (...a) => events.push(a.map(x => (x && x.id) || x));
  run(`Playback.on('unavailable', (t, why) => __evt('unavailable', t, why))`);
  const tick = () => { calls.playNow.length = 0; events.length = 0; timers.length = 0; };

  tick(); setNas(true, 'offline');
  run(`Playback.playNow(S.byId.get('nd:s1'))`);
  assert.deepStrictEqual(events, [['unavailable', 'nd:s1', 'offline']]);
  assert.deepStrictEqual(calls.playNow, [], 'an unreachable NAS song never reaches the audio engine');

  tick();
  run(`Playback.playNow(S.byId.get('${local.id}'))`);
  assert.deepStrictEqual(calls.playNow, [local.id], 'local songs play as always, NAS up or down');
  assert.deepStrictEqual(events, []);
  assert.strictEqual(timers.length, 0, 'no NAS watchdog for a local song');

  tick();
  run(`Playback.playNow(S.byId.get('nd:s2'))`);
  assert.deepStrictEqual(calls.playNow, ['nd:s2'], 'a downloaded song plays with the NAS off');

  // NAS up: plays, and a watchdog is armed
  tick(); setNas(true, 'online');
  run(`Playback.playNow(S.byId.get('nd:s1'))`);
  assert.deepStrictEqual(calls.playNow, ['nd:s1']);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 15000);
  pos = { t: 0, dur: 8 }; paused = false;
  timers[0].fn();
  assert.deepStrictEqual(events, [['unavailable', 'nd:s1', 'slow']], 'no sound after 15s: give up');

  // ...but not when it did start, or the listener paused meanwhile, or a newer song superseded it
  tick(); run(`Playback.playNow(S.byId.get('nd:s1'))`);
  pos = { t: 3.2, dur: 8 }; events.length = 0; timers[0].fn();
  assert.deepStrictEqual(events, [], 'started fine');
  tick(); run(`Playback.playNow(S.byId.get('nd:s1'))`);
  pos = { t: 0, dur: 8 }; paused = true; events.length = 0; timers[0].fn();
  assert.deepStrictEqual(events, [], 'paused by the listener');
  paused = false;
  tick(); run(`Playback.playNow(S.byId.get('nd:s1'))`);
  const stale = timers[0];
  run(`Playback.playNow(S.byId.get('${local.id}'))`);
  events.length = 0; pos = { t: 0, dur: 8 }; stale.fn();
  assert.deepStrictEqual(events, [], 'superseded by a newer play');

  /* --- failures reported by the deck --- */
  tick();
  const stopped = a => (handlers.stopped || []).forEach(f => f(...a));
  run(`Playback.playNow(S.byId.get('nd:s1'))`);
  events.length = 0;
  stopped(['error', 'nd:s1']);
  assert.deepStrictEqual(events, [['unavailable', 'nd:s1', 'failed']], 'a NAS stream that fails is reported, not treated as a song that ended');
  events.length = 0;
  run(`Playback.playNow(S.byId.get('${local.id}'))`);
  const localStopped = []; run(`Playback.on('stopped', (...a) => __stopped(a))`);
  sandbox.__stopped = a => localStopped.push(a);
  stopped(['error', local.id]);
  assert.deepStrictEqual(events, [], 'a local file error keeps its existing behaviour');
  assert.strictEqual(localStopped.length, 1);
  events.length = 0;
  (handlers.loaderror || []).forEach(f => f('nd:s1'));
  assert.deepStrictEqual(events, [['unavailable', 'nd:s1', 'preload']], 'a failed preload is reported early');
  (handlers.loaderror || []).forEach(f => f(local.id));
  assert.strictEqual(events.length, 1, 'a local preload failure is not a NAS event');

  return 'nas-playback: unavailability, recommendations, playNow gating, stall watchdog, failure events';
};
