/* fx/detail.js — detail pages: album / playlist / mix header mesh gradient,
   artist record crate, kinetic titles, live row spectra, row light,
   stat sparklines + gauges, timeline lens, frosted sticky bar.

   Everything hooks in from outside the renderers: a MutationObserver on
   #content notices each render and upgrades the fresh DOM. Header effects
   share ONE WebGL2 context: its canvas is moved into whichever header is on
   screen, and the context is handed back (loseContext) as soon as a page
   without one renders. Per-frame work rides Fx3D.onFrame. */

const DetailFx = (() => {
  const content = document.getElementById('content');
  if (!content || typeof Fx3D === 'undefined') return {};
  const reduce = () => Fx3D.reduceMotion;
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

  // springs come from the Motion API (fx/motion.js): CSS tokens + Motion.animate
  const hasMotion = typeof Motion !== 'undefined';

  /* ---------- palette helpers ---------- */

  const cleanUrl = u => u ? u.replace(/([?&])w=\d+&?/, '$1').replace(/[?&]$/, '') : null;
  const BLUE = [[42, 92, 184], [70, 60, 170], [30, 130, 200]];

  function coverFor(page) {
    if (page.dataset.album) { const a = S.albumById.get(page.dataset.album); if (a && a.cover) return a.cover; }
    if (page.querySelector('.liked-cover')) return null;
    const img = page.querySelector('#detailHead .detail-art img');
    return img ? cleanUrl(img.getAttribute('src')) : null;
  }

  /* ---------- one shared GL context for header effects ---------- */

  const QUAD_VS = `#version 300 es
  const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;

  // Mesh gradient: four colour pools that drift on Lissajous paths, blended
  // by inverse distance over a domain-warped plane, lit around the cover,
  // grained, and faded out below the header so it bleeds into the page.
  const MESH_FS = `#version 300 es
  precision highp float;
  uniform vec2 uRes, uPtr;
  uniform float uT, uHead, uFade, uBass;
  uniform vec3 uC0, uC1, uC2, uC3;
  out vec4 o;
  float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float pool(vec2 q, vec2 k, float r) { vec2 d = q - k; return 1.0 / (pow(dot(d, d) / r, 1.35) + 0.035); }
  void main() {
    vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
    vec2 p = fc / uHead;                       // header height = 1 unit
    float W = uRes.x / uHead, B = uRes.y / uHead, t = uT * 0.07;
    vec2 w = vec2(noise(p * 0.9 + vec2(t, -t * 0.7)), noise(p * 0.9 + vec2(4.7 - t * 0.6, 2.3 + t * 0.5)));
    w += 0.5 * vec2(noise(p * 2.1 - t), noise(p * 2.1 + 9.1 + t));
    vec2 q = p + (w - 0.75) * 0.75;
    vec2 k0 = vec2(0.45 + 0.25 * sin(t * 1.3), 0.45 + 0.2 * cos(t * 1.1));
    vec2 k1 = vec2(W * 0.45 + 0.6 * sin(t * 0.9 + 2.0), 0.05 + 0.25 * sin(t * 1.4 + 1.0));
    vec2 k2 = vec2(W * 0.85 + 0.4 * cos(t * 1.2 + 4.0), 0.55 + 0.3 * sin(t * 0.8 + 3.0));
    vec2 k3 = vec2(W * 0.3 + 0.7 * cos(t * 0.7 + 1.0), 1.15 + 0.25 * cos(t));
    k1 += (uPtr - k1) * 0.18;
    float w0 = pool(q, k0, 0.55), w1 = pool(q, k1, 0.9), w2 = pool(q, k2, 0.8), w3 = pool(q, k3, 1.1);
    vec3 col = (uC0 * w0 + uC1 * w1 + uC2 * w2 + uC3 * w3) / (w0 + w1 + w2 + w3);
    // soft key light behind the cover, breathing a touch with the bass
    col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.3);
    col *= 0.72 + (0.5 + uBass * 0.2) * exp(-dot(p - vec2(0.5, 0.5), p - vec2(0.5, 0.5)) * 0.9);
    col *= 1.0 - 0.28 * smoothstep(0.2, 1.0, p.x / W);
    float a = pow(1.0 - smoothstep(0.25, B, p.y), 1.7);
    col += (hash(fc + fract(uT * 3.1) * 131.0) - 0.5) * 0.045;
    col = max(col, 0.0);
    col = col / (1.0 + col * 0.35);           // soft shoulder so text stays readable
    o = vec4(col * a * uFade, a * uFade);
  }`;

  let G = null;     // { canvas, gl, mesh, part, lost }
  let fx = null;    // the active effect instance

  function context() {
    if (G && !G.lost) return G;
    const canvas = document.createElement('canvas');
    canvas.className = 'dx-gl';
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: 'low-power' });
    if (!gl) return null;
    G = { canvas, gl, lost: false };
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); if (G && G.canvas === canvas) G.lost = true; });
    G.vao = gl.createVertexArray();
    return G;
  }
  function prog(name) {
    if (!G[name]) G[name] = Fx3D.program(G.gl, QUAD_VS, MESH_FS);
    return G[name];
  }
  function releaseGL() {
    if (fx) { fx.stop(); fx = null; }
    if (G) {
      try { G.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
      G.canvas.remove();
      G = null;
    }
  }

  // common plumbing: size the canvas to its box, watch visibility, ride the ticker
  function effect(host, opts) {
    const g = context();
    if (!g) return null;
    const canvas = g.canvas;
    canvas.dataset.mode = opts.mode;
    canvas.style.height = '';
    host.insertBefore(canvas, opts.before || host.firstChild);
    const st = { w: 0, h: 0, dpr: 1, onScreen: true, dirty: true, t0: performance.now(), unsub: null, ro: null, io: null };
    const size = () => {
      if (opts.layout) opts.layout(st);
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      st.dpr = opts.dpr();
      st.w = r.width; st.h = r.height;
      const W = Math.max(1, Math.round(r.width * st.dpr)), H = Math.max(1, Math.round(r.height * st.dpr));
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      st.dirty = true;
    };
    st.ro = new ResizeObserver(size);
    st.ro.observe(opts.observe || host);
    if (opts.observe) st.ro.observe(host);
    st.io = new IntersectionObserver(es => { st.onScreen = es[es.length - 1].isIntersecting; if (st.onScreen) st.dirty = true; });
    st.io.observe(canvas);
    st.unsub = Fx3D.onFrame((now, dt, level) => {
      if (!canvas.isConnected || g.lost || G !== g) return;
      if (!st.w || (reduce() && !st.dirty)) return;
      st.dirty = false;
      opts.draw(g, st, now, dt, level);
    }, { fps: opts.fps, visible: () => st.onScreen });
    st.stop = () => { st.unsub && st.unsub(); st.ro.disconnect(); st.io.disconnect(); opts.cleanup && opts.cleanup(st); };
    size();
    return st;
  }

  /* ---------- album / playlist / mix header: mesh gradient ---------- */

  const BLEED = 300;
  function meshHeader(page, head, enter, carry) {
    const st = effect(page, {
      mode: 'mesh', fps: 24,
      dpr: () => Math.min(devicePixelRatio || 1, 1) * 0.6,
      observe: head,
      layout: s => {
        s.head = head.offsetHeight;
        const want = (s.head + BLEED) + 'px';
        if (G.canvas.style.height !== want) G.canvas.style.height = want;
      },
      draw: (g, s, now, dt, level) => {
        if (!s.col) return;
        const gl = g.gl, P = prog('mesh'), U = P.u;
        const k = reduce() ? 1 : 0.035;
        for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) s.col[i][j] += (s.target[i][j] - s.col[i][j]) * k;
        s.px += ((s.ptr ? s.ptr[0] : 0.5) - s.px) * 0.05;
        s.py += ((s.ptr ? s.ptr[1] : 0.5) - s.py) * 0.05;
        s.bass += ((reduce() ? 0 : level.bass) - s.bass) * 0.2;
        const t = reduce() ? 30 : (now - s.t0) / 1000 + s.seed;
        gl.viewport(0, 0, g.canvas.width, g.canvas.height);
        gl.disable(gl.BLEND);
        gl.useProgram(P.p);
        gl.uniform2f(U.uRes, g.canvas.width, g.canvas.height);
        gl.uniform1f(U.uHead, Math.max(1, s.head * s.dpr));
        gl.uniform2f(U.uPtr, s.px, s.py);
        gl.uniform1f(U.uT, t);
        gl.uniform1f(U.uBass, s.bass);
        gl.uniform1f(U.uFade, s.enter && !reduce() ? clamp((now - s.t0) / 900, 0, 1) : 1);
        for (let i = 0; i < 4; i++) gl.uniform3f(U['uC' + i], s.col[i][0] / 255, s.col[i][1] / 255, s.col[i][2] / 255);
        gl.bindVertexArray(g.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        if (!reduce() && s.enter && now - s.t0 < 900) s.dirty = true;
      }
    });
    if (!st) return null;
    st.kind = 'mesh'; st.enter = enter; st.px = 0.5; st.py = 0.5; st.bass = 0;
    st.seed = carry ? carry.seed : Math.random() * 40;
    st.col = carry ? carry.col.map(c => c.slice()) : null;
    st.target = st.col ? st.col.map(c => c.slice()) : null;
    const url = coverFor(page);
    (url ? coverPalette(url) : Promise.resolve(BLUE)).then(pal => {
      if (fx !== st) return;
      const [a, b, c] = pal;
      st.target = [a, b, c, a.map(v => v * 0.28)];
      if (!st.col) { st.col = st.target.map(x => x.slice()); st.t0 = performance.now(); }
      st.dirty = true;
      applyGlassPalette(page, pal);
    });
    const move = e => {
      const r = head.getBoundingClientRect();
      st.ptr = [(e.clientX - r.left) / r.height, (e.clientY - r.top) / r.height];
    };
    head.addEventListener('pointermove', move, { passive: true });
    head.addEventListener('pointerleave', () => { st.ptr = null; });
    head.classList.add('dx-has-gl');
    page.classList.add('dx-mesh-page');
    return st;
  }

  /* ---------- artist hero: record crate ----------
     His five most-played releases stand to the right of the name as sleeves
     fanned in 3D, the favourite in front. Static transforms plus a one-shot
     entrance: nothing runs per frame. */
  function crate(head, enter) {
    const inner = head.querySelector('.ah-inner');
    if (!inner || inner.querySelector('.ah-crate')) return;
    const name = S.route && S.route.arg;
    const albums = name ? artistAlbums(name).filter(a => a.cover) : [];
    if (albums.length < 3) return;
    const plays = a => (a.trackIds || []).reduce((s, id) => s + (S.counts[id] || 0), 0);
    const top = [...albums].sort((a, b) => plays(b) - plays(a)).slice(0, 5);
    // favourite in the middle, the rest alternating outwards
    const order = [];
    top.forEach((a, i) => { if (i % 2) order.unshift(a); else order.push(a); });
    const mid = (order.length - 1) / 2;
    const el = document.createElement('div');
    el.className = 'ah-crate' + (enter ? ' dealing' : '');
    el.innerHTML = order.map((a, i) => {
      const k = i - mid;
      return `<button class="ah-sleeve${a === top[0] ? ' fav' : ''}" data-action="open-album" data-key="${a.id}" title="${esc(a.title)}" style="--k:${k};--ak:${Math.abs(k)};--i:${top.indexOf(a)}">
        ${a === top[0] ? '<span class="ah-vinyl"></span>' : ''}<img src="${artUrl(a.cover, ART_MD)}" alt="" decoding="async"><span class="ah-sleeve-name">${esc(a.title)}</span></button>`;
    }).join('');
    inner.appendChild(el);
    if (enter) setTimeout(() => el.classList.remove('dealing'), 1600);
  }

  /* ---------- kinetic title ---------- */

  // Letters rise out of their word's baseline on a bouncy spring, each a beat
  // after the last, while the Segoe UI Variable weight axis sweeps thin to
  // bold on a gentler one (the overshoot briefly goes past bold). The split
  // is undone when the last letter lands, so the h1 is plain text again.
  function kinetic(h1) {
    if (!hasMotion || Motion.reduced() || !h1 || h1.children.length || h1.classList.contains('dx-kin')) return;
    const text = h1.textContent;
    if (!text.trim() || text.length > 80) return;
    let i = 0;
    h1.setAttribute('aria-label', text);
    h1.innerHTML = text.split(/(\s+)/).map(word => /^\s*$/.test(word) ? word
      : `<span class="dx-w" aria-hidden="true">${[...word].map(ch => `<span class="dx-l">${esc(ch)}</span>`).join('')}</span>`).join('');
    h1.classList.add('dx-kin');
    const anims = [];
    h1.querySelectorAll('.dx-l').forEach((el, k) => {
      const delay = 220 + Math.min(k, 28) * 26;
      anims.push(Motion.animate(el, [
        { transform: 'translateY(1.05em) rotateX(-60deg)', opacity: 0 },
        { transform: 'none', opacity: 1 }
      ], { spring: 'bouncy', delay, fill: 'backwards' }));
      anims.push(Motion.animate(el, [
        { fontVariationSettings: "'wght' 250", letterSpacing: '.02em' },
        { fontVariationSettings: "'wght' 700", letterSpacing: '0em' }
      ], { spring: { response: 0.7, damping: 0.72 }, delay: delay + 40, fill: 'backwards' }));
    });
    const restore = () => {
      if (!h1.isConnected || !h1.classList.contains('dx-kin')) return;
      h1.textContent = text; h1.classList.remove('dx-kin'); h1.removeAttribute('aria-label');
    };
    Promise.all(anims.map(a => a.finished)).then(restore, restore);
  }

  /* ---------- frosted sticky bar ---------- */

  function applyGlassPalette(page, pal) {
    if (!page.isConnected) return;
    const [a, b, c] = pal.map(p => p.map(Math.round).join(','));
    page.style.setProperty('--dx-c0', a);
    page.style.setProperty('--dx-c1', b);
    page.style.setProperty('--dx-c2', c);
    const edge = pal[0].map(v => Math.round(v * 0.32)).join(',');
    page.style.setProperty('--dx-edge', edge);
  }

  /* ---------- stat cards: sparklines + gauges ---------- */

  let gradSeq = 0;
  // Catmull-Rom through the samples, written as cubic Béziers
  function smoothPath(pts) {
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }
  function sparkSVG(vals, title) {
    const W = 76, H = 30, max = Math.max(...vals, 1), n = vals.length;
    const pts = vals.map((v, i) => [2 + i / Math.max(1, n - 1) * (W - 4), H - 3 - v / max * (H - 8)]);
    const line = smoothPath(pts), id = 'dxg' + (++gradSeq), last = pts[n - 1];
    return `<svg class="dx-viz dx-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-label="${esc(title)}" role="img">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(var(--tint))" stop-opacity=".35"/><stop offset="1" stop-color="rgb(var(--tint))" stop-opacity="0"/></linearGradient></defs>
      <path class="dx-area" d="${line}L${last[0].toFixed(1)},${H}L${pts[0][0].toFixed(1)},${H}Z" fill="url(#${id})"/>
      <path class="dx-line" d="${line}" pathLength="1"/>
      <circle class="dx-dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4"/>
      <title>${esc(title)}</title></svg>`;
  }
  function barsSVG(vals, title) {
    const W = 76, H = 30, max = Math.max(...vals, 1), n = vals.length, bw = (W - 4) / n;
    return `<svg class="dx-viz dx-bars" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">${vals.map((v, i) => {
      const h = Math.max(1.5, v / max * (H - 4));
      return `<rect x="${(2 + i * bw + bw * 0.18).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="1" style="--k:${i}"/>`;
    }).join('')}<title>${esc(title)}</title></svg>`;
  }
  function gaugeSVG(frac, title) {
    const pct = clamp(frac, 0, 1) * 100;
    return `<svg class="dx-viz dx-gauge" viewBox="0 0 36 36" width="34" height="34" role="img" aria-label="${esc(title)}">
      <circle class="dx-track" cx="18" cy="18" r="14" pathLength="100"/>
      <circle class="dx-arc" cx="18" cy="18" r="14" pathLength="100" style="stroke-dashoffset:${(100 - pct).toFixed(2)}"/>
      <text x="18" y="21.2" text-anchor="middle">${Math.round(pct)}</text><title>${esc(title)}</title></svg>`;
  }

  function statViz(page) {
    const cards = page.querySelectorAll('.stat-card[data-viz]');
    if (!cards.length || S.route.name !== 'artist') return;
    const name = S.route.arg;
    const albums = artistAlbums(name);
    const own = S.tracks.filter(t => t.artistKey === name);
    const years = albums.map(releaseYear).filter(Boolean);
    if (!years.length) return;
    const y0 = Math.min(...years), y1 = Math.max(...years), span = y1 - y0 + 1;
    const perYear = () => new Array(span).fill(0);
    const rel = perYear(), songs = perYear(), plays = perYear(), secs = perYear();
    for (const a of albums) { const y = releaseYear(a); if (y) rel[y - y0]++; }
    for (const t of own) {
      const a = S.albumById.get(t.albumId), y = a && releaseYear(a);
      if (!y) continue;
      songs[y - y0]++; plays[y - y0] += S.counts[t.id] || 0; secs[y - y0] += t.duration || 0;
    }
    let run = 0;
    const hours = secs.map(s => (run += s) / 3600);
    const liked = own.filter(t => S.liked.has(t.id)).length;
    const range = `${y0}–${y1}`;
    for (const card of cards) {
      if (card.querySelector('.dx-viz')) continue;
      let svg = '';
      switch (card.dataset.viz) {
        case 'songs': svg = sparkSVG(songs, `Songs per year, ${range}`); break;
        case 'releases': svg = barsSVG(rel, `Releases per year, ${range}`); break;
        case 'hours': svg = sparkSVG(hours, `Hours of music, cumulative, ${range}`); break;
        case 'plays': svg = plays.some(Boolean) ? barsSVG(plays, `Your plays by release year, ${range}`) : ''; break;
        case 'liked': svg = gaugeSVG(own.length ? liked / own.length : 0, 'Share of songs liked (%)'); break;
        case 'unreleased': svg = gaugeSVG(albums.length ? albums.filter(a => a.unreleased).length / albums.length : 0, 'Share of releases unreleased (%)'); break;
      }
      if (svg) { card.insertAdjacentHTML('beforeend', svg); card.classList.add('dx-has-viz'); }
    }
  }

  /* ---------- timeline: fisheye lens ---------- */

  function timelineLens(wrap) {
    if (!wrap || wrap._dxLens) return;
    wrap._dxLens = true;
    const tl = wrap.querySelector('.timeline');
    const nodes = [...wrap.querySelectorAll('.tl-node')].map(el => ({ el, x: parseFloat(el.style.left) || 0, lens: -1, shift: 1e9 }));
    if (!tl || !nodes.length) return;
    wrap.classList.add('dx-lens');
    let target = null, fx = 0, str = 0, raf = 0, clientX = 0;
    const R = 240, D = 2.4, SIGMA = 105;
    const aim = () => {
      const r = wrap.getBoundingClientRect();
      target = clientX - r.left + wrap.scrollLeft - tl.offsetLeft;
    };
    const step = () => {
      raf = 0;
      const on = target != null ? 1 : 0;
      if (target != null) fx = str < 0.02 ? target : fx + (target - fx) * 0.22;
      str += (on - str) * 0.14;
      for (const n of nodes) {
        const dx = n.x - fx;
        // Sarkar–Brown graphical fisheye inside radius R: g(t) = (D+1)t / (D|t|+1)
        const u = clamp(dx / R, -1, 1), g = Math.sign(u) * (D + 1) * Math.abs(u) / (D * Math.abs(u) + 1);
        const shift = (g - u) * R * 0.5 * str;
        const lens = str * Math.exp(-(dx * dx) / (2 * SIGMA * SIGMA));
        if (Math.abs(shift - n.shift) > 0.05) { n.el.style.translate = `${shift.toFixed(2)}px 0`; n.shift = shift; }
        if (Math.abs(lens - n.lens) > 0.002) {
          n.el.style.setProperty('--lens', lens.toFixed(3));
          n.el.style.zIndex = lens > 0.12 ? String(2 + Math.round(lens * 2)) : '';
          n.lens = lens;
        }
      }
      tl.style.setProperty('--fx', fx.toFixed(1) + 'px');
      tl.style.setProperty('--fs', str.toFixed(3));
      if (Math.abs(on - str) > 0.003 || (target != null && Math.abs(target - fx) > 0.3)) raf = requestAnimationFrame(step);
      else if (!on) for (const n of nodes) { n.el.style.translate = ''; n.el.style.zIndex = ''; n.el.style.removeProperty('--lens'); n.lens = -1; n.shift = 1e9; }
    };
    const kick = () => { if (!raf && wrap.isConnected) raf = requestAnimationFrame(step); };
    wrap.addEventListener('pointermove', e => { if (reduce()) return; clientX = e.clientX; aim(); kick(); }, { passive: true });
    wrap.addEventListener('scroll', () => { if (target != null) { aim(); kick(); } }, { passive: true });
    wrap.addEventListener('pointerleave', () => { target = null; kick(); });
  }

  /* ---------- rows: live spectrum on the playing row ---------- */

  const eq = { els: [], seen: new Set(), unsub: null, dirty: true, v: [0, 0, 0, 0], io: null, queued: false };
  eq.io = new IntersectionObserver(es => {
    for (const e of es) e.isIntersecting ? eq.seen.add(e.target) : eq.seen.delete(e.target);
    syncEq();
  });
  function refreshEq() {
    eq.dirty = false;
    const els = [...content.querySelectorAll('.row.playing .eq')];
    for (const el of eq.els) if (!els.includes(el)) { eq.io.unobserve(el); eq.seen.delete(el); }
    for (const el of els) if (!eq.els.includes(el)) { eq.io.observe(el); el._bars = [...el.children]; }
    eq.els = els;
    syncEq();
  }
  function syncEq() {
    const want = eq.els.length && P.playing && !reduce();
    for (const el of eq.els) el.classList.toggle('dx-live', !!want);
    if (want && !eq.unsub) {
      eq.unsub = Fx3D.onFrame(eqFrame, { fps: 24, visible: () => eq.seen.size > 0 });
    } else if (!want && eq.unsub) {
      eq.unsub(); eq.unsub = null;
      for (const el of eq.els) for (const b of el._bars || []) b.style.transform = '';
    }
  }
  function eqFrame(now, dt, lv) {
    const s = now / 1000;
    // four bands out of four levels: the kick rides the low bar, the others
    // wobble a little out of phase so equal levels don't move in lockstep
    const target = [
      Math.pow(lv.bass, 1.6) * 0.8 + lv.kick * 2.2,
      Math.pow(lv.mid, 1.3) * 1.1 + 0.1 * Math.sin(s * 7.3),
      Math.pow(lv.treble, 1.2) * 0.9 + lv.kick * 0.8 + 0.1 * Math.sin(s * 9.1 + 1),
      Math.pow(lv.treble, 1.5) * 1.2 + 0.1 * Math.sin(s * 11.7 + 2)
    ];
    for (let i = 0; i < 4; i++) {
      const tv = clamp(target[i], 0.12, 1);
      eq.v[i] += (tv - eq.v[i]) * (tv > eq.v[i] ? 0.55 : 0.16);
    }
    for (const el of eq.seen) {
      const bars = el._bars || [];
      for (let i = 0; i < bars.length; i++) bars[i].style.transform = `scaleY(${eq.v[i % 4].toFixed(3)})`;
    }
  }
  const markEq = () => {
    eq.dirty = true;
    if (!eq.queued) { eq.queued = true; queueMicrotask(() => { eq.queued = false; if (eq.dirty) refreshEq(); }); }
  };
  for (const fn of ['markPlayingRows', 'setPlayingState']) {
    const orig = window[fn];
    if (typeof orig === 'function') window[fn] = function (...args) { const r = orig.apply(this, args); markEq(); return r; };
  }

  /* ---------- rows: pointer light ---------- */

  let lightRow = null, lightXY = null, lightRaf = 0;
  document.addEventListener('pointermove', e => {
    const row = e.target.closest && e.target.closest('#content .row');
    if (!row) { lightRow = null; return; }
    lightRow = row; lightXY = [e.clientX, e.clientY];
    if (!lightRaf) lightRaf = requestAnimationFrame(() => {
      lightRaf = 0;
      if (!lightRow || !lightRow.isConnected) return;
      const r = lightRow.getBoundingClientRect();
      lightRow.style.setProperty('--mx', (lightXY[0] - r.left).toFixed(0) + 'px');
      lightRow.style.setProperty('--my', (lightXY[1] - r.top).toFixed(0) + 'px');
    });
  }, { passive: true });

  /* ---------- render hook ---------- */

  function scan() {
    const page = content.firstElementChild;
    const head = page && page.classList.contains('detail') ? page.querySelector('#detailHead') : null;
    const enter = 'enter' in content.dataset && !reduce();
    if (fx) { fx.stop(); }
    const prev = fx;
    fx = null;
    if (head && !(G && G.lost)) {
      try {
        // the artist hero shares the album header's colour wash (palette from
        // the photo) and shows his most-played records instead of his face again
        if (head.classList.contains('artist-hero')) {
          fx = meshHeader(page, head, enter, null);
          // artists with their own piece (fx/artiststage.js) get that instead of the crate
          if (!(typeof ArtistStage !== 'undefined' && ArtistStage.mount(head, S.route && S.route.arg, enter))) crate(head, enter);
        }
        else {
          const carry = prev && prev.kind === 'mesh' && prev.col && prev.page === page.dataset.album + '|' + location.hash ? { col: prev.col, seed: prev.seed } : null;
          fx = meshHeader(page, head, enter || !carry, carry);
          if (fx) fx.page = page.dataset.album + '|' + location.hash;
        }
      } catch (err) { console.warn('DetailFx: header effect off', err); fx = null; }
    }
    if (!fx) releaseGL();
    if (page) {
      if (enter) kinetic(page.querySelector('#detailHead .detail-info h1:not(.ah-name)'));
      if (page.classList.contains('artist-page')) {
        statViz(page);
        const img = page.querySelector('.ah-photo .detail-art img');
        const url = img && cleanUrl(img.getAttribute('src'));
        (url ? coverPalette(url) : Promise.resolve(BLUE)).then(pal => applyGlassPalette(page, pal));
      }
      timelineLens(page.querySelector('#timelineWrap'));
      if (!head || !head.classList.contains('dx-has-gl')) {
        const url = page.classList.contains('detail') && coverFor(page);
        if (url && page.querySelector('#stickyBar')) coverPalette(url).then(pal => applyGlassPalette(page, pal));
      }
    }
    markEq();
  }
  new MutationObserver(muts => {
    let top = false;
    for (const m of muts) { if (m.target === content) top = true; }
    if (top) scan(); else markEq();
  }).observe(content, { childList: true, subtree: true });

  return {
    // dev aid: fire a shockwave as if a kick landed
    wave: (str = 1) => { if (fx && fx.waves) { fx.waves.unshift([performance.now(), str]); fx.waves.length = 2; } },
    get state() { return { gl: !!G, mode: fx && fx.kind, eqRows: eq.els.length, eqLive: !!eq.unsub }; }
  };
})();
