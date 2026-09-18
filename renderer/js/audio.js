/* audio.js — dual-deck crossfade engine.
   Two <audio> decks feed one music bus. Transitions are equal-power
   crossfades; automix watches the outro and starts the blend early
   when a track goes quiet. Automatic transitions (natural end-of-track,
   automix) also skip leading dead air on the incoming track and shorten
   the blend around short interludes/skits, so a hip-hop-style tracklist
   with spoken skits between songs doesn't fade into silence or turn a
   skit-to-song segue into a muddy multi-second overlap. A manual skip/play
   always starts the chosen track at 0:00 - only the automatic path takes
   these liberties. The DJ voice has its own bus and ducks the music while
   speaking. */

const AudioEngine = (() => {
  const AC = new (window.AudioContext || window.webkitAudioContext)();
  const musicBus = AC.createGain();
  const voiceBus = AC.createGain();
  const master = AC.createGain();
  musicBus.connect(master);
  voiceBus.connect(master);
  master.connect(AC.destination);

  // AudioContext boots suspended; make sure the very first play is never silent
  // by resuming on the first user gesture, in addition to the resume() calls below.
  document.addEventListener('pointerdown', () => AC.resume(), { once: true });

  function mkDeck() {
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    const src = AC.createMediaElementSource(el);
    // norm holds the per-track loudness-match multiplier (see measureLoudness
    // below); gain is the existing crossfade automation. Splitting them means
    // the equal-power fade curves never need to know about loudness at all.
    const norm = AC.createGain(); norm.gain.value = 1;
    const gain = AC.createGain(); gain.gain.value = 0;
    const an = AC.createAnalyser(); an.fftSize = 1024;
    src.connect(norm); norm.connect(gain); gain.connect(musicBus);
    src.connect(an);
    return { el, norm, gain, an, trackId: null, buf: new Uint8Array(1024) };
  }
  const decks = [mkDeck(), mkDeck()];
  let active = 0;
  let nextQueued = null;
  let transitioning = false;
  let quietSince = 0;

  const opts = { crossfade: 5, automix: true, normalize: true, fadePause: true, mono: false };

  // Mono: the master bus downmixes to one channel, which the destination
  // then plays out of both speakers (one-earbud listening, hearing loss).
  function applyMono() {
    master.channelCountMode = opts.mono ? 'explicit' : 'max';
    master.channelCount = opts.mono ? 1 : 2;
    master.channelInterpretation = 'speakers';
  }

  /* Smooth pause/resume: a short fade instead of a hard cut. While the
     fade-out is running the deck already counts as paused, so pressing Play
     again mid-fade resumes straight away instead of queueing another pause. */
  const PAUSE_FADE = 0.22, RESUME_FADE = 0.35;
  let pauseTok = 0, fadingOut = false;
  function pauseDeck() {
    const d = act();
    pauseTok++;
    if (!opts.fadePause || d.el.paused || transitioning || !d.trackId) { fadingOut = false; d.el.pause(); return; }
    const tok = pauseTok;
    fadingOut = true;
    emit('playstate', false);
    ramp(d.gain, 0, PAUSE_FADE, 'out');
    setTimeout(() => {
      if (tok !== pauseTok) return;
      fadingOut = false;
      d.el.pause();
    }, PAUSE_FADE * 1000 + 20);
  }
  function resumeDeck(d) {
    pauseTok++;
    const wasFading = fadingOut;
    fadingOut = false;
    if (transitioning) { d.el.play().catch(() => {}); return; }
    if (opts.fadePause) {
      if (d.el.paused && !wasFading) {
        d.gain.gain.cancelScheduledValues(AC.currentTime);
        d.gain.gain.setValueAtTime(0, AC.currentTime);
        d.gain.gain.value = 0;
      }
      d.el.play().catch(() => {});
      ramp(d.gain, 1, RESUME_FADE, 'in');
      if (wasFading) emit('playstate', true);
    } else {
      ramp(d.gain, 1, 0.02, 'in');
      d.el.play().catch(() => {});
    }
  }

  /* ---------- loudness matching + intro-silence detection ---------- */
  // Reference RMS a track is compensated toward; picked from typical
  // streaming-loudness masters. Compensation is clamped so a badly clipped
  // or near-silent file can't get pushed to an extreme gain.
  const REF_RMS = 0.16, MIN_COMP = 0.4, MAX_COMP = 1.6, SAMPLE_BYTES = 900_000;
  // How much leading dead air is worth skipping on an automatic transition,
  // and how much margin to leave before the first audible content so the
  // skip doesn't feel like it's cutting straight onto a beat.
  const MAX_INTRO_SKIP = 12, ONSET_RMS = 0.02, ONSET_PREROLL = 0.15;
  const loudness = new Map(); // trackId -> { factor, introSilence } (linear gain compensation, leading-silence seconds)
  window.aura.loudnessAll().then(saved => {
    // old persisted shape was a bare number (gain factor only); migrate it
    // in memory on load so every reader can assume the {factor, introSilence}
    // shape - previously-measured tracks just have introSilence:0 until
    // they're naturally remeasured (they're never forced to re-decode).
    for (const [id, v] of Object.entries(saved || {})) loudness.set(id, typeof v === 'number' ? { factor: v, introSilence: 0 } : v);
  }).catch(() => {});

  async function measureLoudness(id) {
    if (loudness.has(id)) return loudness.get(id);
    loudness.set(id, { factor: 1, introSilence: 0 }); // placeholder so concurrent loads don't re-measure the same track
    try {
      const res = await fetch(url(id), { headers: { Range: `bytes=0-${SAMPLE_BYTES}` } });
      const buf = await res.arrayBuffer();
      const decoded = await AC.decodeAudioData(buf.slice(0));
      const data = decoded.getChannelData(0);
      // skip a leading fraction in case of an intro fade-in/silence, sample the rest
      const start = Math.floor(data.length * 0.15);
      let sum = 0;
      for (let i = start; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / Math.max(1, data.length - start));
      const factor = rms > 0.001 ? Math.max(MIN_COMP, Math.min(MAX_COMP, REF_RMS / rms)) : 1;

      // Walk forward in 50ms windows to find the first sustained audible
      // content, so an automatic transition can land the incoming track on
      // its first real sound instead of fading into a few seconds of dead
      // air (common on yt-dlp rips with a silent lead-in, or an intentional
      // studio pause before the beat drops). Only ever looks within the
      // sampled prefix above; a track with more leading silence than that
      // just doesn't get skipped, never mis-skipped.
      const winSize = Math.max(1, Math.round(decoded.sampleRate * 0.05));
      let onsetSample = -1;
      for (let from = 0; from < data.length; from += winSize) {
        const to = Math.min(data.length, from + winSize);
        let s = 0;
        for (let i = from; i < to; i++) s += data[i] * data[i];
        if (Math.sqrt(s / (to - from)) > ONSET_RMS) { onsetSample = from; break; }
      }
      const introSilence = onsetSample < 0 ? 0 : Math.max(0, Math.min(MAX_INTRO_SKIP, onsetSample / decoded.sampleRate - ONSET_PREROLL));

      const result = { factor, introSilence };
      loudness.set(id, result);
      window.aura.loudnessSet(id, result).catch(() => {});
      return result;
    } catch {
      const fallback = { factor: 1, introSilence: 0 };
      loudness.set(id, fallback); // undecodable partial range (common for m4a); skip normalizing/trimming this one
      return fallback;
    }
  }
  const cbs = { time: [], started: [], playstate: [], stopped: [] };
  const on = (ev, fn) => (cbs[ev] || (cbs[ev] = [])).push(fn);
  const emit = (ev, ...a) => (cbs[ev] || []).forEach(f => { try { f(...a); } catch (e) { console.error(e); } });

  const url = id => '/track/' + encodeURIComponent(id);
  const act = () => decks[active];
  const idle = () => decks[1 - active];

  /* equal-power ramp: 'in' follows sin, 'out' follows cos, 'lin' is linear */
  function ramp(g, target, dur, shape) {
    const now = AC.currentTime;
    // cancelScheduledValues() doesn't reliably stop an in-flight setValueCurveAtTime
    // automation (Chromium keeps it running); cancelAndHoldAtTime() does, and also
    // freezes gain.value at its current position so `start` below reads correctly.
    if (typeof g.gain.cancelAndHoldAtTime === 'function') g.gain.cancelAndHoldAtTime(now);
    else g.gain.cancelScheduledValues(now);
    const start = g.gain.value;
    if (dur <= 0.03) { g.gain.setValueAtTime(target, now); return; }
    const N = 30, c = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      const t = shape === 'in' ? Math.sin(x * Math.PI / 2)
        : shape === 'out' ? 1 - Math.cos(x * Math.PI / 2)
        : x;
      c[i] = Math.max(0, start + (target - start) * t);
    }
    try { g.gain.setValueCurveAtTime(c, now, dur); }
    catch { g.gain.setValueAtTime(target, now); }
  }

  function loadIdle(id) {
    const d = idle();
    if (d.trackId !== id) {
      d.el.src = url(id);
      d.trackId = id;
      // apply whatever's already cached immediately (no decode work here);
      // an unmeasured track just plays at unity gain until it's been measured
      // once in the background, so loading a deck never has to wait on or
      // race a fetch+decode
      d.norm.gain.value = opts.normalize ? (loudness.get(id)?.factor ?? 1) : 1;
      try { d.el.load(); } catch {}
      if (!loudness.has(id)) {
        // deliberately delayed and off the hot path: measuring right when a
        // track is loaded used to race the same track's own playback request
        // (worst case on an immediate manual skip, where load and play happen
        // in the same tick) and could stall the very start of audible sound.
        // A background measurement here only ever benefits a *later* play of
        // this track, so there's no reason to rush it.
        setTimeout(() => {
          measureLoudness(id).then(m => {
            // only touch a deck that's still idle (not already playing that
            // track) so a late-arriving measurement can never cause an
            // audible jump mid-playback
            if (d.trackId === id && d.el.paused) d.norm.gain.value = opts.normalize ? m.factor : 1;
          });
        }, 600);
      }
    }
  }

  // Restores the "active" deck to a track, paused, at a given position -
  // used only to resume Aura's last session on launch. Never calls .play():
  // the app should never suddenly make sound just because it was reopened,
  // the user presses Play to actually continue.
  function loadPaused(id, atSec) {
    const d = act();
    d.el.src = url(id);
    d.trackId = id;
    d.gain.gain.value = 1; // no crossfade in progress - this deck should be fully audible once played
    d.norm.gain.value = opts.normalize ? (loudness.get(id)?.factor ?? 1) : 1;
    const setTime = () => { try { d.el.currentTime = Math.max(0, atSec || 0); } catch {} };
    if (d.el.readyState >= 1) setTime();
    else d.el.addEventListener('loadedmetadata', setTime, { once: true });
    try { d.el.load(); } catch {}
  }

  function scheduleNext(id) {
    nextQueued = id || null;
    if (transitioning) return; // idle deck is still fading out, load after the blend
    if (id) loadIdle(id);
    else {
      const d = idle();
      d.trackId = null;
      try { d.el.removeAttribute('src'); } catch {}
    }
  }

  // Interludes/skits sitting between songs (short by nature) sound wrong run
  // through a full musical crossfade - a multi-second overlap of two bits of
  // dialogue, or a skit bleeding into the next song's intro, just reads as
  // muddy rather than smooth. When either side of an automatic transition is
  // this short, cap the blend to a quick, near-gapless handoff instead.
  const SHORT_TRACK_SEC = 60, SHORT_TRACK_FADE = 1.2;
  function effectiveFade(base) {
    const shortish = d => d.trackId && d.el.duration && d.el.duration < SHORT_TRACK_SEC;
    return (shortish(act()) || shortish(idle())) ? Math.min(base, SHORT_TRACK_FADE) : base;
  }

  // skipIntro is true only for automatic transitions (natural end-of-track,
  // automix, the 'ended' fallback) - never for a manual play/skip, which
  // must always start the chosen track at 0:00.
  function beginTransition(fade, skipIntro) {
    if (transitioning || !nextQueued) return false;
    transitioning = true;
    gated = false;
    pauseTok++; fadingOut = false; // a skip mid pause-fade wins; the old deck is faded out below anyway
    const from = act();
    const to = idle();
    const id = nextQueued;
    nextQueued = null;
    active = 1 - active;
    const meas = loudness.get(id);
    const intro = (skipIntro && meas && meas.introSilence > 0.3 && to.el.duration && meas.introSilence < to.el.duration - 5) ? meas.introSilence : 0;
    try { to.el.currentTime = intro; } catch {}
    to.norm.gain.value = opts.normalize ? (meas?.factor ?? 1) : 1;
    AC.resume();
    to.el.play().catch(() => {});
    const f = Math.max(0.05, fade);
    ramp(to.gain, 1, f, 'in');
    ramp(from.gain, 0, f, 'out');
    emit('started', id);
    setTimeout(() => {
      try { from.el.pause(); } catch {}
      try { from.el.removeAttribute('src'); } catch {}
      from.trackId = null;
      transitioning = false;
      quietSince = 0;
      if (nextQueued) loadIdle(nextQueued); // deferred preload from mid-blend scheduling
    }, Math.max(80, f * 1000));
    return true;
  }

  /* user-initiated start or skip: still blends, just faster, and always
     starts the chosen track from 0:00 (no intro-silence skip - that's only
     for the automatic path, see beginTransition). */
  function playNow(id) {
    if (!id) return;
    previewStop(0.3);
    if (gated) cancelBreak(); // listener skipped while the DJ was mid-break
    const from = act();
    const wasAudible = from.trackId && !from.el.paused;
    if (transitioning) {
      // let the current blend settle into a quick follow-up
      setTimeout(() => playNow(id), 180);
      return;
    }
    scheduleNext(id);
    beginTransition(wasAudible ? 0.7 : 0.12);
  }

  /* ---------- album taste previews ----------
     Hovering a release plays a short, quiet taste of it. Two little decks
     that bypass the music bus (so the user's volume still applies but the
     crossfade engine never sees them) crossfade into each other when the
     pointer slides from one album to the next. */
  const PREVIEW_LEN = 14, PREVIEW_SR = 8000, PREVIEW_DUCK = 0.06, PREVIEW_OVER_MUSIC = 0.8;
  const pvDecks = [0, 1].map(() => {
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    const gain = AC.createGain(); gain.gain.value = 0;
    AC.createMediaElementSource(el).connect(gain);
    gain.connect(master);
    return { el, gain, token: 0, stopT: 0 };
  });
  let pvActive = 0, pvToken = 0, pvDucked = false, pvEndT = 0;
  const highlights = new Map(); // trackId -> Promise<{ start, factor } | null>

  // Find "the good part": decode the whole song at a low sample rate (plenty
  // for loudness, a fraction of the memory), then score every start point by
  // how loud the next ~14s are, plus a bonus when energy jumps up right there,
  // which is where a hook or drop tends to come in. Starts a beat early so the
  // fade-in lands on the lift instead of cutting into it.
  function findHighlight(id) {
    if (!highlights.has(id)) highlights.set(id, (async () => {
      const buf = await (await fetch(url(id))).arrayBuffer();
      const dec = await new OfflineAudioContext(1, 1, PREVIEW_SR).decodeAudioData(buf);
      const chans = [...Array(dec.numberOfChannels).keys()].map(c => dec.getChannelData(c));
      const WIN = PREVIEW_SR / 2, n = Math.floor(chans[0].length / WIN), dur = chans[0].length / PREVIEW_SR;
      const e = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        let s = 0;
        for (const ch of chans) for (let i = k * WIN, end = i + WIN; i < end; i += 2) s += ch[i] * ch[i];
        e[k] = Math.sqrt(s / (WIN / 2 * chans.length));
      }
      const pre = new Float32Array(n + 1);
      for (let k = 0; k < n; k++) pre[k + 1] = pre[k] + e[k];
      const mean = (a, b) => (pre[Math.min(n, b)] - pre[Math.max(0, a)]) / Math.max(1, Math.min(n, b) - Math.max(0, a));
      const L = PREVIEW_LEN * 2, from = Math.round(Math.max(8, dur * 0.12) * 2), to = Math.round(Math.min(dur - PREVIEW_LEN - 4, dur * 0.75) * 2);
      let best = -1, bestScore = -1;
      for (let k = from; k <= to; k++) {
        const score = mean(k, k + L) + 0.6 * Math.max(0, mean(k, k + 8) - mean(k - 8, k));
        if (score > bestScore) { bestScore = score; best = k; }
      }
      const start = best < 0 ? dur * 0.3 : Math.max(0, best / 2 - 1.5);
      const segRms = best < 0 ? mean(0, n) : mean(best, best + L);
      const factor = segRms > 0.001 ? Math.max(MIN_COMP, Math.min(MAX_COMP, REF_RMS / (segRms * 1.2))) : 1;
      return { start, factor };
    })().catch(() => null));
    return highlights.get(id);
  }

  function fadeOutPreviewDeck(d, dur) {
    d.token++;
    clearTimeout(d.stopT);
    if (d.el.paused) return;
    ramp(d.gain, 0, dur, 'out');
    const tok = d.token;
    d.stopT = setTimeout(() => { if (tok === d.token) { try { d.el.pause(); d.el.removeAttribute('src'); } catch {} } }, dur * 1000 + 60);
  }

  // Resolves true once the taste is audible, false if it was superseded or failed.
  async function previewStart(id, { level = 0.5, onEnd } = {}) {
    const my = ++pvToken;
    clearTimeout(pvEndT);
    AC.resume();
    const hl = await findHighlight(id);
    if (my !== pvToken) return false;
    const old = pvDecks[pvActive];
    pvActive = 1 - pvActive;
    const d = pvDecks[pvActive];
    fadeOutPreviewDeck(old, 0.9);
    fadeOutPreviewDeck(d, 0.01);
    const tok = ++d.token;
    try {
      d.el.src = url(id);
      await new Promise((res, rej) => { d.el.onloadedmetadata = res; d.el.onerror = rej; });
      d.el.currentTime = hl ? Math.min(hl.start, Math.max(0, d.el.duration - PREVIEW_LEN)) : d.el.duration * 0.3;
      d.gain.gain.cancelScheduledValues(AC.currentTime);
      d.gain.gain.setValueAtTime(0, AC.currentTime);
      await d.el.play();
    } catch { return false; }
    if (my !== pvToken || tok !== d.token) { fadeOutPreviewDeck(d, 0.3); return false; }
    // quiet by design: roughly half the level of normal playback, loudness
    // matched, and a long equal-power swell so it never jumps out at you.
    // Over a playing song it would just fight it, so the song steps almost
    // all the way back and the taste comes up to a normal listening level.
    const factor = opts.normalize && hl ? hl.factor : 1;
    const main = act();
    if (!pvDucked && main.trackId && !main.el.paused && !gated) { pvDucked = true; ramp(musicBus, PREVIEW_DUCK, 1.2, 'lin'); }
    ramp(d.gain, (pvDucked ? PREVIEW_OVER_MUSIC : level) * factor, 1.6, 'in');
    pvEndT = setTimeout(() => { if (my === pvToken) { previewStop(2.2); if (onEnd) onEnd(); } }, PREVIEW_LEN * 1000);
    return true;
  }

  function previewStop(fade = 0.8) {
    pvToken++;
    clearTimeout(pvEndT);
    for (const d of pvDecks) fadeOutPreviewDeck(d, fade);
    if (pvDucked) { pvDucked = false; if (!gated) ramp(musicBus, 1, fade + 0.9, 'in'); }
  }

  function rms(d) {
    d.an.getByteTimeDomainData(d.buf);
    let s = 0;
    for (let i = 0; i < d.buf.length; i++) { const v = (d.buf[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / d.buf.length);
  }

  /* Idle suspend: a running AudioContext renders silence on its own audio
     thread and holds the output device open for as long as Aura is open.
     After a while with nothing that could make sound (both decks paused,
     no preview, no DJ voice) it's suspended; every path that starts sound
     already calls AC.resume() first. */
  const IDLE_SUSPEND_MS = 30000;
  let idleSince = 0, speaking = 0;
  function audible() {
    return transitioning || gated || !!voice || speaking > 0 || fadingOut
      || decks.some(d => !d.el.paused) || pvDecks.some(d => !d.el.paused);
  }
  function idleCheck() {
    if (audible()) { idleSince = 0; return; }
    if (!idleSince) { idleSince = performance.now(); return; }
    if (AC.state === 'running' && performance.now() - idleSince > IDLE_SUSPEND_MS) AC.suspend().catch(() => {});
  }

  /* transition driver */
  setInterval(() => {
    idleCheck();
    const d = act();
    if (!d.trackId) return;
    const t = d.el.currentTime || 0;
    const dur = d.el.duration || 0;
    emit('time', t, dur, d.trackId);
    if (!dur || d.el.paused || transitioning || !nextQueued) { quietSince = 0; return; }
    if (gated) return;
    const remaining = dur - t;
    const fade = effectiveFade(Math.max(0.05, opts.crossfade));
    // with a DJ gate armed, ask a little before the end even at crossfade 0,
    // so a break can fade the outro instead of catching a hard stop
    if (remaining <= (gate ? Math.max(fade, 1.6) : fade)) { autoTransition(Math.min(fade, Math.max(0.05, remaining))); return; }
    if (opts.automix && remaining <= 15) {
      if (rms(d) < 0.012) {
        if (!quietSince) quietSince = performance.now();
        else if (performance.now() - quietSince > 750) { quietSince = 0; autoTransition(fade); }
      } else quietSince = 0;
    }
  }, 200);

  for (const d of decks) {
    d.el.addEventListener('ended', () => {
      if (d !== act() || gated) return;
      if (nextQueued) autoTransition(0.08);
      else { d.trackId = null; emit('stopped'); }
    });
    d.el.addEventListener('play', () => { if (d === act()) emit('playstate', true); });
    d.el.addEventListener('pause', () => { if (d === act() && !transitioning && !gated) emit('playstate', false); });
    d.el.addEventListener('error', () => { if (d === act() && d.trackId) { console.warn('deck error', d.el.error); emit('stopped'); } });
  }

  function duck(onOff) { ramp(musicBus, onOff ? 0.22 : 1, onOff ? 0.3 : 0.5, 'lin'); }

  /* ---------- DJ breaks ----------
     A gate (set by dj.js while the DJ is on) gets first refusal on every
     automatic song boundary. When it takes one, the engine stops advancing
     on its own ("gated"): the DJ fades the outro, talks, and starts the next
     song itself at the tail of its voice. Any manual play/skip/pause during
     that window cancels the break and behaves normally. */
  let gate = null, gated = false, voice = null;

  function autoTransition(fade) {
    if (gated) return;
    if (gate && nextQueued) {
      let took = false;
      try { took = gate(nextQueued); } catch (e) { console.error(e); }
      if (took) { gated = true; quietSince = 0; return; }
    }
    beginTransition(fade, true);
  }

  function cancelBreak() {
    gated = false;
    stopVoice();
    ramp(musicBus, 1, 0.2, 'lin');
    const d = act();
    if (d.trackId) ramp(d.gain, 1, 0.15, 'in');
    emit('breakcancel');
  }

  function decodeVoice(buf) {
    if (typeof AudioBuffer !== 'undefined' && buf instanceof AudioBuffer) return Promise.resolve(buf);
    if (!buf || !buf.byteLength || buf.byteLength < 128) return Promise.resolve(null);
    return AC.decodeAudioData(buf.slice(0)).catch(() => null);
  }

  function stopVoice() { if (voice) voice.cancel(); voice = null; }

  // Plays a DJ clip on the voice bus. onTail fires `tail` seconds before the
  // clip ends (for system speech, whose length is unknown, right at the end).
  // Resolves true when it finished, false when it was cancelled.
  function voiceThen(clip, text, { tail = 0.45, onTail } = {}) {
    stopVoice();
    AC.resume();
    return new Promise(resolve => {
      const v = voice = { timers: [], done: false, tailFired: false };
      const fireTail = () => { if (v.tailFired) return; v.tailFired = true; if (onTail) { try { onTail(); } catch (e) { console.error(e); } } };
      const finish = ok => { if (v.done) return; v.done = true; v.timers.forEach(clearTimeout); if (voice === v) voice = null; resolve(ok); };
      v.cancel = () => {
        v.tailFired = true;
        try { if (v.src) v.src.stop(); } catch {}
        try { if (v.utter) speechSynthesis.cancel(); } catch {}
        finish(false);
      };
      decodeVoice(clip).then(buf => {
        if (v.done) return;
        if (!buf) { systemSpeech(); return; }
        const src = v.src = AC.createBufferSource();
        src.buffer = buf;
        src.connect(voiceBus);
        src.onended = () => { fireTail(); finish(true); };
        src.start();
        v.timers.push(setTimeout(fireTail, Math.max(0, (buf.duration - tail) * 1000)));
        v.timers.push(setTimeout(() => { fireTail(); finish(true); }, buf.duration * 1000 + 1500));
      });
      function systemSpeech() {
        if (!('speechSynthesis' in window) || !text) { fireTail(); finish(true); return; }
        const u = v.utter = new SpeechSynthesisUtterance(text);
        u.rate = 1.03; u.pitch = 0.95;
        u.onend = u.onerror = () => { fireTail(); finish(true); };
        speechSynthesis.speak(u);
        v.timers.push(setTimeout(() => { fireTail(); finish(true); }, 20000));
      }
    });
  }

  /* DJ voice: WAV buffer from Kokoro, or system speech as fallback */
  function speak(arrayBuf, text) {
    return new Promise(resolve => {
      let finished = false;
      const done = () => { if (finished) return; finished = true; speaking--; duck(false); resolve(); };
      speaking++;
      AC.resume();
      duck(true);
      if (arrayBuf && arrayBuf.byteLength > 128) {
        AC.decodeAudioData(arrayBuf.slice(0)).then(buf => {
          const srcN = AC.createBufferSource();
          srcN.buffer = buf;
          srcN.connect(voiceBus);
          srcN.onended = done;
          srcN.start();
          setTimeout(done, buf.duration * 1000 + 1500);
        }).catch(() => fallbackSpeech());
      } else fallbackSpeech();

      function fallbackSpeech() {
        if ('speechSynthesis' in window && text) {
          const u = new SpeechSynthesisUtterance(text);
          u.rate = 1.03; u.pitch = 0.95;
          u.onend = done; u.onerror = done;
          speechSynthesis.speak(u);
          setTimeout(done, 15000);
        } else done();
      }
    });
  }

  return {
    on,
    setOpts: o => {
      Object.assign(opts, o);
      if ('mono' in o) applyMono();
      if ('normalize' in o) for (const d of decks) if (d.trackId) d.norm.gain.value = opts.normalize ? (loudness.get(d.trackId)?.factor ?? 1) : 1;
    },
    scheduleNext,
    playNow,
    loadPaused,
    pause: () => { if (gated) cancelBreak(); pauseDeck(); },
    resume: () => { previewStop(0.3); AC.resume(); const d = act(); if (d.el.ended && nextQueued) { beginTransition(0.1, true); return; } resumeDeck(d); },
    /* clean end-of-queue stop: unlike pause(), clears the deck so state doesn't
       desync (the UI stays paused mid-track instead of reporting stopped). */
    stop: () => { if (gated) cancelBreak(); const d = act(); try { d.el.pause(); d.el.removeAttribute('src'); } catch {} d.trackId = null; nextQueued = null; emit('stopped'); },
    /* Used only when handing off to Spotify: Spotify content may never
       overlap another audio stream, so the local deck must be fully silent
       and stopped before the Spotify play call goes out, not mid-crossfade. */
    fadeOutAndStop: (durSec = 0.7) => new Promise(resolve => {
      const d = act();
      if (!d.trackId || d.el.paused) { resolve(); return; }
      ramp(d.gain, 0, durSec, 'out');
      setTimeout(() => {
        try { d.el.pause(); d.el.removeAttribute('src'); } catch {}
        d.trackId = null; nextQueued = null;
        resolve();
      }, Math.max(80, durSec * 1000));
    }),
    isPaused: () => { if (gated) return false; const d = act(); return !d.trackId || d.el.paused || fadingOut; },
    hasTrack: () => !!act().trackId,
    seek: sec => { try { act().el.currentTime = Math.max(0, sec); } catch {} },
    pos: () => { const d = act(); return { t: d.el.currentTime || 0, dur: d.el.duration || 0 }; },
    setVolume: v => { master.gain.value = Math.max(0, Math.min(1, v)); },
    getVolume: () => master.gain.value,
    /* Fills `out` (512 bins) with the playing deck's frequency data for the
       visualizers; false when nothing local is audible. */
    spectrum: out => { const d = act(); if (!d.trackId || d.el.paused) return false; d.an.getByteFrequencyData(out); return true; },
    duck, speak,
    previewStart, previewStop,
    previewPrepare: id => { findHighlight(id); },
    clearLoudness: () => loudness.clear(),
    setGate: fn => { gate = fn || null; if (!gate && gated) cancelBreak(); },
    inBreak: () => gated,
    endBreak: () => { gated = false; },
    cancelBreak,
    voiceThen, stopVoice, decodeVoice,
    fadeActive: dur => { const d = act(); if (d.trackId) ramp(d.gain, 0, dur, 'out'); },
    setMusicLevel: (level, dur) => ramp(musicBus, level, dur, 'lin'),
    stopAll: () => { for (const d of decks) { try { d.el.pause(); d.el.removeAttribute('src'); } catch {} d.trackId = null; } nextQueued = null; }
  };
})();
