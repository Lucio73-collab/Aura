/* fx/motion.js: Aura's app-wide motion language (loaded after spotify.js, before main.js)

   ─── Motion API (for the other workstreams) ─────────────────────────────────────────────
   Springs are described like SwiftUI/Apple: { response, damping }
     response = period of the undamped oscillation in seconds (≈ how long it feels)
     damping  = damping ratio ζ (1 = no overshoot, <1 = bounce)
   Presets (Motion.presets): snappy, bouncy, gentle, drawer, pop.

   CSS (set on :root at load; fallbacks in css/motion.css):
     --spring-<preset>      linear(...) easing solved from the damped harmonic oscillator
     --spring-<preset>-dur  the settle time to pair with it, e.g.
       transition: transform var(--spring-bouncy-dur) var(--spring-bouncy);
     --ease-out-expo, --ease-in-exit, --ease-emph: cubic-bezier tokens for fades / exits
     --dur-fast 140ms, --dur-med 240ms, --dur-slow 420ms

   JS:
     Motion.easing(name | {response, damping, velocity?}) → 'linear(...)' string
     Motion.duration(name | cfg)                         → settle time in ms
     Motion.animate(el, keyframes, { spring: 'bouncy' | cfg, delay, fill }) → Animation
         WAAPI with the solved spring; honours reduce motion.
     Motion.flip(el, firstRect, { spring })             → FLIP from a previous rect
     Motion.spring(init, { response, damping, precision, onUpdate(v, vel), onRest, overSheet })
         Interruptible physics spring (number or {x, y, ...} object). Integrates on the
         shared Fx3D.onFrame ticker ONLY while moving, then unsubscribes.
         handle.set(target, { velocity? })  retarget, keeps current velocity
         handle.jump(value) · handle.stop() · handle.value · handle.velocity · handle.active
     Motion.reduced()                                     → true when reduce motion is on

   Navigation (wired here + a one-line hook at the top of main.js route()):
     real navigations run inside document.startViewTransition with a directional depth
     transition (html[data-vt="forward|back|up|down"]), and shared-element morphs
     (view-transition-name: aura-morph) between album/artist cards and detail art.
     While one runs, <html> has .vt-nav (and .vt-morph when a morph is paired).
   ──────────────────────────────────────────────────────────────────────────────────────── */

