/* playback.js - PlaybackSource abstraction (Aura Spotify brief, phase S3/S4).

   Two sources implement the same small interface (load/play/pause/resume/
   seek/setVolume/getState + events); `Playback` is the only thing player.js
   talks to, and it picks the active source from track.source. Event names
   match what player.js already listens for on AudioEngine (started/time/
   playstate/stopped) so none of that wiring has to change.

   Compliance note (see AURA_SPOTIFY_BRIEF.md phase S6): Spotify's Developer
   Policy forbids overlapping Spotify Content with any other audio, including
   another Spotify stream. Every source boundary here is therefore strictly
   sequential - the old source is fully silent before the new one starts -
   never an overlapping crossfade. That's why Spotify-adjacent transitions
   can't use the dual-deck crossfade and why the next Spotify track is only
   ever started once the current one is confirmed stopped, not pre-started
   "a beat early" the way the local engine's own automix can. */

const LocalSource = (() => {
  const cbs = {};
  const on = (ev, fn) => (cbs[ev] || (cbs[ev] = [])).push(fn);
  const emit = (ev, ...a) => (cbs[ev] || []).forEach(f => { try { f(...a); } catch (e) { console.error(e); } });
  AudioEngine.on('started', id => emit('started', id));
  AudioEngine.on('time', (t, dur, id) => emit('time', t, dur, id));
  AudioEngine.on('playstate', p => emit('playstate', p));
  AudioEngine.on('stopped', () => emit('stopped'));
  return {
    on,
    scheduleNext: id => AudioEngine.scheduleNext(id),
    play: id => AudioEngine.playNow(id),
    loadPaused: (id, atSec) => AudioEngine.loadPaused(id, atSec),
    pause: () => AudioEngine.pause(),
    resume: () => AudioEngine.resume(),
    stop: () => AudioEngine.stop(),
    fadeOutAndStop: dur => AudioEngine.fadeOutAndStop(dur),
    seek: sec => AudioEngine.seek(sec),
    setVolume: v => AudioEngine.setVolume(v),
    getVolume: () => AudioEngine.getVolume(),
    isPaused: () => AudioEngine.isPaused(),
    hasTrack: () => AudioEngine.hasTrack(),
    pos: () => AudioEngine.pos()
  };
})();

/* Remote-controls a real Spotify Connect device over /v1/me/player/*. There
   is no push channel and no reliable 'ended' event, so this polls (a
   self-rescheduling timeout, so slow responses never pile up) and
   interpolates progress between polls. Never touches an audio stream. */
