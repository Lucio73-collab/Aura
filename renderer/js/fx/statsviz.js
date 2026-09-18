/* fx/statsviz.js — the Stats page as an instrument panel.
   One WebGL2 context for the whole page (a detached canvas): the listening
   terrain and the 3D album bars render into it in turn and are blitted into
   their own 2D canvases, so the page never holds more than one live context.
   The 24h clock and the streamgraph are SVG (crisp text, cheap morphs).
   Everything rides Fx3D.onFrame and only draws while something is moving,
   on screen. Range switches morph: grids/radii/streams tween, bars spring,
   digits roll. Reduced motion draws static frames. */

const StatsViz = (() => {
  const TAU = Math.PI * 2;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const N_BUCKETS = 64, N_BARS = 8, N_STREAMS = 8;
  const RANGES = [['7d', 'Week'], ['30d', 'Month'], ['90d', '90 days'], ['all', 'All time']];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const pad2 = n => String(n).padStart(2, '0');
  const rm = () => Fx3D.reduceMotion;
  const hm = min => { min = Math.round(min); return min >= 60 ? Math.floor(min / 60) + 'h ' + (min % 60) + 'm' : min + ' min'; };
  const plural = (n, w) => n.toLocaleString('en-US') + ' ' + w + (n === 1 ? '' : 's');
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  /* Chart morphs ride a Motion spring from 0 → 1. 'gentle' is critically damped, so a
     morphing value never overshoots past (or dips below) the real data. */
  function morph(owner, apply, { animate = true, delay = 0, done } = {}) {
    owner._m?.stop(); clearTimeout(owner._mt);
    const h = owner._m = Motion.spring(0, { spring: 'gentle', precision: 0.002, onUpdate: p => apply(clamp(p, 0, 1)), onRest: () => done && done() });
    if (!animate || rm()) { h.jump(1); return; }
    apply(0);
    if (delay) owner._mt = setTimeout(() => h.set(1), delay); else h.set(1);
  }
  const stopMorph = o => { o._m?.stop(); clearTimeout(o._mt); };

  /* ---------- small linear algebra (column-major mat4) ---------- */
  const V3 = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  };
  const M4 = {
    persp(fovy, asp, n, f) { const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16); o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f); return o; },
    look(e, c) {
      const z = V3.norm(V3.sub(e, c)), x = V3.norm(V3.cross([0, 1, 0], z)), y = V3.cross(z, x);
      return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -V3.dot(x, e), -V3.dot(y, e), -V3.dot(z, e), 1]);
    },
    mul(a, b) { const o = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; },
    inv(m) {
      const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
      const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
      const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06, d = det ? 1 / det : 0;
      return new Float32Array([
        (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
        (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
        (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
        (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d
      ]);
    },
    xf: (m, x, y, z) => { const w = m[3] * x + m[7] * y + m[11] * z + m[15]; return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w, w]; }
  };
  // camera → { vp, inv, eye }
  function camera(eye, target, fovy, asp) {
    const vp = M4.mul(M4.persp(fovy, asp, 0.1, 60), M4.look(eye, target));
    return { vp, inv: M4.inv(vp), eye };
  }
  // camera distance along `dir` that fits every corner inside ±mx/±my of NDC
  function fitDistance(corners, dir, target, fovy, asp, mx, my) {
    let R = 12;
    for (let k = 0; k < 8; k++) {
      const cam = camera([target[0] + dir[0] * R, target[1] + dir[1] * R, target[2] + dir[2] * R], target, fovy, asp);
      let s = 0;
      for (const c of corners) { const p = M4.xf(cam.vp, c[0], c[1], c[2]); if (p[3] <= 0.05) { s = 2; break; } s = Math.max(s, Math.abs(p[0]) / mx, Math.abs(p[1]) / my); }
      R *= Math.max(0.5, Math.min(2, s));
    }
    return R;
  }
  const boxCorners = (x0, x1, y0, y1, z0, z1) => [[x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0], [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1]];
  const orbitDir = (yaw, pitch) => [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const project = (cam, w, h, x, y, z) => { const p = M4.xf(cam.vp, x, y, z); return [(p[0] * 0.5 + 0.5) * w, (0.5 - p[1] * 0.5) * h, p[3] > 0]; };
  function ray(cam, w, h, px, py) {
    const nx = px / w * 2 - 1, ny = 1 - py / h * 2;
    const a = M4.xf(cam.inv, nx, ny, -1), b = M4.xf(cam.inv, nx, ny, 1);
    return { o: a.slice(0, 3), d: V3.norm(V3.sub(b, a)) };
  }

  /* ---------- colour ---------- */
  function accentRGB() {
    const x = document.createElement('canvas').getContext('2d');
    x.fillStyle = '#6aa5ff';
    x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6aa5ff';
    const s = x.fillStyle;
    if (s[0] === '#') return [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
    const m = s.match(/\d+(\.\d+)?/g); return m ? m.slice(0, 3).map(Number) : [106, 165, 255];
  }
  const mixRGB = (a, b, t) => a.map((v, i) => Math.round(lerp(v, b[i], t)));
  const rgbStr = (c, a = 1) => a === 1 ? `rgb(${c.join(',')})` : `rgba(${c.join(',')},${a})`;
  const SURFACE = [22, 25, 32];
  // sequential ramp: near-surface → accent → accent lifted toward white
  const ramp = (acc, t) => t < 0.6 ? mixRGB(SURFACE, acc, 0.18 + t / 0.6 * 0.82) : mixRGB(acc, [240, 246, 255], (t - 0.6) / 0.4 * 0.45);

  /* ---------- data shaping ---------- */
  function spanOf(range, ev) {
    const d = { '7d': 7, '30d': 30, '90d': 90 }[range];
    if (d) return d * 864e5;
    const first = ev && ev.first != null ? ev.first : Date.now();
    return Math.max(7 * 864e5, (ev ? ev.now : Date.now()) - first + 3600e3);
  }
  function gauss1(arr, sigma, cyclic) {
    const n = arr.length, out = new Float32Array(n), R = Math.ceil(sigma * 3);
    for (let i = 0; i < n; i++) {
      let s = 0, w = 0;
      for (let k = -R; k <= R; k++) {
        let j = i + k;
        if (cyclic) j = (j % n + n) % n; else if (j < 0 || j >= n) continue;
        const g = Math.exp(-k * k / (2 * sigma * sigma)); s += arr[j] * g; w += g;
      }
      out[i] = w ? s / w : 0;
    }
    return out;
  }
  function shape(st, ev, range) {
    const events = (ev && ev.events) || [];
    const now = (ev && ev.now) || Date.now();
    const plays = new Float32Array(168), mins = new Float32Array(168);
    const hourMin = new Float32Array(24), hourPlays = new Float32Array(24);
    const songs = new Set(), rel = new Set(), days = new Set();
    for (const [ts, ms, id] of events) {
      const d = new Date(ts), c = ((d.getDay() + 6) % 7) * 24 + d.getHours();
      plays[c]++; mins[c] += ms / 60000; hourMin[d.getHours()] += ms / 60000; hourPlays[d.getHours()]++;
      songs.add(id); days.add(d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate());
      const t = S.byId.get(id); if (t && t.albumId) rel.add(t.albumId);
    }
    // terrain heights: half raw, half Gaussian-smoothed (σ 0.75 cell, hours wrap, days clamp)
    const sm = new Float32Array(168);
    for (let j = 0; j < 7; j++) for (let i = 0; i < 24; i++) {
      let s = 0, w = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const jj = j + dj; if (jj < 0 || jj > 6) continue;
        const g = Math.exp(-(di * di + dj * dj) / (2 * 0.75 * 0.75));
        s += plays[jj * 24 + (i + di + 24) % 24] * g; w += g;
      }
      sm[j * 24 + i] = s / w;
    }
    const maxP = Math.max(1, ...plays), maxS = Math.max(1e-6, ...sm);
    const height = new Float32Array(168);
    const anyPlays = plays.some(v => v);
    for (let i = 0; i < 168; i++) height[i] = anyPlays ? 0.55 * plays[i] / maxP + 0.45 * sm[i] / maxS : 0;
    const hMax = Math.max(1e-6, ...height);
    for (let i = 0; i < 168; i++) height[i] /= hMax;

    // streams: minutes per album in N buckets across the range, lightly smoothed
    // the x-axis starts a little before the first play in range, so a range that
    // is mostly silence doesn't squash all the listening into its last pixels
    const rangeStart = now - spanOf(range, ev);
    const firstIn = events.length ? events[0][0] : now;
    const t0 = Math.max(rangeStart, firstIn - Math.max(3600e3, (now - firstIn) * 0.04));
    const span = Math.max(6 * 3600e3, now - t0), bw = span / N_BUCKETS;
    const albums = (st.topAlbums || []).filter(a => S.albumById.has(a.id));
    const albumMin = new Map();
    for (const [, ms, id] of events) { const t = S.byId.get(id); if (t && t.albumId && S.albumById.has(t.albumId)) albumMin.set(t.albumId, (albumMin.get(t.albumId) || 0) + ms); }
    const topIds = [...albumMin].sort((a, b) => b[1] - a[1]).slice(0, N_STREAMS).map(([id]) => id);
    const raw = new Map(topIds.map(id => [id, new Float32Array(N_BUCKETS)]));
    const other = new Float32Array(N_BUCKETS);
    for (const [ts, ms, id] of events) {
      const b = clamp(Math.floor((ts - t0) / bw), 0, N_BUCKETS - 1);
      const t = S.byId.get(id), arr = (t && raw.get(t.albumId)) || other;
      arr[b] += ms / 60000;
    }
    const series = [...raw].map(([id, v]) => { const a = S.albumById.get(id); return { id, title: a.title, cover: a.cover, values: gauss1(v, 0.9) }; });
    if (other.some(v => v > 0)) series.push({ id: 'other', title: 'Everything else', cover: null, values: gauss1(other, 0.9) });

    let peak = -1;
    for (let h = 0; h < 24; h++) if (hourMin[h] > 0 && (peak < 0 || hourMin[h] > hourMin[peak])) peak = h;
    return {
      range, now, t0, span,
      grid: { plays, mins, height, maxPlays: Math.max(0, ...plays) },
      clock: { hourMin, hourPlays, peak },
      bars: albums.slice(0, N_BARS).map(a => { const x = S.albumById.get(a.id); return { id: a.id, title: x.title, cover: x.cover, year: x.year, min: a.ms / 60000 }; }),
      series,
      kpi: { minutes: st.minutes || 0, plays: st.plays || 0, songs: songs.size, releases: rel.size, days: days.size, first: events.length ? events[0][0] : null }
    };
  }

  /* ---------- the one GL context ---------- */
  let G = null;
  const TERRAIN_VS = `#version 300 es
  precision highp float; precision highp int;
  layout(location=0) in vec2 aUV; layout(location=1) in float aKind; layout(location=2) in vec3 aSideN;
  uniform mat4 uVP; uniform float uG[168]; uniform vec3 uSize;
  out vec3 vPos; out vec3 vN; out vec2 vUV; out float vH; out float vKind;
  float G(int i, int j) { i = (i % 24 + 24) % 24; j = clamp(j, 0, 6); return uG[j * 24 + i]; }
  float cr(float a, float b, float c, float d, float t) { return b + 0.5 * t * (c - a + t * (2.0 * a - 5.0 * b + 4.0 * c - d + t * (3.0 * (b - c) + d - a))); }
  float H(vec2 uv) {
    vec2 x = uv - 0.5; ivec2 b = ivec2(floor(x)); vec2 f = x - vec2(b);
    float r0 = cr(G(b.x-1,b.y-1), G(b.x,b.y-1), G(b.x+1,b.y-1), G(b.x+2,b.y-1), f.x);
    float r1 = cr(G(b.x-1,b.y), G(b.x,b.y), G(b.x+1,b.y), G(b.x+2,b.y), f.x);
    float r2 = cr(G(b.x-1,b.y+1), G(b.x,b.y+1), G(b.x+1,b.y+1), G(b.x+2,b.y+1), f.x);
    float r3 = cr(G(b.x-1,b.y+2), G(b.x,b.y+2), G(b.x+1,b.y+2), G(b.x+2,b.y+2), f.x);
    return max(0.0, cr(r0, r1, r2, r3, f.y));
  }
  void main() {
    float h = H(aUV);
    vec3 p = vec3((aUV.x / 24.0 - 0.5) * uSize.x, (aKind > 1.5 ? 0.0 : h) * uSize.y, (aUV.y / 7.0 - 0.5) * uSize.z);
    vec3 n = aSideN;
    if (aKind < 0.5) {
      float e = 0.1;
      float hx = H(aUV + vec2(e, 0.0)) - H(aUV - vec2(e, 0.0));
      float hz = H(aUV + vec2(0.0, e)) - H(aUV - vec2(0.0, e));
      n = normalize(cross(vec3(0.0, hz * uSize.y, 2.0 * e / 7.0 * uSize.z), vec3(2.0 * e / 24.0 * uSize.x, hx * uSize.y, 0.0)));
    }
    vPos = p; vN = n; vUV = aUV; vH = aKind > 1.5 ? 0.0 : h; vKind = aKind;
    gl_Position = uVP * vec4(p, 1.0);
  }`;
  const TERRAIN_FS = `#version 300 es
  precision highp float;
  in vec3 vPos; in vec3 vN; in vec2 vUV; in float vH; in float vKind;
  uniform vec3 uEye, uLo, uMid, uHi; uniform vec3 uHover; uniform float uLevels; uniform vec3 uSize;
  out vec4 o;
  float line(float x) { float w = fwidth(x); return 1.0 - smoothstep(0.0, 1.25, abs(fract(x - 0.5) - 0.5) / max(w, 1e-4)); }
  void main() {
    vec3 N = normalize(vN), V = normalize(uEye - vPos);
    if (dot(N, V) < 0.0 && vKind < 0.5) N = -N;
    float h = clamp(vH, 0.0, 1.0);
    vec3 base = h < 0.55 ? mix(uLo, uMid, smoothstep(0.0, 0.55, h)) : mix(uMid, uHi, smoothstep(0.55, 1.0, h));
    vec3 L1 = normalize(vec3(-0.45, 0.85, 0.55)), L2 = normalize(vec3(0.8, 0.35, -0.4));
    float key = max(dot(N, L1), 0.0) * 0.6 + 0.4; key *= key;
    float fill = max(dot(N, L2), 0.0) * 0.28;
    float hemi = mix(0.45, 1.0, N.y * 0.5 + 0.5);
    float spec = pow(max(dot(N, normalize(L1 + V)), 0.0), 40.0) * 0.22 * (0.3 + h);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 col = base * (0.3 * hemi + 0.8 * key + fill) + spec + uHi * rim * 0.12 * (0.2 + h);
    float cell = step(abs(floor(vUV.x) - uHover.x) + abs(floor(vUV.y) - uHover.y), 0.1) * uHover.z;
    if (vKind < 0.5) {
      float iso = line(h * uLevels) * smoothstep(0.015, 0.06, h);
      col = mix(col, uHi * 1.1 + 0.08, iso * 0.5);
      vec2 g = vec2(line(vUV.x), line(vUV.y));
      float grid = max(g.x, g.y);
      float six = line(vUV.x / 6.0);
      col += vec3(0.9, 0.95, 1.0) * (grid * 0.035 + six * 0.05) * (1.0 - h * 0.6);
      col += cell * (uHi * 0.22 + 0.04);
    } else {
      float y = vPos.y / uSize.y;
      col = mix(uLo * 0.55, base * 0.55, clamp(y * 1.6, 0.0, 1.0)) * (0.55 + 0.45 * key);
      col += uHi * 0.35 * smoothstep(0.012, 0.0, abs(vPos.y - vH * uSize.y) - 0.004) * step(0.5, vKind) * (1.0 - step(1.5, vKind));
      col += uHi * pow(1.0 - clamp(y * 8.0, 0.0, 1.0), 6.0) * 0.06;
    }
    o = vec4(col, 1.0);
  }`;
  const FLAT_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol;
  uniform mat4 uVP; out vec4 vCol; out vec3 vP;
  void main() { vCol = aCol; vP = aPos; gl_Position = uVP * vec4(aPos, 1.0); }`;
  const FLAT_FS = `#version 300 es
  precision highp float;
  in vec4 vCol; in vec3 vP; uniform int uMode; uniform vec4 uB[8]; uniform vec3 uBC[8]; uniform vec2 uExt; out vec4 o;
  float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
  void main() {
    if (uMode == 0) { o = vec4(vCol.rgb * vCol.a, vCol.a); return; }
    if (uMode == 1) { // soft elliptical contact shadow under the terrain
      vec2 q = vCol.xy; float d = dot(q, q);
      float a = smoothstep(1.0, 0.25, d) * 0.55; o = vec4(0.0, 0.0, 0.0, a); return;
    }
    // bars floor: contact shadows + cover-coloured bounce light + faint grid, fading out at the edges
    vec3 col = vec3(0.0); float sh = 0.0;
    for (int i = 0; i < 8; i++) {
      if (uB[i].w <= 0.0) continue;
      float d = sdBox(vP.xz - uB[i].xy, vec2(uB[i].z));
      sh += exp(-max(d, 0.0) * 5.0) * clamp(uB[i].w * 0.6, 0.0, 0.7);
      col += uBC[i] * exp(-max(d, 0.0) * 2.2) * 0.16 * clamp(uB[i].w, 0.0, 1.0);
    }
    vec2 g = abs(fract(vP.xz * 1.0 - 0.5) - 0.5) / fwidth(vP.xz);
    float grid = (1.0 - smoothstep(0.0, 1.0, min(g.x, g.y))) * 0.05;
    vec2 e = abs(vP.xz) / uExt; float fade = smoothstep(1.0, 0.55, max(e.x, e.y * 1.2));
    vec3 c = (col + vec3(0.8, 0.88, 1.0) * grid) * fade;
    float a = clamp((sh * 0.8) * fade + length(c), 0.0, 0.9);
    o = vec4(c, a);
  }`;
  const BAR_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos; layout(location=1) in vec3 aN; layout(location=2) in vec2 aUV; layout(location=3) in float aFace;
  uniform mat4 uVP; uniform vec3 uBar; // x, height, half width
  out vec3 vP; out vec3 vN; out vec2 vUV; out float vFace; out float vY;
  void main() {
    vec3 p = vec3(uBar.x + aPos.x * uBar.z * 2.0, aPos.y * uBar.y, aPos.z * uBar.z * 2.0);
    vP = p; vN = aN; vUV = aUV; vFace = aFace; vY = aPos.y;
    gl_Position = uVP * vec4(p, 1.0);
  }`;
  const BAR_FS = `#version 300 es
  precision highp float;
  in vec3 vP; in vec3 vN; in vec2 vUV; in float vFace; in float vY;
  uniform sampler2D uTex; uniform float uHasTex, uHot, uH, uTick; uniform vec3 uCol, uEye; out vec4 o;
  void main() {
    vec3 N = normalize(vN), V = normalize(uEye - vP);
    vec3 L = normalize(vec3(-0.4, 0.9, 0.6));
    vec3 tex = uHasTex > 0.5 ? texture(uTex, vUV).rgb : uCol;
    float key = max(dot(N, L), 0.0) * 0.55 + 0.45;
    float rim = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    vec3 col;
    if (vFace < 0.5) {
      col = tex * (0.92 + 0.08 * key) + pow(max(dot(reflect(-L, N), V), 0.0), 30.0) * 0.08;
      vec2 e = min(vUV, 1.0 - vUV); float edge = 1.0 - smoothstep(0.0, 0.025, min(e.x, e.y));
      col += edge * 0.18 * (0.5 + uHot);
    } else {
      float y = vP.y;
      vec3 side = mix(uCol * 0.55, tex, 0.3);
      col = mix(uCol * 0.1, side * 0.75, pow(clamp(vY, 0.0, 1.0), 0.8)) * key;
      float t = abs(fract(y / uTick - 0.5) - 0.5) / fwidth(y / uTick);
      col += (1.0 - smoothstep(0.0, 1.0, t)) * 0.05 * step(0.05, y) * step(y, uH - 0.05);
      col += uCol * smoothstep(0.08, 0.0, uH - y) * 0.35;
      col += rim * uCol * 0.25;
    }
    col += uHot * vec3(0.07) + uHot * uCol * 0.08;
    o = vec4(col, 1.0);
  }`;

  function vao(gl, attribs, index) {
    const v = gl.createVertexArray(); gl.bindVertexArray(v);
    attribs.forEach(([loc, size, data]) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    });
    let count = attribs[0][2].length / attribs[0][1];
    if (index) { const b = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW); count = index.length; }
    gl.bindVertexArray(null);
    return { v, count, indexed: !!index };
  }

  function terrainMesh(gl) {
    const SU = 144, SV = 56, uv = [], kind = [], sn = [], idx = [];
    const push = (u, v, k, n) => { uv.push(u, v); kind.push(k); sn.push(n[0], n[1], n[2]); return kind.length - 1; };
    for (let j = 0; j <= SV; j++) for (let i = 0; i <= SU; i++) push(i / SU * 24, j / SV * 7, 0, [0, 1, 0]);
    for (let j = 0; j < SV; j++) for (let i = 0; i < SU; i++) {
      const a = j * (SU + 1) + i, b = a + 1, c = a + SU + 1, d = c + 1; idx.push(a, c, b, b, c, d);
    }
    const skirt = (pts, n) => {
      let prev = null;
      for (const [u, v] of pts) { const t = push(u, v, 1, n), bt = push(u, v, 2, n); if (prev) idx.push(prev[0], prev[1], t, t, prev[1], bt); prev = [t, bt]; }
    };
    const along = (n, f) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
    skirt(along(SU, t => [t * 24, 7]), [0, 0, 1]);
    skirt(along(SU, t => [t * 24, 0]), [0, 0, -1]);
    skirt(along(SV, t => [0, t * 7]), [-1, 0, 0]);
    skirt(along(SV, t => [24, t * 7]), [1, 0, 0]);
    return vao(gl, [[0, 2, new Float32Array(uv)], [1, 1, new Float32Array(kind)], [2, 3, new Float32Array(sn)]], new Uint16Array(idx));
  }
  const T_SIZE = [6.4, 1.25, 2.9]; // world width (24h), height scale, depth (7 days)
  function terrainLines(gl) {
    const [W, , D] = T_SIZE, p = [], c = [];
    const seg = (x0, z0, x1, z1, a) => { p.push(x0, 0.001, z0, x1, 0.001, z1); c.push(0.85, 0.9, 1, a, 0.85, 0.9, 1, a); };
    const m = 0.1, L = -W / 2 - m, R = W / 2 + m, B = -D / 2 - m, F = D / 2 + m;
    seg(L, B, R, B, 0.14); seg(R, B, R, F, 0.14); seg(R, F, L, F, 0.3); seg(L, F, L, B, 0.3);
    for (let h = 0; h <= 24; h++) { const x = (h / 24 - 0.5) * W, len = h % 6 === 0 ? 0.16 : 0.07; seg(x, F, x, F + len, h % 6 === 0 ? 0.5 : 0.25); }
    for (let d = 0; d <= 7; d++) { const z = (d / 7 - 0.5) * D; seg(L, z, L - 0.1, z, 0.35); }
    const shadow = [], sc = [], S2 = [W / 2 * 1.25, D / 2 * 1.6];
    const q = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const [x, z] of q) { shadow.push(x * S2[0], -0.002, z * S2[1]); sc.push(x, z, 0, 0); }
    return { lines: vao(gl, [[0, 3, new Float32Array(p)], [1, 4, new Float32Array(c)]]), shadow: vao(gl, [[0, 3, new Float32Array(shadow)], [1, 4, new Float32Array(sc)]]) };
  }
  function cubeMesh(gl) {
    const P = [], N = [], U = [], F = [];
    const face = (verts, n, uvs, f) => { for (const i of [0, 1, 2, 0, 2, 3]) { P.push(...verts[i]); N.push(...n); U.push(...uvs[i]); F.push(f); } };
    const e = 0.5;
    face([[-e, 1, -e], [e, 1, -e], [e, 1, e], [-e, 1, e]], [0, 1, 0], [[0, 1], [1, 1], [1, 0], [0, 0]], 0);
    face([[-e, 0, e], [e, 0, e], [e, 1, e], [-e, 1, e]], [0, 0, 1], [[0, .02], [1, .02], [1, .02], [0, .02]], 1);
    face([[e, 0, -e], [-e, 0, -e], [-e, 1, -e], [e, 1, -e]], [0, 0, -1], [[1, .98], [0, .98], [0, .98], [1, .98]], 1);
    face([[e, 0, e], [e, 0, -e], [e, 1, -e], [e, 1, e]], [1, 0, 0], [[.98, 0], [.98, 1], [.98, 1], [.98, 0]], 1);
    face([[-e, 0, -e], [-e, 0, e], [-e, 1, e], [-e, 1, -e]], [-1, 0, 0], [[.02, 1], [.02, 0], [.02, 0], [.02, 1]], 1);
    return vao(gl, [[0, 3, new Float32Array(P)], [1, 3, new Float32Array(N)], [2, 2, new Float32Array(U)], [3, 1, new Float32Array(F)]]);
  }

  function initGL() {
    if (G) return G;
    const c = document.createElement('canvas'); c.width = c.height = 2;
    const gl = c.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true, preserveDrawingBuffer: true });
    if (!gl) return null;
    try {
      G = {
        c, gl,
        terrain: Fx3D.program(gl, TERRAIN_VS, TERRAIN_FS), flat: Fx3D.program(gl, FLAT_VS, FLAT_FS), bar: Fx3D.program(gl, BAR_VS, BAR_FS),
        tMesh: terrainMesh(gl), tExtra: terrainLines(gl), cube: cubeMesh(gl), tex: new Map(), aniso: gl.getExtension('EXT_texture_filter_anisotropic')
      };
      const fl = []; const X = 7, Z = 2.4;
      for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) fl.push(x * X, 0, z * Z);
      G.floor = vao(gl, [[0, 3, new Float32Array(fl)], [1, 4, new Float32Array(24)]]);
      G.floorExt = [X, Z];
    } catch (err) { console.error('StatsViz GL', err); gl.getExtension('WEBGL_lose_context')?.loseContext(); G = null; }
    return G;
  }
  function destroyGL() {
    if (!G) return;
    G.gl.getExtension('WEBGL_lose_context')?.loseContext();
    G = null;
  }
  function coverTex(id, url) {
    if (!G || !url) return null;
    if (G.tex.has(id)) return G.tex.get(id);
    const rec = { t: null };
    G.tex.set(id, rec);
    const img = new Image(); img.decoding = 'async';
    const gen = G;
    img.onload = () => {
      if (G !== gen) return;
      const gl = G.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (G.aniso) gl.texParameterf(gl.TEXTURE_2D, G.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      rec.t = t;
      if (inst) inst.B.dirty = true;
    };
    img.src = artUrl(url, ART_SM * 2);
    return rec;
  }
  // make sure the shared canvas can hold a w×h viewport, set it up, return blit fn
  function beginView(w, h) {
    const gl = G.gl, c = G.c;
    if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return ctx => { ctx.clearRect(0, 0, w, h); ctx.drawImage(c, 0, c.height - h, w, h, 0, 0, w, h); };
  }
  const draw = (gl, m, mode) => { gl.bindVertexArray(m.v); if (m.indexed) gl.drawElements(mode ?? gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0); else gl.drawArrays(mode ?? gl.TRIANGLES, 0, m.count); };

  /* ---------- odometer ---------- */
  const STRIP = Array.from({ length: 30 }, (_, i) => `<span>${i % 10}</span>`).join('');
  const LH = 1.08; // em per digit row, matches .odo-d height in stats.css
  function odometer(node, value, suffix) {
    value = Math.max(0, Math.round(value));
    const str = value.toLocaleString('en-US');
    const prev = node._odo;
    node._odo = value;
    node.setAttribute('aria-label', str + (suffix || ''));
    const cells = [...str];
    const rebuild = prev == null || prev.toLocaleString('en-US').length !== str.length;
    if (rebuild) {
      node.innerHTML = cells.map(ch => /\d/.test(ch) ? `<span class="odo-d" aria-hidden="true"><span class="odo-s">${STRIP}</span></span>` : `<span class="odo-sep" aria-hidden="true">${ch}</span>`).join('');
    }
    const prevStr = rebuild ? null : prev.toLocaleString('en-US');
    const strips = node.querySelectorAll('.odo-s');
    let di = 0;
    cells.forEach((ch, ci) => {
      if (!/\d/.test(ch)) return;
      const s = strips[di++], d = +ch, fromRight = strips.length - di;
      let from, to;
      if (rebuild) { from = 0; to = (fromRight === 0 ? 20 : 10) + d; }
      else {
        const pd = +prevStr[ci];
        if (pd === d && prevStr.slice(0, ci) === str.slice(0, ci)) { from = to = 10 + d; }
        else if (value >= prev) { from = pd; to = 10 + d; }
        else { from = 20 + pd; to = 10 + d; }
      }
      s._a?.cancel();
      const fin = `translateY(${-to * LH}em)`;
      s.style.transform = fin;
      if (rm() || from === to) return;
      // lower digits travel further, so give them a longer spring: the number settles left to right
      s._a = Motion.animate(s, [{ transform: `translateY(${-from * LH}em)` }, { transform: fin }],
        { spring: { response: 0.75 + fromRight * 0.14, damping: 0.8 }, delay: ci * 45, fill: 'backwards' });
    });
  }

  /* ---------- markup ---------- */
  const tabsHTML = range => `<div class="sv-tabs" role="tablist" aria-label="Range" style="--n:${RANGES.length};--i:${Math.max(0, RANGES.findIndex(r => r[0] === range))}">
      ${RANGES.map(([r, l]) => `<button class="sv-tab ${r === range ? 'on' : ''}" role="tab" aria-selected="${r === range}" data-action="stats-range" data-range="${r}">${l}</button>`).join('')}
    </div>`;
  function shellHTML() {
    const panel = (cls, eyebrow, title, desc, body, extra = '') => `<section class="sv-panel ${cls}" aria-label="${title}">
      <header class="sv-ph"><div><div class="sv-eyebrow">${eyebrow}</div><h2 class="sv-title">${title}</h2><p class="sv-desc">${desc}</p></div>${extra}</header>${body}</section>`;
    const kpi = (key, label) => `<div class="sv-kpi" data-kpi="${key}"><div class="sv-kpi-lbl">${label}</div><div class="sv-odo" role="img" data-odo="${key}"></div><div class="sv-kpi-cap" data-cap="${key}">&nbsp;</div></div>`;
    return `
    <div class="sv-kpis">${kpi('minutes', 'Minutes listened')}${kpi('plays', 'Plays')}${kpi('songs', 'Different songs')}${kpi('days', 'Days with music')}</div>
    <div class="sv-row sv-row-a">
      ${panel('sv-terrain', 'Weekly rhythm', 'When you listen', 'Plays per hour of each weekday. Drag to turn, hover a cell for the exact count.',
        `<div class="sv-stage" tabindex="0" aria-describedby="svTerrainTable"><canvas></canvas><div class="sv-labels" aria-hidden="true"></div><div class="sv-tip" hidden></div></div><div class="sv-sr" id="svTerrainTable"></div>`,
        `<div class="sv-ramp" aria-hidden="true"><span>0</span><i></i><span data-max>0</span></div>`)}
      ${panel('sv-clock', 'Daily cycle', 'Around the clock', 'Minutes listened in each hour of the day.',
        `<div class="sv-stage"><svg viewBox="-172 -172 344 344" role="img"></svg><div class="sv-tip" hidden></div></div><div class="sv-sr"></div>`)}
    </div>
    ${panel('sv-stream', 'Flow', 'What you played, over time', 'Minutes per release, from your first play in the range. Hover a stream to follow it.',
      `<div class="sv-stage"><svg role="img" preserveAspectRatio="none"></svg><div class="sv-cross" hidden></div><div class="sv-tip" hidden></div></div><div class="sv-axis" aria-hidden="true"></div><div class="sv-slegend"></div><div class="sv-sr"></div>`)}
    <div class="sv-row sv-row-b">
      ${panel('sv-bars', 'Rotation', 'Top releases', 'Minutes listened, most played first.',
        `<div class="sv-stage"><canvas role="img"></canvas><div class="sv-labels"></div><div class="sv-tip" hidden></div></div><div class="sv-sr"></div>`)}
      <section class="sv-panel sv-songs" aria-label="Top songs"><header class="sv-ph"><div><div class="sv-eyebrow">Heavy rotation</div><h2 class="sv-title">Top songs</h2></div></header><div class="sv-songs-body"></div></section>
    </div>`;
  }

  /* ---------- tooltip ---------- */
  function tip(node, x, y, rows, stageW) {
    node.replaceChildren();
    for (const r of rows) {
      const line = el('div', 'sv-tip-row' + (r.lead ? ' lead' : ''));
      if (r.key) { const k = el('i', 'sv-key'); k.style.background = r.key; line.append(k); }
      line.append(el('b', null, r.v));
      if (r.l) line.append(el('span', null, r.l));
      node.append(line);
    }
    node.hidden = false;
    const flip = x > stageW * 0.62;
    node.style.transform = `translate(${Math.round(x + (flip ? -14 : 14))}px, ${Math.round(y - 12)}px) translate(${flip ? '-100%' : '0'}, -100%)`;
  }

  /* ---------- terrain ---------- */
  function terrainCPU(g, u, v) { // same bicubic as the vertex shader, for picking
    const G2 = (i, j) => g[clamp(j, 0, 6) * 24 + ((i % 24) + 24) % 24];
    const cr = (a, b, c, d, t) => b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
    const x = u - 0.5, y = v - 0.5, bx = Math.floor(x), by = Math.floor(y), fx = x - bx, fy = y - by;
    const r = [0, 1, 2, 3].map(k => cr(G2(bx - 1, by - 1 + k), G2(bx, by - 1 + k), G2(bx + 1, by - 1 + k), G2(bx + 2, by - 1 + k), fx));
    return Math.max(0, cr(r[0], r[1], r[2], r[3], fy));
  }
  function makeTerrain(panel) {
    const stage = panel.querySelector('.sv-stage'), canvas = stage.querySelector('canvas'), labels = stage.querySelector('.sv-labels'), tipEl = stage.querySelector('.sv-tip');
    const T = {
      panel, stage, canvas, ctx: canvas.getContext('2d'), tipEl, w: 0, h: 0, dpr: 1,
      cur: new Float32Array(168), from: new Float32Array(168), to: new Float32Array(168),
      yaw: 0, pitch: 0.68, auto: 0, drag: null, idleAt: performance.now() - 2500, hover: null, cam: null, dirty: true, lastDraw: 0, data: null, visible: false, acc: [106, 165, 255]
    };
    const dayL = DAYS.map(d => { const s = el('span', 'sv-tl day', d); labels.append(s); return s; });
    const hourL = [0, 3, 6, 9, 12, 15, 18, 21].map(h => { const s = el('span', 'sv-tl hour' + (h % 6 ? ' minor' : ''), pad2(h)); labels.append(s); return s; });

    T.setData = (m, animate, delay) => {
      T.data = m;
      T.from.set(T.cur); T.to.set(m.grid.height);
      morph(T, p => { for (let i = 0; i < 168; i++) T.cur[i] = lerp(T.from[i], T.to[i], p); T.dirty = true; }, { animate, delay });
      panel.querySelector('[data-max]').textContent = plural(m.grid.maxPlays, 'play');
      const tbl = panel.querySelector('.sv-sr');
      const rows = DAYS_LONG.map((d, j) => {
        let tot = 0, best = 0; for (let i = 0; i < 24; i++) { tot += m.grid.plays[j * 24 + i]; if (m.grid.plays[j * 24 + i] > m.grid.plays[j * 24 + best]) best = i; }
        return `<tr><th scope="row">${d}</th><td>${tot}</td><td>${tot ? pad2(best) + ':00' : '–'}</td></tr>`;
      }).join('');
      tbl.innerHTML = `<table><caption>Plays by weekday</caption><thead><tr><th scope="col">Day</th><th scope="col">Plays</th><th scope="col">Busiest hour</th></tr></thead><tbody>${rows}</tbody></table>`;
      T.dirty = true;
      if (T.hover) T.showTip();
    };
    T.camera = now => {
      const asp = T.w / Math.max(1, T.h), fovy = 0.34, target = [-0.2, 0.25, 0.2];
      const sway = rm() ? 0 : 0.3, yaw = T.yaw + (rm() ? 0 : Math.sin(T.auto) * sway);
      // fit the distance once per size/drag, for the widest yaw of the sway, so the slab
      // and its axis labels never leave the frame and the zoom doesn't breathe
      const key = `${T.w}|${T.h}|${T.yaw.toFixed(3)}|${T.pitch.toFixed(3)}|${sway}`;
      if (key !== T.fitKey) {
        const [W, HS, D] = T_SIZE, corners = boxCorners(-W / 2 - 0.55, W / 2 + 0.1, 0, HS, -D / 2 - 0.1, D / 2 + 0.45);
        T.fitR = Math.max(...[-0.6, 0, 0.6].map(k => fitDistance(corners, orbitDir(T.yaw + k * sway, T.pitch), target, fovy, asp, 0.98, 0.92)));
        T.fitKey = key;
      }
      const d = orbitDir(yaw, T.pitch), R = T.fitR;
      T.cam = camera([target[0] + d[0] * R, target[1] + d[1] * R, target[2] + d[2] * R], target, fovy, asp);
    };
    T.render = now => {
      if (!T.w || !G) return;
      const gl = G.gl, dw = Math.round(T.w * T.dpr), dh = Math.round(T.h * T.dpr);
      if (canvas.width !== dw || canvas.height !== dh) { canvas.width = dw; canvas.height = dh; }
      T.camera(now);
      const blit = beginView(dw, dh), acc = T.acc;
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(G.flat.p); gl.uniformMatrix4fv(G.flat.u.uVP, false, T.cam.vp);
      gl.uniform1i(G.flat.u.uMode, 1); draw(gl, G.tExtra.shadow);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      const p = G.terrain, u = p.u; gl.useProgram(p.p);
      gl.uniformMatrix4fv(u.uVP, false, T.cam.vp);
      gl.uniform1fv(u['uG[0]'], T.cur);
      gl.uniform3fv(u.uSize, T_SIZE); gl.uniform3fv(u.uEye, T.cam.eye);
      const c = v => v.map(x => x / 255);
      gl.uniform3fv(u.uLo, c(SURFACE.map(v => v * 0.9))); gl.uniform3fv(u.uMid, c(mixRGB(SURFACE, acc, 0.62))); gl.uniform3fv(u.uHi, c(mixRGB(acc, [236, 244, 255], 0.35)));
      gl.uniform3f(u.uHover, T.hover ? T.hover[0] : -9, T.hover ? T.hover[1] : -9, T.hover ? 1 : 0);
      gl.uniform1f(u.uLevels, 8);
      draw(gl, G.tMesh);
      gl.useProgram(G.flat.p); gl.uniform1i(G.flat.u.uMode, 0);
      draw(gl, G.tExtra.lines, gl.LINES);
      blit(T.ctx);
      // project the axis labels
      const [W, , D] = T_SIZE, cam = T.cam;
      dayL.forEach((s, j) => { const [x, y] = project(cam, T.w, T.h, -W / 2 - 0.34, 0, (j + 0.5) / 7 * D - D / 2); s.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-100%, -50%)`; });
      hourL.forEach((s, k) => { const [x, y] = project(cam, T.w, T.h, (k * 3 / 24 - 0.5) * W, 0, D / 2 + 0.36); s.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, 0)`; });
      T.lastDraw = now; T.dirty = false;
    };
    // The idle sway runs for a while after you arrive or let go, then the
    // terrain holds still: a scene that sways forever re-renders the GL, copies
    // it and moves 31 labels 30 times a second for as long as Stats is open.
    const SWAY_FOR = 12000;
    const swaying = now => !rm() && !T.drag && now - T.idleAt > 2500 && now - T.idleAt < 2500 + SWAY_FOR;
    T.wants = now => T.visible && T.w > 0 && (T.dirty || T.drag || (swaying(now) && now - T.lastDraw > 33));
    T.step = (now, dt) => {
      if (swaying(now)) T.auto += dt * 0.11;
      T.render(now);
    };
    // picking: march the ray down through the height field's bounding slab, then bisect
    T.pick = (px, py) => {
      if (!T.cam) return null;
      const { o, d } = ray(T.cam, T.w, T.h, px, py);
      const [W, HS, D] = T_SIZE;
      const at = t => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      const hAt = p => terrainCPU(T.cur, (p[0] / W + 0.5) * 24, (p[2] / D + 0.5) * 7) * HS;
      const inside = p => Math.abs(p[0]) <= W / 2 && Math.abs(p[2]) <= D / 2;
      if (d[1] >= 0) return null;
      const tTop = (HS * 1.1 - o[1]) / d[1], tBot = -o[1] / d[1];
      let prev = tTop, hit = null;
      for (let s = 1; s <= 96; s++) {
        const t = lerp(tTop, tBot, s / 96), p = at(t);
        if (inside(p) && p[1] <= hAt(p)) { let a = prev, b = t; for (let k = 0; k < 8; k++) { const mid = (a + b) / 2, q = at(mid); if (inside(q) && q[1] <= hAt(q)) b = mid; else a = mid; } hit = at(b); break; }
        prev = t;
      }
      if (!hit) { const p = at(tBot); if (!inside(p)) return null; hit = p; }
      return [clamp(Math.floor((hit[0] / W + 0.5) * 24), 0, 23), clamp(Math.floor((hit[2] / D + 0.5) * 7), 0, 6), hit];
    };
    T.showTip = () => {
      if (!T.hover || !T.data || !T.cam) { tipEl.hidden = true; return; }
      const [i, j] = T.hover, c = j * 24 + i, [W, HS, D] = T_SIZE;
      const u = i + 0.5, v = j + 0.5, hy = terrainCPU(T.cur, u, v) * HS;
      const [x, y] = project(T.cam, T.w, T.h, (u / 24 - 0.5) * W, hy, (v / 7 - 0.5) * D);
      const n = T.data.grid.plays[c];
      tip(tipEl, x, y, [{ v: plural(n, 'play'), l: n ? hm(T.data.grid.mins[c]) : '', lead: true }, { v: DAYS_LONG[j], l: `${pad2(i)}:00–${pad2((i + 1) % 24)}:00` }], T.w);
    };
    const local = e => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    stage.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      stage.setPointerCapture(e.pointerId);
      T.drag = { x: e.clientX, y: e.clientY, yaw: T.yaw, pitch: T.pitch }; stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', e => {
      if (T.drag) {
        T.yaw = T.drag.yaw + (e.clientX - T.drag.x) * 0.006;
        T.pitch = clamp(T.drag.pitch + (e.clientY - T.drag.y) * 0.004, 0.18, 1.25);
        T.idleAt = performance.now(); T.dirty = true;
      }
      const [x, y] = local(e), h = T.pick(x, y), key = h ? h[0] + ',' + h[1] : '';
      if (key !== (T.hover ? T.hover.join(',') : '')) { T.hover = h ? [h[0], h[1]] : null; T.dirty = true; }
      T.showTip();
    });
    const end = () => { T.drag = null; T.idleAt = performance.now(); stage.classList.remove('dragging'); };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    stage.addEventListener('pointerleave', () => { if (!T.drag) { T.hover = null; tipEl.hidden = true; T.dirty = true; } });
    stage.addEventListener('keydown', e => {
      const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (e.key === 'Escape') { T.hover = null; tipEl.hidden = true; T.dirty = true; return; }
      if (!k) return;
      e.preventDefault();
      const h = T.hover || [new Date().getHours(), (new Date().getDay() + 6) % 7];
      T.hover = T.hover ? [(h[0] + k[0] + 24) % 24, clamp(h[1] + k[1], 0, 6)] : h;
      T.idleAt = performance.now(); T.dirty = true; T.render(performance.now()); T.showTip();
    });
    stage.addEventListener('focus', () => { stage.classList.add('kbd'); });
    stage.addEventListener('blur', () => { stage.classList.remove('kbd'); if (!stage.matches(':hover')) { T.hover = null; tipEl.hidden = true; T.dirty = true; } });
    return T;
  }

  /* ---------- 24h clock ---------- */
  const R0 = 50, R1 = 138;
  function sector(r0, r1, a0, a1) {
    const p = (r, a) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
    return `M${p(r0, a0)}L${p(r1, a0)}A${r1} ${r1} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 0 0 ${p(r0, a0)}Z`;
  }
  function makeClock(panel) {
    const svg = panel.querySelector('svg'), tipEl = panel.querySelector('.sv-tip'), stage = panel.querySelector('.sv-stage');
    const C = { panel, svg, cur: new Float32Array(24), from: new Float32Array(24), to: new Float32Array(24), data: null, wedges: [], hover: -1, minute: -1, acc: [106, 165, 255], visible: false };
    const rings = sv('g', { class: 'sv-rings' });
    for (const f of [0.25, 0.5, 0.75, 1]) rings.append(sv('circle', { r: R0 + (R1 - R0) * Math.sqrt(f) }));
    rings.append(sv('circle', { r: R0 - 6, class: 'inner' }));
    const ticks = sv('g', { class: 'sv-ticks' });
    for (let h = 0; h < 24; h++) {
      const a = h / 24 * TAU, major = h % 6 === 0, r = R1 + 5, r2 = r + (major ? 8 : 4);
      ticks.append(sv('line', { x1: r * Math.sin(a), y1: -r * Math.cos(a), x2: r2 * Math.sin(a), y2: -r2 * Math.cos(a), class: major ? 'major' : '' }));
      if (h % 3 === 0) { const t = sv('text', { x: (R1 + 22) * Math.sin(a), y: -(R1 + 22) * Math.cos(a), class: major ? 'major' : 'minor' }); t.textContent = pad2(h); ticks.append(t); }
    }
    const wedgeG = sv('g', { class: 'sv-wedges' });
    for (let h = 0; h < 24; h++) {
      const w = sv('path', { class: 'sv-wedge', tabindex: '0', 'data-h': h });
      w.addEventListener('pointerenter', () => C.setHover(h));
      w.addEventListener('focus', () => C.setHover(h));
      w.addEventListener('blur', () => C.setHover(-1));
      C.wedges.push(w); wedgeG.append(w);
    }
    svg.addEventListener('pointerleave', () => C.setHover(-1));
    const hand = sv('g', { class: 'sv-hand' });
    for (let k = 0; k < 14; k++) { const a0 = -(k + 1) * 0.045, a1 = -k * 0.045 + 0.002; hand.append(sv('path', { d: sector(R0 - 4, R1 + 2, a0, a1), class: 'trail', style: `opacity:${(0.2 * Math.pow(1 - k / 14, 2)).toFixed(3)}` })); }
    hand.append(sv('line', { x1: 0, y1: -(R0 - 4), x2: 0, y2: -(R1 + 12), class: 'needle' }));
    hand.append(sv('circle', { cx: 0, cy: -(R1 + 12), r: 3.2, class: 'tip' }));
    const center = sv('g', { class: 'sv-center' });
    const big = sv('text', { y: 4, class: 'big' }), small = sv('text', { y: 22, class: 'small' }), now = sv('text', { y: -22, class: 'small now' });
    center.append(now, big, small);
    const maxLbl = sv('text', { x: 6, y: -R1 + 11, class: 'max' });
    svg.append(rings, wedgeG, ticks, hand, center, maxLbl);

    C.setHover = h => {
      C.hover = h;
      C.wedges.forEach((w, i) => w.classList.toggle('hot', i === h));
      svg.classList.toggle('hovering', h >= 0);
      if (h < 0 || !C.data) { tipEl.hidden = true; return; }
      const a = (h + 0.5) / 24 * TAU, r = R0 + (R1 - R0) * C.cur[h];
      const { cx, cy, k } = C.map(), box = stage.clientWidth;
      const x = cx + r * Math.sin(a) * k, y = cy - r * Math.cos(a) * k;
      tip(tipEl, x, y, [{ v: hm(C.data.clock.hourMin[h]), lead: true, l: plural(C.data.clock.hourPlays[h], 'play') }, { v: `${pad2(h)}:00–${pad2((h + 1) % 24)}:00` }], box);
    };
    C.setData = (m, animate) => {
      C.data = m;
      const mx = Math.max(1e-6, ...m.clock.hourMin);
      C.from.set(C.cur);
      for (let h = 0; h < 24; h++) C.to[h] = Math.sqrt(m.clock.hourMin[h] / mx); // polar area: area ∝ value
      morph(C, p => { for (let h = 0; h < 24; h++) C.cur[h] = lerp(C.from[h], C.to[h], p); C.paint(); }, { animate, delay: animate && !C.painted ? 200 : 0 });
      C.painted = true;
      const pk = m.clock.peak;
      big.textContent = pk >= 0 ? pad2(pk) + ':00' : '–';
      small.textContent = pk >= 0 ? 'busiest hour' : 'no plays yet';
      maxLbl.textContent = mx > 0.5 ? hm(mx) : '';
      svg.setAttribute('aria-label', pk >= 0 ? `Listening by hour of day. Busiest hour ${pad2(pk)}:00 with ${hm(m.clock.hourMin[pk])}.` : 'Listening by hour of day: no plays in this range.');
      panel.querySelector('.sv-sr').innerHTML = `<table><caption>Minutes listened per hour</caption><thead><tr><th scope="col">Hour</th><th scope="col">Minutes</th><th scope="col">Plays</th></tr></thead><tbody>${
        Array.from({ length: 24 }, (_, h) => `<tr><th scope="row">${pad2(h)}:00</th><td>${Math.round(m.clock.hourMin[h])}</td><td>${m.clock.hourPlays[h]}</td></tr>`).join('')}</tbody></table>`;
    };
    C.paint = () => {
      const acc = C.acc;
      for (let h = 0; h < 24; h++) {
        const v = C.cur[h], a0 = h / 24 * TAU + 0.014, a1 = (h + 1) / 24 * TAU - 0.014;
        C.wedges[h].setAttribute('d', sector(R0, R0 + Math.max(1.5, (R1 - R0) * v), a0, a1));
        C.wedges[h].style.fill = rgbStr(ramp(acc, v));
      }
    };
    // viewBox → stage pixels (read on hover / minute ticks only, never per frame)
    C.map = () => { const sr = stage.getBoundingClientRect(), vr = svg.getBoundingClientRect(); return { cx: vr.left - sr.left + vr.width / 2, cy: vr.top - sr.top + vr.height / 2, k: vr.width / 344 }; };
    // the tip's sonar ping is an HTML dot (compositor-only transform/opacity loop):
    // an SVG transform animation would restyle + relayout the page every frame
    const pulse = el('i', 'sv-pulse'); stage.append(pulse);
    C.placePulse = () => {
      const { cx, cy, k } = C.map(), a = C.minute / 1440 * TAU, r = (R1 + 12) * k;
      pulse.style.left = (cx + r * Math.sin(a)).toFixed(1) + 'px'; pulse.style.top = (cy - r * Math.cos(a)).toFixed(1) + 'px';
    };
    C.tick = first => {
      const d = new Date(), m = d.getHours() * 60 + d.getMinutes();
      if (m === C.minute) return;
      C.minute = m;
      now.textContent = 'now ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      const deg = m / 1440 * 360;
      C.wedges.forEach((w, i) => w.classList.toggle('current', i === d.getHours()));
      if (first && !rm()) Motion.animate(hand, [{ transform: 'rotate(0deg)' }, { transform: `rotate(${deg}deg)` }], { spring: { response: 1.1, damping: 0.72 }, delay: 300, fill: 'backwards' });
      hand.style.transform = `rotate(${deg}deg)`;
      C.placePulse();
    };

    return C;
  }

  /* ---------- streamgraph ---------- */
  function insideOut(series) {
    const n = series.length, peaks = series.map(s => { let b = 0; for (let j = 1; j < s.length; j++) if (s[j] > s[b]) b = j; return b; });
    const sums = series.map(s => s.reduce((a, b) => a + b, 0));
    const byPeak = [...Array(n).keys()].sort((a, b) => peaks[a] - peaks[b]);
    let top = 0, bottom = 0; const tops = [], bottoms = [];
    for (const i of byPeak) { if (top < bottom) { top += sums[i]; tops.push(i); } else { bottom += sums[i]; bottoms.push(i); } }
    return bottoms.reverse().concat(tops);
  }
  // Byron & Wattenberg wiggle (as d3.stackOffsetWiggle), then centred on the axis
  function wiggle(vals, order) {
    const m = N_BUCKETS, base = new Float32Array(m);
    let y = 0;
    for (let j = 1; j < m; j++) {
      let s1 = 0, s2 = 0;
      for (let i = 0; i < order.length; i++) {
        const si = vals[order[i]], sij0 = si[j], sij1 = si[j - 1];
        let s3 = (sij0 - sij1) / 2;
        for (let k = 0; k < i; k++) { const sk = vals[order[k]]; s3 += sk[j] - sk[j - 1]; }
        s1 += sij0; s2 += s3 * sij0;
      }
      if (s1) y -= s2 / s1;
      base[j] = y;
    }
    const lo = vals.map(() => new Float32Array(m)), hi = vals.map(() => new Float32Array(m));
    let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < m; j++) {
      let acc = base[j];
      for (const i of order) { lo[i][j] = acc; acc += vals[i][j]; hi[i][j] = acc; }
      mn = Math.min(mn, base[j]); mx = Math.max(mx, acc);
    }
    const shift = -(mn + mx) / 2;
    for (let i = 0; i < vals.length; i++) for (let j = 0; j < m; j++) { lo[i][j] += shift; hi[i][j] += shift; }
    return { lo, hi, ext: Math.max(1e-6, (mx - mn) / 2) };
  }
  // Catmull-Rom through the points as cubic Béziers (uniform, tension 1/6)
  function crPath(xs, ys, reverse) {
    const n = xs.length, idx = i => reverse ? n - 1 - i : i;
    const X = i => xs[idx(clamp(i, 0, n - 1))], Y = i => ys[idx(clamp(i, 0, n - 1))];
    let d = '';
    for (let i = 0; i < n - 1; i++) {
      const c1x = X(i) + (X(i + 1) - X(i - 1)) / 6, c1y = Y(i) + (Y(i + 1) - Y(i - 1)) / 6;
      const c2x = X(i + 1) - (X(i + 2) - X(i)) / 6, c2y = Y(i + 1) - (Y(i + 2) - Y(i)) / 6;
      d += `C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${X(i + 1).toFixed(1)} ${Y(i + 1).toFixed(1)}`;
    }
    return d;
  }
  function makeStream(panel) {
    const stage = panel.querySelector('.sv-stage'), svg = stage.querySelector('svg'), tipEl = stage.querySelector('.sv-tip'), cross = stage.querySelector('.sv-cross');
    const axis = panel.querySelector('.sv-axis'), legend = panel.querySelector('.sv-slegend');
    const St = { panel, svg, w: 0, h: 0, keys: [], paths: new Map(), from: new Map(), to: new Map(), cur: new Map(), meta: new Map(), colors: new Map(), layout: null, hover: null, hoverJ: -1, data: null, visible: false };
    const g = sv('g'); svg.append(g);
    St.setData = (m, animate) => {
      St.data = m;
      const ids = m.series.map(s => s.id);
      // leaving series tween to zero, then drop
      for (const k of St.keys) if (!ids.includes(k)) { St.to.set(k, new Float32Array(N_BUCKETS)); }
      for (const s of m.series) {
        St.meta.set(s.id, s);
        if (!St.cur.has(s.id)) St.cur.set(s.id, new Float32Array(N_BUCKETS));
        St.to.set(s.id, s.values);
        if (!St.colors.has(s.id)) {
          St.colors.set(s.id, s.id === 'other' ? [74, 78, 90] : [110, 116, 130]);
          if (s.cover) vibrantColor(s.cover).then(rgb => { St.colors.set(s.id, rgb); St.paintColors(); });
        }
      }
      St.keys = [...new Set([...ids, ...St.keys])];
      for (const k of St.keys) St.from.set(k, Float32Array.from(St.cur.get(k)));
      for (const k of St.keys) if (!St.paths.has(k)) {
        const p = sv('path', { class: 'sv-s' }); p.dataset.id = k; g.append(p); St.paths.set(k, p);
      }
      morph(St, p => {
        for (const k of St.keys) { const a = St.from.get(k), b = St.to.get(k), c = St.cur.get(k); for (let j = 0; j < N_BUCKETS; j++) c[j] = lerp(a[j], b[j], p); }
        St.layoutPaint();
      }, { animate, delay: animate && !St.painted ? 350 : 0, done: () => {
        const live = new Set(St.data.series.map(s => s.id));
        St.keys = St.keys.filter(k => { if (live.has(k)) return true; St.paths.get(k)?.remove(); St.paths.delete(k); St.cur.delete(k); St.to.delete(k); St.from.delete(k); return false; });
      } });
      St.painted = true;
      // axis + legend + table
      const fmt = new Intl.DateTimeFormat('en-US', m.span <= 8 * 864e5 ? { weekday: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
      axis.replaceChildren(...[0, 0.25, 0.5, 0.75, 1].map(f => { const s = el('span', null, f === 1 ? 'Now' : fmt.format(new Date(m.t0 + f * m.span))); s.style.left = f * 100 + '%'; return s; }));
      legend.replaceChildren(...m.series.map(s => {
        const b = el('button', 'sv-lg'); b.dataset.id = s.id;
        if (s.id !== 'other') { b.dataset.action = 'open-album'; b.dataset.key = s.id; b.title = 'Open ' + s.title; }
        const art = el('span', 'sv-lg-art');
        if (s.cover) { const im = el('img'); im.src = artUrl(s.cover, ART_SM); im.alt = ''; art.append(im); }
        const total = s.values.reduce((a, b) => a + b, 0);
        b.append(art, el('span', 'sv-lg-name', s.title), el('span', 'sv-lg-val', hm(total)));
        b.addEventListener('pointerenter', () => St.setHover(s.id, -1));
        b.addEventListener('focus', () => St.setHover(s.id, -1));
        b.addEventListener('pointerleave', () => St.setHover(null, -1));
        b.addEventListener('blur', () => St.setHover(null, -1));
        return b;
      }));
      if (!m.series.length) legend.append(el('div', 'sv-empty', 'No plays in this range yet.'));
      svg.setAttribute('aria-label', m.series.length ? 'Streamgraph of minutes per release over time. Largest: ' + m.series.slice(0, 3).map(s => s.title).join(', ') + '.' : 'No listening in this range.');
      panel.querySelector('.sv-sr').innerHTML = `<table><caption>Minutes per release in this range</caption><thead><tr><th scope="col">Release</th><th scope="col">Minutes</th></tr></thead><tbody>${
        m.series.map(s => `<tr><th scope="row">${esc(s.title)}</th><td>${Math.round(s.values.reduce((a, b) => a + b, 0))}</td></tr>`).join('')}</tbody></table>`;
      St.paintColors();
    };
    St.layoutPaint = () => {
      if (!St.w) return;
      const vals = St.keys.map(k => St.cur.get(k));
      const order = insideOut(St.keys.map(k => St.to.get(k)));
      const L = wiggle(vals, order);
      const W = St.w, H = St.h, k = (H / 2 - 8) / L.ext;
      const xs = Array.from({ length: N_BUCKETS }, (_, j) => j / (N_BUCKETS - 1) * W);
      St.layout = { L, k, xs };
      St.keys.forEach((key, i) => {
        const up = Array.from(L.hi[i], v => H / 2 - v * k), dn = Array.from(L.lo[i], v => H / 2 - v * k);
        St.paths.get(key).setAttribute('d', `M${xs[0]} ${up[0].toFixed(1)}${crPath(xs, up)}L${xs[N_BUCKETS - 1]} ${dn[N_BUCKETS - 1].toFixed(1)}${crPath(xs, dn, true)}Z`);
      });
    };
    St.paintColors = () => {
      for (const [k, p] of St.paths) {
        const c = St.colors.get(k) || [110, 116, 130];
        const rest = k === 'other' ? c : mixRGB(c, [96, 100, 112], 0.35);
        const hot = St.hover === k;
        p.style.fill = rgbStr(St.hover ? (hot ? c : mixRGB(c, [40, 42, 50], 0.72)) : rest);
        p.classList.toggle('hot', hot);
      }
      for (const b of legend.querySelectorAll('.sv-lg')) {
        b.classList.toggle('hot', St.hover === b.dataset.id);
        b.style.setProperty('--c', rgbStr(St.colors.get(b.dataset.id) || [120, 124, 136]));
      }
    };
    St.setHover = (id, j) => {
      if (id !== St.hover) { St.hover = id; St.paintColors(); }
      if (j < 0 || !St.layout || !St.data) { tipEl.hidden = true; cross.hidden = true; return; }
      const x = St.layout.xs[j];
      cross.hidden = false; cross.style.transform = `translateX(${x.toFixed(1)}px)`;
      const date = new Date(St.data.t0 + (j + 0.5) / N_BUCKETS * St.data.span);
      const when = new Intl.DateTimeFormat('en-US', St.data.span <= 8 * 864e5 ? { weekday: 'short', hour: 'numeric' } : { month: 'short', day: 'numeric' }).format(date);
      const rows = St.data.series.map(s => ({ s, v: St.cur.get(s.id)[j] })).sort((a, b) => b.v - a.v);
      const out = [{ v: when, l: '', lead: false }];
      for (const { s, v } of rows.slice(0, 7)) out.push({ v: v >= 1 ? Math.round(v) + ' min' : v > 0.05 ? '<1 min' : '–', l: s.title, key: rgbStr(St.colors.get(s.id) || [120, 124, 136]), lead: s.id === id });
      const hy = id && St.layout ? (() => { const i = St.keys.indexOf(id); return St.h / 2 - St.layout.L.hi[i][j] * St.layout.k; })() : St.h * 0.3;
      tip(tipEl, x, Math.max(40, hy), out, St.w);
    };
    stage.addEventListener('pointermove', e => {
      if (!St.layout) return;
      const r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const j = clamp(Math.round(x / St.w * (N_BUCKETS - 1)), 0, N_BUCKETS - 1);
      const v = (St.h / 2 - y) / St.layout.k;
      let id = null;
      St.keys.forEach((k, i) => { if (St.data.series.some(s => s.id === k) && v >= St.layout.L.lo[i][j] && v <= St.layout.L.hi[i][j]) id = k; });
      St.setHover(id, j);
    });
    stage.addEventListener('pointerleave', () => St.setHover(null, -1));
    stage.addEventListener('click', () => { if (St.hover && St.hover !== 'other') navigate('#/album/' + St.hover); });
    St.resize = (w, h) => { St.w = w; St.h = h; svg.setAttribute('viewBox', `0 0 ${w} ${h}`); St.layoutPaint(); };
    return St;
  }

  /* ---------- 3D album bars ---------- */
  function makeBars(panel) {
    const stage = panel.querySelector('.sv-stage'), canvas = stage.querySelector('canvas'), labels = stage.querySelector('.sv-labels'), tipEl = stage.querySelector('.sv-tip');
    const B = { panel, canvas, ctx: canvas.getContext('2d'), w: 0, h: 0, dpr: 1, items: new Map(), order: [], hover: null, par: 0, parT: 0, cam: null, dirty: true, visible: false, data: null, enterAt: 0 };
    const SP = 1.3, HW = 0.47, HMAX = 2.4;
    B.setData = (m, animate) => {
      B.data = m;
      const maxMin = Math.max(1e-6, ...m.bars.map(b => b.min));
      const ids = m.bars.map(b => b.id), n = Math.max(ids.length, 1);
      const first = !B.items.size;
      for (const [id, it] of B.items) if (!ids.includes(id)) { it.th = 0; it.leaving = true; clearTimeout(it.t); it.spring.set({ h: 0, x: it.x }); }
      m.bars.forEach((b, i) => {
        let it = B.items.get(b.id);
        const x = (i - (n - 1) / 2) * SP;
        if (!it) {
          it = { id: b.id, h: 0, x, color: [120, 130, 150], label: null, value: null };
          it.spring = Motion.spring({ h: 0, x }, { spring: 'bouncy', precision: 0.003,
            onUpdate: v => { it.h = Math.max(0, v.h); it.x = v.x; B.dirty = true; },
            onRest: () => { if (it.leaving && B.items.get(it.id) === it) { it.label.remove(); it.value.remove(); B.items.delete(it.id); B.dirty = true; } } });
          vibrantColor(b.cover).then(rgb => { it.color = rgb; B.dirty = true; });
          const lab = el('button', 'sv-bl'); lab.dataset.action = 'open-album'; lab.dataset.key = b.id;
          lab.addEventListener('pointerenter', () => B.setHover(b.id));
          lab.addEventListener('focus', () => B.setHover(b.id));
          lab.addEventListener('pointerleave', () => B.setHover(null));
          lab.addEventListener('blur', () => B.setHover(null));
          const val = el('span', 'sv-bv');
          labels.append(lab, val);
          it.label = lab; it.value = val;
          B.items.set(b.id, it);
          coverTex(b.id, b.cover);
        }
        it.leaving = false; it.b = b; it.tx = x; it.th = Math.max(0.03, b.min / maxMin * HMAX); it.rank = i + 1;
        it.label.innerHTML = `<span class="sv-bl-name">${esc(b.title)}</span>`;
        it.label.setAttribute('aria-label', `${i + 1}. ${b.title}, ${hm(b.min)}`);
        it.value.textContent = hm(b.min);
        clearTimeout(it.t);
        if (!animate || rm()) it.spring.jump({ h: it.th, x: it.tx });
        else {
          // stagger the rise on first paint; later range switches retarget at once
          const delay = it.h < 0.01 ? (first ? 380 : 120) + i * 70 : 0;
          const go = () => it.spring.set({ h: it.th, x: it.tx });
          if (delay) { it.spring.jump({ h: 0, x: it.tx }); it.t = setTimeout(go, delay); } else go();
        }
      });
      B.span = n * SP; B.tick = maxMin > 180 ? 60 : maxMin > 60 ? 30 : maxMin > 20 ? 10 : 5; // minutes per etched line
      B.tickW = B.tick / maxMin * HMAX;
      B.dirty = true;
      const cv = canvas;
      cv.setAttribute('aria-label', m.bars.length ? 'Top releases by minutes: ' + m.bars.map((b, i) => `${i + 1}. ${b.title}, ${hm(b.min)}`).join('; ') : 'No releases played in this range.');
      panel.querySelector('.sv-sr').innerHTML = `<table><caption>Top releases</caption><thead><tr><th scope="col">Rank</th><th scope="col">Release</th><th scope="col">Minutes</th></tr></thead><tbody>${
        m.bars.map((b, i) => `<tr><td>${i + 1}</td><th scope="row">${esc(b.title)}</th><td>${Math.round(b.min)}</td></tr>`).join('')}</tbody></table>`;
      panel.classList.toggle('empty', !m.bars.length);
    };
    B.camera = () => {
      const asp = B.w / Math.max(1, B.h), fovy = 0.5, pitch = 0.42, target = [0, HMAX * 0.36, 0];
      const half = Math.max(B.span, 5 * SP) / 2;
      const key = `${B.w}|${B.h}|${half}`;
      if (key !== B.fitKey) { B.fitR = fitDistance(boxCorners(-half, half, -0.2, HMAX + 0.35, -HW, HW), orbitDir(-0.16, pitch), target, fovy, asp, 0.95, 0.78); B.fitKey = key; }
      const d = orbitDir(-0.16 + B.par * 0.08, pitch), R = B.fitR;
      B.cam = camera([d[0] * R, target[1] + d[1] * R, d[2] * R], target, fovy, asp);
    };
    B.setHover = id => {
      if (B.hover === id) return;
      B.hover = id; B.dirty = true;
      for (const it of B.items.values()) it.label.classList.toggle('hot', it.id === id);
      if (!id) tipEl.hidden = true;
    };
    B.wants = now => B.visible && B.w > 0 && (B.dirty || B.moving || Math.abs(B.par - B.parT) > 0.002);
    B.stop = () => { for (const it of B.items.values()) { clearTimeout(it.t); it.spring.stop(); } };
    B.step = (now, dt) => {
      let moving = false;
      if (!rm()) B.par += (B.parT - B.par) * Math.min(1, dt * 5); else B.par = 0;
      for (const [id, it] of B.items) {
        it.hot = lerp(it.hot || 0, B.hover === id ? 1 : 0, rm() ? 1 : Math.min(1, dt * 12));
        if (Math.abs(it.hot - (B.hover === id ? 1 : 0)) > 0.01) moving = true;
      }
      B.moving = moving;
      B.render();
    };
    B.render = () => {
      if (!B.w || !G) return;
      const gl = G.gl, dw = Math.round(B.w * B.dpr), dh = Math.round(B.h * B.dpr);
      if (canvas.width !== dw || canvas.height !== dh) { canvas.width = dw; canvas.height = dh; }
      B.camera();
      const blit = beginView(dw, dh), cam = B.cam, items = [...B.items.values()];
      // floor
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(G.flat.p); gl.uniformMatrix4fv(G.flat.u.uVP, false, cam.vp); gl.uniform1i(G.flat.u.uMode, 2);
      const ub = new Float32Array(32), uc = new Float32Array(24);
      items.slice(0, 8).forEach((it, i) => { ub.set([it.x, 0, HW, Math.max(0, it.h)], i * 4); uc.set(it.color.map(v => v / 255), i * 3); });
      gl.uniform4fv(G.flat.u['uB[0]'], ub); gl.uniform3fv(G.flat.u['uBC[0]'], uc);
      gl.uniform2f(G.flat.u.uExt, Math.max(B.span / 2 + 1.2, 3), G.floorExt[1]);
      draw(gl, G.floor);
      // bars
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      const p = G.bar, u = p.u; gl.useProgram(p.p);
      gl.uniformMatrix4fv(u.uVP, false, cam.vp); gl.uniform3fv(u.uEye, cam.eye); gl.uniform1i(u.uTex, 0); gl.uniform1f(u.uTick, B.tickW || 1);
      gl.activeTexture(gl.TEXTURE0);
      for (const it of items) {
        const h = Math.max(0.0, it.h); if (h <= 0.001) continue;
        const rec = G.tex.get(it.id);
        gl.bindTexture(gl.TEXTURE_2D, rec && rec.t);
        gl.uniform1f(u.uHasTex, rec && rec.t ? 1 : 0);
        gl.uniform3f(u.uBar, it.x, h, HW); gl.uniform1f(u.uH, h);
        gl.uniform3fv(u.uCol, it.color.map(v => v / 255)); gl.uniform1f(u.uHot, it.hot || 0);
        draw(gl, G.cube);
      }
      blit(B.ctx);
      // HTML labels: name under the front edge, value above the top cap
      const slot = items.length > 1 ? Math.abs(project(cam, B.w, B.h, SP, 0, HW)[0] - project(cam, B.w, B.h, 0, 0, HW)[0]) : 110;
      const labW = Math.max(44, Math.min(130, slot - 4));
      let baseY = 0;
      for (const it of items) baseY = Math.max(baseY, project(cam, B.w, B.h, it.x, 0, HW)[1]);
      for (const it of items) {
        const [x] = project(cam, B.w, B.h, it.x, 0, HW), y = baseY + 4;
        const [vx, vy] = project(cam, B.w, B.h, it.x, Math.max(0, it.h), -HW * 0.2);
        const a = clamp(it.h / Math.max(0.03, it.th || 0.03), 0, 1);
        it.label.style.width = labW + 'px';
        it.label.style.transform = `translate(${x.toFixed(1)}px, ${(y + 6).toFixed(1)}px) translateX(-50%)`;
        it.value.style.transform = `translate(${vx.toFixed(1)}px, ${(vy - 12).toFixed(1)}px) translate(-50%, -100%)`;
        it.value.style.opacity = it.leaving ? 0 : a.toFixed(2);
        it.label.style.opacity = it.leaving ? 0 : 1;
      }
      B.dirty = false;
      if (B.hover && B.items.get(B.hover)) {
        const it = B.items.get(B.hover), [x, y] = project(cam, B.w, B.h, it.x + HW, it.h, 0);
        tip(tipEl, x, y, [{ v: hm(it.b.min), lead: true, l: '#' + it.rank }, { v: it.b.title, l: it.b.year ? String(it.b.year) : '' }], B.w);
      }
    };
    const pick = (px, py) => {
      if (!B.cam) return null;
      const { o, d } = ray(B.cam, B.w, B.h, px, py);
      let best = null, bt = Infinity;
      for (const it of B.items.values()) {
        if (it.leaving) continue;
        const mn = [it.x - HW, 0, -HW], mx = [it.x + HW, Math.max(it.h, 0.2), HW];
        let t0 = -Infinity, t1 = Infinity;
        for (let a = 0; a < 3; a++) {
          if (Math.abs(d[a]) < 1e-9) { if (o[a] < mn[a] || o[a] > mx[a]) { t0 = Infinity; break; } continue; }
          let ta = (mn[a] - o[a]) / d[a], tb = (mx[a] - o[a]) / d[a]; if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        }
        if (t0 <= t1 && t0 < bt) { bt = t0; best = it.id; }
      }
      return best;
    };
    stage.addEventListener('pointermove', e => {
      if (e.target.closest('.sv-bl')) return;
      const r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      B.parT = clamp(x / B.w * 2 - 1, -1, 1);
      B.setHover(pick(x, y));
      stage.classList.toggle('pointing', !!B.hover);
    });
    stage.addEventListener('pointerleave', () => { B.parT = 0; B.setHover(null); });
    stage.addEventListener('click', e => { if (!e.target.closest('.sv-bl') && B.hover) navigate('#/album/' + B.hover); });
    return B;
  }

  /* ---------- instance ---------- */
  let inst = null;
  function teardown() {
    if (!inst) return;
    inst.unhook(); inst.io.disconnect(); inst.ro.disconnect();
    stopMorph(inst.T); stopMorph(inst.C); stopMorph(inst.St); inst.B.stop();
    inst = null;
    destroyGL();
  }

  function setKpis(page, m, animate) {
    const k = m.kpi;
    const cap = (key, t) => { const n = page.querySelector(`[data-cap="${key}"]`); if (n) n.textContent = t; };
    const set = (key, v, suf) => { const n = page.querySelector(`[data-odo="${key}"]`); if (!n) return; if (!animate) n._odo = null; odometer(n, v, suf); };
    set('minutes', k.minutes, ' minutes'); set('plays', k.plays, ' plays'); set('songs', k.songs, ' songs'); set('days', k.days, ' days');
    cap('minutes', k.minutes >= 60 ? hm(k.minutes) + ' of music' : 'of music');
    cap('plays', k.days ? `${Math.round(k.plays / k.days)} a day when you listen` : 'nothing yet');
    cap('songs', `across ${plural(k.releases, 'release')}`);
    const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
    const rangeDays = { '7d': 7, '30d': 30, '90d': 90 }[m.range];
    cap('days', rangeDays ? `out of the last ${rangeDays}` : k.first ? 'since ' + fmt.format(new Date(k.first)) : 'nothing yet');
  }

  function mount(page, st, ev, range) {
    teardown();
    const m = shape(st, ev, range);
    initGL();
    const q = s => page.querySelector(s);
    const T = makeTerrain(q('.sv-terrain')), C = makeClock(q('.sv-clock')), St = makeStream(q('.sv-stream')), B = makeBars(q('.sv-bars'));
    const acc = accentRGB(); T.acc = C.acc = acc;
    page.style.setProperty('--sv-acc', acc.join(','));
    const entering = 'enter' in (document.getElementById('content')?.dataset || {});
    const animate = !rm();
    inst = { page, T, C, St, B, range };
    T.setData(m, animate, 250);
    C.setData(m, animate); St.setData(m, animate); B.setData(m, animate);
    setKpis(page, m, animate);
    C.tick(true);
    const dpr = big => Math.min(window.devicePixelRatio || 1, big ? 1.5 : 1.5);
    inst.ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width: w, height: h } = e.contentRect, t = e.target;
        if (t === T.stage) { T.w = w; T.h = h; T.dpr = dpr(true); T.dirty = true; }
        else if (t === St.svg.parentNode) St.resize(w, h);
        else if (t === C.svg.parentNode) C.placePulse();
        else if (t === B.canvas.parentNode) { B.w = w; B.h = h; B.dpr = dpr(true); B.dirty = true; }
      }
    });
    [T.stage, St.svg.parentNode, B.canvas.parentNode, C.svg.parentNode].forEach(n => inst.ro.observe(n));
    inst.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const v = e.isIntersecting;
        if (e.target === T.panel) { T.visible = v; if (v) T.dirty = true; }
        else if (e.target === C.panel) { C.visible = v; C.panel.classList.toggle('offscreen', !v); }
        else if (e.target === St.panel) St.visible = v;
        else if (e.target === B.panel) { B.visible = v; if (v) B.dirty = true; }
      }
    });
    [T.panel, C.panel, St.panel, B.panel].forEach(n => inst.io.observe(n));
    let lastClock = 0;
    inst.unhook = Fx3D.onFrame((now, dt) => {
      if (!inst || !page.isConnected) { teardown(); return; }
      if (T.wants(now)) T.step(now, dt);
      if (B.wants(now)) B.step(now, dt);
      if (now - lastClock > 15000) { lastClock = now; C.tick(false); }
    }, {
      fps: 60,
      visible: () => {
        if (!inst) return false;
        if (!page.isConnected) { queueMicrotask(teardown); return false; }
        const now = performance.now();
        return T.wants(now) || B.wants(now) || now - lastClock > 15000;
      }
    });
    void entering;
  }

  function update(page, st, ev, range) {
    if (!inst || inst.page !== page) return mount(page, st, ev, range);
    const m = shape(st, ev, range);
    inst.range = range;
    const animate = !rm();
    const acc = accentRGB(); inst.T.acc = inst.C.acc = acc;
    inst.T.setData(m, animate); inst.C.setData(m, animate); inst.St.setData(m, animate); inst.B.setData(m, animate);
    setKpis(page, m, animate);
    const tabs = page.querySelector('.sv-tabs');
    const i = RANGES.findIndex(r => r[0] === range);
    tabs.style.setProperty('--i', Math.max(0, i));
    for (const b of tabs.querySelectorAll('.sv-tab')) { const on = b.dataset.range === range; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
  }

  // remember the chosen range, so an in-place re-render of #/stats keeps it
  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('[data-action="stats-range"]');
    if (t) S.statsRange = t.dataset.range;
  }, true);

  return { tabsHTML, shellHTML, mount, update, teardown, get active() { return !!inst; }, get glLive() { return !!G; }, _shape: shape };
})();