const Motion = (() => {
  const reduced = () => (typeof Fx3D !== 'undefined' && Fx3D.reduceMotion) || document.documentElement.classList.contains('reduce-motion');

  /* ---------- analytic spring (damped harmonic oscillator, 0 → 1) ---------- */

  // x(t) for a unit step: displacement d = x - 1 starts at -1 with velocity v0.
  function stepFn(response, damping, v0 = 0) {
    const w0 = 2 * Math.PI / response, z = damping;
    if (z < 1) {
      const wd = w0 * Math.sqrt(1 - z * z), c2 = (v0 - z * w0) / wd;
      return t => 1 + Math.exp(-z * w0 * t) * (-Math.cos(wd * t) + c2 * Math.sin(wd * t));
    }
    if (z === 1) { const c2 = v0 - w0; return t => 1 + Math.exp(-w0 * t) * (-1 + c2 * t); }
    const s = Math.sqrt(z * z - 1), r1 = -w0 * (z - s), r2 = -w0 * (z + s);
    const c1 = (v0 + r2) / (r1 - r2), c2 = -1 - c1;
    return t => 1 + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
  }

  // settle time: the last moment the curve is further than eps from rest
  function settle(fn, eps = 0.0015) {
    let last = 0;
    for (let ms = 1; ms <= 6000; ms++) if (Math.abs(1 - fn(ms / 1000)) > eps) last = ms;
    return Math.max(60, last + 16);
  }

  // Ramer–Douglas–Peucker keeps the linear() string short without visible error
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    let idx = 0, max = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i];
      const d = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / Math.hypot(by - ay, bx - ax);
      if (d > max) { max = d; idx = i; }
    }
    if (max <= eps) return [pts[0], pts[pts.length - 1]];
    return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  }

  const presets = {
    snappy: { response: 0.34, damping: 0.86 },
    bouncy: { response: 0.5, damping: 0.62 },
    gentle: { response: 0.62, damping: 1 },
    drawer: { response: 0.44, damping: 0.94 },
    pop: { response: 0.38, damping: 0.5 }
  };
  const cache = new Map();
  function solve(cfg) {
    if (typeof cfg === 'string') cfg = presets[cfg] || presets.snappy;
    const key = cfg.response + '|' + cfg.damping + '|' + (cfg.velocity || 0);
    let r = cache.get(key);
    if (r) return r;
    const fn = stepFn(cfg.response, cfg.damping, cfg.velocity || 0);
    const dur = settle(fn);
    const N = 120, pts = [];
    for (let i = 0; i <= N; i++) pts.push([i / N, fn((i / N) * dur / 1000)]);
    pts[N][1] = 1;
    const keep = rdp(pts, 0.0012);
    const easing = 'linear(' + keep.map(([t, x], i) =>
      i === 0 ? '0' : i === keep.length - 1 ? '1' : `${+x.toFixed(4)} ${+(t * 100).toFixed(2)}%`).join(', ') + ')';
    r = { easing, duration: dur };
    cache.set(key, r);
    return r;
  }

  const hasLinear = CSS.supports('animation-timing-function', 'linear(0, 1)');
  const easing = cfg => hasLinear ? solve(cfg).easing : 'cubic-bezier(.3, 1.2, .4, 1)';
  const duration = cfg => solve(cfg).duration;

  // publish the tokens as CSS custom properties before the first paint
  (() => {
    const st = document.documentElement.style;
    for (const name of Object.keys(presets)) {
      st.setProperty('--spring-' + name, easing(name));
      st.setProperty('--spring-' + name + '-dur', duration(name) + 'ms');
    }
  })();

  /* ---------- WAAPI helpers ---------- */

  function animate(el, keyframes, o = {}) {
    const cfg = o.spring || 'snappy';
    return el.animate(keyframes, {
      duration: reduced() ? 1 : (o.duration || duration(cfg)),
      easing: easing(cfg), delay: reduced() ? 0 : (o.delay || 0),
      fill: o.fill || 'none', composite: o.composite || 'replace'
    });
  }

  function flip(el, first, o = {}) {
    if (!first || reduced()) return null;
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left, dy = first.top - last.top;
    const sx = first.width / (last.width || 1), sy = first.height / (last.height || 1);
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return null;
    return animate(el, [
      { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: '0 0', transform: 'none' }
    ], o);
  }

  /* ---------- interruptible JS spring on the shared ticker ---------- */

  function spring(init, o = {}) {
    const scalar = typeof init === 'number';
    const wrap = v => scalar ? { v } : { ...v };
    let x = wrap(init), goal = wrap(init);
    const keys = Object.keys(x);
    let vel = Object.fromEntries(keys.map(k => [k, 0]));
    let cfg = { response: 0.4, damping: 0.8, precision: 0.01, ...(typeof o.spring === 'string' ? presets[o.spring] : {}), ...o };
    let unsub = null;
    const out = obj => scalar ? obj.v : obj;
    const emit = () => cfg.onUpdate && cfg.onUpdate(out(x), out(vel));
    const stop = () => { if (unsub) { unsub(); unsub = null; } };
    function frame(now, dt) {
      if (!dt) return;
      const w0 = 2 * Math.PI / cfg.response, k = w0 * w0, c = 2 * cfg.damping * w0;
      const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
      let rest = true;
      for (const key of keys) {
        let p = x[key], v = vel[key];
        const g = goal[key];
        for (let i = 0; i < n; i++) { v += (-k * (p - g) - c * v) * h; p += v * h; }
        if (Math.abs(p - g) > cfg.precision || Math.abs(v) > cfg.precision * 10) rest = false;
        x[key] = p; vel[key] = v;
      }
      if (rest) { for (const key of keys) { x[key] = goal[key]; vel[key] = 0; } }
      emit();
      if (rest) { stop(); cfg.onRest && cfg.onRest(out(x)); }
    }
    const handle = {
      set(target, opt = {}) {
        goal = wrap(target);
        if (opt.velocity != null) vel = wrap(opt.velocity);
        if (reduced()) { handle.jump(target); return handle; }
        if (!unsub) unsub = Fx3D.onFrame(frame, { overSheet: !!cfg.overSheet });
        return handle;
      },
      jump(value) {
        stop(); x = wrap(value); goal = wrap(value);
        vel = Object.fromEntries(keys.map(k => [k, 0]));
        emit(); cfg.onRest && cfg.onRest(out(x));
        return handle;
      },
      configure(next) { cfg = { ...cfg, ...next }; return handle; },
      stop,
      get value() { return out(x); },
      get velocity() { return out(vel); },
      get target() { return out(goal); },
      get active() { return !!unsub; }
    };
    return handle;
  }

  /* ---------- route transitions (View Transitions API) ---------- */

  const html = document.documentElement;
  const supportsVT = typeof document.startViewTransition === 'function';
  let lastClick = null, active = null, tok = 0, inside = false;

  const inView = el => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect(), c = document.getElementById('content').getBoundingClientRect();
    return r.width > 0 && r.bottom > c.top + 8 && r.top < c.bottom - 8 && r.right > c.left && r.left < c.right;
  };
  const sideItems = () => [...document.querySelectorAll('#sidebar .nav-item')];

  // remember what was clicked: a card to morph from, or a sidebar item for a lateral move
  document.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest) return;
    const act = t.closest('[data-action]');
    let art = null;
    if (act && act.matches('.card, .latest-card') && /^open-(album|artist|spalbum|spartist)$/.test(act.dataset.action)) {
      art = act.querySelector('.card-art, .lc-art');
    }
    const item = t.closest('#sidebar .nav-item');
    const items = item ? sideItems() : null;
    lastClick = {
      t: performance.now(), art, kind: art && act.dataset.action.replace('open-', ''),
      navFrom: items ? items.findIndex(a => a.classList.contains('active')) : -1,
      navTo: items ? items.indexOf(item) : -1
    };
  }, true);

  // warm the big cover before the click lands so the morph target has pixels
  document.addEventListener('pointerdown', e => {
    const card = e.target.closest && e.target.closest('.card[data-action="open-album"], .latest-card[data-action="open-album"], .card[data-action="open-artist"]');
    if (!card || typeof S === 'undefined') return;
    try {
      let url = null;
      if (card.dataset.key) { const a = S.albumById.get(card.dataset.key); url = a && a.cover; }
      else if (card.dataset.artist) { const ar = S.artistByName.get(card.dataset.artist); url = ar && artistImage(ar); }
      if (url) new Image().src = artUrl(url, ART_LG);
    } catch { /* best effort */ }
  }, { capture: true, passive: true });

  function imgReady(el, ms) {
    const img = el && el.querySelector('img');
    if (!img || (img.complete && img.naturalWidth)) return Promise.resolve();
    return Promise.race([img.decode().catch(() => {}), new Promise(r => setTimeout(r, ms))]);
  }

  function morphTarget(from, to, src) {
    const c = document.getElementById('content');
    if (src.card) {
      if (to.name === 'artist' || to.name === 'spartist') return c.querySelector('.ah-photo .detail-art') || c.querySelector('.detail-head .detail-art');
      if (to.name === 'album' || to.name === 'spalbum') return c.querySelector('.detail-head .detail-art');
      return null;
    }
    // leaving a detail page: fly the art back into its card if the new page shows one
    const q = from.name === 'album'
      ? `.card[data-key="${CSS.escape(from.arg || '')}"] .card-art, .latest-card[data-key="${CSS.escape(from.arg || '')}"] .lc-art`
      : `.card.artist[data-artist="${CSS.escape(from.arg || '')}"] .card-art`;
    return [...c.querySelectorAll(q)].find(inView) || null;
  }

  // Called first thing in route(). Returns true when it took over (the real
  // render then happens inside the view transition's update callback).
  function interceptRoute(run) {
    if (inside || !supportsVT || reduced() || document.hidden || html.classList.contains('win-hidden')) return false;
    if (typeof nav === 'undefined' || nav.lastKey == null || typeof S === 'undefined' || S.needsSetup) return false;
    const st = history.state;
    const stamped = st && typeof st.auraIdx === 'number';
    const idx = stamped ? st.auraIdx : nav.idx + 1;
    if (idx + '|' + location.hash === nav.lastKey) return false; // same-page re-render
    const from = S.route || { name: 'home' }, to = parseHash();
    if (from.name === 'search' && to.name === 'search') return false; // typing refines in place
    if ($('#modal:not(.hidden)')) return false;

    const now = performance.now();
    const click = lastClick && now - lastClick.t < 900 ? lastClick : null;
    lastClick = null;
    let mode = stamped && idx < nav.idx ? 'back' : 'forward';
    if (click && click.navTo >= 0 && click.navFrom >= 0 && click.navTo !== click.navFrom) mode = click.navTo > click.navFrom ? 'up' : 'down';

    const c = document.getElementById('content');
    let src = null;
    if (click && click.art && inView(click.art)) src = { el: click.art, card: true };
    else if (from.name === 'album' || from.name === 'artist') {
      const d = c.querySelector(from.name === 'artist' ? '.ah-photo .detail-art' : '.detail-head .detail-art');
      if (inView(d)) src = { el: d, card: false };
    }

    const my = ++tok;
    if (active) { try { active.skipTransition(); } catch { /* already done */ } }
    html.dataset.vt = mode;
    html.classList.add('vt-nav');
    html.classList.toggle('vt-morph', !!src);
    if (src) { src.el.classList.add('vt-src'); src.el.style.viewTransitionName = 'aura-morph'; }
    let target = null;
    let vt;
    try {
      vt = document.startViewTransition(async () => {
        if (src) { src.el.style.viewTransitionName = ''; src.el.classList.remove('vt-src'); }
        if (my !== tok) return; // a newer navigation owns the page now
        inside = true;
        try { run(); } finally { inside = false; }
        if (src) {
          target = morphTarget(from, to, src);
          if (target && inView(target)) {
            target.style.viewTransitionName = 'aura-morph';
            const img = target.querySelector('img[loading="lazy"]');
            if (img) img.loading = 'eager';
            // pointerdown already warmed the big cover; never hold the frozen frame for long
            await imgReady(target, 90);
          } else { target = null; html.classList.remove('vt-morph'); }
        }
      });
    } catch (err) {
      if (src) { src.el.style.viewTransitionName = ''; src.el.classList.remove('vt-src'); }
      html.classList.remove('vt-nav', 'vt-morph'); delete html.dataset.vt;
      return false;
    }
    active = vt;
    const done = () => {
      if (target) target.style.viewTransitionName = '';
      if (my === tok) { html.classList.remove('vt-nav', 'vt-morph'); delete html.dataset.vt; active = null; }
    };
    vt.finished.then(done, done);
    // if the update callback threw, still render so the app can't wedge
    vt.updateCallbackDone.catch(err => console.error('route transition', err));
    vt.ready.catch(() => {}); vt.finished.catch(() => {});
    return true;
  }

  /* ---------- sidebar: travelling active pill ---------- */

  let pill = null, pillSpring = null, pillShown = false;
  function placePill(instant) {
    const side = document.getElementById('sidebar');
    if (!side) return;
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'nav-pill';
      side.insertBefore(pill, document.getElementById('mainNav'));
      side.classList.add('has-pill');
      pillSpring = spring({ y: 0, h: 34 }, {
        spring: 'snappy', precision: 0.2,
        onUpdate: (v, vel) => {
          // stretch along the travel axis in proportion to speed, volume-ish preserved
          const s = Math.min(0.28, Math.abs(vel.y) / 3200);
          pill.style.transform = `translate3d(0, ${v.y.toFixed(2)}px, 0) scale(${(1 - s * 0.35).toFixed(4)}, ${(1 + s).toFixed(4)})`;
          pill.style.height = v.h.toFixed(1) + 'px';
        }
      });
    }
    const item = side.querySelector('.nav-item.active');
    if (!item || !item.offsetParent) { pill.classList.remove('on'); pillShown = false; return; }
    const sr = side.getBoundingClientRect(), r = item.getBoundingClientRect();
    const y = r.top - sr.top + side.scrollTop, h = r.height;
    pill.style.left = (r.left - sr.left) + 'px';
    pill.style.width = r.width + 'px';
    if (instant || !pillShown || reduced()) pillSpring.jump({ y, h });
    else pillSpring.set({ y, h });
    pill.classList.add('on');
    pillShown = true;
  }
  if (typeof markNav === 'function') {
    const _markNav = markNav;
    markNav = function () { _markNav.apply(this, arguments); placePill(false); };
  }
  // sidebar layout shifts (fonts, playlists loading, other chrome restyles) re-seat it without travel
  if (typeof ResizeObserver === 'function') {
    let roT = 0;
    const ro = new ResizeObserver(() => { if (!pill) return; cancelAnimationFrame(roT); roT = requestAnimationFrame(() => { if (!pillSpring.active) placePill(true); }); });
    addEventListener('DOMContentLoaded', () => { for (const id of ['sidebar', 'mainNav', 'playlistNav']) { const el = document.getElementById(id); if (el) ro.observe(el); } });
    if (document.readyState !== 'loading') for (const id of ['sidebar', 'mainNav', 'playlistNav']) { const el = document.getElementById(id); if (el) ro.observe(el); }
  }
  if (document.fonts) document.fonts.ready.then(() => { if (pill) placePill(true); });

  /* ---------- context menu / toast exits ---------- */

  if (typeof hideMenu === 'function' && typeof showMenu === 'function') {
    const _hide = hideMenu, _show = showMenu;
    hideMenu = function () {
      const m = document.getElementById('ctxMenu');
      if (!m || m.classList.contains('hidden') || reduced()) { if (m) { clearTimeout(m._closeT); m.classList.remove('closing'); } return _hide(); }
      menuActs = [];
      if (m.classList.contains('closing')) return;
      m.classList.remove('open');
      m.classList.add('closing');
      m._closeT = setTimeout(() => { m.classList.remove('closing'); _hide(); }, 160);
    };
    showMenu = function () {
      const m = document.getElementById('ctxMenu');
      if (m) { clearTimeout(m._closeT); m.classList.remove('closing'); }
      return _show.apply(this, arguments);
    };
  }

  if (typeof toast === 'function') {
    const _toast = toast;
    toast = function () {
      const t = document.getElementById('toast');
      const was = t && t.classList.contains('show');
      const r = _toast.apply(this, arguments);
      if (was && !reduced()) animate(t, [{ scale: '0.94' }, { scale: '1' }], { spring: 'pop' });
      return r;
    };
  }

  /* ---------- magnetic primary round buttons ---------- */

  const MAG = '.big-play, .play-btn, .np-play';
  const mags = new Map(); // el -> { spring, cx, cy, r }
  let px = 0, py = 0;
  function engage(el) {
    let m = mags.get(el);
    const r = el.getBoundingClientRect();
    const off = m ? m.spring.value : { x: 0, y: 0 };
    const geo = { cx: r.left + r.width / 2 - off.x, cy: r.top + r.height / 2 - off.y, r: Math.max(r.width, r.height) / 2 };
    if (!m) {
      m = { spring: spring({ x: 0, y: 0 }, {
        response: 0.36, damping: 0.52, precision: 0.02, overSheet: !!el.closest('#nowPlaying'),
        onUpdate: v => { el.style.setProperty('--mag-x', v.x.toFixed(2) + 'px'); el.style.setProperty('--mag-y', v.y.toFixed(2) + 'px'); },
        onRest: v => { if (!v.x && !v.y && !m.held) { el.classList.remove('mag'); el.style.removeProperty('--mag-x'); el.style.removeProperty('--mag-y'); mags.delete(el); } }
      }) };
      mags.set(el, m);
      el.classList.add('mag');
    }
    Object.assign(m, geo, { held: true });
    return m;
  }
  function pull() {
    for (const [el, m] of mags) {
      if (!m.held) continue;
      if (!el.isConnected) { m.spring.stop(); mags.delete(el); continue; }
      const dx = px - m.cx, dy = py - m.cy, d = Math.hypot(dx, dy), zone = m.r + 26;
      if (d > zone) { m.held = false; m.spring.set({ x: 0, y: 0 }); continue; }
      const k = 0.3 * (1 - Math.max(0, d - m.r) / 26 * 0.6), lim = m.r * 0.32;
      const mx = Math.max(-lim, Math.min(lim, dx * k)), my = Math.max(-lim, Math.min(lim, dy * k));
      m.spring.set({ x: mx, y: my });
    }
  }
  document.addEventListener('pointermove', e => {
    px = e.clientX; py = e.clientY;
    if (reduced()) return;
    const hit = e.target.closest && e.target.closest(MAG);
    if (hit && !hit.disabled && !(mags.get(hit) || {}).held) engage(hit);
    if (mags.size) pull();
  }, { passive: true });
  const releaseAll = () => { for (const m of mags.values()) { m.held = false; m.spring.set({ x: 0, y: 0 }); } };
  document.addEventListener('scroll', releaseAll, { capture: true, passive: true });
  document.addEventListener('pointerleave', releaseAll);

  return {
    presets, easing, duration, animate, flip, spring, reduced, interceptRoute,
    _debug: { get active() { return active; }, get mags() { return mags.size; }, get pill() { return pillSpring && pillSpring.active; } }
  };
})();