const SpotifySource = (() => {
  const cbs = {};
  const on = (ev, fn) => (cbs[ev] || (cbs[ev] = [])).push(fn);
  const emit = (ev, ...a) => (cbs[ev] || []).forEach(f => { try { f(...a); } catch (e) { console.error(e); } });

  const POLL_MS = 2000, POLL_NEAR_END_MS = 600, POLL_PAUSED_MS = 5000, POLL_IDLE_MS = 30000, POLL_ERROR_MS = 6000;
  // Spotify's reported state lags a command by a second or two; during this
  // window a poll must not undo what Aura just asked for.
  const SETTLE_MS = 2500;

  let curTrack = null;
  let deviceId = null;
  let paused = true, ended = false, pausedSince = 0;
  let lastProgressMs = 0, lastPollAt = 0;
  let pollTimer = null, pollGen = 0;
  let settleUntil = 0, sawNearEnd = false;
  let localVolumePct = 90, deviceVolumePct = null;
  let lastErr = { code: null, at: 0 };

  function interpolatedMs() {
    if (!curTrack) return 0;
    const base = paused ? lastProgressMs : lastProgressMs + (Date.now() - lastPollAt);
    return Math.max(0, Math.min(base, curTrack.duration * 1000));
  }

  function reportError(e) {
    const code = (e && e.code) || 'UNKNOWN';
    if (lastErr.code === code && Date.now() - lastErr.at < 60000) return; // no toast spam from polling
    lastErr = { code, at: Date.now() };
    emit('error', e);
  }

  function schedule(ms) {
    clearTimeout(pollTimer);
    if (!curTrack || ended) { pollTimer = null; return; }
    const gen = pollGen;
    pollTimer = setTimeout(() => { if (gen === pollGen) poll(); }, ms);
  }
  function nextDelay() {
    // paused for a while: just enough to notice a resume from the Spotify app, without burning API quota
    if (paused) return Date.now() - pausedSince > 120000 ? POLL_IDLE_MS : POLL_PAUSED_MS;
    const remaining = curTrack ? curTrack.duration * 1000 - interpolatedMs() : Infinity;
    return remaining <= 6000 ? POLL_NEAR_END_MS : POLL_MS;
  }
  function stopPolling() { pollGen++; clearTimeout(pollTimer); pollTimer = null; }

  function finish() {
    if (ended || !curTrack) return;
    ended = true; paused = true; pausedSince = Date.now(); sawNearEnd = false;
    lastProgressMs = curTrack.duration * 1000; lastPollAt = Date.now();
    stopPolling();
    emit('stopped');
  }

  async function poll() {
    const track = curTrack, gen = pollGen;
    if (!track || ended) return;
    let st;
    try { st = await spApi.spPlaybackState(); }
    catch (e) {
      if (gen !== pollGen) return;
      reportError(e);
      schedule(POLL_ERROR_MS);
      return;
    }
    if (gen !== pollGen || curTrack !== track) return; // superseded while waiting
    lastErr = { code: null, at: 0 };
    const now = Date.now();
    const settling = now < settleUntil;
    const durMs = track.duration * 1000;

    if (!st || !st.item) {
      // Nothing on the account right now. Right after our track was about
      // to end that means it finished; otherwise Spotify went idle.
      if (!settling) {
        if (sawNearEnd) { finish(); return; }
        if (!paused) { lastProgressMs = interpolatedMs(); lastPollAt = now; paused = true; pausedSince = Date.now(); emit('playstate', false); }
      }
      schedule(nextDelay());
      return;
    }
    if (st.device) {
      if (st.device.id) deviceId = st.device.id;
      if (typeof st.device.volume_percent === 'number') deviceVolumePct = st.device.volume_percent;
    }
    const sameTrack = st.item.uri === track.uri || ('sp:' + st.item.id) === track.id;
    if (!sameTrack) {
      // Spotify moved on by itself (autoplay, or someone picked a song in
      // the Spotify app). Aura's queue decides what plays next.
      if (!settling) { finish(); return; }
      schedule(nextDelay());
      return;
    }
    const progress = st.progress_ms || 0;
    const playing = !!st.is_playing;
    if (!settling) {
      // Our song ran out: Spotify either parks at the end, or rewinds to the
      // start (paused, or playing again if its own repeat is on).
      if (sawNearEnd && progress < durMs - 8000) { finish(); return; }
      if (!playing && progress >= durMs - 1500) { finish(); return; }
      if (playing === paused) { paused = !playing; if (paused) pausedSince = now; emit('playstate', playing); }
      lastProgressMs = progress; lastPollAt = now;
      if (durMs - progress > 8000) sawNearEnd = false;
    }
    // only ever set while settling: a song can run out inside the settle
    // window, and forgetting it got this close would stall the queue
    if (playing && durMs - progress <= 5000) sawNearEnd = true;
    schedule(nextDelay());
  }

  // Aura's volume slider drives the Spotify device too, but only when it is
  // actually moved (debounced), never pushed on every track start.
  let volTimer = null;
  function pushVolume() {
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      if (!curTrack) return;
      spApi.spVolume(localVolumePct, deviceId)
        .then(() => { deviceVolumePct = localVolumePct; })
        .catch(e => { if (e.code !== 'PLAYER_REFUSED') reportError(e); }); // phones refuse remote volume
    }, 350);
  }

  setInterval(() => { if (curTrack && !paused) emit('time', interpolatedMs() / 1000, curTrack.duration, curTrack.id); }, 250);

  const api = {
    on,
    setDevice: id => { deviceId = id || null; },
    getDevice: () => deviceId,
    getDeviceVolumePct: () => deviceVolumePct,
    currentTrack: () => curTrack,
    /* Throws on failure and leaves the previous state untouched, so the
       caller can re-pick a device and retry. */
    async play(track, deviceIdOverride, positionSec = 0) {
      if (deviceIdOverride) deviceId = deviceIdOverride;
      // stop polling first: a poll landing mid-request would see the new
      // song, decide the old one "ended" and skip ahead in the queue
      stopPolling();
      try { await spApi.spPlayUris([track.uri], deviceId, positionSec * 1000); }
      catch (e) { schedule(POLL_ERROR_MS); throw e; }
      curTrack = track; ended = false; paused = false; sawNearEnd = false;
      lastProgressMs = positionSec * 1000; lastPollAt = Date.now();
      settleUntil = Date.now() + SETTLE_MS;
      lastErr = { code: null, at: 0 };
      emit('started', track.id);
      emit('playstate', true);
      schedule(1200);
    },
    async pause() {
      if (!curTrack || paused) return;
      lastProgressMs = interpolatedMs(); lastPollAt = Date.now();
      paused = true; pausedSince = Date.now(); settleUntil = Date.now() + SETTLE_MS;
      emit('playstate', false);
      try { await spApi.spPause(deviceId); }
      catch (e) { if (e.code !== 'PLAYER_REFUSED') reportError(e); } // PLAYER_REFUSED here means already paused
      schedule(POLL_PAUSED_MS);
    },
    /* Throws (back in the paused state) when the device can't resume, so
       Playback can find a device again and restart the song there. */
    async resume() {
      if (!curTrack) return;
      if (ended) { await api.play(curTrack, deviceId, 0); return; } // finished song: again from the top
      if (!paused) return;
      paused = false; lastPollAt = Date.now(); settleUntil = Date.now() + SETTLE_MS;
      emit('playstate', true);
      try { await spApi.spResume(deviceId); }
      catch (e) { paused = true; pausedSince = Date.now(); emit('playstate', false); throw e; }
      schedule(POLL_MS);
    },
    positionSec: () => interpolatedMs() / 1000,
    async stop() {
      const had = curTrack && !paused && !ended;
      curTrack = null; ended = false; paused = true; pausedSince = Date.now(); sawNearEnd = false;
      stopPolling();
      if (had) { try { await spApi.spPause(deviceId); } catch {} }
    },
    seek(sec) {
      if (!curTrack) return Promise.resolve();
      sec = Math.max(0, Math.min(sec, curTrack.duration - 1));
      if (ended) return api.play(curTrack, deviceId, sec).catch(reportError);
      lastProgressMs = sec * 1000; lastPollAt = Date.now();
      settleUntil = Date.now() + SETTLE_MS; sawNearEnd = false;
      emit('time', sec, curTrack.duration, curTrack.id);
      return spApi.spSeek(sec * 1000, deviceId).catch(reportError);
    },
    setVolume(v) { localVolumePct = Math.round(Math.max(0, Math.min(1, v)) * 100); if (curTrack) pushVolume(); },
    getVolume: () => localVolumePct / 100,
    isPaused: () => paused,
    hasTrack: () => !!curTrack,
    pos: () => ({ t: interpolatedMs() / 1000, dur: curTrack ? curTrack.duration : 0 })
  };
  return api;
})();

