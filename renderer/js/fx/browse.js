/* fx/browse.js — Browse workstream: Home hero, Albums (Grid / Flow), Artists, Recently Added, cards.
   Loaded after views.js and before main.js. Everything hooks in by wrapping the page renderers
   (renderHome / renderAlbums / renderArtists / renderRecent) so views.js keeps its markup.

   - Hero: a raymarched liquid-chrome metaball cluster behind the greeting. One WebGL2 context that
     survives re-renders (the canvas element is moved into each new hero), drawn at ~0.55x and
     upscaled, capped at 60 fps, paused off-screen / covered / window hidden (Fx3D.onFrame).
   - Kinetic greeting: per-letter spring rise with a variable-weight sweep, pointer weight wave.
   - Flow: a WebGL2 cover carousel on a curved arc with floor reflections, mip-based depth of field,
     inertial drag / wheel / keys and a critically damped spring snapping to the nearest album.
     Draws only while something moves; textures load lazily around the focus and are evicted.
   - Cards / tiles: cover-coloured shadows and palette gradients, computed lazily on hover. */

const FxBrowse = (() => {
  const reduced = () => Fx3D.reduceMotion || document.documentElement.classList.contains('reduce-motion');
  const content = () => document.getElementById('content');
  // "/art/x.jpg?w=400" -> "/art/x.jpg" so core.js picks its own sample size (and cache key)
  const baseSrc = img => (img && img.getAttribute('src') || '').replace(/[?&]w=\d+$/, '');
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const hexRGB = hex => {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(String(hex).trim());
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [106, 165, 255];
  };
  const accentRGB = () => hexRGB(getComputedStyle(document.documentElement).getPropertyValue('--accent'));
  const loseGL = gl => { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {} };

  const QUAD_VS = `#version 300 es
  in vec2 aQ;
  void main() { gl_Position = vec4(aQ, 0.0, 1.0); }`;

  /* ================================================================== hero: liquid chrome ==== */

  const HERO_FS = `#version 300 es
  precision highp float;
  uniform vec2 uRes, uPtr;
  uniform float uT, uEnergy, uFade, uPtrOn;
  uniform vec3 uTint, uTint2, uAccent;
  uniform vec3 uB[6];
  uniform float uR[6];
  uniform vec4 uBound;
  out vec4 outColor;

  float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
  float map(vec3 p) {
    float d = length(p - uB[0]) - uR[0];
    for (int i = 1; i < 6; i++) d = smin(d, length(p - uB[i]) - uR[i], 0.42);
    // slow surface swell so it reads as liquid, not as spheres
    return d + 0.022 * sin(p.x * 6.0 + uT * 1.1) * sin(p.y * 5.0 - uT * 0.9) * sin(p.z * 6.0 + uT * 0.7);
  }
  vec3 normalAt(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0025;
    return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) + k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
  }
  vec3 hueShift(vec3 c, float a) {
    const vec3 k = vec3(0.57735);
    float ca = cos(a);
    return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
  }
  // the fx3d.js studio, re-lit for chrome: dark room, overhead softbox, a cover-tinted strip
  // on the right, a second palette colour low on the left, and a small light that follows the pointer
  vec3 env(vec3 R) {
    // a horizon: pale tinted sky over a near-black floor, split sharply, is what reads as liquid metal
    vec3 sky = mix(mix(uTint, vec3(0.75), 0.55) * 0.34, vec3(0.05, 0.055, 0.07), smoothstep(0.05, 0.75, R.y));
    vec3 ground = mix(vec3(0.02, 0.021, 0.026), uTint2 * 0.05, smoothstep(-0.1, -0.9, R.y));
    vec3 col = mix(ground, sky, smoothstep(-0.07, 0.01, R.y));
    col += vec3(1.0) * smoothstep(0.62, 0.97, R.y) * smoothstep(0.9, 0.2, abs(R.x)) * 1.7;
    col += uTint * 2.6 * exp(-pow((R.x - 0.68) * 4.2, 2.0)) * smoothstep(-0.55, 0.45, R.y);
    col += max(uTint2, 0.0) * 1.8 * exp(-pow((R.x + 0.74) * 3.4, 2.0)) * smoothstep(0.35, -0.7, R.y);
    col += mix(uAccent, vec3(1.0), 0.35) * 1.6 * uPtrOn * exp(-pow(length(R.xy - uPtr) * 3.2, 2.0)) * smoothstep(-0.2, 0.4, R.z);
    col += vec3(0.28, 0.29, 0.32) * smoothstep(-0.72, -1.0, R.y);
    return col;
  }
  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * 2.0;
    vec3 ro = vec3(0.0, 0.0, 4.0);
    vec3 rd = normalize(vec3(uv, -4.0));
    vec3 oc = ro - uBound.xyz;
    float b = dot(oc, rd), c = dot(oc, oc) - uBound.w * uBound.w, h = b * b - c;
    // soft light the cluster throws on the backdrop (closest approach of the ray to its core)
    float dd = length(cross(rd, uBound.xyz - ro));
    vec3 glow = mix(uTint, uTint2, 0.35) * exp(-dd * dd * 0.9) * (0.06 + uEnergy * 0.1);
    vec3 col = vec3(0.0);
    float cov = 0.0;
    if (h > 0.0) {
      h = sqrt(h);
      float t = max(-b - h, 0.0), tEnd = -b + h;
      float dmin = 1e9, tmin = t;
      bool hit = false;
      for (int i = 0; i < 64; i++) {
        float d = map(ro + rd * t);
        if (d < dmin) { dmin = d; tmin = t; }
        if (d < 0.0015) { hit = true; break; }
        t += d * 0.92;
        if (t > tEnd) break;
      }
      float px = 2.0 / uRes.y * tmin / 4.0;
      cov = hit ? 1.0 : 1.0 - smoothstep(0.0, px * 1.6, dmin);
      if (cov > 0.0) {
        vec3 p = ro + rd * (hit ? t : tmin);
        vec3 N = normalAt(p), V = -rd, R = reflect(rd, N);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 3.0);
        float ao = clamp(map(p + N * 0.14) / 0.14, 0.0, 1.0);
        vec3 film = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + ndv * 1.3 + p.y * 0.25 + uT * 0.02));
        col = env(R) * mix(vec3(1.0), film * 1.45, 0.3) * mix(0.93, 0.5 + 0.5 * ao, 0.55 + 0.45 * fres);
        col += mix(uTint, hueShift(uTint, 0.6), fres) * fres * (0.25 + uEnergy * 0.9);
        vec3 H = normalize(normalize(vec3(0.5, 0.85, 0.55)) + V);
        col += vec3(pow(max(dot(N, H), 0.0), 160.0) * 2.4);
        // bright rim so the silhouette never reads as a dark outline
        col += mix(uTint, vec3(1.0), 0.45) * pow(1.0 - ndv, 5.0) * 0.9;
        col = 1.0 - exp(-col * 1.2);
      }
    }
    // premultiplied: the glow adds light without covering the page
    outColor = vec4((col * cov + glow * (1.0 - cov)) * uFade, cov * uFade);
  }`;

  const Hero = (() => {
    let canvas = null, gl = null, prog = null, vao = null;
    let unsub = null, releaseT = 0, onScreen = true, dirty = true;
    const rect = { l: 0, t: 0, w: 1, h: 1 };
    const st = {
      t0: performance.now(), fadeT0: 0,
      tint: [106, 165, 255], tintT: [106, 165, 255], tint2: [80, 90, 200], tint2T: [80, 90, 200],
      acc: [106, 165, 255], sx: 0, sv: 0, ptr: [0, 0], ptrOn: 0, lean: [0, 0]
    };
    const B = new Float32Array(18), R = new Float32Array(6);
    // fixed choreography per blob: base radius, orbit amplitudes and rates
    const BLOBS = [
      { r: 0.46, a: [0.2, 0.14, 0.2], w: [0.21, 0.17, 0.13], ph: 0.0 },
      { r: 0.34, a: [1.0, 0.42, 0.45], w: [0.23, 0.31, 0.19], ph: 1.7 },
      { r: 0.29, a: [0.8, 0.58, 0.4], w: [0.29, 0.22, 0.27], ph: 3.1 },
      { r: 0.25, a: [1.15, 0.36, 0.5], w: [0.17, 0.27, 0.23], ph: 4.4 },
      { r: 0.2, a: [0.7, 0.7, 0.35], w: [0.33, 0.19, 0.31], ph: 5.6 },
      { r: 0.16, a: [0.55, 0.5, 0.3], w: [0.37, 0.29, 0.25], ph: 2.4 }
    ];

    function measure() {
      if (!canvas || !canvas.isConnected) return;
      const r = canvas.getBoundingClientRect();
      rect.l = r.left; rect.t = r.top; rect.w = r.width || 1; rect.h = r.height || 1;
    }
    const onScroll = () => { measure(); if (reduced()) dirty = true; };

    function create() {
      canvas = document.createElement('canvas');
      canvas.className = 'hero-fx hero-chrome';
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      if (!gl) { canvas = null; return false; }
      try { prog = Fx3D.program(gl, QUAD_VS, HERO_FS); } catch (err) { console.warn('FxBrowse hero shader', err); loseGL(gl); canvas = gl = null; return false; }
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const q = gl.getAttribLocation(prog.p, 'aQ');
      gl.enableVertexAttribArray(q); gl.vertexAttribPointer(q, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      canvas.addEventListener('webglcontextlost', e => e.preventDefault());
      new ResizeObserver(() => {
        const r = canvas.getBoundingClientRect();
        if (!r.width) return;
        // soft by nature: ~0.55x of CSS pixels, upscaled by the compositor
        const k = 0.55 * Math.min(devicePixelRatio || 1, 1.5);
        canvas.width = Math.max(1, Math.round(r.width * k));
        canvas.height = Math.max(1, Math.round(r.height * k));
        measure(); dirty = true;
      }).observe(canvas);
      new IntersectionObserver(es => { onScreen = es[es.length - 1].isIntersecting; if (onScreen) measure(); }).observe(canvas);
      return true;
    }

    function release() {
      if (unsub) { unsub(); unsub = null; }
      content()?.removeEventListener('scroll', onScroll);
      if (gl) loseGL(gl);
      canvas = gl = prog = vao = null;
    }

    function visible() {
      if (!canvas) return false;
      if (!canvas.isConnected) {
        // navigated away: pause now, hand the context back if we don't come back soon
        if (!releaseT) releaseT = setTimeout(release, 12000);
        return false;
      }
      return onScreen;
    }

    function frame(now, dt, lv) {
      if (!gl || gl.isContextLost()) return;
      const rm = reduced();
      const ease = (c, t, k) => { for (let i = 0; i < 3; i++) c[i] += (t[i] - c[i]) * k; };
      const k = rm ? 1 : 1 - Math.pow(0.02, dt);
      ease(st.tint, st.tintT, k); ease(st.tint2, st.tint2T, k);
      const colorMoving = Math.abs(st.tint[0] - st.tintT[0]) + Math.abs(st.tint2[1] - st.tint2T[1]) > 0.5;
      const fade = rm ? 1 : clamp((now - st.fadeT0) / 1400, 0, 1);
      if (rm && !dirty && !colorMoving && fade >= 1) return; // static frame until something changes
      // idle (paused, pointer elsewhere): the slow morph reads fine at 12 fps,
      // and each frame is a full raymarch, so don't pay 30 of them a second
      const idle = !P.playing && st.ptrOn < 0.02 && !colorMoving && fade >= 1 && !dirty;
      if (idle && now - (st.lastDraw || 0) < 1000 / 12 - 1) return;
      st.lastDraw = now;
      dirty = false;

      const W = canvas.width, H = canvas.height, aspect = rect.w / rect.h;
      const t = rm ? 14 : (now - st.t0) / 1000;
      // bass on a spring so the swell overshoots a touch and settles
      const target = rm ? 0 : Math.min(1, lv.bass * 0.6 + lv.kick * 2.0);
      st.sv = (st.sv + (target - st.sx) * 0.2) * 0.72;
      st.sx += st.sv;
      const energy = rm ? 0 : Math.min(1, lv.bass * 0.5 + lv.kick * 1.8);

      // pointer in hero world units (the z=0 plane spans y -1..1)
      const cx = (Fx3D.pointer.x + 1) / 2 * innerWidth, cy = (Fx3D.pointer.y + 1) / 2 * innerHeight;
      const inside = cx >= rect.l && cx <= rect.l + rect.w && cy >= rect.t && cy <= rect.t + rect.h;
      const wx = (cx - rect.l - rect.w / 2) / rect.h * 2, wy = -(cy - rect.t - rect.h / 2) / rect.h * 2;
      const pk = rm ? 1 : 1 - Math.pow(0.03, dt);
      st.ptrOn += ((inside && !rm ? 1 : 0) - st.ptrOn) * pk;
      if (inside) { st.ptr[0] += (wx - st.ptr[0]) * pk; st.ptr[1] += (wy - st.ptr[1]) * pk; }

      // keep the cluster clear of the headline: hug the right edge more as the hero narrows
      const C = [aspect - clamp(1.15 + (aspect - 2.5) * 0.5, 1.15, 1.45), -0.08, 0];
      const lean = [(st.ptr[0] - C[0]) * 0.07 * st.ptrOn, (st.ptr[1] - C[1]) * 0.07 * st.ptrOn];
      let bound = 0;
      for (let i = 0; i < 6; i++) {
        const b = BLOBS[i];
        let x = C[0] + lean[0] + Math.sin(t * b.w[0] + b.ph) * b.a[0];
        let y = C[1] + lean[1] + Math.cos(t * b.w[1] + b.ph * 1.3) * b.a[1];
        let z = Math.sin(t * b.w[2] + b.ph * 0.7) * b.a[2];
        if (i === 5 && st.ptrOn > 0.01) {
          // the smallest drop is drawn toward the pointer, on a short leash
          let dx = st.ptr[0] - x, dy = st.ptr[1] - y;
          const len = Math.hypot(dx, dy), max = 1.25;
          if (len > max) { dx *= max / len; dy *= max / len; }
          x += dx * 0.75 * st.ptrOn; y += dy * 0.75 * st.ptrOn; z += 0.35 * st.ptrOn;
        }
        const r = b.r * (1 + (i < 3 ? st.sx * 0.16 : st.sx * 0.06));
        B[i * 3] = x; B[i * 3 + 1] = y; B[i * 3 + 2] = z; R[i] = r;
        bound = Math.max(bound, Math.hypot(x - C[0], y - C[1], z) + r);
      }

      const U = prog.u;
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.useProgram(prog.p);
      gl.uniform2f(U.uRes, W, H);
      gl.uniform2f(U.uPtr, clamp((st.ptr[0] - C[0]) * 0.35, -0.9, 0.9), clamp((st.ptr[1] - C[1]) * 0.45 + 0.1, -0.9, 0.9));
      gl.uniform1f(U.uPtrOn, st.ptrOn);
      gl.uniform1f(U.uT, t);
      gl.uniform1f(U.uEnergy, energy);
      gl.uniform1f(U.uFade, fade);
      gl.uniform3fv(U.uTint, st.tint.map(v => v / 255));
      gl.uniform3fv(U.uTint2, st.tint2.map(v => v / 255));
      gl.uniform3fv(U.uAccent, st.acc.map(v => v / 255));
      gl.uniform3fv(U['uB[0]'], B);
      gl.uniform1fv(U['uR[0]'], R);
      gl.uniform4f(U.uBound, C[0], C[1], 0, bound + 0.18);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    function mount(placeholder, seedCover) {
      if (!placeholder) return null;
      clearTimeout(releaseT); releaseT = 0;
      if (!canvas || !gl || gl.isContextLost()) { release(); if (!create()) return null; }
      const wasAttached = canvas.isConnected;
      placeholder.replaceWith(canvas);
      canvas.id = 'homeFx';
      const c = content();
      if (c) { c.removeEventListener('scroll', onScroll); c.addEventListener('scroll', onScroll, { passive: true }); }
      // fade in on a real navigation only; an in-place re-render keeps the running scene
      if (!wasAttached && c && 'enter' in c.dataset) { st.fadeT0 = performance.now(); }
      st.acc = accentRGB();
      measure(); dirty = true;
      if (!unsub) unsub = Fx3D.onFrame(frame, { fps: 30, visible });
      if (seedCover) {
        vibrantColor(seedCover).then(rgb => { st.tintT = rgb.slice(); dirty = true; });
        coverPalette(seedCover).then(p => { if (p && p[1]) { st.tint2T = p[1].map(v => Math.max(40, v)); dirty = true; } });
      }
      return { setColor: rgb => { if (rgb) st.tintT = rgb.slice(); dirty = true; } };
    }

    return { mount, get active() { return !!unsub; }, release };
  })();

  /* ============================================================= kinetic greeting ==== */

  function kinetic(h1) {
    if (!h1 || h1.classList.contains('kinetic')) return;
    const text = h1.textContent.trim();
    h1.classList.add('kinetic');
    h1.setAttribute('aria-label', text);
    let i = 0;
    h1.innerHTML = text.split(/\s+/).map(w =>
      `<span class="kw" aria-hidden="true">${[...w].map(ch => `<span class="kl" style="--i:${i++}">${esc(ch)}</span>`).join('')}</span>`
    ).join(' ');
    h1.style.setProperty('--n', i);

    // pointer weight wave: letters near the pointer thin out and lift, on springs
    const letters = [...h1.querySelectorAll('.kl')];
    if (typeof Motion === 'undefined') return;
    const zero = Object.fromEntries(letters.map((_, k) => [k, 0]));
    // one Motion spring over every letter's weight; it rides the shared ticker only while moving
    const spring = Motion.spring(zero, {
      response: 0.42, damping: 0.62, precision: 0.002,
      onUpdate: v => {
        if (!h1.isConnected) { spring.stop(); return; }
        for (let k = 0; k < letters.length; k++) {
          letters[k].style.fontWeight = Math.round(700 - clamp(v[k], -0.2, 1.2) * 390);
          letters[k].style.translate = `0 ${(-v[k] * 7).toFixed(2)}px`;
        }
      }
    });
    let geo = null;
    const hero = h1.closest('.home-hero');
    hero.addEventListener('pointermove', e => {
      if (reduced()) return;
      if (!geo) {
        const H = h1.getBoundingClientRect();
        geo = { mid: H.top + H.height / 2, h: H.height, xs: letters.map(l => { const r = l.getBoundingClientRect(); return r.left + r.width / 2; }) };
      }
      const near = clamp(1 - Math.abs(e.clientY - geo.mid) / (geo.h * 1.2), 0, 1);
      spring.set(Object.fromEntries(geo.xs.map((x, k) => [k, Math.exp(-Math.pow((e.clientX - x) / 70, 2)) * near])));
    }, { passive: true });
    hero.addEventListener('pointerleave', () => { geo = null; if (!reduced()) spring.set(zero); });
  }

  /* ============================================================= card + tile colours ==== */

  function colorCard(art) {
    if (!art || art.dataset.cc) return;
    const img = art.querySelector('img');
    const src = baseSrc(img);
    art.dataset.cc = '1';
    if (!src) return;
    // on the card, so the art (shadow, foil) and an artist's orbit ring both inherit it
    vibrantColor(src).then(rgb => (art.closest('.card') || art).style.setProperty('--cc', rgb.join(',')));
  }
  function colorTile(tile) {
    if (!tile || tile.dataset.pal) return;
    tile.dataset.pal = '1';
    const src = baseSrc(tile.querySelector('.tile-art img'));
    const set = p => p.forEach((c, i) => tile.style.setProperty('--p' + i, c.map(Math.round).join(',')));
    if (!src) {
      const a = accentRGB();
      set([a, a.map(v => v * 0.55), [236, 72, 153]]);
      return;
    }
    coverPalette(src).then(p => set(p.map(c => {
      // lift very dark swatches so the flow still reads on the dark tile
      const m = Math.max(...c) || 1;
      return m < 90 ? c.map(v => v * 90 / m + 12) : c;
    })));
  }
  document.addEventListener('pointerover', e => {
    const t = e.target;
    if (!t || !t.closest) return;
    const art = t.closest('#content .card .card-art');
    if (art) colorCard(art);
    const tile = t.closest('#content .tile');
    if (tile) colorTile(tile);
  }, { passive: true });

  // colours for what's on screen ahead of the first hover, so the first lift is already tinted
  function precolor(root) {
    const arts = [...root.querySelectorAll('.card .card-art')].slice(0, 48);
    const tiles = [...root.querySelectorAll('.tile')];
    const run = () => { arts.forEach(colorCard); tiles.forEach(colorTile); };
    (window.requestIdleCallback || setTimeout)(run, { timeout: 900 });
  }

  /* ================================================================== Flow carousel ==== */

  const FLOW_VS = `#version 300 es
  in vec2 aP;
  uniform mat4 uM, uVP;
  uniform float uMirror;
  out vec2 vUV; out vec3 vW; out vec3 vN;
  void main() {
    vec4 w = uM * vec4(aP, 0.0, 1.0);
    vec3 n = mat3(uM) * vec3(0.0, 0.0, 1.0);
    if (uMirror > 0.5) { w.y = -1.0 - w.y; n.y = -n.y; }
    vUV = aP + 0.5; vW = w.xyz; vN = n;
    gl_Position = uVP * w;
  }`;

  const FLOW_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vW; in vec3 vN;
  uniform sampler2D uTex;
  uniform float uMirror, uBlur, uShade, uAlpha, uTexOn, uSheen, uFocus;
  uniform vec3 uPh, uEye, uLight;
  out vec4 outColor;
  float rbox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  vec3 tap(vec2 uv, float bias) { return texture(uTex, uv, bias).rgb; }
  void main() {
    vec2 uv = vUV;
    float d = rbox(uv - 0.5, vec2(0.5), 0.02);
    float aa = fwidth(d) * 0.8;
    float mask = 1.0 - smoothstep(-aa, aa, d);
    if (mask < 0.003) discard;
    float blur = uBlur + uMirror * 1.6;
    vec3 c = uPh * (0.8 + 0.4 * uv.y);
    if (uTexOn > 0.0) {
      vec3 tc;
      if (blur < 0.15) tc = tap(uv, 0.0);
      else {
        // depth of field: a small rotated-grid kernel over a blurrier mip
        float r = 0.0045 * blur;
        tc = (tap(uv, blur) * 2.0 + tap(uv + vec2(r, r * 0.4), blur) + tap(uv + vec2(-r * 0.4, r), blur)
            + tap(uv + vec2(-r, -r * 0.4), blur) + tap(uv + vec2(r * 0.4, -r), blur)) / 6.0;
      }
      c = mix(c, tc, uTexOn);
    }
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, mix(0.55, 1.0, uShade));
    c *= uShade;
    if (uMirror < 0.5) {
      vec3 V = normalize(uEye - vW);
      vec3 N = normalize(vN); if (dot(N, V) < 0.0) N = -N;
      float spec = pow(max(dot(reflect(-V, N), uLight), 0.0), 48.0);
      float band = exp(-pow((uv.x * 0.75 + uv.y * 0.66 - uSheen) * 4.5, 2.0));
      c += vec3(spec * 0.22 + band * (0.05 + 0.05 * uFocus));
      // lacquered edge catching the light along the top
      c += vec3(0.16) * (1.0 - smoothstep(0.0, aa * 3.0, abs(d))) * smoothstep(0.35, 1.0, uv.y);
    }
    float a = mask * uAlpha;
    if (uMirror > 0.5) a *= 0.34 * pow(clamp(1.0 - uv.y * 1.55, 0.0, 1.0), 2.4);
    outColor = vec4(c * a, a);
  }`;

  // The record inside each sleeve: drawn on the same quad (in the cover's own space, just behind
  // it) as a procedural disc. Grooves, dead wax and a label printed with the cover turn by uSpin;
  // the light on the grooves stays put, so it reads as vinyl.
  const DISC_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vW; in vec3 vN;
  uniform sampler2D uTex;
  uniform float uTexOn, uSpin, uAlpha, uShade, uMirror;
  uniform vec3 uPh, uLight;
  out vec4 outColor;
  void main() {
    vec2 p = vUV * 2.0 - 1.0;
    float r = length(p), aa = fwidth(r) * 1.2;
    float mask = 1.0 - smoothstep(1.0 - aa, 1.0, r);
    if (mask < 0.003) discard;
    float cs = cos(uSpin), sn = sin(uSpin);
    vec2 q = mat2(cs, -sn, sn, cs) * p;
    // grooves: fine rings with a few wider gaps between tracks
    float ring = 0.5 + 0.5 * sin(r * 520.0);
    float gap = smoothstep(0.004, 0.0, abs(fract(r * 7.3 + 0.35) - 0.5) - 0.47);
    vec3 c = vec3(0.045 + 0.022 * ring) * (1.0 - 0.5 * gap);
    // anisotropic sheen: two bright wedges facing the light, fixed while the disc turns
    float ang = atan(p.y, p.x), la = atan(uLight.y, uLight.x);
    float wedge = pow(abs(cos(ang - la)), 18.0);
    float grooved = smoothstep(0.37, 0.39, r) * (1.0 - smoothstep(0.93, 0.95, r));
    c += vec3(0.30, 0.31, 0.34) * wedge * grooved * (0.55 + 0.45 * ring);
    // smooth lead-in rim and a glossy dead-wax ring round the label
    float rim = smoothstep(0.945, 0.955, r);
    c = mix(c, vec3(0.08) + 0.18 * wedge, rim);
    float wax = smoothstep(0.33, 0.335, r) * (1.0 - smoothstep(0.37, 0.375, r));
    c = mix(c, vec3(0.03) + 0.12 * wedge, wax);
    // the label: the cover, turned with the disc
    if (r < 0.335) {
      vec2 luv = q / 0.335 * 0.5 + 0.5;
      vec3 lab = mix(uPh * 2.4, texture(uTex, luv, 0.6).rgb, uTexOn);
      float lr = smoothstep(0.325, 0.335, r);
      c = mix(lab * 0.92, c, lr);
      c *= 1.0 - 0.25 * smoothstep(0.2, 0.33, r);
    }
    // spindle hole
    c = mix(vec3(0.01), c, smoothstep(0.03, 0.03 + aa, r));
    c *= uShade;
    float a = mask * uAlpha;
    if (uMirror > 0.5) a *= 0.34 * pow(clamp(1.0 - vUV.y * 1.55, 0.0, 1.0), 2.4);
    outColor = vec4(c * a, a);
  }`;

  // column-major mat4 helpers
  function perspective(fovy, aspect, n, f) {
    const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f);
    return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0]);
  }
  function lookAt(e, c, u) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  }
  function mul4(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  // translate * rotY * rotX
  function model(x, y, z, ry, rx, s) {
    const c = Math.cos(ry), sn = Math.sin(ry), cb = Math.cos(rx), sb = Math.sin(rx);
    return new Float32Array([c * s, 0, -sn * s, 0, sn * sb * s, cb * s, c * sb * s, 0, sn * cb * s, -sb * s, c * cb * s, 0, x, y, z, 1]);
  }
  // where cover i sits for a (fractional) offset d from the focus: a gentle arc whose side covers
  // turn away from the centre, recede and bunch up
  function layout(d) {
    const a = Math.tanh(d * 1.25);
    return {
      x: a * 0.8 + d * 0.42,
      z: -(1 - Math.exp(-d * d * 1.8)) * 0.95 - d * d * 0.01,
      ry: a * 1.02
    };
  }

  const Flow = (() => {
    let canvas = null, gl = null, prog = null, disc = null, vao = null, dummy = null, aniso = null;
    let unsub = null, releaseT = 0, onScreen = true;
    let stage = null, list = [], infoEl = null, railFill = null, countEl = null;
    const tex = new Map(); // cover url -> { t, ready, at, img, used }
    let loading = 0;
    const s = {
      x: 0, v: 0, target: 0, drag: null, dirty: true, focus: -1,
      tilt: { x: 0, y: 0, vx: 0, vy: 0 }, ptr: { x: 0, y: 0, on: false }, cssW: 1, cssH: 1, wheel: 0, wheelAt: 0,
      // the record: pull 0 = in the sleeve, 1 = slid out to the right; peek = pointer over the focused sleeve
      rec: { i: -1, pull: 0, v: 0, spin: 0, spinV: 0, peek: false, opening: null }
    };

    const n = () => list.length;
    const RANGE = 7.5;

    function create() {
      canvas = document.createElement('canvas');
      canvas.className = 'flow-canvas';
      canvas.tabIndex = -1;
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false });
      if (!gl) { canvas = null; return false; }
      try { prog = Fx3D.program(gl, FLOW_VS, FLOW_FS); } catch (err) { console.warn('FxBrowse flow shader', err); loseGL(gl); canvas = gl = null; return false; }
      try { disc = Fx3D.program(gl, FLOW_VS, DISC_FS); } catch (err) { console.warn('FxBrowse disc shader', err); disc = null; }
      aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog.p, 'aP');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      dummy = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, dummy);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([30, 31, 36, 255]));
      canvas.addEventListener('webglcontextlost', e => e.preventDefault());
      new ResizeObserver(() => {
        const r = canvas.getBoundingClientRect();
        if (!r.width) return;
        const k = Math.min(devicePixelRatio || 1, 1.5);
        s.cssW = r.width; s.cssH = r.height;
        canvas.width = Math.round(r.width * k); canvas.height = Math.round(r.height * k);
        s.dirty = true;
      }).observe(canvas);
      new IntersectionObserver(es => { onScreen = es[es.length - 1].isIntersecting; s.dirty = true; }).observe(canvas);
      wireInput();
      return true;
    }

    function release() {
      if (unsub) { unsub(); unsub = null; }
      if (gl) loseGL(gl);
      tex.clear(); loading = 0;
      canvas = gl = prog = disc = vao = dummy = null;
    }

    /* ---- textures: nearest-first, three at a time, evicted by distance ---- */
    function pump() {
      if (!gl) return;
      const f = Math.round(s.x);
      for (let k = 0; k <= 8 && loading < 3; k++) {
        for (const i of k ? [f + k, f - k] : [f]) {
          if (i < 0 || i >= n() || loading >= 3) continue;
          const url = list[i].cover;
          if (!url || tex.has(url)) continue;
          load(url);
        }
      }
    }
    function load(url) {
      const e = { t: null, ready: false, at: 0 };
      tex.set(url, e);
      loading++;
      const img = new Image();
      img.decoding = 'async';
      if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous';
      img.onload = () => {
        loading--;
        if (!gl || tex.get(url) !== e) return;
        try {
          const t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          // covers aren't always square: centre-crop like object-fit: cover does in the grid
          let src = img;
          const iw = img.naturalWidth, ih = img.naturalHeight;
          if (iw && ih && Math.abs(iw - ih) > 2) {
            const side = Math.min(iw, ih, 512), c = document.createElement('canvas');
            c.width = c.height = side;
            const m = Math.min(iw, ih);
            c.getContext('2d').drawImage(img, (iw - m) / 2, (ih - m) / 2, m, m, 0, 0, side, side);
            src = c;
          }
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
          e.t = t; e.ready = true; e.at = performance.now();
        } catch { /* a tainted or broken image just stays a placeholder */ }
        s.dirty = true;
        pump(); evict();
      };
      img.onerror = () => { loading--; pump(); };
      img.src = artUrl(url, 512);
    }
    function evict() {
      if (tex.size <= 26 || !gl) return;
      const pos = new Map(list.map((a, i) => [a.cover, i]));
      const far = [...tex.entries()].filter(([u, e]) => e.ready)
        .map(([u, e]) => [u, e, pos.has(u) ? Math.abs(pos.get(u) - s.x) : 1e9])
        .sort((a, b) => b[2] - a[2]);
      for (const [u, e, dist] of far) {
        if (tex.size <= 22 || dist < 9) break;
        gl.deleteTexture(e.t); tex.delete(u);
      }
    }

    /* ---- physics ---- */
    const OMEGA = 10.5;
    function stepPhysics(dt) {
      if (s.drag) return true;
      if (reduced()) { const moved = s.x !== s.target; s.x = s.target; s.v = 0; return moved; }
      let rem = dt;
      while (rem > 1e-6) {
        const h = Math.min(rem, 1 / 240);
        // critically damped: x'' = w^2 (target - x) - 2 w x'
        s.v += (OMEGA * OMEGA * (s.target - s.x) - 2 * OMEGA * s.v) * h;
        s.x += s.v * h;
        rem -= h;
      }
      if (Math.abs(s.target - s.x) < 0.0004 && Math.abs(s.v) < 0.003) { s.x = s.target; s.v = 0; return false; }
      return true;
    }
    function goTo(i) {
      if (!n()) return;
      s.target = clamp(Math.round(i), 0, n() - 1);
      s.dirty = true;
    }

    /* ---- input ---- */
    function project(M, VP) {
      const m = mul4(VP, M);
      return [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => {
        const cx = m[0] * x + m[4] * y + m[12], cy = m[1] * x + m[5] * y + m[13], cw = m[3] * x + m[7] * y + m[15];
        return [(cx / cw * 0.5 + 0.5) * s.cssW, (0.5 - cy / cw * 0.5) * s.cssH];
      });
    }
    function inQuad(q, px, py) {
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
        const c = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
      }
      return true;
    }
    function pick(px, py) {
      const VP = viewProj();
      const idx = [];
      for (let i = Math.max(0, Math.floor(s.x - RANGE)); i <= Math.min(n() - 1, Math.ceil(s.x + RANGE)); i++) idx.push(i);
      idx.sort((a, b) => Math.abs(a - s.x) - Math.abs(b - s.x)); // nearest (front-most) first
      for (const i of idx) {
        const L = layout(i - s.x);
        if (inQuad(project(model(L.x, 0, L.z, L.ry, 0, 1), VP), px, py)) return i;
      }
      return -1;
    }
    // Motion morphs album card covers into the album page (and back). Flow has no DOM cover, so
    // a real .card/.card-art is laid exactly over the focused GL cover for the transition to capture.
    function placeProxy(i) {
      const a = list[i];
      if (!a || !a.cover || !stage || !canvas.isConnected) return null;
      stage.querySelector('.flow-proxy')?.remove();
      const L = layout(i - s.x);
      const q = project(model(L.x, 0, L.z, L.ry, 0, 1), viewProj());
      const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const size = Math.max(x1 - x0, y1 - y0);
      const cr = canvas.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      const el = document.createElement('div');
      el.className = 'card flow-proxy';
      el.dataset.action = 'open-album';
      el.dataset.key = a.id;
      el.style.cssText = `left:${(cr.left - sr.left + (x0 + x1 - size) / 2).toFixed(1)}px;top:${(cr.top - sr.top + (y0 + y1 - size) / 2).toFixed(1)}px;width:${size.toFixed(1)}px;height:${size.toFixed(1)}px`;
      el.innerHTML = `<div class="card-art"><img src="${artUrl(a.cover, 512)}" alt=""></div>`;
      stage.appendChild(el);
      s.proxyUntil = performance.now() + 1100;
      return el;
    }
    function open(i) {
      const a = list[i];
      if (!a || s.rec.opening) return;
      goTo(i);
      // pull the record out of its sleeve first; the page opens once it's mostly out
      if (disc && !reduced() && stage && stage.isConnected) {
        const R = s.rec;
        if (R.i !== i) { R.i = i; R.pull = 0; R.v = 0; }
        R.opening = { i, at: performance.now(), wait: Math.abs(s.x - i) > 0.02 ? 900 : 620 };
        s.dirty = true;
        return;
      }
      navigateTo(i);
    }
    function navigateTo(i) {
      const a = list[i];
      s.rec.opening = null;
      if (!a || !stage || !stage.isConnected) return;
      const p = !reduced() && Math.abs(s.x - i) < 0.02 ? placeProxy(i) : null;
      // a real click on the proxy: Motion notes the card, main.js's handler navigates
      if (p) p.click(); else location.hash = '#/album/' + a.id;
    }
    // the record's spring: a little overshoot as it clears the sleeve
    function stepRecord(now, dt) {
      const R = s.rec, f = clamp(Math.round(s.target), 0, n() - 1);
      if (R.opening && now - R.opening.at > R.opening.wait) navigateTo(R.opening.i);
      const settled = Math.abs(s.x - s.target) < 0.08 && !s.drag;
      let goal = 0;
      if (R.opening) goal = Math.abs(s.x - R.opening.i) < 0.3 ? 1 : 0;
      else if (R.peek && settled) goal = 0.16;
      // another album came to the front: the old record goes back in before the new one moves
      if (R.i !== f && !R.opening) { goal = 0; if (R.pull < 0.01) { R.i = f; R.pull = 0; R.v = 0; } }
      const w = 11, z = 0.62;
      let rem = Math.min(dt, 0.05);
      while (rem > 1e-6) {
        const h = Math.min(rem, 1 / 240);
        R.v += (w * w * (goal - R.pull) - 2 * z * w * R.v) * h;
        R.pull += R.v * h;
        rem -= h;
      }
      // it rolls as it slides, then keeps turning while the page opens
      R.spinV += ((R.opening ? 7 : 0) - R.spinV) * Math.min(1, dt * 3);
      R.spin += R.spinV * dt + R.v * dt * 2.2;
      const moving = Math.abs(goal - R.pull) > 0.0008 || Math.abs(R.v) > 0.002 || Math.abs(R.spinV) > 0.01;
      if (!moving) { R.pull = goal; R.v = 0; R.spinV = 0; }
      return moving || !!R.opening;
    }
    function play(i) { const a = list[i]; if (a && typeof playAlbum === 'function') playAlbum(a, false); }

    function wireInput() {
      canvas.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        canvas.setPointerCapture(e.pointerId);
        s.drag = { id: e.pointerId, x0: e.clientX, lx: e.clientX, lt: performance.now(), moved: false, vel: 0 };
        s.v = 0; s.dirty = true;
      });
      canvas.addEventListener('pointermove', e => {
        const r = canvas.getBoundingClientRect();
        s.ptr.x = (e.clientX - r.left) / r.width * 2 - 1;
        s.ptr.y = (e.clientY - r.top) / r.height * 2 - 1;
        s.ptr.on = true; s.dirty = true;
        s.rec.peek = !s.drag && n() > 0 && pick(e.clientX - r.left, e.clientY - r.top) === Math.round(s.target);
        const d = s.drag;
        if (!d || d.id !== e.pointerId) return;
        const now = performance.now(), dx = e.clientX - d.lx;
        if (Math.abs(e.clientX - d.x0) > 5) { d.moved = true; stage.classList.add('dragging'); }
        const perItem = Math.max(90, s.cssH * 0.26);
        s.x = clamp(s.x - dx / perItem, -0.45, n() - 0.55);
        const dtt = Math.max(1, now - d.lt) / 1000;
        d.vel = d.vel * 0.6 + (-dx / perItem / dtt) * 0.4;
        d.lx = e.clientX; d.lt = now;
      });
      const end = e => {
        const d = s.drag;
        if (!d || d.id !== e.pointerId) return;
        s.drag = null;
        stage.classList.remove('dragging');
        if (!d.moved && e.type === 'pointerup') {
          const r = canvas.getBoundingClientRect();
          const i = pick(e.clientX - r.left, e.clientY - r.top);
          // opened from the click event that follows, so Motion's click capture sees the proxy card last
          if (i >= 0 && i === Math.round(s.target) && Math.abs(s.x - s.target) < 0.3) s.pendingOpen = i;
          else if (i >= 0) goTo(i);
          else goTo(s.x);
          return;
        }
        // stale velocity (the pointer stopped before letting go) shouldn't fling
        const vel = performance.now() - d.lt > 80 ? 0 : clamp(d.vel, -40, 40);
        s.v = vel;
        goTo(s.x + vel * 0.19);
      };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
      canvas.addEventListener('click', () => {
        const i = s.pendingOpen;
        s.pendingOpen = -1;
        if (i >= 0) open(i);
      });
      canvas.addEventListener('pointerleave', () => { s.ptr.on = false; s.rec.peek = false; s.dirty = true; });
      canvas.addEventListener('dblclick', e => {
        const r = canvas.getBoundingClientRect();
        const i = pick(e.clientX - r.left, e.clientY - r.top);
        if (i >= 0) play(i);
      });
      canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const now = performance.now();
        if (now - s.wheelAt > 250) s.wheel = 0;
        s.wheelAt = now;
        s.wheel += e.deltaMode === 1 ? delta * 40 : delta;
        // one album per mouse notch; trackpads accumulate their small deltas
        while (Math.abs(s.wheel) >= 50) {
          const dir = Math.sign(s.wheel);
          s.wheel -= dir * 100;
          if (Math.abs(s.wheel) < 50) s.wheel = 0;
          goTo(s.target + dir);
        }
      }, { passive: false });
    }

    // capture phase, so the global arrow keys (seek / volume) don't also fire while Flow is up
    document.addEventListener('keydown', e => {
      if (!stage || !stage.isConnected || !n() || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target && e.target.matches && e.target.matches('input, textarea, select, [contenteditable="true"]')) return;
      if ((typeof nowPlayingOpen === 'function' && nowPlayingOpen()) || !document.getElementById('modal')?.classList.contains('hidden')) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowUp') goTo(s.target - 1);
      else if (k === 'ArrowRight' || k === 'ArrowDown') goTo(s.target + 1);
      else if (k === 'PageUp') goTo(s.target - 5);
      else if (k === 'PageDown') goTo(s.target + 5);
      else if (k === 'Home') goTo(0);
      else if (k === 'End') goTo(n() - 1);
      else if (k === 'Enter') { e.shiftKey ? play(Math.round(s.target)) : open(Math.round(s.target)); }
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);

    /* ---- info below the covers ---- */
    function updateInfo(i) {
      const a = list[i];
      if (!a || !infoEl) return;
      S.flowFocusId = a.id;
      const year = a.releaseDate ? String(a.releaseDate).slice(0, 4) : (a.year || '');
      const type = a.type && a.type !== 'album' ? TYPE_LABEL[a.type] : '';
      const bits = [year, type, a.unreleased ? 'Unreleased' : ''].filter(Boolean);
      const words = String(a.title).split(/\s+/);
      let li = 0;
      infoEl.innerHTML = `<div class="fi-title" data-flow-open="${i}" aria-label="${esc(a.title)}">${words.map(w => `<span class="fi-w">${[...w].map(ch => `<span class="fi-l" style="--i:${li++}">${esc(ch)}</span>`).join('')}</span>`).join(' ')}</div>
        <div class="fi-sub"><span class="link" data-action="open-artist" data-artist="${esc(a.artist)}">${esc(a.artist)}</span>${bits.length ? ' · ' + esc(bits.join(' · ')) : ''}</div>
        <div class="fi-actions">
          <button class="btn primary" data-action="play-album" data-key="${a.id}">${icon('play')}Play</button>
          <button class="btn" data-flow-open="${i}">Open album</button>
        </div>`;
      infoEl.classList.toggle('long', li > 22);
      if (countEl) countEl.textContent = `${String(i + 1).padStart(2, '0')} / ${String(n()).padStart(2, '0')}`;
      stage.querySelectorAll('.fr-tick.on').forEach(t => t.classList.remove('on'));
      stage.querySelector(`.fr-tick[data-i="${i}"]`)?.classList.add('on');
      if (a.cover) vibrantColor(a.cover).then(rgb => { if (list[s.focus] === a && stage) stage.style.setProperty('--fc', `rgb(${rgb.join(',')})`); });
    }

    let VPcache = null, VPkey = '';
    function viewProj() {
      const key = s.cssW + 'x' + s.cssH;
      if (key !== VPkey) {
        const aspect = s.cssW / s.cssH;
        // keep the focused cover about half the stage tall whatever the aspect; widen on narrow stages
        const fov = aspect < 1.3 ? 0.62 + (1.3 - aspect) * 0.5 : 0.62;
        VPcache = mul4(perspective(fov, aspect, 0.1, 40), lookAt([0, 0.34, 3.05], [0, -0.26, 0], [0, 1, 0]));
        VPkey = key;
      }
      return VPcache;
    }

    function frame(now, dt) {
      if (!gl || gl.isContextLost() || !n()) return;
      const moving = stepPhysics(dt);
      // hover tilt on the focused cover follows the pointer on a spring
      const T = s.tilt, rm = reduced();
      const tx = s.ptr.on && !s.drag && !rm ? s.ptr.x * 0.16 : 0, ty = s.ptr.on && !s.drag && !rm ? s.ptr.y * 0.1 : 0;
      T.vx = (T.vx + (tx - T.x) * 0.12) * 0.78; T.x += T.vx;
      T.vy = (T.vy + (ty - T.y) * 0.12) * 0.78; T.y += T.vy;
      const tiltMoving = Math.abs(T.vx) + Math.abs(T.vy) + Math.abs(tx - T.x) + Math.abs(ty - T.y) > 0.0005;
      const recMoving = disc ? stepRecord(now, dt) : false;

      const f = clamp(Math.round(s.x), 0, n() - 1);
      if (f !== s.focus) { s.focus = f; updateInfo(f); pump(); }
      if (s.proxyUntil && (now > s.proxyUntil || moving || s.drag)) {
        const e = tex.get((list[f] || {}).cover);
        if (moving || s.drag || !list[f].cover || (e && e.ready && now - e.at > 350) || now > s.proxyUntil + 3000) {
          stage && stage.querySelector('.flow-proxy')?.remove();
          s.proxyUntil = 0; s.dirty = true;
        }
      }
      let fading = false;
      if (!moving && !tiltMoving && !recMoving && !s.dirty) {
        for (let i = Math.max(0, f - 8); i <= Math.min(n() - 1, f + 8); i++) {
          const e = tex.get(list[i].cover);
          if (e && e.ready && now - e.at < 400) { fading = true; break; }
        }
        if (!fading) return; // settled: nothing to draw
      }
      s.dirty = false;
      if (railFill) railFill.style.transform = `translateX(${(n() > 1 ? clamp(s.x / (n() - 1), 0, 1) : 0) * 100}%)`;

      const W = canvas.width, H = canvas.height;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog.p);
      const U = prog.u;
      gl.uniformMatrix4fv(U.uVP, false, viewProj());
      gl.uniform3f(U.uEye, 0, 0.34, 3.05);
      const lx = -0.35 + s.ptr.x * 0.4, ly = 0.55 - s.ptr.y * 0.2, ll = Math.hypot(lx, ly, 0.75);
      gl.uniform3f(U.uLight, lx / ll, ly / ll, 0.75 / ll);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(U.uTex, 0);
      gl.bindVertexArray(vao);

      const items = [];
      for (let i = Math.max(0, Math.floor(s.x - RANGE)); i <= Math.min(n() - 1, Math.ceil(s.x + RANGE)); i++) {
        const d = i - s.x, L = layout(d), ad = Math.abs(d);
        const focusW = Math.max(0, 1 - ad);
        const M = model(L.x, 0, L.z, L.ry + T.x * focusW, T.y * focusW, 1);
        items.push({ i, d, ad, M, focusW });
      }
      items.sort((a, b) => b.ad - a.ad);
      const R = s.rec, recOut = disc && R.pull > 0.002 ? R.i : -1;
      for (const mirror of [1, 0]) {
        gl.uniform1f(U.uMirror, mirror);
        for (const it of items) {
          const a = list[it.i], e = a.cover ? tex.get(a.cover) : null;
          const on = e && e.ready ? clamp((now - e.at) / 350, 0, 1) : 0;
          if (it.i === recOut) { drawDisc(it, e, on, R, mirror); gl.useProgram(prog.p); gl.uniform1f(U.uMirror, mirror); }
          gl.bindTexture(gl.TEXTURE_2D, on ? e.t : dummy);
          gl.uniformMatrix4fv(U.uM, false, it.M);
          gl.uniform1f(U.uTexOn, on);
          gl.uniform1f(U.uBlur, Math.min(3.2, Math.max(0, it.ad - 0.35) * 0.9));
          gl.uniform1f(U.uShade, 1 - Math.min(0.62, Math.pow(Math.min(it.ad, 5) / 5, 0.8) * 0.62));
          gl.uniform1f(U.uAlpha, 1 - clamp((it.ad - 5.2) / 2.2, 0, 1));
          gl.uniform1f(U.uSheen, 1.5 - (it.d * 0.9) + T.x * 1.5);
          gl.uniform1f(U.uFocus, it.focusW);
          const h = (it.i * 47) % 360;
          gl.uniform3f(U.uPh, 0.1 + 0.03 * Math.sin(h), 0.105, 0.125 + 0.03 * Math.cos(h));
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
      gl.bindVertexArray(null);
    }

    function visible() {
      if (!canvas) return false;
      if (!canvas.isConnected) {
        if (!releaseT) releaseT = setTimeout(release, 15000);
        return false;
      }
      return onScreen;
    }

    // in the sleeve's own space: slid out to the right, a hair behind the cover, slightly smaller
    function drawDisc(it, e, on, R, mirror) {
      const U = disc.u;
      const T = new Float32Array([0.96, 0, 0, 0, 0, 0.96, 0, 0, 0, 0, 1, 0, R.pull * 0.62, 0, -0.012, 1]);
      gl.useProgram(disc.p);
      gl.uniformMatrix4fv(U.uVP, false, viewProj());
      gl.uniformMatrix4fv(U.uM, false, mul4(it.M, T));
      gl.uniform1f(U.uMirror, mirror);
      gl.uniform1i(U.uTex, 0);
      gl.bindTexture(gl.TEXTURE_2D, on ? e.t : dummy);
      gl.uniform1f(U.uTexOn, on);
      gl.uniform1f(U.uSpin, R.spin);
      gl.uniform1f(U.uAlpha, clamp(R.pull * 8, 0, 1));
      gl.uniform1f(U.uShade, 1 - Math.min(0.62, Math.pow(Math.min(it.ad, 5) / 5, 0.8) * 0.62));
      gl.uniform3f(U.uLight, -0.35 + s.ptr.x * 0.4, 0.55 - s.ptr.y * 0.2, 0.75);
      const h = (it.i * 47) % 360;
      gl.uniform3f(U.uPh, 0.1 + 0.03 * Math.sin(h), 0.105, 0.125 + 0.03 * Math.cos(h));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function mount(el, albums) {
      clearTimeout(releaseT); releaseT = 0;
      if (!canvas || !gl || gl.isContextLost()) { release(); if (!create()) return false; }
      stage = el; list = albums;
      infoEl = el.querySelector('.flow-info');
      railFill = el.querySelector('.fr-fill');
      countEl = el.querySelector('.flow-count');
      el.querySelector('.flow-slot').replaceWith(canvas);
      const keep = list.findIndex(a => a.id === S.flowFocusId);
      const startAt = keep >= 0 ? keep : 0;
      // a real navigation glides in from a few covers back; a re-render keeps its place
      const c = content();
      const entering = c && 'enter' in c.dataset && !reduced();
      // coming back from an album inside a view transition: morph target instead of a glide
      const morphBack = keep >= 0 && document.documentElement.classList.contains('vt-nav');
      s.target = startAt; s.x = entering && !morphBack ? Math.max(0, startAt - 3.5) : startAt; s.v = 0;
      s.focus = -1; s.dirty = true; s.pendingOpen = -1;
      Object.assign(s.rec, { i: -1, pull: 0, v: 0, spin: 0, spinV: 0, peek: false, opening: null });
      if (morphBack) {
        const r = canvas.getBoundingClientRect();
        if (r.width) { s.cssW = r.width; s.cssH = r.height; placeProxy(startAt); }
      }
      pump();
      if (!unsub) unsub = Fx3D.onFrame(frame, { fps: 120, visible });
      return true;
    }

    return { mount, goTo, open: i => open(i), release, get supported() { return typeof WebGL2RenderingContext !== 'undefined'; }, state: s, textures: tex };
  })();

  function flowHTML(albums) {
    const ticks = albums.map((a, i) => `<button class="fr-tick" data-flow-go="${i}" data-i="${i}" title="${esc(a.title)}"></button>`).join('');
    return `<section class="flow-stage" id="albumFlow" aria-label="Album flow. Arrow keys to browse, Enter to open, Shift+Enter to play">
      <div class="flow-3d"><canvas class="flow-slot"></canvas></div>
      <div class="flow-info" aria-live="polite"></div>
      <div class="flow-foot">
        <span class="flow-count"></span>
        <div class="flow-rail" style="--n:${albums.length}"><span class="fr-fill"></span>${ticks}</div>
        <span class="flow-hint">Drag, scroll or use arrow keys</span>
      </div>
    </section>`;
  }

  const toggleHTML = flow => `<div class="view-toggle" role="radiogroup" aria-label="Album view">
      <span class="vt-thumb"></span>
      <button role="radio" aria-checked="${!flow}" class="${flow ? '' : 'on'}" data-browse-view="grid" title="Grid">${icon('grid')}<span>Grid</span></button>
      <button role="radio" aria-checked="${flow}" class="${flow ? 'on' : ''}" data-browse-view="flow" title="Flow">${flowIcon}<span>Flow</span></button>
    </div>`;
  const flowIcon = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M8 6.5h8v11H8z"/><path d="M5.5 8.2 3 9v6l2.5.8M18.5 8.2 21 9v6l-2.5.8"/></svg>`;

  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('[data-browse-view], [data-flow-go], [data-flow-open]');
    if (!t) return;
    if (t.dataset.flowGo != null) { Flow.goTo(+t.dataset.flowGo); return; }
    if (t.dataset.flowOpen != null) { Flow.open(+t.dataset.flowOpen); return; }
    const view = t.dataset.browseView;
    if ((S.settings.albumsView || 'grid') === view) return;
    S.settings.albumsView = view;
    try { window.aura.settingsSet({ albumsView: view }); } catch {}
    // let the thumb spring across first, then cross-fade the page
    const group = t.closest('.view-toggle');
    group.querySelectorAll('button').forEach(b => { const on = b === t; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    const swap = () => { if (S.route.name === 'albums') renderAlbums(); };
    if (reduced()) { swap(); return; }
    setTimeout(() => document.startViewTransition ? document.startViewTransition(swap) : swap(), 170);
  });

  /* ================================================================ page hooks ==== */

  function wrap(name, after) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    const wrapped = function (...args) {
      const r = orig.apply(this, args);
      try { after(...args); } catch (err) { console.error('FxBrowse ' + name, err); }
      return r;
    };
    window[name] = wrapped;
  }

  wrap('renderHome', () => {
    const c = content();
    const hero = c.querySelector('.home-hero');
    if (!hero) return;
    kinetic(hero.querySelector('h1'));
    const seed = (typeof cur === 'function' && cur() && cur().cover)
      || (S.recentPlayed || []).map(id => S.byId.get(id)).find(t => t && t.cover)?.cover
      || (sortByRelease(S.albums).find(a => a.cover) || {}).cover;
    // the rings halo views.js just mounted is dropped by Fx3D once its canvas leaves the page
    if (Hero.mount(hero.querySelector('#homeFx'), seed)) hero.classList.add('chrome-hero');
    precolor(c);
  });

  wrap('renderAlbums', () => {
    const c = content();
    const actions = c.querySelector('.page-head .head-actions');
    const albums = sortByRelease(S.albums);
    const flow = S.settings.albumsView === 'flow' && albums.length > 0 && Flow.supported;
    if (actions && albums.length) actions.insertAdjacentHTML('afterbegin', toggleHTML(flow));
    const grid = c.querySelector('.grid-cards');
    if (flow && grid) {
      grid.insertAdjacentHTML('beforebegin', flowHTML(albums));
      grid.remove();
      c.querySelector('.page').classList.add('albums-flow');
      if (!Flow.mount(c.querySelector('#albumFlow'), albums)) {
        // no WebGL2: fall back to the grid for this render
        S.settings.albumsView = 'grid';
        renderAlbums();
      }
    } else precolor(c);
  });

  wrap('renderArtists', () => precolor(content()));
  wrap('renderRecent', () => precolor(content()));

  return {
    hero: Hero, flow: Flow, kinetic,
    stats: () => ({ heroActive: Hero.active, flowTextures: Flow.textures.size, flowX: Flow.state.x })
  };
})();
