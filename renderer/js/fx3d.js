/* fx3d.js — hand-rolled 3D for the chrome: meshes, rotation matrices,
   perspective projection and a canvas-2D wireframe renderer.
   No WebGL or three.js: a few hundred projected vertices per scene is plenty,
   and it keeps the page CSP (script-src 'self') free of third-party code.
   Every scene shares one rAF ticker and one audio analysis pass, and a
   scene quietly unregisters itself once its canvas leaves the document. */

const Fx3D = (() => {
  const TAU = Math.PI * 2;
  const PHI = (1 + Math.sqrt(5)) / 2;
  const systemReduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // follows the OS until Settings > Reduce motion overrides it (setReduceMotion)
  let reduceMotion = systemReduceMotion;

  /* ---------- vector helpers ---------- */

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // Rz · Rx · Ry as a flat 3x3, so projecting a vertex is nine multiplies
  function rotation(ax, ay, az) {
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    const rxy = [cy, 0, sy, sx * sy, cx, -sx * cy, -cx * sy, sx, cx * cy];
    return [
      cz * rxy[0] - sz * rxy[3], cz * rxy[1] - sz * rxy[4], cz * rxy[2] - sz * rxy[5],
      sz * rxy[0] + cz * rxy[3], sz * rxy[1] + cz * rxy[4], sz * rxy[2] + cz * rxy[5],
      rxy[6], rxy[7], rxy[8]
    ];
  }

  /* ---------- meshes: { v: [[x,y,z]...], e: [[i,j]...] }, roughly unit radius ---------- */

  function edgesOf(faces) {
    const seen = new Set(), e = [];
    for (const f of faces) {
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const k = a < b ? a * 65536 + b : b * 65536 + a;
        if (!seen.has(k)) { seen.add(k); e.push([a, b]); }
      }
    }
    return e;
  }

  function icosahedron() {
    const v = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]].map(norm);
    const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    return { v, f };
  }

  // Loop subdivision of the icosahedron, pushed back onto the unit sphere:
  // level 1 = 42 vertices, 2 = 162, 3 = 642.
  function geodesic(level = 2) {
    let { v, f } = icosahedron();
    for (let l = 0; l < level; l++) {
      const cache = new Map(), next = [];
      const mid = (a, b) => {
        const k = a < b ? a * 65536 + b : b * 65536 + a;
        if (!cache.has(k)) { v.push(norm(mul(add(v[a], v[b]), 0.5))); cache.set(k, v.length - 1); }
        return cache.get(k);
      };
      for (const [a, b, c] of f) {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      f = next;
    }
    return { v, e: edgesOf(f) };
  }

  // (p,q) torus knot swept into a tube. Frames come from parallel transport
  // (no Frenet flips at inflection points), and the leftover twist where the
  // loop closes is spread evenly along the curve so the seam lines up.
  function torusKnot(p = 2, q = 3, seg = 150, sides = 7, tube = 0.085) {
    const curve = t => { const r = 0.62 + 0.26 * Math.cos(q * t); return [r * Math.cos(p * t), r * Math.sin(p * t), 0.3 * Math.sin(q * t)]; };
    const pts = [], tan = [];
    for (let i = 0; i < seg; i++) pts.push(curve(i / seg * TAU));
    for (let i = 0; i < seg; i++) tan.push(norm(sub(pts[(i + 1) % seg], pts[(i - 1 + seg) % seg])));
    const normals = [];
    let n = norm(cross(tan[0], Math.abs(tan[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    for (let i = 0; i < seg; i++) {
      n = norm(sub(n, mul(tan[i], dot(n, tan[i]))));
      normals.push(n);
    }
    const nEnd = norm(sub(n, mul(tan[0], dot(n, tan[0]))));
    const twist = Math.atan2(dot(normals[0], cross(tan[0], nEnd)), dot(normals[0], nEnd));
    const v = [], e = [];
    for (let i = 0; i < seg; i++) {
      const N = normals[i], B = cross(tan[i], N), off = twist * i / seg;
      for (let j = 0; j < sides; j++) {
        const a = j / sides * TAU + off;
        v.push(add(pts[i], add(mul(N, Math.cos(a) * tube), mul(B, Math.sin(a) * tube))));
        const idx = i * sides + j;
        e.push([idx, i * sides + (j + 1) % sides], [idx, ((i + 1) % seg) * sides + j]);
      }
    }
    return { v, e };
  }

  function torus(R = 0.72, r = 0.26, seg = 44, sides = 14) {
    const v = [], e = [];
    for (let i = 0; i < seg; i++) {
      const u = i / seg * TAU;
      for (let j = 0; j < sides; j++) {
        const w = j / sides * TAU;
        v.push([(R + r * Math.cos(w)) * Math.cos(u), (R + r * Math.cos(w)) * Math.sin(u), r * Math.sin(w)]);
        const idx = i * sides + j;
        e.push([idx, i * sides + (j + 1) % sides], [idx, ((i + 1) % seg) * sides + j]);
      }
    }
    return { v, e };
  }

  // Evenly spread points via the golden angle: no clumping at the poles.
  function fibonacciSphere(n = 220) {
    const v = [], golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), th = i * golden;
      v.push([Math.cos(th) * r, y, Math.sin(th) * r]);
    }
    return { v, e: [] };
  }

  const MESHES = { geodesic: () => geodesic(2), ico: () => geodesic(0), knot: () => torusKnot(), torus: () => torus(), particles: () => fibonacciSphere() };
  const meshCache = new Map();
  const mesh = name => { if (!meshCache.has(name)) meshCache.set(name, (MESHES[name] || MESHES.geodesic)()); return meshCache.get(name); };

  /* ---------- solid meshes for WebGL: interleaved triangles, pos3 normal3 wire3 ---------- */

  // Each coarse geodesic face is split into sub² smooth triangles that carry
  // the parent face's barycentrics, so the shader can draw the coarse lattice
  // as crisp glowing lines on top of a round surface. flat = faceted gem.
  function solidGeodesic(level, sub, flat) {
    let { v, f } = icosahedron();
    for (let l = 0; l < level; l++) {
      const cache = new Map(), next = [];
      const mid = (a, b) => {
        const k = a < b ? a * 65536 + b : b * 65536 + a;
        if (!cache.has(k)) { v.push(norm(mul(add(v[a], v[b]), 0.5))); cache.set(k, v.length - 1); }
        return cache.get(k);
      };
      for (const [a, b, c] of f) {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      f = next;
    }
    const out = [];
    for (const [ia, ib, ic] of f) {
      const A = v[ia], B = v[ib], C = v[ic];
      let fn = norm(cross(sub3(B, A), sub3(C, A)));
      if (dot(fn, add(add(A, B), C)) < 0) fn = mul(fn, -1);
      const at = (i, j) => {
        const b = i / sub, c = j / sub, a = 1 - b - c;
        const p = add(add(mul(A, a), mul(B, b)), mul(C, c));
        const pos = flat ? p : norm(p);
        return [...pos, ...(flat ? fn : pos), a, b, c];
      };
      for (let i = 0; i < sub; i++) {
        for (let j = 0; j < sub - i; j++) {
          out.push(...at(i, j), ...at(i + 1, j), ...at(i, j + 1));
          if (i + j < sub - 1) out.push(...at(i + 1, j), ...at(i + 1, j + 1), ...at(i, j + 1));
        }
      }
    }
    return { data: new Float32Array(out), count: out.length / 9, nodes: flat ? [] : v, grid: false, smooth: !flat, flat };
  }
  const sub3 = sub;

  // A tube swept along frames; wire.xy is a continuous grid coordinate
  // (rings along the curve, stripes around it) that the shader turns into lines.
  function sweep(seg, sides, frame, radius, every) {
    const ring = (i, j) => {
      const fr = frame(i % seg), a = j / sides * TAU + fr.off;
      const n = add(mul(fr.N, Math.cos(a)), mul(fr.B, Math.sin(a)));
      return [...add(fr.p, mul(n, radius)), ...n, i / every[0], j / every[1], 0];
    };
    const out = [];
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < sides; j++) {
        const a = ring(i, j), b = ring(i + 1, j), c = ring(i + 1, j + 1), d = ring(i, j + 1);
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
    return { data: new Float32Array(out), count: out.length / 9, nodes: [], grid: true, smooth: true, flat: false };
  }

  function solidKnot(p = 2, q = 3, seg = 260, sides = 20, tube = 0.085) {
    const curve = t => { const r = 0.62 + 0.26 * Math.cos(q * t); return [r * Math.cos(p * t), r * Math.sin(p * t), 0.3 * Math.sin(q * t)]; };
    const pts = [], tan = [], normals = [];
    for (let i = 0; i < seg; i++) pts.push(curve(i / seg * TAU));
    for (let i = 0; i < seg; i++) tan.push(norm(sub(pts[(i + 1) % seg], pts[(i - 1 + seg) % seg])));
    let n = norm(cross(tan[0], Math.abs(tan[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    for (let i = 0; i < seg; i++) { n = norm(sub(n, mul(tan[i], dot(n, tan[i])))); normals.push(n); }
    const nEnd = norm(sub(n, mul(tan[0], dot(n, tan[0]))));
    const twist = Math.atan2(dot(normals[0], cross(tan[0], nEnd)), dot(normals[0], nEnd));
    return sweep(seg, sides, i => ({ p: pts[i], N: normals[i], B: cross(tan[i], normals[i]), off: twist * i / seg }), tube, [seg / 52, sides / 4]);
  }

  function solidTorus(R = 0.72, r = 0.26, seg = 96, sides = 40) {
    return sweep(seg, sides, i => {
      const u = i / seg * TAU;
      return { p: [R * Math.cos(u), R * Math.sin(u), 0], N: [Math.cos(u), Math.sin(u), 0], B: [0, 0, 1], off: 0 };
    }, r, [seg / 24, sides / 10]);
  }

  const SOLIDS = { geodesic: () => solidGeodesic(2, 5, false), ico: () => solidGeodesic(0, 1, true), knot: () => solidKnot(), torus: () => solidTorus(), particles: () => null };
  const solidCache = new Map();
  const solid = name => { if (!solidCache.has(name)) solidCache.set(name, (SOLIDS[name] || SOLIDS.geodesic)()); return solidCache.get(name); };

  // same surface ripple as the vertex shader, so the lattice nodes (drawn as
  // sprites from JS) stay glued to the displaced surface
  function displace(p, t, amp, treble) {
    const wave = Math.sin(p[0] * 3.1 + t * 1.3) * Math.sin(p[1] * 2.7 - t * 1.1) * Math.sin(p[2] * 3.7 + t * 0.9);
    const d = 1 + amp * wave + treble * 0.04 * Math.sin(p[1] * 9 + t * 4);
    return [p[0] * d, p[1] * d, p[2] * d];
  }

  /* ---------- WebGL renderer ---------- */

  const GLSL_DISPLACE = `
  uniform float uT, uAmp, uTreble;
  vec3 displace(vec3 p) {
    float wave = sin(p.x * 3.1 + uT * 1.3) * sin(p.y * 2.7 - uT * 1.1) * sin(p.z * 3.7 + uT * 0.9);
    return p * (1.0 + uAmp * wave + uTreble * 0.04 * sin(p.y * 9.0 + uT * 4.0));
  }`;

  // Projection matches the 2D renderer: screen = center + r.xy * size * D / (D - r.z),
  // written through w so varyings stay perspective-correct.
  const GLSL_PROJECT = `
  uniform mat3 uRot;
  uniform vec2 uCenter, uScale;
  uniform float uD;
  vec4 project(vec3 r) {
    float wh = (uD - r.z) / uD;
    vec2 ndc = uCenter + vec2(r.x, -r.y) * uScale / wh;
    return vec4(ndc * wh, -r.z * 0.25 * wh, wh);
  }`;

  const MESH_VS = `#version 300 es
  in vec3 aPos; in vec3 aNrm; in vec3 aWire;
  uniform float uSmooth;
  ${GLSL_DISPLACE}
  ${GLSL_PROJECT}
  out vec3 vPos; out vec3 vNrm; out vec3 vWire;
  void main() {
    vec3 p = displace(aPos);
    vec3 n = aNrm;
    if (uSmooth > 0.5) {
      // normal of the rippled surface by finite differences along two tangents
      vec3 t1 = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
      vec3 t2 = cross(n, t1);
      vec3 c = cross(displace(aPos + t1 * 0.01) - p, displace(aPos + t2 * 0.01) - p);
      n = normalize(c) * (dot(c, n) < 0.0 ? -1.0 : 1.0);
    }
    vec3 r = p * uRot;
    vec3 rn = n * uRot;
    gl_Position = project(r);
    // lighting space: y up, camera at (0, 0, D) looking down -z
    vPos = vec3(r.x, -r.y, r.z);
    vNrm = vec3(rn.x, -rn.y, rn.z);
    vWire = aWire;
  }`;

  const MESH_FS = `#version 300 es
  precision highp float;
  in vec3 vPos; in vec3 vNrm; in vec3 vWire;
  uniform vec3 uColor;
  uniform float uD, uAlpha, uWire, uGrid, uLine, uEnergy, uMid, uT, uPass, uChrome, uFlat;
  out vec4 outColor;

  vec3 hueShift(vec3 c, float a) {
    const vec3 k = vec3(0.57735);
    float ca = cos(a);
    return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
  }

  // procedural studio: dark room, a white softbox overhead, a tinted strip
  // light to the right and a hue-shifted fill low on the left
  vec3 env(vec3 R, vec3 tint) {
    vec3 col = mix(vec3(0.012, 0.014, 0.022), tint * 0.2, smoothstep(-0.7, 0.9, R.y));
    col += vec3(1.0) * smoothstep(0.7, 0.97, R.y) * 1.5;
    col += tint * 2.2 * exp(-pow((R.x - 0.72) * 4.5, 2.0)) * smoothstep(-0.4, 0.35, R.y);
    col += max(hueShift(tint, 2.2), 0.0) * 1.3 * exp(-pow((R.x + 0.78) * 3.5, 2.0)) * smoothstep(0.25, -0.65, R.y);
    col += vec3(0.5) * smoothstep(-0.75, -1.0, R.y);
    return col;
  }

  void main() {
    vec3 N = normalize(vNrm);
    if (uFlat > 0.5) {
      N = normalize(cross(dFdx(vPos), dFdy(vPos)));
      if (dot(N, vPos) < 0.0) N = -N;
    }
    vec3 V = normalize(vec3(0.0, 0.0, uD) - vPos);
    float ndv = dot(N, V);
    bool front = ndv > 0.0;
    if (uPass < 1.5 && (uPass > 0.5) != front) discard;
    if (!front) N = -N;
    ndv = abs(ndv);

    vec3 tint = uColor;
    vec3 light = mix(tint, vec3(1.0), 0.5);
    vec3 R = reflect(-V, N);
    float fres = pow(1.0 - ndv, 2.6);
    vec3 H1 = normalize(normalize(vec3(0.55, 0.8, 0.6)) + V);
    vec3 H2 = normalize(normalize(vec3(-0.8, -0.35, 0.5)) + V);
    float spec = pow(max(dot(N, H1), 0.0), 120.0) * 2.2 + pow(max(dot(N, H2), 0.0), 36.0) * 0.35;
    // thin-film iridescence drifting slowly over the surface
    vec3 film = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + ndv * 1.4 + vPos.y * 0.3 + uT * 0.025));
    vec3 refl = env(R, tint) * mix(vec3(1.0), film * 1.5, 0.4);

    float wire = 0.0;
    if (uWire > 0.0) {
      if (uGrid > 0.5) {
        vec2 g = abs(fract(vWire.xy - 0.5) - 0.5) / max(fwidth(vWire.xy), 1e-5);
        wire = max(1.0 - smoothstep(0.0, uLine, g.x), (1.0 - smoothstep(0.0, uLine * 0.8, g.y)) * 0.55);
      } else {
        float d = min(min(vWire.x, vWire.y), vWire.z);
        wire = 1.0 - smoothstep(0.0, uLine, d / max(fwidth(d), 1e-5));
      }
    }
    float depthF = clamp((vPos.z + 1.2) / 2.4, 0.0, 1.0);
    float beat = 0.85 + uMid * 0.5 + uEnergy * 0.8;

    vec3 col;
    if (uChrome > 0.5) {
      float diff = max(dot(N, normalize(vec3(0.55, 0.8, 0.6))), 0.0);
      col = refl * 0.9 + tint * (0.04 + diff * 0.22) + vec3(spec) + tint * fres * (0.7 + uEnergy * 1.5);
      col += light * wire * uWire * (0.6 + uEnergy);
    } else {
      col = refl * (0.04 + fres * 0.9) + vec3(spec) + tint * fres * (0.3 + uEnergy * 1.2);
      col += mix(tint, light * 1.15, depthF * depthF) * wire * uWire * (0.22 + depthF * 0.75) * beat;
      if (!front) col *= 0.3;
    }
    col = 1.0 - exp(-col * 1.15);
    float a = uChrome > 0.5 ? 1.0 : clamp(max(max(col.r, col.g), col.b) * 1.1, 0.0, 1.0);
    outColor = vec4(col * uAlpha, a * uAlpha);
  }`;

  const SPRITE_VS = `#version 300 es
  in vec4 aP; in vec2 aX;
  uniform vec2 uCenter, uScale;
  uniform float uD, uDpr;
  out vec2 vX;
  void main() {
    float wh = (uD - aP.z) / uD;
    gl_Position = vec4(uCenter + vec2(aP.x, -aP.y) * uScale / wh, -aP.z * 0.25, 1.0);
    gl_PointSize = aP.w * uDpr / wh;
    vX = aX;
  }`;

  const SPRITE_FS = `#version 300 es
  precision mediump float;
  in vec2 vX;
  uniform vec3 uColor;
  out vec4 outColor;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;
    float g = (exp(-r2 * 5.0) * 0.8 + (1.0 - smoothstep(0.0, 0.12, r2)) * 0.9) * (1.0 - r2);
    vec3 c = mix(uColor, mix(uColor, vec3(1.0), 0.55), vX.y) * g * vX.x;
    outColor = vec4(c, max(max(c.r, c.g), c.b));
  }`;

  const HALO_VS = `#version 300 es
  in vec2 aQ;
  void main() { gl_Position = vec4(aQ, 0.0, 1.0); }`;

  const HALO_FS = `#version 300 es
  precision mediump float;
  uniform vec2 uCenterPx, uRes;
  uniform float uRadius, uEnergy, uAlpha;
  uniform vec3 uColor;
  out vec4 outColor;
  void main() {
    float r2 = dot(gl_FragCoord.xy - uCenterPx, gl_FragCoord.xy - uCenterPx) / (uRadius * uRadius);
    // fade out before the canvas border so the glow never shows a box edge
    vec2 f = gl_FragCoord.xy;
    float edge = smoothstep(0.0, min(uRes.x, uRes.y) * 0.22, min(min(f.x, f.y), min(uRes.x - f.x, uRes.y - f.y)));
    vec3 c = uColor * (exp(-r2 * 1.1) * (0.1 + uEnergy * 0.3) + exp(-r2 * 5.0) * 0.08) * uAlpha * edge;
    outColor = vec4(c, 0.0);
  }`;

  function program(gl, vs, fs) {
    const make = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  function setupGL(sc) {
    const gl = sc.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true });
    if (!gl) return null;
    const G = { gl };
    G.mesh = program(gl, MESH_VS, MESH_FS);
    G.sprite = program(gl, SPRITE_VS, SPRITE_FS);
    G.halo = program(gl, HALO_VS, HALO_FS);

    G.haloVao = gl.createVertexArray();
    gl.bindVertexArray(G.haloVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const q = gl.getAttribLocation(G.halo.p, 'aQ');
    gl.enableVertexAttribArray(q); gl.vertexAttribPointer(q, 2, gl.FLOAT, false, 0, 0);

    G.spriteVao = gl.createVertexArray();
    gl.bindVertexArray(G.spriteVao);
    G.spriteBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, G.spriteBuf);
    const aP = gl.getAttribLocation(G.sprite.p, 'aP'), aX = gl.getAttribLocation(G.sprite.p, 'aX');
    gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(aX); gl.vertexAttribPointer(aX, 2, gl.FLOAT, false, 24, 16);
    gl.bindVertexArray(null);
    G.sprites = new Float32Array(6 * 512);
    return G;
  }

  function setSolidGL(sc) {
    const G = sc.gl, gl = G.gl;
    if (G.meshVao) { gl.deleteVertexArray(G.meshVao); gl.deleteBuffer(G.meshBuf); G.meshVao = null; }
    G.solid = solid(sc.o.shape);
    if (!G.solid) return;
    G.meshVao = gl.createVertexArray();
    gl.bindVertexArray(G.meshVao);
    G.meshBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, G.meshBuf);
    gl.bufferData(gl.ARRAY_BUFFER, G.solid.data, gl.STATIC_DRAW);
    for (const [name, off] of [['aPos', 0], ['aNrm', 12], ['aWire', 24]]) {
      const loc = gl.getAttribLocation(G.mesh.p, name);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 36, off);
    }
    gl.bindVertexArray(null);
  }

  function drawGL(sc, now) {
    const G = sc.gl, gl = G.gl, { o, w, h, dpr } = sc;
    if (gl.isContextLost()) return;
    const t = reduceMotion ? 8 : (now - sc.t0) / 1000;
    const lv = o.audio ? level : { bass: 0, mid: 0, treble: 0, kick: 0 };
    for (let i = 0; i < 3; i++) sc.color[i] += (sc.targetColor[i] - sc.color[i]) * 0.05;
    sc.px += (pointer.x - sc.px) * 0.06;
    sc.py += (pointer.y - sc.py) * 0.06;

    // a spring on the bass so the pulse overshoots and settles instead of twitching
    const target = lv.bass * o.pulse + lv.kick * o.pulse * 1.4;
    sc.springV = (sc.springV || 0) + (target - (sc.springX || 0)) * 0.22;
    sc.springV *= 0.72;
    sc.springX = (sc.springX || 0) + sc.springV;

    sc.yaw += (sc.yawTarget - sc.yaw) * 0.045;
    let intro = 1, fade = 1;
    if (sc.intro) {
      const e = Math.min(1, (now - sc.t0) / 1300);
      intro = e >= 1 ? 1 : 1 - Math.pow(2, -9 * e) * Math.cos(e * 13);
      fade = Math.min(1, e * 3);
      if (e >= 1) sc.intro = false;
    }
    const M = rotation(t * o.spin[0] + o.tilt + sc.py * o.parallax * 0.6, t * o.spin[1] + sc.px * o.parallax + sc.yaw + (1 - intro) * 1.2, t * o.spin[2]);
    const size = Math.min(w, h) * o.scale * 0.5 * (1 + sc.springX) * Math.max(0.001, intro);
    const cx = w * o.cx, cy = h * o.cy, D = 3.4;
    const col = sc.color.map(c => c / 255);
    const amp = o.wobble + (lv.bass * 0.05 + lv.kick * 0.1) * o.react;
    const energy = Math.min(1, lv.bass * 0.5 + lv.kick * 1.8);
    const center = [cx / w * 2 - 1, 1 - cy / h * 2], scale = [size * 2 / w, size * 2 / h];
    const alpha = Math.min(1, o.alpha[1] * 1.35) * fade;

    gl.viewport(0, 0, sc.canvas.width, sc.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);

    if (o.glow) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(G.halo.p);
      gl.uniform2f(G.halo.u.uCenterPx, cx * dpr, (h - cy) * dpr);
      gl.uniform1f(G.halo.u.uRadius, size * dpr * 1.25);
      gl.uniform2f(G.halo.u.uRes, sc.canvas.width, sc.canvas.height);
      gl.uniform1f(G.halo.u.uEnergy, energy);
      gl.uniform1f(G.halo.u.uAlpha, alpha * o.glow);
      gl.uniform3fv(G.halo.u.uColor, col);
      gl.bindVertexArray(G.haloVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const S = G.solid;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    if (S) {
      const U = G.mesh.u, chrome = o.material === 'chrome';
      gl.useProgram(G.mesh.p);
      gl.uniformMatrix3fv(U.uRot, false, M);
      gl.uniform2fv(U.uCenter, center);
      gl.uniform2fv(U.uScale, scale);
      gl.uniform1f(U.uD, D);
      gl.uniform1f(U.uT, t);
      gl.uniform1f(U.uAmp, amp);
      gl.uniform1f(U.uTreble, lv.treble);
      gl.uniform1f(U.uSmooth, S.smooth ? 1 : 0);
      gl.uniform1f(U.uFlat, S.flat ? 1 : 0);
      gl.uniform1f(U.uGrid, S.grid ? 1 : 0);
      gl.uniform3fv(U.uColor, col);
      gl.uniform1f(U.uAlpha, alpha);
      gl.uniform1f(U.uWire, o.wire);
      gl.uniform1f(U.uLine, Math.max(0.6, o.line * dpr * 1.1));
      gl.uniform1f(U.uEnergy, energy);
      gl.uniform1f(U.uMid, lv.mid);
      gl.uniform1f(U.uChrome, chrome ? 1 : 0);
      gl.bindVertexArray(G.meshVao);
      if (chrome) {
        gl.depthMask(true);
        gl.uniform1f(U.uPass, 2);
        gl.drawArrays(gl.TRIANGLES, 0, S.count);
      } else {
        // glass: inner (back) faces first, then the outer shell over them
        gl.depthMask(false);
        gl.uniform1f(U.uPass, 0);
        gl.drawArrays(gl.TRIANGLES, 0, S.count);
        gl.uniform1f(U.uPass, 1);
        gl.drawArrays(gl.TRIANGLES, 0, S.count);
      }
    }

    // sprites: lattice nodes, orbit rings + comet beads, dust
    let buf = G.sprites, k = 0;
    const push = (x, y, z, s, a, m) => {
      if (k + 6 > buf.length) { const nb = new Float32Array(buf.length * 2); nb.set(buf); buf = G.sprites = nb; }
      buf[k++] = x; buf[k++] = y; buf[k++] = z; buf[k++] = s; buf[k++] = a; buf[k++] = m;
    };
    const rot = (p, R) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];

    if (o.points) {
      const nodes = S ? S.nodes : sc.mesh.v;
      for (const p0 of nodes) {
        const r = rot(displace(p0, t, amp, lv.treble), M);
        const f = (r[2] + 1.2) / 2.4;
        push(r[0], r[1], r[2], (S ? 5 : 4.5) * (0.5 + f) * o.line, (S ? 0.9 : 1) * o.alpha[1] * f * f * (0.8 + energy), 1);
      }
    }
    for (let j = 0; j < o.orbits; j++) {
      const incl = 1.05 + j * 0.55, yaw = j * 2.1 + t * 0.05 * (j % 2 ? -1 : 1);
      const R = rotation(incl + sc.py * 0.2, yaw + sc.px * 0.3, 0);
      const rad = 1.28 + j * 0.2 + lv.bass * 0.06;
      const ring = a => rot([Math.cos(a) * rad, 0, Math.sin(a) * rad], R);
      const STEPS = 150;
      for (let s = 0; s < STEPS; s++) {
        const r = ring(s / STEPS * TAU), f = (r[2] + 1.6) / 3.2;
        push(r[0], r[1], r[2], 2.2 + f * 1.6, 0.05 + 0.3 * f * f, 0);
      }
      const dir = j % 2 ? -1 : 1, speed = 0.5 + j * 0.17;
      for (let tr = 0; tr < 26; tr++) {
        const r = ring(t * speed * dir - tr * 0.022 * dir), f = (r[2] + 1.6) / 3.2;
        const fade = 1 - tr / 26;
        push(r[0], r[1], r[2], (tr ? 7 * fade + 2 : 16) * (0.6 + f), fade * fade * (0.3 + 0.7 * f) * (tr ? 0.7 : 1.2), 1);
      }
    }
    const since = (now - sc.burstAt) / 1000;
    if (since < 1.6) {
      const e = since / 1.6, ease = 1 - Math.pow(1 - e, 3), a = Math.pow(1 - e, 2);
      for (let ringN = 0; ringN < 2; ringN++) {
        const rad = 1.02 + ease * (0.9 + ringN * 0.45), N = 120;
        for (let i = 0; i < N; i++) {
          const ang = i / N * TAU + ringN * 0.3;
          push(Math.cos(ang) * rad, Math.sin(ang) * rad, 0, (ringN ? 4 : 6) * (1 - e * 0.5), a * (ringN ? 0.35 : 0.7), 1);
        }
      }
    }
    if (sc.dust) {
      const R = rotation(0, t * 0.03, 0);
      for (let i = 0; i < sc.dust.length; i++) {
        const p0 = sc.dust[i], r0 = rot(p0, R);
        const r = rot(r0, M);
        const z = r[2] * 0.6, f = (r[2] + 2) / 4;
        const twinkle = 0.65 + 0.35 * Math.sin(t * (0.7 + (i % 7) * 0.23) + i);
        push(r[0], r[1], z, (2 + f * 3.5), (0.08 + 0.45 * f * f) * twinkle, 1);
      }
    }
    if (k) {
      gl.useProgram(G.sprite.p);
      gl.uniform2fv(G.sprite.u.uCenter, center);
      gl.uniform2fv(G.sprite.u.uScale, scale);
      gl.uniform1f(G.sprite.u.uD, D);
      gl.uniform1f(G.sprite.u.uDpr, dpr);
      gl.uniform3fv(G.sprite.u.uColor, col);
      gl.depthMask(false);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(G.spriteVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.spriteBuf);
      gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, k), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, k / 6);
    }
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  /* ---------- halo: concentric rings, the app's shared motif ---------- */

  // Evenly spaced hairline rings around a center (or around an anchor element
  // such as the artist photo). A few rings carry a slow arc with a fading
  // tail, one carries dial ticks, and beats travel outward ring by ring.
  // Everything is 2D: crisp hairlines matter more here than lighting.
  const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
  const easeOut = x => 1 - Math.pow(1 - x, 3);
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, a).toFixed(3)})`;

  function drawHalo(sc, now) {
    const { ctx, o, w, h, dpr } = sc;
    const t = reduceMotion ? 6 : (now - sc.t0) / 1000;
    for (let i = 0; i < 3; i++) sc.color[i] += (sc.targetColor[i] - sc.color[i]) * 0.05;
    sc.px += (pointer.x - sc.px) * 0.05;
    sc.py += (pointer.y - sc.py) * 0.05;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const short = Math.min(w, h);
    let cx = w * o.cx, cy = h * o.cy, r0 = short * o.inner;
    if (o.anchor && o.anchor.isConnected) {
      const a = o.anchor.getBoundingClientRect(), c = sc.canvas.getBoundingClientRect();
      if (a.width) {
        cx = a.left + a.width / 2 - c.left; cy = a.top + a.height / 2 - c.top;
        r0 = a.width / 2 + short * o.inner;
      }
    }
    const gap = short * o.gap;
    const col = sc.color.map(Math.round);
    const light = col.map(v => Math.round(v + (255 - v) * 0.6));
    const energy = o.audio ? Math.min(1, level.bass * 0.5 + level.kick * 1.8) : 0;
    const e = sc.intro ? (now - sc.t0) / 1000 : 99;
    if (e > 4) sc.intro = false;

    const glowR = r0 * 1.8;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    glow.addColorStop(0, rgba(col, (0.14 + energy * 0.12) * o.alpha * clamp01(e * 2)));
    glow.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);

    ctx.lineCap = 'round';
    const top = -Math.PI / 2;
    for (let i = 0; i < o.rings; i++) {
      // intro: each ring draws itself on, a beat after the one inside it
      const p = easeOut(clamp01((e - 0.05 - i * 0.06) / 1.1));
      if (p <= 0) continue;
      const beat = o.audio ? pastBeat(i * 3) : 0;
      const rad = r0 + i * gap + beat * gap * 0.16;
      const ox = cx + sc.px * i * o.parallax, oy = cy + sc.py * i * o.parallax;
      const a = o.alpha * Math.pow(1 - i / o.rings, 1.3);

      ctx.strokeStyle = rgba(col, a * (0.26 + beat * 0.6));
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(ox, oy, rad, top, top + TAU * p); ctx.stroke();

      if (i === o.tickRing) {
        const N = 120, rot = t * 0.02 * o.speed;
        ctx.strokeStyle = rgba(light, a * 0.55 * p);
        ctx.beginPath();
        for (let k = 0; k < N * p; k++) {
          const ang = top + k / N * TAU + rot, len = k % 10 ? 3 : 7;
          const c = Math.cos(ang), s = Math.sin(ang);
          ctx.moveTo(ox + c * (rad + 3), oy + s * (rad + 3));
          ctx.lineTo(ox + c * (rad + 3 + len), oy + s * (rad + 3 + len));
        }
        ctx.stroke();
      }

      if (o.arcs && i % 2 === 1) {
        // fixed per ring, so the layout is composed rather than random
        const seed = ((i * 37) % 11) / 11;
        const len = (0.12 + seed * 0.2) * TAU;
        const dir = (i >> 1) % 2 ? -1 : 1;
        const head = top + seed * TAU + dir * t * (0.1 + seed * 0.06) * o.speed * 2.2 / (1 + i * 0.2);
        const tail = head - dir * len;
        const aa = a * (0.95 + beat * 0.8) * p;
        const grad = ctx.createConicGradient(Math.min(head, tail), ox, oy);
        const f = len / TAU;
        grad.addColorStop(0, rgba(light, dir > 0 ? 0 : aa));
        grad.addColorStop(f, rgba(light, dir > 0 ? aa : 0));
        grad.addColorStop(Math.min(1, f + 0.001), rgba(light, 0));
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(ox, oy, rad, Math.min(head, tail), Math.max(head, tail)); ctx.stroke();
        const hx = ox + Math.cos(head) * rad, hy = oy + Math.sin(head) * rad;
        const dot = ctx.createRadialGradient(hx, hy, 0, hx, hy, 9);
        dot.addColorStop(0, rgba(light, aa));
        dot.addColorStop(0.25, rgba(light, aa * 0.5));
        dot.addColorStop(1, rgba(light, 0));
        ctx.fillStyle = dot;
        ctx.fillRect(hx - 9, hy - 9, 18, 18);
      }
    }

    // a strong beat (or a burst) sends one clean ring out across the rest
    if (o.audio && !reduceMotion && level.kick > 0.14 && now - sc.lastRipple > 420) sc.ripples.push(sc.lastRipple = now);
    sc.ripples = sc.ripples.filter(t0 => now - t0 < 1600);
    for (const t0 of sc.ripples) {
      const k = (now - t0) / 1600, ek = easeOut(k);
      ctx.strokeStyle = rgba(light, Math.pow(1 - k, 2) * 0.32 * o.alpha);
      ctx.lineWidth = 0.8 + (1 - k) * 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, r0 + ek * gap * (o.rings - 1), 0, TAU); ctx.stroke();
    }
  }

  const HALO_DEFAULTS = {
    color: [106, 165, 255], cx: 0.5, cy: 0.5, anchor: null,
    inner: 0.16, gap: 0.1, rings: 9, tickRing: 2, arcs: true,
    speed: 1, parallax: 1.2, alpha: 1, audio: true,
    intro: true, fps: 0, visible: null, onFrame: null
  };

  /* ---------- ambient: the Now Playing backdrop ---------- */

  // A slow domain-warped flow in the cover's own colors fills the sheet, light
  // spills out from behind the cover, and faint rings drift outward from it,
  // brightening with the bass. Track changes send one ring out and crossfade
  // the colors. Dim on purpose: it's a mood, the cover and controls lead.
  const AMBIENT_FS = `#version 300 es
  precision highp float;
  uniform vec2 uRes, uCenter, uPtr;
  uniform float uT, uHalf, uBass, uEnergy, uRipple, uScale, uFade;
  uniform vec3 uTint, uP0, uP1, uP2;
  out vec4 outColor;

  float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * noise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
    return s;
  }

  void main() {
    vec2 fc = gl_FragCoord.xy;
    vec2 uv = (fc - 0.5 * uRes) / min(uRes.x, uRes.y);
    float t = uT * 0.035;
    vec2 p = uv * 1.1 + uPtr * 0.04;
    vec2 w1 = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
    vec2 w2 = vec2(fbm(p + 2.0 * w1 + vec2(1.7, 9.2) + 0.6 * t), fbm(p + 2.0 * w1 + vec2(8.3, 2.8) - 0.5 * t));
    float n = fbm(p + 2.4 * w2);

    vec3 col = mix(uP0 * 0.14, uP0, smoothstep(0.3, 0.8, n));
    col = mix(col, uP1, smoothstep(0.4, 0.85, w2.x) * 0.8);
    col = mix(col, uP2, smoothstep(0.45, 0.9, w1.y) * 0.6);
    col *= 0.5 * mix(0.5, 1.0, smoothstep(-0.55, 0.45, uv.y));

    float d = length(fc - uCenter);
    float R = uHalf * 1.42;
    float g = exp(-pow(max(d - uHalf * 0.5, 0.0) / (uHalf * 1.3), 2.0));
    // grey covers get a quieter glow, or it washes the sheet out
    float sat = (max(uTint.r, max(uTint.g, uTint.b)) - min(uTint.r, min(uTint.g, uTint.b))) / max(max(uTint.r, max(uTint.g, uTint.b)), 0.01);
    col += uTint * g * (0.2 + uBass * 0.3) * mix(0.5, 1.0, sat);

    float gap = uHalf * 0.38;
    float x = (d - R) / gap;
    if (x > 0.0) {
      float fpx = abs(fract(x - uT * 0.1) - 0.5) * gap;
      float line = 1.0 - smoothstep(0.35 * uScale, 1.3 * uScale, fpx);
      float fade = exp(-x * 0.34) * smoothstep(0.0, 1.0, x);
      col += mix(uTint, vec3(1.0), 0.4) * line * fade * (0.055 + uEnergy * 0.16);
    }
    if (uRipple < 1.0) {
      float ring = 1.0 - smoothstep(0.0, (1.2 + uRipple * 5.0) * uScale, abs(d - R - uRipple * uHalf * 2.8));
      col += mix(uTint, vec3(1.0), 0.5) * ring * pow(1.0 - uRipple, 2.0) * 0.3;
    }

    col *= 1.0 - 0.55 * dot(uv, uv);
    col += (hash(fc + fract(uT * 7.0) * 113.0) - 0.5) * 0.02;
    outColor = vec4(max(col, 0.0) * uFade, 1.0);
  }`;

  function setupAmbient(sc) {
    const gl = sc.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
    if (!gl) return null;
    const G = { gl, prog: program(gl, HALO_VS, AMBIENT_FS) };
    G.vao = gl.createVertexArray();
    gl.bindVertexArray(G.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const q = gl.getAttribLocation(G.prog.p, 'aQ');
    gl.enableVertexAttribArray(q); gl.vertexAttribPointer(q, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return G;
  }

  // shared by both ambient renderers: eased colors, cover position, bass spring
  function ambientStep(sc, now) {
    const { o, w, h } = sc;
    for (let i = 0; i < 3; i++) sc.color[i] += (sc.targetColor[i] - sc.color[i]) * 0.04;
    for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) sc.pal[k][i] += (sc.palTarget[k][i] - sc.pal[k][i]) * 0.025;
    sc.px += (pointer.x - sc.px) * 0.04;
    sc.py += (pointer.y - sc.py) * 0.04;
    let ccx = w / 2, ccy = h * 0.4, half = Math.min(w, h) * 0.22;
    if (o.anchor && o.anchor.isConnected) {
      const a = o.anchor.getBoundingClientRect(), c = sc.canvas.getBoundingClientRect();
      if (a.width) { ccx = a.left + a.width / 2 - c.left; ccy = a.top + a.height / 2 - c.top; half = a.width / 2; }
    }
    const lv = o.audio ? level : { bass: 0, kick: 0 };
    const target = Math.min(1, lv.bass * 0.8 + lv.kick * 1.6);
    sc.springV = ((sc.springV || 0) + (target - (sc.springX || 0)) * 0.18) * 0.74;
    sc.springX = (sc.springX || 0) + sc.springV;
    return {
      t: reduceMotion ? 20 : (now - sc.t0) / 1000,
      ccx, ccy, half,
      bass: Math.max(0, sc.springX), energy: Math.min(1, lv.bass * 0.5 + lv.kick * 1.8),
      ripple: reduceMotion ? 1 : clamp01((now - sc.burstAt) / 1900),
      fade: clamp01((now - sc.t0) / 900)
    };
  }

  function drawAmbient(sc, now) {
    const G = sc.gl, gl = G.gl, U = G.prog.u;
    if (gl.isContextLost()) return;
    const s = ambientStep(sc, now), k = sc.canvas.width / sc.w;
    gl.viewport(0, 0, sc.canvas.width, sc.canvas.height);
    gl.useProgram(G.prog.p);
    gl.uniform2f(U.uRes, sc.canvas.width, sc.canvas.height);
    gl.uniform2f(U.uCenter, s.ccx * k, (sc.h - s.ccy) * k);
    gl.uniform2f(U.uPtr, sc.px, -sc.py);
    gl.uniform1f(U.uT, s.t);
    gl.uniform1f(U.uHalf, s.half * k);
    gl.uniform1f(U.uBass, s.bass);
    gl.uniform1f(U.uEnergy, s.energy);
    gl.uniform1f(U.uRipple, s.ripple);
    gl.uniform1f(U.uScale, k);
    gl.uniform1f(U.uFade, s.fade);
    gl.uniform3fv(U.uTint, sc.color.map(c => c / 255));
    for (let i = 0; i < 3; i++) gl.uniform3fv(U['uP' + i], sc.pal[i].map(c => c / 255));
    gl.bindVertexArray(G.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // no WebGL: the same idea as three soft color pools and the cover's glow
  function drawAmbient2D(sc, now) {
    const { ctx, w, h, dpr } = sc, s = ambientStep(sc, now);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = rgba(sc.pal[0].map(v => Math.round(v * 0.1)), 1);
    ctx.fillRect(0, 0, w, h);
    const pool = (c, x, y, r, a) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(c.map(Math.round), a)); g.addColorStop(1, rgba(c.map(Math.round), 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    };
    const m = Math.max(w, h), tt = s.t * 0.05;
    pool(sc.pal[0], w * (0.2 + 0.08 * Math.sin(tt)), h * 0.2, m * 0.6, 0.3 * s.fade);
    pool(sc.pal[1], w * (0.85 + 0.06 * Math.cos(tt * 1.3)), h * 0.45, m * 0.55, 0.26 * s.fade);
    pool(sc.pal[2], w * 0.45, h * (1 + 0.05 * Math.sin(tt * 0.8)), m * 0.5, 0.2 * s.fade);
    pool(sc.color, s.ccx, s.ccy, s.half * 2.6, (0.16 + s.bass * 0.2) * s.fade);
  }

  const AMBIENT_DEFAULTS = {
    color: [106, 165, 255], anchor: null, audio: true, res: 0.75,
    intro: false, fps: 0, visible: null, onFrame: null
  };

  /* ---------- shared inputs: pointer + audio ---------- */

  const pointer = { x: 0, y: 0 };
  window.addEventListener('pointermove', e => {
    pointer.x = e.clientX / innerWidth * 2 - 1;
    pointer.y = e.clientY / innerHeight * 2 - 1;
  }, { passive: true });

  const bins = new Uint8Array(512);
  const level = { bass: 0, mid: 0, treble: 0, kick: 0 };
  let slowBass = 0;
  // recent bass per frame, so rings further out can answer a beat a little later
  const HIST = 128, history = new Float32Array(HIST);
  let histHead = 0;
  const pastBeat = framesAgo => history[(histHead - 1 - framesAgo + HIST * 2) % HIST];
  const band = (from, to) => { let s = 0; for (let i = from; i < to; i++) s += bins[i]; return s / ((to - from) * 255); };
  const follow = (cur, target) => cur + (target - cur) * (target > cur ? 0.5 : 0.1);

  function readAudio(now) {
    const playing = typeof P !== 'undefined' && P.playing;
    let b = 0, m = 0, tr = 0;
    if (playing && typeof AudioEngine !== 'undefined' && AudioEngine.spectrum && AudioEngine.spectrum(bins)) {
      // ~43 Hz per bin: bass 43-260 Hz, mids to ~1.7 kHz, treble to ~7 kHz
      b = band(1, 6); m = band(6, 40); tr = band(40, 160);
    } else if (playing) {
      // Spotify Connect gives us no samples: fake a gentle ~96 bpm pulse
      const s = now / 1000;
      b = 0.3 + 0.35 * Math.pow(Math.max(0, Math.sin(s * Math.PI * 1.6)), 8);
      m = 0.28 + 0.06 * Math.sin(s * 2.3); tr = 0.2;
    }
    level.bass = follow(level.bass, b);
    level.mid = follow(level.mid, m);
    level.treble = follow(level.treble, tr);
    level.kick = Math.max(0, level.bass - slowBass);
    slowBass += (level.bass - slowBass) * 0.04;
    history[histHead] = Math.min(1, level.kick * 2.2 + Math.max(0, level.bass - 0.25) * 0.5);
    histHead = (histHead + 1) % HIST;
  }

  /* ---------- scenes ---------- */

  const scenes = new Set();
  let raf = null;
  const BUCKETS = 7;

  const DEFAULTS = {
    shape: 'geodesic', color: [106, 165, 255], scale: 0.62, cx: 0.5, cy: 0.5,
    spin: [0.09, 0.16, 0.02], tilt: 0.35, parallax: 0.45,
    wobble: 0.05, pulse: 0.1, audio: true, line: 1,
    alpha: [0.05, 0.75], points: true, dust: 0, orbits: 0,
    material: 'glass', wire: 1, glow: 1, react: 1, intro: true,
    fps: 0, visible: null, onFrame: null
  };

  // kind 'mesh' is the 3D object (the logo), 'halo' the concentric rings used
  // on page heroes, 'ambient' the full-sheet Now Playing backdrop
  function mount(canvas, options = {}) {
    if (!canvas) return null;
    const kind = options.kind || 'mesh';
    const sc = {
      canvas, kind, ctx: null, gl: null,
      o: { ...(kind === 'halo' ? HALO_DEFAULTS : kind === 'ambient' ? AMBIENT_DEFAULTS : DEFAULTS), ...options },
      w: 0, h: 0, dpr: 1, t0: performance.now(), last: 0,
      px: 0, py: 0, proj: null, dust: null, ripples: [], lastRipple: 0
    };
    sc.color = sc.o.color.slice();
    sc.targetColor = sc.o.color.slice();
    // elastic pop-in only on a real navigation (or first boot), never when a
    // view quietly re-renders itself
    const content = canvas.closest('#content');
    sc.intro = sc.o.intro && !reduceMotion && (!content || 'enter' in content.dataset);
    sc.yaw = 0; sc.yawTarget = 0; sc.burstAt = -1e9;
    const setup = kind === 'ambient' ? () => setupAmbient(sc)
      : kind === 'mesh' ? () => { const G = setupGL(sc); if (G) { sc.gl = G; setSolidGL(sc); } return G; }
      : () => null;
    if (kind === 'mesh') sc.mesh = mesh(sc.o.shape);
    if (kind === 'ambient') {
      const c = sc.o.color;
      sc.pal = [c, c.map(v => v * 0.6), c.map(v => v * 0.35)];
      sc.palTarget = sc.pal.map(p => p.slice());
    }
    try {
      sc.gl = setup();
    } catch (err) {
      console.warn('Fx3D: WebGL unavailable, using 2D fallback', err);
      sc.gl = null;
    }
    if (!sc.gl) sc.ctx = canvas.getContext('2d');
    if (sc.gl) {
      canvas.addEventListener('webglcontextlost', e => e.preventDefault());
      canvas.addEventListener('webglcontextrestored', () => { try { sc.gl = setup(); } catch {} });
    }
    if (kind === 'mesh' && sc.o.dust) sc.dust = fibonacciSphere(sc.o.dust).v.map(p => mul(p, 1.35 + Math.random() * 0.6));
    sc.ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      // big WebGL canvases cap at 1.5x: the glass shader runs per pixel.
      // The ambient backdrop is soft by nature and renders below 1x.
      sc.dpr = kind === 'ambient' ? Math.min(sc.o.res, devicePixelRatio || 1)
        : Math.min(sc.gl && r.width * r.height > 250000 ? 1.5 : 2, devicePixelRatio || 1);
      sc.w = r.width; sc.h = r.height;
      canvas.width = Math.max(1, Math.round(r.width * sc.dpr));
      canvas.height = Math.max(1, Math.round(r.height * sc.dpr));
    });
    sc.ro.observe(canvas);
    sc.onScreen = true;
    sc.io = new IntersectionObserver(entries => { sc.onScreen = entries[entries.length - 1].isIntersecting; });
    sc.io.observe(canvas);
    scenes.add(sc);
    kick();
    return {
      setColor: rgb => { if (rgb) sc.targetColor = rgb.slice(); },
      // ambient only: three colors pulled from the cover
      setPalette: cols => { if (cols && sc.palTarget) sc.palTarget = cols.slice(0, 3).map(c => c.slice()); },
      // track change: the mesh turns a third, rings send a wave out
      burst: () => {
        if (reduceMotion) return;
        sc.yawTarget += TAU / 3; sc.burstAt = performance.now();
        if (kind === 'halo') sc.ripples.push(sc.lastRipple = sc.burstAt);
      },
      destroy: () => drop(sc)
    };
  }

  // views re-render often: hand the GL context back right away instead of
  // waiting for GC, or Chromium starts evicting the oldest live contexts
  function drop(sc) {
    scenes.delete(sc);
    try { sc.ro.disconnect(); sc.io.disconnect(); } catch {}
    if (sc.gl) { try { sc.gl.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {} sc.gl = null; }
  }

  /* What's worth drawing. The ticker follows the display's refresh rate, and
     on a 360 Hz panel that meant every scene redrew 360 times a second, even
     with the window hidden in the tray (backgroundThrottling is off for the
     audio engine, so Chromium never pauses rAF on its own). Now:
     - nothing runs at all while the window is hidden or minimized,
     - a scene scrolled out of view, or covered by the open Now Playing sheet,
       is skipped,
     - every scene and hook tops out at MAX_FPS (60): past that the extra
       frames bought nothing visible and cost a lot of CPU and GPU. */
  const MAX_FPS = 60;
  let windowVisible = true, covered = false, lastTick = 0;
  // per-frame callbacks for effects that aren't Fx3D scenes: they ride this
  // same ticker, so they inherit the tray/minimize pause, the covered-by-sheet
  // skip and the fps cap. { fn(now, dt, level), fps, visible(), overSheet }
  const hooks = new Set();
  function onFrame(fn, opts = {}) {
    const h = { fn, fps: opts.fps || 0, visible: opts.visible || null, overSheet: !!opts.overSheet, last: 0 };
    hooks.add(h);
    kick();
    return () => hooks.delete(h);
  }
  // Nothing to draw (all scenes hidden or idle, no hooks wanting frames): the
  // ticker sleeps on a 50 ms timer instead of waking every vsync, and a new
  // subscription wakes it at once.
  let sleepT = null;
  function kick() {
    if (sleepT) { clearTimeout(sleepT); sleepT = null; raf = null; }
    if (!raf && windowVisible) raf = requestAnimationFrame(tick);
  }
  function wanted(sc) {
    if (!sc.onScreen) return false;
    if (covered && sc.kind !== 'ambient') return false;
    return !sc.o.visible || sc.o.visible();
  }

  // raf stays truthy (TICKING) for the whole tick: a hook or scene that
  // subscribes mid-frame (springs do, constantly) must not start a second
  // requestAnimationFrame chain. That bug once ran three chains at 360 Hz.
  const TICKING = -1;
  function tick(now) {
    raf = TICKING;
    if ((!scenes.size && !hooks.size) || !windowVisible) { raf = null; return; }
    lastTick = now;
    let audioRead = false, active = false;
    if (hooks.size) {
      for (const h of hooks) {
        if (h.visible && !h.visible()) continue;
        if (covered && !h.overSheet) continue;
        active = true;
        const fps = reduceMotion ? Math.min(h.fps || MAX_FPS, 30) : Math.min(h.fps || MAX_FPS, MAX_FPS);
        if (now - h.last < 1000 / fps - 1) continue;
        const dt = Math.min(0.1, (now - (h.last || now)) / 1000);
        h.last = now;
        if (!audioRead) { readAudio(now); audioRead = true; }
        try { h.fn(now, dt, level); } catch (err) { console.error('Fx3D hook', err); hooks.delete(h); }
      }
    }
    for (const sc of scenes) {
      if (!sc.canvas.isConnected) { drop(sc); continue; }
      if (!wanted(sc)) continue;
      active = true;
      const fps = reduceMotion ? 4 : Math.min(sc.o.fps || MAX_FPS, MAX_FPS);
      // 1ms slack so frame-time jitter can't make a 120 fps cap land on 90
      if (now - sc.last < 1000 / fps - 1) continue;
      sc.last = now;
      if (!sc.w || !sc.h) continue;
      if (!audioRead) { readAudio(now); audioRead = true; }
      if (sc.kind === 'halo') { if (sc.ctx) drawHalo(sc, now); }
      else if (sc.kind === 'ambient') { if (sc.gl) drawAmbient(sc, now); else if (sc.ctx) drawAmbient2D(sc, now); }
      else if (sc.gl) drawGL(sc, now); else if (sc.ctx) draw(sc, now);
      if (sc.o.onFrame) sc.o.onFrame(level, sc);
    }
    // The display may refresh at 360 Hz. Asking for every vsync and skipping
    // most of them still made Chromium run a rendering update (a style recalc)
    // per vsync, so wait on a timer until the next MAX_FPS frame is nearly due
    // and only then ask for a frame. Idle, sleep 50 ms between checks.
    const wait = active ? 1000 / MAX_FPS - (performance.now() - now) - 1 : 50;
    sleepT = setTimeout(() => { sleepT = null; raf = null; kick(); }, Math.max(0, wait));
  }

  function draw(sc, now) {
    const { ctx, o, w, h } = sc;
    const t = reduceMotion ? 8 : (now - sc.t0) / 1000;
    const lv = o.audio ? level : { bass: 0, mid: 0, treble: 0, kick: 0 };
    for (let i = 0; i < 3; i++) sc.color[i] += (sc.targetColor[i] - sc.color[i]) * 0.05;
    sc.px += (pointer.x - sc.px) * 0.06;
    sc.py += (pointer.y - sc.py) * 0.06;

    ctx.setTransform(sc.dpr, 0, 0, sc.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    const M = rotation(t * o.spin[0] + o.tilt + sc.py * o.parallax * 0.6, t * o.spin[1] + sc.px * o.parallax, t * o.spin[2]);
    const size = Math.min(w, h) * o.scale * 0.5 * (1 + lv.bass * o.pulse + lv.kick * o.pulse * 1.4);
    const cx = w * o.cx, cy = h * o.cy, D = 3.4;
    const [r, g, b] = sc.color.map(Math.round);
    const lr = Math.round(r + (255 - r) * 0.45), lg = Math.round(g + (255 - g) * 0.45), lb = Math.round(b + (255 - b) * 0.45);

    // project: rotate, displace radially (a travelling interference pattern
    // of three sines, amplified by the bass), then perspective divide
    const V = sc.mesh.v, n = V.length;
    if (!sc.proj || sc.proj.length !== n * 3) sc.proj = new Float32Array(n * 3);
    const P3 = sc.proj;
    const amp = o.wobble + lv.bass * 0.2 + lv.kick * 0.25;
    for (let i = 0; i < n; i++) {
      const p = V[i];
      const wave = Math.sin(p[0] * 3.1 + t * 1.3) * Math.sin(p[1] * 2.7 - t * 1.1) * Math.sin(p[2] * 3.7 + t * 0.9);
      const d = 1 + amp * wave + lv.treble * 0.04 * Math.sin(p[1] * 9 + t * 4);
      const x = p[0] * d, y = p[1] * d, z = p[2] * d;
      const rx = M[0] * x + M[1] * y + M[2] * z;
      const ry = M[3] * x + M[4] * y + M[5] * z;
      const rz = M[6] * x + M[7] * y + M[8] * z;
      const k = D / (D - rz);
      P3[i * 3] = cx + rx * size * k;
      P3[i * 3 + 1] = cy + ry * size * k;
      P3[i * 3 + 2] = rz;
    }

    // edges batched into depth buckets: one stroke() per bucket instead of
    // one per edge, far edges faint and thin, near edges bright and thick
    const [aMin, aMax] = o.alpha;
    const E = sc.mesh.e;
    if (E.length) {
      const paths = Array.from({ length: BUCKETS }, () => []);
      for (let i = 0; i < E.length; i++) {
        const a = E[i][0] * 3, c = E[i][1] * 3;
        const depth = ((P3[a + 2] + P3[c + 2]) * 0.5 + 1.2) / 2.4;
        paths[Math.max(0, Math.min(BUCKETS - 1, Math.floor(depth * BUCKETS)))].push(a, c);
      }
      for (let bkt = 0; bkt < BUCKETS; bkt++) {
        const list = paths[bkt];
        if (!list.length) continue;
        const f = bkt / (BUCKETS - 1);
        const alpha = (aMin + (aMax - aMin) * f * f) * (0.85 + lv.mid * 0.5);
        ctx.strokeStyle = f > 0.7 ? `rgba(${lr},${lg},${lb},${alpha})` : `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = o.line * (0.5 + f);
        ctx.beginPath();
        for (let i = 0; i < list.length; i += 2) {
          ctx.moveTo(P3[list[i]], P3[list[i] + 1]);
          ctx.lineTo(P3[list[i + 1]], P3[list[i + 1] + 1]);
        }
        ctx.stroke();
      }
    }

    if (o.points) {
      for (let i = 0; i < n; i++) {
        const z = P3[i * 3 + 2];
        if (E.length && z < 0.15) continue;
        const f = (z + 1.2) / 2.4;
        const s = (E.length ? 1.1 : 1.6) * (0.5 + f) * o.line;
        ctx.fillStyle = `rgba(${lr},${lg},${lb},${(aMax * f * f) * (E.length ? 0.9 : 1)})`;
        ctx.fillRect(P3[i * 3] - s / 2, P3[i * 3 + 1] - s / 2, s, s);
      }
    }

    if (o.orbits) drawOrbits(sc, t, size, cx, cy, D, lv, [r, g, b], [lr, lg, lb]);
    if (sc.dust) drawDust(sc, t, M, size, cx, cy, D, [lr, lg, lb]);
    ctx.globalCompositeOperation = 'source-over';
  }

  // Tilted circular orbits (a circle rotated by its inclination, then by the
  // scene's own rotation), each carrying one bead with a fading trail.
  function drawOrbits(sc, t, size, cx, cy, D, lv, col, light) {
    const { ctx, o } = sc;
    for (let k = 0; k < o.orbits; k++) {
      const incl = 1.05 + k * 0.55, yaw = k * 2.1 + t * 0.05 * (k % 2 ? -1 : 1);
      const R = rotation(incl + sc.py * 0.2, yaw + sc.px * 0.3, 0);
      const rad = 1.28 + k * 0.2 + lv.bass * 0.06;
      const ring = (a) => {
        const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
        const rx = R[0] * x + R[2] * z, ry = R[3] * x + R[5] * z, rz = R[6] * x + R[8] * z;
        const kk = D / (D - rz);
        return [cx + rx * size * kk, cy + ry * size * kk, rz];
      };
      const STEPS = 90;
      let prev = ring(0);
      for (let s = 1; s <= STEPS; s++) {
        const cur = ring(s / STEPS * TAU);
        const f = ((prev[2] + cur[2]) * 0.5 + 1.6) / 3.2;
        ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.04 + 0.28 * f * f})`;
        ctx.lineWidth = 0.6 + f * 0.8;
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(cur[0], cur[1]); ctx.stroke();
        prev = cur;
      }
      const speed = 0.5 + k * 0.17;
      for (let trail = 0; trail < 14; trail++) {
        const p = ring(t * speed * (k % 2 ? -1 : 1) - trail * 0.035 * (k % 2 ? -1 : 1));
        const f = (p[2] + 1.6) / 3.2;
        const a = (1 - trail / 14) * (0.25 + 0.75 * f);
        ctx.fillStyle = `rgba(${light[0]},${light[1]},${light[2]},${a})`;
        ctx.beginPath(); ctx.arc(p[0], p[1], (trail ? 1.6 : 3) * (0.6 + f), 0, TAU); ctx.fill();
      }
    }
  }

  function drawDust(sc, t, M, size, cx, cy, D, light) {
    const { ctx } = sc;
    const R = rotation(0, t * 0.03, 0);
    for (const p0 of sc.dust) {
      const x0 = R[0] * p0[0] + R[2] * p0[2], z0 = R[6] * p0[0] + R[8] * p0[2];
      const x = M[0] * x0 + M[1] * p0[1] + M[2] * z0;
      const y = M[3] * x0 + M[4] * p0[1] + M[5] * z0;
      const z = M[6] * x0 + M[7] * p0[1] + M[8] * z0;
      const k = D / (D - z * 0.6);
      const f = (z + 2) / 4;
      ctx.fillStyle = `rgba(${light[0]},${light[1]},${light[2]},${0.08 + 0.4 * f * f})`;
      const s = 0.8 + f * 1.4;
      ctx.fillRect(cx + x * size * k - s / 2, cy + y * size * k - s / 2, s, s);
    }
  }

  /* ---------- 3D tilt for cards and cover art ---------- */

  // Delegated so it works on anything rendered later: the element under the
  // pointer rotates toward it on both axes, lifts off the page and a specular
  // glare follows. A damped spring drives it, so it trails the pointer
  // smoothly and settles back with a small overshoot when the pointer leaves.
  function wireTilt(root, selector, maxDeg = 10) {
    const live = new Map();
    let raf = 0, current = null;
    const step = () => {
      raf = 0;
      for (const [el, st] of live) {
        for (const k of ['rx', 'ry', 'lift']) {
          st.v[k] = (st.v[k] + (st.t[k] - st.c[k]) * 0.16) * 0.74;
          st.c[k] += st.v[k];
        }
        const rest = Math.abs(st.c.rx) + Math.abs(st.c.ry) + Math.abs(st.c.lift) + Math.abs(st.v.rx) + Math.abs(st.v.ry);
        if ((!st.hover && rest < 0.02) || !el.isConnected) {
          el.style.transform = ''; el.style.removeProperty('--lift'); el.classList.remove('tilting'); live.delete(el);
          continue;
        }
        el.style.transform = `perspective(700px) rotateX(${st.c.rx.toFixed(2)}deg) rotateY(${st.c.ry.toFixed(2)}deg) translateZ(${(st.c.lift * 18).toFixed(2)}px)`;
        el.style.setProperty('--lift', st.c.lift.toFixed(3));
      }
      if (live.size) raf = requestAnimationFrame(step);
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(step); };
    const release = el => { const st = live.get(el); if (st) { st.hover = false; st.t = { rx: 0, ry: 0, lift: 0 }; kick(); } };
    root.addEventListener('pointermove', e => {
      const el = e.target.closest(selector);
      if (current && current !== el) { release(current); current = null; }
      if (!el || reduceMotion) return;
      current = el;
      let st = live.get(el);
      if (!st) {
        st = { c: { rx: 0, ry: 0, lift: 0 }, v: { rx: 0, ry: 0, lift: 0 }, t: null, hover: true };
        live.set(el, st);
        el.classList.add('tilting');
      }
      const r = el.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
      st.hover = true;
      st.t = { rx: (0.5 - ny) * maxDeg, ry: (nx - 0.5) * maxDeg * 1.2, lift: 1 };
      el.style.setProperty('--gx', (nx * 100).toFixed(1) + '%');
      el.style.setProperty('--gy', (ny * 100).toFixed(1) + '%');
      kick();
    }, { passive: true });
    root.addEventListener('pointerleave', () => { if (current) { release(current); current = null; } });
  }

  /* ---------- number count-up ---------- */

  function countUp(root) {
    for (const el of root.querySelectorAll('[data-count]')) {
      const target = +el.dataset.count;
      if (!isFinite(target)) continue;
      const fmt = v => Math.round(v).toLocaleString();
      if (reduceMotion || target < 2) { el.textContent = fmt(target); continue; }
      const t0 = performance.now(), dur = 900 + Math.min(600, Math.log10(target + 1) * 150);
      const step = now => {
        const p = Math.min(1, (now - t0) / dur);
        el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
        if (p < 1 && el.isConnected) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }

  return {
    mount, wireTilt, countUp, level, systemReduceMotion, onFrame, pointer, program,
    get reduceMotion() { return reduceMotion; },
    get covered() { return covered; },
    // window shown/hidden (main process) and Now Playing fully covering the page
    setWindowVisible: on => { windowVisible = !!on; if (windowVisible && (scenes.size || hooks.size)) kick(); },
    setCovered: on => { covered = !!on; },
    setReduceMotion: on => { reduceMotion = !!on; },
    meshes: { geodesic, torusKnot, torus, fibonacciSphere }
  };
})();