const Playback = (() => {
  const cbs = {};
  const on = (ev, fn) => (cbs[ev] || (cbs[ev] = [])).push(fn);
  const emit = (ev, ...a) => (cbs[ev] || []).forEach(f => { try { f(...a); } catch (e) { console.error(e); } });

  let active = 'local'; // which source is actually driving audio right now
  let nextQueued = null;
  let handedOffNext = false;
  let devicePickerFn = null; // set by spotify.js: async (devices) => deviceId
  let switching = 0;         // >0 while Aura itself stops a source, so that stop isn't taken for a song ending
  let playSeq = 0;           // newest playNow wins; older in-flight ones bail out

  for (const [src, name] of [[LocalSource, 'local'], [SpotifySource, 'spotify']]) {
    src.on('time', (...a) => { if (active === name) emit('time', ...a); });
    src.on('started', (...a) => { if (active === name) emit('started', ...a); });
    src.on('playstate', (...a) => { if (active === name) emit('playstate', ...a); });
    src.on('stopped', (...a) => {
      if (active !== name || switching) return;
      if (!handleNaturalEnd()) emit('stopped', ...a);
    });
  }
  SpotifySource.on('error', e => emit('error', e));

  function handleNaturalEnd() {
    if (handedOffNext || !nextQueued) return false;
    const t = S.byId.get(nextQueued);
    if (!t) return false;
    handedOffNext = true;
    playNow(t);
    return true;
  }

  function onDevicePicker(fn) { devicePickerFn = fn; }

  // Errors no device choice can fix; anything else is worth asking for a device again.
  const FATAL = new Set(['PREMIUM_REQUIRED', 'REAUTH_REQUIRED', 'OFFLINE', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'NO_DEVICE_PICKED']);

  async function ensureSpotifyDevice({ forcePick = false } = {}) {
    if (!forcePick) {
      const known = SpotifySource.getDevice();
      if (known) return known;
      try {
        const st = await spApi.spPlaybackState();
        if (st && st.device && st.device.id && !st.device.is_restricted) { SpotifySource.setDevice(st.device.id); return st.device.id; }
      } catch (e) { if (FATAL.has(e.code)) throw e; }
    }
    const devices = (await spApi.spDevices()).filter(d => d && d.id);
    const usable = devices.filter(d => !d.is_restricted);
    if (!forcePick) {
      const pick = usable.find(d => d.is_active) || (usable.length === 1 ? usable[0] : null);
      if (pick) { SpotifySource.setDevice(pick.id); return pick.id; }
    }
    if (typeof devicePickerFn === 'function') {
      const id = await devicePickerFn(devices);
      if (id) { SpotifySource.setDevice(id); return id; }
      const e = new Error('No Spotify device picked'); e.code = 'NO_DEVICE_PICKED'; throw e;
    }
    const e = new Error('No active Spotify device'); e.code = 'NO_ACTIVE_DEVICE'; throw e;
  }

  async function quietly(fn) {
    switching++;
    try { await fn(); } finally { switching--; }
  }

  /* Local-track-ending-into-a-Spotify-next needs its own early trigger since
     it isn't driven by polling: watch the local clock and start the handoff
     ~0.8s before the natural end. playNow fades the local deck fully out
     before Spotify's play call goes out (see the compliance note above). */
  let localHandoffArmed = false;
  LocalSource.on('time', (t, dur) => {
    if (active !== 'local' || !nextQueued || handedOffNext || localHandoffArmed) return;
    const next = S.byId.get(nextQueued);
    if (!next || next.source !== 'spotify') return;
    if (dur && dur - t <= 0.8) {
      localHandoffArmed = true;
      handedOffNext = true;
      playNow(next);
    }
  });
  LocalSource.on('started', () => { localHandoffArmed = false; });

  async function playNow(track) {
    if (!track) return;
    const seq = ++playSeq;
    const stale = () => seq !== playSeq;
    if (track.source === 'spotify') {
      if (!track.uri) { emit('error', Object.assign(new Error('This Spotify song has no playable link'), { code: 'UNKNOWN' })); return; }
      let deviceId;
      // Resolve the device before touching local audio, so a cancelled
      // picker or a missing device leaves whatever was playing alone.
      try { deviceId = await ensureSpotifyDevice(); }
      catch (e) { if (!stale()) emit('error', e); return; }
      if (stale()) return;
      if (active === 'local' && LocalSource.hasTrack()) {
        await quietly(() => LocalSource.isPaused() ? LocalSource.stop() : LocalSource.fadeOutAndStop(0.7));
        if (stale()) return;
      }
      active = 'spotify';
      try {
        await SpotifySource.play(track, deviceId);
      } catch (e) {
        if (stale()) return;
        if (FATAL.has(e.code)) { emit('error', e); return; }
        // The remembered device is gone or refused: ask again, retry once.
        try {
          SpotifySource.setDevice(null);
          deviceId = await ensureSpotifyDevice({ forcePick: e.code === 'PLAYER_REFUSED' });
          if (stale()) return;
          await SpotifySource.play(track, deviceId);
        } catch (e2) { if (!stale()) emit('error', e2); return; }
      }
      if (!stale()) handedOffNext = false;
    } else {
      if (SpotifySource.hasTrack()) {
        // Pause the Spotify device (fully silent) before local audio starts.
        await quietly(() => SpotifySource.stop());
        if (stale()) return;
      }
      active = 'local';
      handedOffNext = false; localHandoffArmed = false;
      LocalSource.play(track.id);
    }
  }

  function scheduleNext(id) {
    nextQueued = id || null;
    handedOffNext = false; localHandoffArmed = false;
    const next = id ? S.byId.get(id) : null;
    // Only the local engine can actually preload/crossfade; a Spotify id
    // never gets handed to it (there is no local file to load).
    if (active === 'local') LocalSource.scheduleNext(next && next.source !== 'spotify' ? id : null);
  }

  function cur() { return active === 'local' ? LocalSource : SpotifySource; }

  return {
    on, onDevicePicker,
    playNow, scheduleNext,
    chooseSpotifyDevice: () => ensureSpotifyDevice({ forcePick: true }),
    // Session-restore only: preload the local deck paused at a saved
    // position, never audible until the user presses Play. Spotify tracks
    // aren't restorable this way (there's no "preload paused" on Connect),
    // callers should just skip restoring one.
    loadPaused: (track, atSec) => { active = 'local'; LocalSource.loadPaused(track.id, atSec); },
    pause: () => cur().pause(),
    resume: async () => {
      if (active !== 'spotify') return LocalSource.resume();
      const track = SpotifySource.currentTrack();
      try { await SpotifySource.resume(); }
      catch (e) {
        if (!track || FATAL.has(e.code)) { emit('error', e); return; }
        // Spotify dropped the session or the device went away while paused
        // (it idles out after a while): find a device and pick up where it was.
        const seq = ++playSeq;
        try {
          SpotifySource.setDevice(null);
          const deviceId = await ensureSpotifyDevice();
          if (seq !== playSeq) return;
          await SpotifySource.play(track, deviceId, SpotifySource.positionSec());
        } catch (e2) { if (seq === playSeq) emit('error', e2); }
      }
    },
    stop: () => { playSeq++; LocalSource.stop(); SpotifySource.stop(); },
    seek: sec => cur().seek(sec),
    setVolume: v => { LocalSource.setVolume(v); SpotifySource.setVolume(v); },
    getVolume: () => LocalSource.getVolume(),
    isPaused: () => cur().isPaused(),
    hasTrack: () => cur().hasTrack(),
    pos: () => cur().pos(),
    activeSource: () => active,
    /* The DJ's voice is always synthesized locally and always plays over the
       local voice bus (Kokoro/system speech has no other output path) - what
       differs by source is what gets ducked while it talks. Over Spotify
       there's no music bus to duck, so this lowers the Connect device's own
       volume instead, per the brief's S4.4 note, then restores it. */
    async speak(buf, text) {
      const restorePct = SpotifySource.getDeviceVolumePct();
      if (active === 'spotify' && SpotifySource.hasTrack() && !SpotifySource.isPaused() && restorePct != null) {
        const duckedPct = Math.max(5, Math.round(restorePct * 0.22));
        const deviceId = SpotifySource.getDevice();
        try { await spApi.spVolume(duckedPct, deviceId); } catch {}
        try { await AudioEngine.speak(buf, text); }
        finally { try { await spApi.spVolume(restorePct, deviceId); } catch {} }
      } else {
        await AudioEngine.speak(buf, text);
      }
    }
  };
})();
