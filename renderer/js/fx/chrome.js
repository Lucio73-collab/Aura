/* fx/chrome.js — the persistent chrome: floating glass player bar, waveform
   seek bar, morphing transport icons, beat ring on the cover, liquid volume
   with a level meter, sidebar light, film grain + cover light pool, and a
   springy queue panel.

   Everything hooks from here (wrapping a few global functions from player.js)
   instead of editing shared files. One Fx3D.onFrame hook drives all per-frame
   work and only exists while something actually moves: while playing, or for
   the few hundred ms a one-shot animation (icon morph, volume slosh, waveform
   grow-in, colour fade) needs. Paused and idle, it unsubscribes entirely. */

const ChromeFx = (() => {
  if (typeof document === 'undefined' || typeof Fx3D === 'undefined') return null;
  const RM = () => Fx3D.reduceMotion;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;

  /* Springs come from the shared Motion API (fx/motion.js): Motion.spring for
     interruptible physics, Motion.animate / Motion.flip for WAAPI one-shots. */

  /* ---------- the one frame loop ---------- */
  const jobs = new Set();   // fn(now, dt, level) -> truthy while it still wants frames
  let unsub = null;
  function frame(now, dt, level) {
    for (const j of jobs) { if (!j(now, dt, level)) jobs.delete(j); }
    if (!jobs.size && !P.playing) stopLoop();
  }
  function stopLoop() { if (unsub) { unsub(); unsub = null; } }
  function want(job) {
    if (job) jobs.add(job);
    if (!unsub) unsub = Fx3D.onFrame(frame, { fps: 60, visible: () => document.visibilityState !== 'hidden' });
  }
  // continuous jobs that run while playing
  const live = new Set();
  const liveJob = (now, dt, level) => { if (!P.playing) return false; for (const f of live) f(now, dt, level); return true; };
  function syncLive() { if (P.playing && live.size) want(liveJob); }

  /* ---------- tint ---------- */
  const tint = [106, 165, 255], tintTarget = [106, 165, 255];
  let tintMoving = false;
  const css = (r, g, b, a) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
  const tintCss = (a, lift = 0) => css(lerp(tint[0], 255, lift), lerp(tint[1], 255, lift), lerp(tint[2], 255, lift), a);
  function setTint(rgb) {
    for (let i = 0; i < 3; i++) tintTarget[i] = rgb[i];
    const rs = document.documentElement.style;
    rs.setProperty('--chrome-tint', rgb.join(','));
    rs.setProperty('--pool-c', `rgb(${rgb.join(' ')})`);
    shiftPool();
    if (RM()) { for (let i = 0; i < 3; i++) tint[i] = rgb[i]; redrawAll(); return; }
    if (!tintMoving) {
      tintMoving = true;
      want((now, dt) => {
        let done = true;
        const k = 1 - Math.exp(-dt * 4);
        for (let i = 0; i < 3; i++) { tint[i] += (tintTarget[i] - tint[i]) * k; if (Math.abs(tintTarget[i] - tint[i]) > 0.6) done = false; }
        if (done) for (let i = 0; i < 3; i++) tint[i] = tintTarget[i];
        Wave.rebuildLayers(); Wave.draw(); Vol.draw();
        tintMoving = !done;
        return !done;
      });
    }
  }

  /* ================= waveform seek bar ================= */
  const Wave = (() => {
    const LRU = new Map(), LRU_MAX = 40, BUCKETS = 600;
    let wrap, canvas, g, tip, input, W = 0, H = 0, dpr = 1;
    let peaks = null, peaksFor = null, trackId = null, isSpotify = false;
    let dimL = null, litL = null, glowL = null; // pre-rendered layers
    let grow = 1, morph = 1; // 0..1 grow-in of bars / bar->waveform morph
    let hoverX = null, rectLeft = 0, lastDrawnX = -1, abort = null;

    function mount() {
      input = $('#seek');
      if (!input || input.closest('.wave')) return;
      wrap = document.createElement('div');
      wrap.className = 'wave';
      canvas = document.createElement('canvas');
      canvas.className = 'wave-cv';
      tip = document.createElement('div');
      tip.className = 'wave-tip';
      input.parentNode.insertBefore(wrap, input);
      wrap.append(canvas, input, tip);
      g = canvas.getContext('2d');
      new ResizeObserver(() => {
        const r = wrap.getBoundingClientRect();
        dpr = Math.min(2, devicePixelRatio || 1);
        W = r.width; H = r.height;
        canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
        rebuildLayers(); draw(true);
      }).observe(wrap);
      input.addEventListener('pointerenter', e => { rectLeft = wrap.getBoundingClientRect().left; hover(e); });
      input.addEventListener('pointermove', hover);
      input.addEventListener('pointerleave', () => { hoverX = null; wrap.classList.remove('hovering'); draw(true); });
      input.addEventListener('input', () => draw(true));
    }
    function hover(e) {
      hoverX = clamp(e.clientX - rectLeft, 0, W);
      const dur = (cur() && cur().duration) || Playback.pos().dur || 0;
      tip.textContent = fmtTime(dur * hoverX / (W || 1));
      const flip = hoverX > W - 60;
      tip.style.transform = `translate(${Math.round(hoverX + (flip ? -10 : 10))}px, -50%)`;
      tip.classList.toggle('flip', flip);
      wrap.classList.add('hovering');
      draw(true);
    }

    /* ---- peaks: fetch the file, decode at 3 kHz (decodeAudioData resamples to
       the context rate, so a 4-minute song is ~720k samples instead of 21M),
       RMS into 600 buckets in idle slices, normalize to the 97th percentile. */
    async function loadPeaks(t) {
      if (abort) abort.abort();
      if (!t || t.source === 'spotify') return;
      if (LRU.has(t.id)) { const p = LRU.get(t.id); LRU.delete(t.id); LRU.set(t.id, p); setPeaks(t.id, p, true); return; }
      const ctl = abort = new AbortController();
      // let the track start (and any crossfade settle) before decoding
      await new Promise(r => setTimeout(r, 900));
      if (ctl.signal.aborted) return;
      try {
        const res = await fetch('/track/' + encodeURIComponent(t.id), { signal: ctl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();
        if (ctl.signal.aborted) return;
        const oc = new OfflineAudioContext(1, 1, 3000);
        const audio = await oc.decodeAudioData(buf);
        if (ctl.signal.aborted) return;
        const chans = [];
        for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) chans.push(audio.getChannelData(c));
        const len = chans[0].length, out = new Float32Array(BUCKETS), step = len / BUCKETS;
        let sliceStart = performance.now();
        for (let b = 0; b < BUCKETS; b++) {
          const s0 = Math.floor(b * step), s1 = Math.min(len, Math.floor((b + 1) * step));
          let sum = 0;
          for (const ch of chans) for (let i = s0; i < s1; i++) sum += ch[i] * ch[i];
          out[b] = Math.sqrt(sum / Math.max(1, (s1 - s0) * chans.length));
          if (performance.now() - sliceStart > 6) { // yield: never hold the main thread > ~6ms
            await new Promise(r => (window.requestIdleCallback || setTimeout)(r, { timeout: 60 }));
            if (ctl.signal.aborted) return;
            sliceStart = performance.now();
          }
        }
        const sorted = Array.from(out).sort((a, b) => a - b);
        // stretch between the 5th and 98th percentile: mastered hip-hop sits in a
        // narrow loudness band, and a plain peak-normalize draws a flat brick
        const lo = sorted[Math.floor(BUCKETS * 0.05)] * 0.6, hi = sorted[Math.floor(BUCKETS * 0.98)] || 1;
        for (let b = 0; b < BUCKETS; b++) out[b] = clamp(0.12 + 0.88 * Math.pow(clamp((out[b] - lo) / Math.max(1e-6, hi - lo), 0, 1), 1.35), 0.04, 1);
        LRU.set(t.id, out);
        while (LRU.size > LRU_MAX) LRU.delete(LRU.keys().next().value);
        setPeaks(t.id, out, false);
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.warn('chrome: waveform decode failed', t.id, err && err.message);
      }
    }
    function setPeaks(id, p, cached) {
      if (id !== trackId) return;
      peaks = p; peaksFor = id;
      rebuildLayers();
      if (RM() || cached) { grow = 1; morph = 1; draw(true); return; }
      grow = 0; morph = 0;
      want((now, dt) => {
        grow = Math.min(1, grow + dt / 0.9);
        morph = Math.min(1, morph + dt / 0.45);
        rebuildLayers(); draw(true);
        return grow < 1;
      });
    }
    function onTrack(t) {
      if (!wrap) return;
      trackId = t.id; isSpotify = t.source === 'spotify';
      wrap.classList.toggle('flat', isSpotify);
      if (peaksFor !== t.id) { peaks = null; peaksFor = null; morph = 0; }
      rebuildLayers(); draw(true);
      loadPeaks(t);
    }

    // column layout: 2px bars, 1px gaps
    const barW = 2, gap = 1.2;
    function columns() {
      const n = Math.max(8, Math.floor(W / (barW + gap)));
      const vals = new Float32Array(n);
      if (!peaks) return vals;
      for (let i = 0; i < n; i++) {
        const a = i / n * peaks.length, b = (i + 1) / n * peaks.length;
        let m = 0, c = 0;
        for (let k = Math.floor(a); k < Math.max(Math.floor(a) + 1, Math.floor(b)); k++) { m += peaks[Math.min(k, peaks.length - 1)]; c++; }
        // staggered grow-in, left to right, with a little ease-out-back
        const local = clamp(grow * 1.6 - (i / n) * 0.6, 0, 1);
        const e = 1 + 2.2 * Math.pow(local - 1, 3) + 1.2 * Math.pow(local - 1, 2);
        vals[i] = (m / c) * e;
      }
      return vals;
    }
    let cols = null;
    function layer() { const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; return c; }
    function paintBars(ctx, fill, alphaBottom) {
      const mid = H * 0.6, topH = H * 0.56, botH = H * 0.34;
      const n = cols.length, step = W / n;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = fill;
      // flat capsule shape the bars grow out of (and the whole look while decoding)
      const flatH = 3;
      for (let i = 0; i < n; i++) {
        const v = cols[i];
        const th = lerp(flatH / 2, Math.max(1, v * topH), morph);
        ctx.fillRect(i * step, mid - th - 0.5, barW, th);
      }
      ctx.globalAlpha = alphaBottom;
      for (let i = 0; i < n; i++) {
        const v = cols[i];
        const bh = lerp(flatH / 2, Math.max(1, v * botH), morph);
        ctx.fillRect(i * step, mid + 0.5, barW, bh);
      }
      ctx.globalAlpha = 1;
    }
    function rebuildLayers() {
      if (!canvas || !W) return;
      if (isSpotify) { dimL = litL = null; return; }
      cols = columns();
      if (!dimL || dimL.width !== canvas.width || dimL.height !== canvas.height) { dimL = layer(); litL = layer(); glowL = layer(); }
      paintBars(dimL.getContext('2d'), 'rgba(255,255,255,.24)', 0.5);
      const lg = litL.getContext('2d');
      const grad = lg.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, tintCss(1, 0.55)); grad.addColorStop(0.6, tintCss(1, 0.2)); grad.addColorStop(1, tintCss(1, 0));
      paintBars(lg, grad, 0.45);
      // soft bloom copy of the lit bars
      const gg = glowL.getContext('2d');
      gg.setTransform(1, 0, 0, 1, 0, 0);
      gg.clearRect(0, 0, glowL.width, glowL.height);
      gg.filter = `blur(${3 * dpr}px)`;
      gg.drawImage(litL, 0, 0);
      gg.filter = 'none';
    }

    function progress() {
      if (typeof seekDragging !== 'undefined' && seekDragging) return input.value / 1000;
      const { t, dur } = Playback.pos();
      return dur ? clamp(t / dur, 0, 1) : input.value / 1000;
    }

    let shimmer = 0;
    function draw(force, now = performance.now(), level = null) {
      if (!g || !W) return;
      const p = $('#playerBar').classList.contains('empty') ? 0 : progress();
      const x = p * W;
      if (!force && Math.abs(x - lastDrawnX) < 0.25 && !level) return;
      lastDrawnX = x;
      const cw = canvas.width, ch = canvas.height;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cw, ch);
      const mid = isSpotify ? H / 2 : H * 0.6;
      if (isSpotify || !dimL) {
        // styled capsule fallback (Spotify Connect, or no layers yet)
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const h = 4, y = mid - h / 2;
        g.fillStyle = 'rgba(255,255,255,.14)'; roundRect(g, 0, y, W, h, 2); g.fill();
        const grad = g.createLinearGradient(0, 0, Math.max(1, x), 0);
        grad.addColorStop(0, tintCss(0.5)); grad.addColorStop(1, tintCss(1, 0.35));
        g.fillStyle = grad; roundRect(g, 0, y, Math.max(h, x), h, 2); g.fill();
      } else {
        g.drawImage(dimL, 0, 0);
        // hover preview between the playhead and the pointer
        if (hoverX != null) {
          const a = Math.min(x, hoverX), b = Math.max(x, hoverX);
          g.save(); g.beginPath(); g.rect(a * dpr, 0, (b - a) * dpr, ch); g.clip();
          g.globalAlpha = hoverX > x ? 0.35 : 0.55; g.drawImage(hoverX > x ? litL : dimL, 0, 0); g.restore();
        }
        g.save(); g.beginPath(); g.rect(0, 0, x * dpr, ch); g.clip();
        g.globalAlpha = 0.55 + shimmer * 0.45; g.globalCompositeOperation = 'lighter';
        g.drawImage(glowL, 0, 0);
        g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
        g.drawImage(litL, 0, 0);
        g.restore();
        if (hoverX != null) {
          // scrubbing backwards: dim the part that would be un-played
          if (hoverX < x) {
            g.save(); g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(10,11,14,.55)';
            g.fillRect(hoverX * dpr, 0, (x - hoverX) * dpr, ch); g.restore();
          }
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.fillStyle = 'rgba(255,255,255,.55)';
          g.fillRect(Math.round(hoverX) - 0.5, 2, 1, H - 4);
        }
        // live shimmer: the few bars just behind the head breathe with the music
        if (level && cols && !RM()) {
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          const n = cols.length, step = W / n, head = Math.floor(x / step);
          g.globalCompositeOperation = 'lighter';
          for (let k = 0; k < 14; k++) {
            const i = head - k; if (i < 0) break;
            const fall = 1 - k / 14;
            const wob = 0.5 + 0.5 * Math.sin(now / 140 - k * 0.8);
            const amp = (level.mid * 0.7 + level.kick * 1.6) * fall * wob;
            if (amp < 0.02) continue;
            const th = Math.max(1, cols[i] * H * 0.56) * (1 + amp * 0.5);
            g.fillStyle = tintCss(Math.min(0.55, amp * 0.8), 0.7);
            g.fillRect(i * step, mid - th - 0.5, barW, th);
          }
          g.globalCompositeOperation = 'source-over';
        }
      }
      // playhead: a glow disc + a bright rounded needle
      if (!$('#playerBar').classList.contains('empty')) {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const r = 9 + shimmer * 10;
        const rg = g.createRadialGradient(x, mid, 0, x, mid, r);
        rg.addColorStop(0, tintCss(0.55 + shimmer * 0.3, 0.5)); rg.addColorStop(1, tintCss(0));
        g.fillStyle = rg; g.fillRect(x - r, mid - r, r * 2, r * 2);
        g.fillStyle = 'rgba(255,255,255,.95)';
        const nh = isSpotify ? 10 : H * 0.8;
        roundRect(g, x - 1, mid - nh * 0.62, 2, nh, 1); g.fill();
      }
    }
    function tickLive(now, dt, level) {
      // no beat shimmer: it forced a full canvas redraw every tick; now the
      // bar only repaints when the playhead has actually moved
      shimmer = 0;
      draw(false, now, null);
    }
    return { mount, onTrack, draw: () => draw(true), rebuildLayers, tickLive, get lruSize() { return LRU.size; } };
  })();

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
  }

  /* ================= morphing play / pause ================= */
  const Morph = (() => {
    // play = triangle split into two quads; pause = two bars. Vertex-for-vertex
    // interpolation between them, driven by a spring (overshoot included).
    const PLAY = [[[7.6, 4.8], [13.9, 8.45], [13.9, 15.55], [7.6, 19.2]], [[13.9, 8.45], [20, 12], [20, 12], [13.9, 15.55]]];
    const PAUSE = [[[6.6, 5], [10, 5], [10, 19], [6.6, 19]], [[14, 5], [17.4, 5], [17.4, 19], [14, 19]]];
    let svg, paths, btn, spr = null, k = 0;
    function mount() {
      btn = $('#btnPlay'); if (!btn) return;
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'ic morph'); svg.setAttribute('aria-hidden', 'true');
      paths = [0, 1].map(() => {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-width', '1.4'); p.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(p); return p;
      });
      spr = Motion.spring(0, { spring: 'bouncy', precision: 0.002, onUpdate: v => { k = v; render(); } });
      render();
      btn.replaceChildren(svg);
    }
    function render() {
      const kk = clamp(k, -0.06, 1.06);
      paths.forEach((p, q) => {
        let d = '';
        for (let i = 0; i < 4; i++) {
          const x = lerp(PLAY[q][i][0], PAUSE[q][i][0], kk), y = lerp(PLAY[q][i][1], PAUSE[q][i][1], kk);
          d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
        }
        p.setAttribute('d', d + 'Z');
      });
      // a quarter turn of swagger mid-morph
      svg.style.transform = `rotate(${clamp(k - (spr ? spr.target : 0), -1, 1) * -16}deg)`;
    }
    function set(on) {
      if (!btn) return;
      if (!btn.contains(svg)) btn.replaceChildren(svg); // setPlayingState rewrote it
      const target = on ? 1 : 0;
      if (spr.target === target) { if (!spr.active && k !== target) spr.jump(target); return; }
      if (Motion.reduced()) { spr.jump(target); return; }
      btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse');
      spr.set(target);
    }
    return { mount, set };
  })();

  /* ================= transport micro-animations ================= */
  function nudge(btn, dir) {
    const ic = btn && btn.querySelector('svg'); if (!ic || RM()) return;
    Motion.animate(ic, [{ transform: `translateX(${dir * 5}px) scaleX(.8)` }, { transform: 'none' }], { spring: 'pop' });
    const ghost = ic.cloneNode(true);
    ghost.classList.add('ghost');
    btn.appendChild(ghost);
    ghost.animate([{ transform: 'translateX(0)', opacity: 0.55 }, { transform: `translateX(${dir * 12}px)`, opacity: 0 }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' })
      .finished.then(() => ghost.remove(), () => ghost.remove());
  }
  function drawStroke(svg, dur = 650) {
    if (!svg || RM()) return;
    for (const el of svg.querySelectorAll('path, circle, rect, line, polyline')) {
      el.setAttribute('pathLength', '1');
      el.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], { duration: dur, easing: 'cubic-bezier(.65,0,.35,1)' });
    }
  }
  function watchModes() {
    const sh = $('#btnShuffle'), rp = $('#btnRepeat');
    let shOn = sh.classList.contains('on'), rpState = rp.classList.contains('one') ? 2 : rp.classList.contains('on') ? 1 : 0;
    new MutationObserver(() => {
      const on = sh.classList.contains('on'); if (on === shOn) return; shOn = on;
      const svg = sh.querySelector('svg'); if (!svg || RM()) return;
      if (on) drawStroke(svg, 600);
      svg.animate([{ transform: 'scale(1)' }, { transform: on ? 'scale(1.25) rotate(-8deg)' : 'scale(.8)' , offset: 0.3 }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
    }).observe(sh, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(() => {
      const st = rp.classList.contains('one') ? 2 : rp.classList.contains('on') ? 1 : 0; if (st === rpState) return; rpState = st;
      const svg = rp.querySelector('svg'); if (!svg || RM()) return;
      Motion.animate(svg, [{ transform: `rotate(${st ? -180 : 120}deg)` }, { transform: 'rotate(0)' }], { spring: 'bouncy' });
    }).observe(rp, { attributes: true, attributeFilter: ['class'] });
  }

  /* ================= cover beat ring ================= */
  const Ring = (() => {
    let el, glow = 0, lastO = '', lastS = '';
    function mount() {
      const left = $('#pbLeft'), art = $('#pbArt'); if (!left || !art) return;
      el = document.createElement('span'); el.className = 'pb-ring'; el.setAttribute('aria-hidden', 'true');
      left.insertBefore(el, art);
    }
    function tick(now, dt, level) {
      if (!el) return;
      const target = RM() ? 0.35 : clamp(0.18 + level.bass * 0.35 + level.kick * 2.2, 0, 1);
      glow += (target - glow) * Math.min(1, dt * (target > glow ? 22 : 5));
      const o = glow.toFixed(2), sc = (1 + glow * 0.09).toFixed(3);
      if (o === lastO && sc === lastS) return;
      lastO = o; lastS = sc;
      el.style.cssText = `opacity:${o};transform:scale(${sc})`; // one style write; rotation is a CSS animation
    }
    function rest() { if (el) { el.style.cssText = 'opacity:0'; lastO = lastS = ''; } }
    return { mount, tick, rest };
  })();

  /* ================= liquid volume + level meter ================= */
  const Vol = (() => {
    let input, canvas, g, W = 0, H = 0, dpr = 1;
    let fillX = 0.9, slosh = 0, meter = 0, peak = 0, peakHold = 0;
    // liquid: an underdamped spring; its velocity leans and ripples the meniscus
    const fill = Motion.spring(0.9, { response: 0.42, damping: 0.5, precision: 0.002,
      onUpdate: (v, vel) => { fillX = v; slosh = vel * 0.05; if (!P.playing) draw(); },
      onRest: () => { slosh = 0; draw(); } });
    function mount() {
      input = $('#vol'); if (!input || input.closest('.vol-fx')) return;
      const wrap = document.createElement('div'); wrap.className = 'vol-fx';
      canvas = document.createElement('canvas'); canvas.className = 'vol-cv';
      input.parentNode.insertBefore(wrap, input);
      wrap.append(canvas, input);
      g = canvas.getContext('2d');
      fill.jump(input.value / 100);
      new ResizeObserver(() => {
        const r = wrap.getBoundingClientRect();
        dpr = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height;
        canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
        draw();
      }).observe(wrap);
    }
    function target(v) { if (input && Math.abs(fill.target - v) > 1e-4) fill.set(v); }
    function draw(now = performance.now()) {
      if (!g || !W) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const th = 5, y = H / 2 - th / 2 - 2, fx = clamp(fillX, 0, 1) * W;
      g.fillStyle = 'rgba(255,255,255,.12)'; roundRect(g, 0, y, W, th, th / 2); g.fill();
      if (fx > 0.5) {
        // fluid body: the leading edge is a meniscus that leans with velocity and ripples
        const lean = clamp(slosh * 9, -4, 4), rip = Math.sin(now / 90) * Math.min(1.5, Math.abs(slosh) * 30);
        const grad = g.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, tintCss(0.75, 0.1)); grad.addColorStop(1, tintCss(1, 0.55));
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(th / 2, y);
        g.lineTo(Math.max(th / 2, fx - th / 2 + lean), y);
        g.bezierCurveTo(fx + th * 0.6 + lean + rip, y, fx + th * 0.6 - lean * 0.3 - rip, y + th, Math.max(th / 2, fx - th / 2 - lean * 0.5), y + th);
        g.lineTo(th / 2, y + th);
        g.arc(th / 2, y + th / 2, th / 2, Math.PI / 2, Math.PI * 1.5);
        g.fill();
        // specular line on the liquid
        g.fillStyle = 'rgba(255,255,255,.35)';
        g.fillRect(th / 2, y + 1, Math.max(0, fx - th), 1);
      }
      // segmented level meter under the track, scaled by the volume itself
      const segs = Math.max(8, Math.floor(W / 6)), sw = W / segs;
      const lit = meter * segs, pk = Math.floor(peak * segs);
      for (let i = 0; i < segs; i++) {
        const on = i < lit ? Math.min(1, lit - i) : 0;
        const hot = i / segs > 0.82;
        g.fillStyle = on > 0 ? (hot ? `rgba(255,255,255,${0.35 + on * 0.6})` : tintCss(0.25 + on * 0.7, 0.3)) : (i === pk && peak > 0.02 ? tintCss(0.8, 0.5) : 'rgba(255,255,255,.06)');
        g.fillRect(i * sw + 0.5, y + th + 4, sw - 1.5, 2);
      }
    }
    function tick(now, dt, level) {
      const vol = input ? input.value / 100 : 0;
      const energy = RM() ? 0 : clamp(level.bass * 0.55 + level.mid * 0.5 + level.kick * 1.4, 0, 1) * vol;
      meter += (energy - meter) * Math.min(1, dt * (energy > meter ? 30 : 7));
      if (meter >= peak) { peak = meter; peakHold = now; } else if (now - peakHold > 700) peak = Math.max(meter, peak - dt * 0.5);
      draw(now);
    }
    function rest() { meter = 0; peak = 0; draw(); }
    return { mount, target, draw: () => draw(), tick, rest };
  })();

  /* ================= queue panel ================= */
  const Queue = (() => {
    const bins = new Uint8Array(512);
    let bars = [];
    const BANDS = [[1, 4], [4, 12], [12, 36], [36, 100], [100, 220]];
    const lv = new Float32Array(5);
    function flipRender(orig) {
      return function (...args) {
        const list = $('#queueList');
        const panelOpen = list && $('#queuePanel').classList.contains('open') && !RM();
        const before = new Map();
        if (panelOpen) for (const r of list.querySelectorAll('.q-row')) { if (!before.has(r.dataset.id)) before.set(r.dataset.id, r.getBoundingClientRect()); }
        const res = orig.apply(this, args);
        decorateNow();
        if (panelOpen && before.size) {
          let enter = 0;
          for (const r of list.querySelectorAll('.q-row')) {
            const was = before.get(r.dataset.id);
            if (was == null) {
              if (enter < 12) Motion.animate(r, [{ opacity: 0, transform: 'translateX(18px) scale(.97)' }, { opacity: 1, transform: 'none' }],
                { spring: 'bouncy', delay: 30 * enter++, fill: 'backwards' });
              continue;
            }
            Motion.flip(r, was, { spring: 'bouncy' });
          }
        }
        return res;
      };
    }
    function decorateNow() {
      const art = $('#queueList .q-row.now .q-art');
      bars = [];
      if (!art) return;
      const spec = document.createElement('span'); spec.className = 'q-spec';
      for (let i = 0; i < 5; i++) { const b = document.createElement('i'); spec.appendChild(b); bars.push(b); }
      art.appendChild(spec);
      syncLive();
    }
    function tick(now, dt, level) {
      if (!bars.length || !bars[0].isConnected || !$('#queuePanel').classList.contains('open')) return;
      const have = typeof AudioEngine !== 'undefined' && Playback.activeSource && Playback.activeSource() === 'local' && AudioEngine.spectrum(bins);
      for (let i = 0; i < 5; i++) {
        let v;
        if (have) { const [a, b] = BANDS[i]; let s = 0; for (let k = a; k < b; k++) s += bins[k]; v = s / ((b - a) * 255); v = clamp((v - 0.15) * 1.5, 0.08, 1); }
        else v = clamp([level.bass, level.bass * 0.8 + level.mid * 0.3, level.mid, level.treble, level.treble * 0.8][i] + 0.12 * Math.sin(now / 160 + i * 1.7), 0.08, 1);
        if (RM()) v = 0.4;
        lv[i] += (v - lv[i]) * Math.min(1, dt * (v > lv[i] ? 25 : 8));
        bars[i].style.transform = `scaleY(${lv[i].toFixed(3)})`;
      }
    }
    return { flipRender, decorateNow, tick };
  })();

  /* ================= sidebar ================= */
  function mountSidebar() {
    const side = $('#sidebar'); if (!side) return;
    const light = document.createElement('div'); light.className = 'side-light'; light.setAttribute('aria-hidden', 'true');
    side.prepend(light);
    // nav icons re-draw their strokes on hover; pathLength=1 makes the dash math size-free
    const prep = root => root && root.querySelectorAll('.nav-item .ic :is(path, circle, rect)').forEach(el => el.setAttribute('pathLength', '1'));
    for (const id of ['#mainNav', '#playlistNav', '#spPlaylistNav']) {
      const n = $(id); if (!n) continue;
      prep(n);
      new MutationObserver(() => prep(n)).observe(n, { childList: true, subtree: true });
    }
    // light sweep across the search field on focus
    const sw = $('#searchWrap');
    if (sw) sw.addEventListener('focusin', () => { sw.classList.remove('sweep'); void sw.offsetWidth; sw.classList.add('sweep'); });
  }

  /* ================= global surface: light pool + grain ================= */
  let pool, grain;
  function mountSurface() {
    pool = document.createElement('div'); pool.className = 'chrome-pool'; pool.setAttribute('aria-hidden', 'true');
    pool.innerHTML = '<i></i><i></i>';
    document.body.prepend(pool);
    grain = document.createElement('div'); grain.className = 'chrome-grain'; grain.setAttribute('aria-hidden', 'true');
    // 128px tile of luminance noise, generated once
    const N = 128, c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d'), img = x.createImageData(N, N);
    for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255 | 0; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    x.putImageData(img, 0, 0);
    grain.style.backgroundImage = `url(${c.toDataURL('image/png')})`;
    document.body.appendChild(grain);
  }
  let grainLast = 0;
  function tickGrain(now) {
    if (!grain || RM() || now - grainLast < 83) return; // ~12 fps: film, not static
    grainLast = now;
    grain.style.transform = `translate(${-(Math.random() * 128 | 0)}px, ${-(Math.random() * 128 | 0)}px)`;
  }
  let poolFlip = 0;
  function shiftPool() {
    if (!pool) return;
    poolFlip++;
    const a = pool.children[0], b = pool.children[1];
    const rx = () => (Math.random() * 2 - 1);
    a.style.transform = `translate(${(rx() * 12).toFixed(1)}vw, ${(rx() * 8).toFixed(1)}vh) scale(${(1 + rx() * 0.12).toFixed(3)})`;
    b.style.transform = `translate(${(rx() * 14).toFixed(1)}vw, ${(rx() * 10).toFixed(1)}vh) scale(${(1 + rx() * 0.15).toFixed(3)})`;
  }

  /* ================= specular sweep on the island ================= */
  let sweepTimer = null;
  function sweep() {
    const pb = $('#playerBar'); if (!pb || RM()) return;
    pb.classList.remove('spec'); void pb.offsetWidth; pb.classList.add('spec');
  }
  function scheduleSweeps() {
    clearTimeout(sweepTimer);
    if (!P.playing || RM()) return;
    sweepTimer = setTimeout(() => { if (document.visibilityState !== 'hidden') sweep(); scheduleSweeps(); }, 11000 + Math.random() * 6000);
  }

  function redrawAll() { Wave.rebuildLayers(); Wave.draw(); Vol.draw(); }

  /* ================= wiring ================= */
  function init() {
    Wave.mount(); Morph.mount(); Ring.mount(); Vol.mount(); mountSidebar(); mountSurface();
    watchModes();
    $('#btnPrev').addEventListener('click', e => nudge(e.currentTarget, -1));
    $('#btnNext').addEventListener('click', e => nudge(e.currentTarget, 1));

    // each piece at the rate it needs (the shared hook runs at up to 60 fps)
    const every = (ms, fn) => { let acc = 0, last = 0; return (now, dt, level) => { acc += dt; if (now - last < ms - 2) return; last = now; fn(now, acc, level); acc = 0; }; };
    // Budgeted for "always on while music plays": the waveform only redraws
    // when the playhead crosses a pixel, the ring's glow reads fine at 15 fps,
    // and the live volume meter and moving grain were dropped - they kept the
    // whole window recompositing for very little.
    for (const f of [every(200, Wave.tickLive), every(66, Ring.tick), every(66, Queue.tick)]) live.add(f);

    const pb = $('#playerBar');
    const readTint = () => {
      const v = pb.style.getPropertyValue('--tint'); if (!v) return;
      const rgb = v.split(',').map(Number); if (rgb.length === 3 && rgb.every(n => n >= 0)) setTint(rgb);
    };
    new MutationObserver(readTint).observe(pb, { attributes: true, attributeFilter: ['style'] });
    readTint();
    new MutationObserver(() => Wave.draw()).observe(pb, { attributes: true, attributeFilter: ['class'] });

    Morph.set(typeof P !== 'undefined' && P.playing);
    // repaint anything static when reduce motion flips
    const origRM = Fx3D.setReduceMotion;
    if (origRM) Fx3D.setReduceMotion = on => { origRM(on); redrawAll(); Ring.rest(); scheduleSweeps(); };
  }

  // wrap globals from player.js (they're looked up by name at call time)
  if (typeof setPlayingState === 'function') {
    const orig = setPlayingState;
    setPlayingState = function (on) {
      orig(on);
      Morph.set(on);
      const pbar = document.getElementById('playerBar'); if (pbar) pbar.classList.toggle('is-playing', !!on);
      if (on) { syncLive(); scheduleSweeps(); } else { Ring.rest(); Vol.rest(); Wave.draw(); clearTimeout(sweepTimer); }
    };
  }
  if (typeof updateNowPlayingUI === 'function') {
    const orig = updateNowPlayingUI;
    updateNowPlayingUI = function (t) { orig(t); try { Wave.onTrack(t); sweep(); } catch (err) { console.error('chrome', err); } };
  }
  if (typeof setSliderFill === 'function') {
    const orig = setSliderFill;
    setSliderFill = function (el, pct) {
      orig(el, pct);
      if (!el) return;
      if (el.id === 'vol') Vol.target(clamp(pct / 100, 0, 1));
      else if (el.id === 'seek' && !P.playing) Wave.draw();
    };
  }
  if (typeof renderQueue === 'function') renderQueue = Queue.flipRender(renderQueue);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return {
    sweep,
    debug: () => ({ loop: !!unsub, jobs: jobs.size, lru: Wave.lruSize })
  };
})();
