/* fx/nowplaying.js — the Now Playing sheet as one WebGL2 scene.

   Everything behind the sheet's text is drawn into a single full-sheet
   canvas, in this order:
     1. a domain-warped fBm "fluid" in the cover's three colors, rendered at
        half resolution, which bass hits push outward as soft shock waves
     2. composite at full resolution: film grain, vignette, the slab's contact
        shadow and a bloom behind the play button that breathes with the beat
     3. a log-frequency spectrum of light bars around the cover (in the
        cover's own plane, so it tilts with it)
     4. a glossy floor: cover + record mirrored below, fading with distance
     5. the record (procedural grooves, anisotropic sheen, the cover as its
        label) that slides out from behind the sleeve and spins at 33 1/3 rpm
     6. the cover as a real slab with depth, spring-tilted toward the pointer
     7. ~49k GPU particles (transform feedback): dust advected by a curl-noise
        flow and colored by the cover, plus a 128x128 grid on the cover that
        is released through a noise-threshold dissolve when the track changes

   The DOM <img id="npArt"> stays in place (transparent) for layout, clicks
   and the context menu; its rect drives the 3D cover every frame.
   Rides Fx3D.onFrame (single throttled ticker, overSheet), draws a static
   frame under reduce motion and nothing with Settings > visuals off. */

const NowPlayingFX = (() => {
  const TAU = Math.PI * 2;
  const GRID = 128, N_AMB = 32768, N = N_AMB + GRID * GRID;
  const BARS = 72;
  const RPM33 = 100 / 3 / 60 * TAU;
  const TRANS_MS = 1100;
  const D = 1800; // camera distance in CSS px (like CSS perspective)

  let gl = null, canvas = null, sheet = null, art = null, playBtn = null;
  let R = null; // GL resources
  let live = false;

  const st = {
    w: 0, h: 0, dpr: 1, dirty: true, lastStatic: 0, lastDraw: 0, t0: performance.now(),
    tint: [106, 165, 255], tintT: [106, 165, 255],
    pal: [[106, 165, 255], [64, 96, 190], [140, 110, 220]], palT: null,
    tx: 0, ty: 0, slide: 0, spin: 0, omega: 0, beat: 0,
    waves: [0, 1, 2, 3].map(() => ({ t: -1e9, s: 0 })), lastWave: 0, waveIdx: 0,
    trans: { active: false, reset: false, start: 0 }, hasTex: false, hasOld: false, want: null,
    bins: new Uint8Array(512), spec: new Float32Array(BARS), specBytes: new Uint8Array(BARS),
    src: 0, maxFps: 60
  };
  st.palT = st.pal.map(p => p.slice());

  /* ---------- GLSL ---------- */

  const NOISE = `
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  // the dissolve mask: the cover shader and the particle update agree on it,
  // so a particle leaves exactly where the old cover burns away
  float dissolveN(vec2 uv) { return length(uv - 0.5) * 0.8 + vnoise(uv * 6.0) * 0.28 + vnoise(uv * 23.0 + 3.1) * 0.14 - 0.08; }
  float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }`;

  // world space = CSS px of the sheet, y down, z toward the viewer
  const PROJECT = `
  uniform vec2 uView, uCam;
  uniform float uD;
  vec4 project(vec3 w) {
    float k = (uD - w.z) / uD;
    vec2 s = uCam + (w.xy - uCam) / k;
    return vec4(vec2(s.x / uView.x * 2.0 - 1.0, 1.0 - s.y / uView.y * 2.0) * k, clamp(-w.z / 3000.0, -1.0, 1.0) * k, k);
  }`;

  const FS_TRI_VS = `#version 300 es
  layout(location = 0) in vec2 aQ;
  void main() { gl_Position = vec4(aQ, 0.0, 1.0); }`;

  const FLUID_FS = `#version 300 es
  precision highp float;
  uniform vec2 uRes, uCenter, uPtr;
  uniform float uT, uHalf, uBass;
  uniform vec3 uTint, uP0, uP1, uP2;
  uniform vec4 uWaves[4];
  out vec4 o;
  ${NOISE}
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
    return s;
  }
  void main() {
    vec2 fc = gl_FragCoord.xy;
    float m = min(uRes.x, uRes.y);
    vec2 uv = (fc - 0.5 * uRes) / m;
    vec2 dc = fc - uCenter;
    float r = length(dc);
    vec2 dir = dc / max(r, 1.0);
    // shock waves: a travelling gaussian that pushes the field outward
    float disp = 0.0, ring = 0.0;
    for (int i = 0; i < 4; i++) {
      float age = uWaves[i].x;
      if (age >= 2.4) continue;
      float rad = uHalf * 1.1 + age * m * 0.62;
      float wdt = uHalf * (0.22 + age * 0.4);
      float x = (r - rad) / wdt;
      float env = exp(-x * x) * pow(1.0 - age / 2.4, 2.0) * uWaves[i].y;
      disp += x * env;
      ring += env;
    }
    float t = uT * 0.028;
    vec2 p = uv * 1.2 + uPtr * 0.03 - dir * disp * 0.07;
    vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
    vec2 w = vec2(fbm(p + 1.9 * q + vec2(1.7, 9.2) + 0.7 * t), fbm(p + 1.9 * q + vec2(8.3, 2.8) - 0.6 * t));
    float n = fbm(p + 2.3 * w);
    vec3 col = mix(uP0 * 0.07, uP0 * 0.62, smoothstep(0.2, 0.85, n));
    col = mix(col, uP1 * 0.62, smoothstep(0.35, 0.9, w.x) * 0.75);
    col = mix(col, uP2 * 0.56, smoothstep(0.5, 0.95, q.y) * 0.6);
    // silky ridges where the warped layers line up
    float ridge = smoothstep(0.52, 0.8, n) * smoothstep(0.35, 0.75, w.y);
    col += mix(uP1, vec3(1.0), 0.35) * ridge * ridge * 0.06;
    col *= mix(0.55, 1.0, smoothstep(-0.6, 0.45, uv.y));
    float g = exp(-pow(max(r - uHalf * 0.3, 0.0) / (uHalf * 1.6), 2.0));
    col += uTint * g * (0.1 + uBass * 0.16);
    col += mix(uTint, vec3(1.0), 0.4) * ring * 0.05;
    o = vec4(max(col, 0.0), 1.0);
  }`;

  const COMPOSITE_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uFluid;
  uniform vec2 uRes;
  uniform float uT, uFade;
  uniform vec4 uCover, uPlay;
  uniform vec3 uTint;
  out vec4 o;
  ${NOISE}
  void main() {
    vec2 fc = gl_FragCoord.xy, st = fc / uRes;
    vec3 col = texture(uFluid, st).rgb;
    // the slab's soft shadow on the backdrop (y is up here, so down is -y)
    float h = uCover.z;
    float sd = sdRoundBox(fc - uCover.xy + vec2(0.0, h * 0.14), vec2(h * 0.9), h * 0.1);
    col *= 1.0 - 0.6 * exp(-max(sd, 0.0) / (h * 0.28));
    // play button bloom
    float dp = length(fc - uPlay.xy) / uPlay.z;
    col += mix(uTint, vec3(1.0), 0.5) * exp(-dp * dp * 2.2) * uPlay.w;
    vec2 v = st - 0.5;
    col *= 1.0 - 0.7 * pow(dot(v, v) * 1.7, 1.5);
    col += (hash12(fc + fract(uT * 7.13) * vec2(417.0, 251.0)) - 0.5) * 0.028;
    o = vec4(max(col, 0.0) * uFade, 1.0);
  }`;

  const BOX_VS = `#version 300 es
  layout(location = 0) in vec3 aPos;
  layout(location = 1) in vec3 aNrm;
  layout(location = 2) in vec2 aUv;
  uniform vec3 uCenter, uSize;
  uniform mat3 uRot;
  uniform float uMirror, uFloor;
  ${PROJECT}
  out vec3 vW, vN; out vec2 vUv; out float vFace, vFloorD;
  void main() {
    vec3 w = uCenter + uRot * (aPos * uSize);
    vec3 n = uRot * aNrm;
    vFloorD = 0.0;
    if (uMirror > 0.5) { w.y = 2.0 * uFloor - w.y; n.y = -n.y; vFloorD = w.y - uFloor; }
    vW = w; vN = n; vUv = aUv; vFace = aNrm.z;
    gl_Position = project(w);
  }`;

  const BOX_FS = `#version 300 es
  precision highp float;
  in vec3 vW, vN; in vec2 vUv; in float vFace, vFloorD;
  uniform sampler2D uTex, uTexOld;
  uniform float uHasTex, uHasOld, uTrans, uMirror, uRadius, uReflect;
  uniform vec4 uCropA, uCropB;
  uniform vec3 uTint, uSize, uCamPos, uLight;
  out vec4 o;
  ${NOISE}
  void main() {
    vec3 N = normalize(vN), V = normalize(uCamPos - vW), L = normalize(uLight);
    vec3 H = normalize(L + V);
    float ndl = max(dot(N, L), 0.0), ndh = max(dot(N, H), 0.0);
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
    vec3 col;
    float alpha = 1.0;
    if (vFace > 0.5) {
      vec2 uv = vUv;
      vec2 px = (uv - 0.5) * uSize.xy;
      float sd = sdRoundBox(px, uSize.xy * 0.5, uRadius);
      alpha = 1.0 - smoothstep(-0.8, 0.8, sd);
      vec3 empty = uTint * 0.18 + 0.03;
      vec3 base = uHasTex > 0.5 ? texture(uTex, uCropA.zw + uv * uCropA.xy).rgb : empty;
      if (uTrans < 1.0) {
        vec3 old = uHasOld > 0.5 ? texture(uTexOld, uCropB.zw + uv * uCropB.xy).rgb : empty;
        float n = dissolveN(uv), e = uTrans * 1.3 - 0.15;
        base = mix(old, base, smoothstep(e + 0.012, e - 0.012, n));
        float edge = 1.0 - smoothstep(0.0, 0.022, abs(n - e));
        base += mix(uTint, vec3(1.0), 0.35) * edge * edge * 0.9 * smoothstep(0.0, 0.08, uTrans) * (1.0 - smoothstep(0.85, 1.0, uTrans));
      }
      // clear-coat: a tight highlight, a broad sheen and a moving softbox streak
      vec3 R = reflect(-V, N);
      float streak = exp(-pow((R.x * 0.8 - R.y * 0.6 - 0.1) * 7.0, 2.0));
      float bevel = 1.0 - smoothstep(0.0, 1.6, -sd);
      col = base * (0.93 + 0.07 * ndl)
          + vec3(pow(ndh, 180.0) * 0.5 + pow(ndh, 14.0) * 0.035)
          + vec3(streak * 0.05)
          + mix(uTint, vec3(1.0), 0.6) * fres * 0.25
          + vec3(bevel * 0.16 * (0.4 + 0.6 * ndl));
    } else if (vFace < -0.5) {
      col = vec3(0.02);
    } else {
      // the slab's edge: dark paperboard with a tinted rim light
      col = (vec3(0.045) + uTint * 0.05) * (0.35 + 0.65 * ndl) + vec3(pow(ndh, 40.0) * 0.3) + uTint * fres * 0.25;
    }
    if (uMirror > 0.5) {
      float f = exp(-vFloorD / (uSize.x * 0.14)) * uReflect;
      o = vec4(col * alpha * f, alpha * f);
      return;
    }
    o = vec4(col * alpha, alpha);
  }`;

  const DISC_VS = `#version 300 es
  layout(location = 0) in vec2 aQ;
  uniform vec3 uCenter, uOffset;
  uniform mat3 uRot;
  uniform float uR, uMirror, uFloor;
  ${PROJECT}
  out vec2 vQ; out vec3 vW; out float vFloorD;
  void main() {
    vec3 w = uCenter + uRot * (uOffset + vec3(aQ * uR, 0.0));
    vFloorD = 0.0;
    if (uMirror > 0.5) { w.y = 2.0 * uFloor - w.y; vFloorD = w.y - uFloor; }
    vQ = aQ; vW = w;
    gl_Position = project(w);
  }`;

  const VINYL_FS = `#version 300 es
  precision highp float;
  in vec2 vQ; in vec3 vW; in float vFloorD;
  uniform sampler2D uTex;
  uniform mat3 uRot;
  uniform float uHasTex, uSpin, uR, uMirror, uHalfS, uReflect;
  uniform vec4 uCropA;
  uniform vec3 uTint, uCamPos, uLight, uOffset;
  out vec4 o;
  ${NOISE}
  float aniso(vec3 T, vec3 H, float e) { float th = dot(T, H); return pow(sqrt(max(0.0, 1.0 - th * th)), e); }
  void main() {
    vec2 q = vQ;
    float r = length(q), aa = fwidth(r) * 1.2;
    float alpha = (1.0 - smoothstep(1.0 - aa, 1.0, r)) * smoothstep(0.016, 0.016 + aa, r);
    if (alpha <= 0.001) discard;
    float ang = atan(q.y, q.x);
    vec3 N = uRot * vec3(0.0, 0.0, 1.0);
    vec3 T = normalize(uRot * vec3(-sin(ang), cos(ang), 0.0));
    if (uMirror > 0.5) { N.y = -N.y; T.y = -T.y; }
    vec3 V = normalize(uCamPos - vW), L = normalize(uLight);
    vec3 L2 = normalize(vec3(0.8, 0.35, 0.5));
    vec3 H = normalize(L + V), H2 = normalize(L2 + V);
    float ndh = max(dot(N, H), 0.0);
    vec3 col;
    const float LABEL = 0.335;
    if (r < LABEL) {
      float c = cos(uSpin), s = sin(uSpin);
      vec2 lq = mat2(c, -s, s, c) * q / LABEL;
      vec3 lab = uHasTex > 0.5 ? texture(uTex, uCropA.zw + (lq * 0.5 + 0.5) * uCropA.xy).rgb : uTint * 0.5;
      lab *= 0.82 + 0.18 * smoothstep(LABEL, LABEL - 0.03, r);
      col = lab * 0.9 + vec3(pow(ndh, 60.0) * 0.12);
      col *= smoothstep(0.03, 0.05, r) * 0.6 + 0.4; // spindle ring
    } else {
      float band = (r - 0.37) / (0.965 - 0.37);
      float groovy = step(0.37, r) * step(r, 0.965);
      float gap = 0.0;
      for (int i = 1; i < 7; i++) {
        float gp = float(i) / 7.0 + (hash12(vec2(float(i), 3.7)) - 0.5) * 0.07;
        gap = max(gap, 1.0 - smoothstep(0.0, 0.007, abs(band - gp)));
      }
      groovy *= 1.0 - gap * 0.85;
      // micro grooves, faded to their mean where they get finer than a pixel
      float f = r * uR * 0.85;
      float g = mix(0.5 + 0.5 * sin(f * 6.2832), 0.5, smoothstep(0.3, 0.8, fwidth(f)));
      // wear and pressing variation that turns with the record, so the spin reads
      float spun = ang - uSpin;
      float wear = vnoise(vec2(cos(spun), sin(spun)) * 3.0 + r * 40.0);
      float gloss = mix(0.3, 1.0, groovy * (0.55 + 0.45 * g)) * (0.8 + 0.4 * wear);
      col = vec3(0.016) + uTint * 0.01;
      col += vec3(0.85) * aniso(T, H, 140.0) * gloss * 0.6;
      col += mix(uTint, vec3(1.0), 0.35) * aniso(T, H, 12.0) * gloss * 0.07;
      col += mix(uTint, vec3(1.0), 0.15) * aniso(T, H2, 70.0) * gloss * 0.32;
      col += vec3(pow(ndh, 220.0) * 0.45 * (1.0 - groovy));
      col += vec3(0.05) * (1.0 - smoothstep(0.0, 0.012, abs(r - 0.985)));
    }
    // the sleeve's shadow falls across the record where it tucks behind it
    float cx = uOffset.x + q.x * uR;
    col *= 1.0 - 0.7 * smoothstep(uHalfS + 26.0, uHalfS - 2.0, cx);
    if (uMirror > 0.5) {
      float fr = exp(-vFloorD / (uR * 0.3)) * uReflect;
      o = vec4(col * alpha * fr, alpha * fr);
      return;
    }
    o = vec4(col * alpha, alpha);
  }`;

  // a ring of spectrum bars around the record: bass where the record sticks
  // out (right), highs curling back toward the sleeve, mirrored top/bottom
  const HALO_FS = `#version 300 es
  precision highp float;
  in vec2 vQ;
  uniform sampler2D uSpec;
  uniform float uRec, uExt, uAlpha, uIdle;
  uniform vec3 uTint;
  out vec4 o;
  void main() {
    vec2 p = vQ * uExt;
    float r = length(p);
    float d = r - uRec * 1.035;
    if (d < 0.0 || r > uExt) discard;
    float u = acos(clamp(p.x / max(r, 1e-3), -1.0, 1.0)) / 3.14159265;
    float x = u / 0.72 * ${BARS}.0;
    float bi = min(floor(x), ${BARS}.0 - 1.0);
    float a = texture(uSpec, vec2((bi + 0.5) / ${BARS}.0, 0.5)).r * (1.0 - smoothstep(0.62, 0.72, u));
    float fu = fract(x), fw = fwidth(x);
    float mask = smoothstep(0.25 - fw, 0.25 + fw, fu) * (1.0 - smoothstep(0.75 - fw, 0.75 + fw, fu));
    float len = uRec * (0.008 + a * 0.17);
    float bar = (1.0 - smoothstep(len - 1.5, len, d));
    float glow = exp(-d / (uRec * 0.12)) * (a * 0.5 + uIdle * 0.06);
    float edge = 1.0 - smoothstep(uExt * 0.9, uExt, r);
    vec3 lc = mix(uTint, vec3(1.0), 0.55);
    vec3 col = lc * (bar * mask * (0.05 * uIdle + a * 0.85) * 0.55 + glow * 0.14) * edge;
    o = vec4(col * uAlpha, 0.0);
  }`;

  const UPDATE_VS = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 aPos;
  layout(location = 1) in vec3 aVel;
  layout(location = 2) in vec4 aData;
  uniform float uDt, uT, uKick, uTrans, uHalf, uThick;
  uniform vec2 uView;
  uniform vec3 uCenter;
  uniform mat3 uRot;
  out vec3 oPos; out vec3 oVel; out vec4 oData;
  ${NOISE}
  float psi(vec2 p, float t) { return vnoise(p + vec2(t, -0.7 * t)) + 0.5 * vnoise(p * 2.1 + vec2(-1.3 * t, t) + 17.0); }
  // divergence-free 2D flow: the curl of a scalar noise potential
  vec2 curl(vec2 p, float t) {
    const float e = 0.02;
    return vec2(psi(p + vec2(0.0, e), t) - psi(p - vec2(0.0, e), t), psi(p - vec2(e, 0.0), t) - psi(p + vec2(e, 0.0), t)) / (2.0 * e);
  }
  void main() {
    vec3 p = aPos, v = aVel;
    vec4 d = aData;
    float dt = uDt;
    if (d.w < 0.5) {
      float life = 8.0 + 8.0 * hash12(d.xy * 91.7);
      d.z += dt;
      if (d.z > life || p.x < -120.0 || p.x > uView.x + 120.0 || p.y < -120.0 || p.y > uView.y + 120.0) {
        float s = float(gl_VertexID) * 0.618 + fract(uT * 0.1371) * 997.0;
        p = vec3(vec2(hash12(vec2(s, 1.7)), hash12(vec2(4.1, s))) * uView, mix(-520.0, 180.0, hash12(vec2(s, 7.0 + s * 0.3))));
        v = vec3(0.0);
        d.xy = vec2(hash12(vec2(s + 11.0, 3.3)), hash12(vec2(2.9, s + 5.0)));
        d.z = 0.0;
      }
      vec2 fl = curl(p.xy * 0.0019, uT * 0.035) * 22.0;
      vec3 target = vec3(fl, (vnoise(p.xy * 0.003 + 40.0 + uT * 0.05) - 0.5) * 26.0);
      v += (target - v) * min(1.0, dt * 0.9);
      vec2 rd = p.xy - uCenter.xy;
      float rl = max(length(rd), 1.0);
      v.xy += rd / rl * uKick * 1500.0 * dt * exp(-rl / (uHalf * 3.0));
      p += v * dt;
    } else {
      vec2 uv = d.xy;
      vec3 home = uCenter + uRot * vec3((uv - 0.5) * 2.0 * uHalf, uThick * 0.5 + 1.0);
      if (uTrans <= 0.0) { p = home; v = vec3(0.0); d.z = 0.0; }
      else if (d.z <= 0.0) {
        p = home;
        if (dissolveN(uv) < uTrans * 1.3 - 0.15) {
          vec2 jit = vec2(hash12(uv * 17.3), hash12(uv * 29.1)) - 0.5;
          vec2 dir = normalize(uv - 0.5 + jit * 0.35);
          v = uRot * vec3(dir * (90.0 + 380.0 * hash12(uv * 311.0)), 160.0 + 520.0 * hash12(uv * 57.0));
          d.z = 0.0001;
        }
      } else if (d.z < 4.0) {
        d.z += dt;
        v.xy += curl(p.xy * 0.004, uT * 0.1) * 380.0 * dt;
        v *= exp(-dt * 1.2);
        p += v * dt;
      }
    }
    oPos = p; oVel = v; oData = d;
  }`;

  const NULL_FS = `#version 300 es
  precision lowp float; out vec4 o; void main() { o = vec4(0.0); }`;

  const POINT_VS = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 aPos;
  layout(location = 1) in vec3 aVel;
  layout(location = 2) in vec4 aData;
  uniform sampler2D uTex, uTexOld;
  uniform float uHasTex, uHasOld, uDpr, uKick, uAlpha;
  uniform vec4 uCropA, uCropB;
  uniform vec3 uTint, uP0, uP1;
  ${PROJECT}
  out vec3 vCol;
  ${NOISE}
  void main() {
    float a, size;
    vec3 col;
    if (aData.w < 0.5) {
      float life = 8.0 + 8.0 * hash12(aData.xy * 91.7), age = aData.z;
      a = smoothstep(0.0, 1.5, age) * smoothstep(life, life - 2.0, age);
      vec3 tc = uHasTex > 0.5 ? textureLod(uTex, uCropA.zw + aData.xy * uCropA.xy, 5.0).rgb : uTint;
      col = max(tc, mix(uP0, uP1, hash12(aData.xy * 13.0)) * 0.6) * 1.1 + 0.1;
      float h = hash12(aData.xy * 7.3);
      size = mix(0.9, 2.2, h * h);
      float zf = clamp((aPos.z + 520.0) / 700.0, 0.0, 1.0);
      a *= mix(0.05, 0.26, zf) * (1.0 + uKick * 3.0);
      // motes drifting in front of the slab stay faint so the art reads clean
      a *= aPos.z > 0.0 ? 0.4 : 1.0;
      if (h > 0.988) { size *= 5.0; a *= 0.35; }
    } else {
      float age = aData.z;
      a = age > 0.0 ? pow(max(0.0, 1.0 - age / 0.8), 1.8) * 0.9 : 0.0;
      vec3 tc = uHasOld > 0.5 ? textureLod(uTexOld, uCropB.zw + aData.xy * uCropB.xy, 2.0).rgb : uTint;
      col = tc * 1.15 + uTint * 0.12 + 0.05;
      size = 2.2;
    }
    if (a < 0.003) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); return; }
    vec4 cp = project(aPos);
    gl_Position = cp;
    gl_PointSize = max(1.0, size * uDpr / cp.w);
    vCol = col * a * uAlpha;
  }`;

  const POINT_FS = `#version 300 es
  precision mediump float;
  in vec3 vCol;
  out vec4 o;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float f = 1.0 - smoothstep(0.0, 1.0, dot(q, q));
    o = vec4(vCol * f * 1.7, 0.0);
  }`;

  /* ---------- GL helpers ---------- */

  function program(vs, fs, varyings) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('NowPlayingFX shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('NowPlayingFX link: ' + gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }
  const loc = (pr, n) => pr.u[n] || null;
  const f1 = (pr, n, a) => gl.uniform1f(loc(pr, n), a);
  const f2 = (pr, n, a, b) => gl.uniform2f(loc(pr, n), a, b);
  const f3 = (pr, n, v) => gl.uniform3f(loc(pr, n), v[0], v[1], v[2]);
  const f4 = (pr, n, a, b, c, d) => gl.uniform4f(loc(pr, n), a, b, c, d);
  const i1 = (pr, n, a) => gl.uniform1i(loc(pr, n), a);

  function makeTex(filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.LINEAR_MIPMAP_LINEAR ? gl.LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 20, 24, 255]));
    return t;
  }

  function setup() {
    const r = {};
    r.fluid = program(FS_TRI_VS, FLUID_FS);
    r.comp = program(FS_TRI_VS, COMPOSITE_FS);
    r.box = program(BOX_VS, BOX_FS);
    r.vinyl = program(DISC_VS, VINYL_FS);
    r.halo = program(DISC_VS, HALO_FS);
    r.update = program(UPDATE_VS, NULL_FS, ['oPos', 'oVel', 'oData']);
    r.points = program(POINT_VS, POINT_FS);

    const vao = (data, layout) => {
      const v = gl.createVertexArray();
      gl.bindVertexArray(v);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const stride = layout.reduce((s, n) => s + n, 0) * 4;
      let off = 0;
      layout.forEach((n, i) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, stride, off); off += n * 4; });
      gl.bindVertexArray(null);
      return v;
    };
    r.tri = vao(new Float32Array([-1, -1, 3, -1, -1, 3]), [2]);
    r.quad = vao(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), [2]);

    // unit slab: pos3 nrm3 uv2; the front (+z) face carries the cover's uv
    const box = [];
    const faces = [[[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]]];
    for (const [n, u, v] of faces) {
      const c = (a, b) => [0, 1, 2].map(i => n[i] * 0.5 + u[i] * a + v[i] * b);
      for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) box.push(...c(a, b), ...n, a + 0.5, b + 0.5);
    }
    r.box.vao = vao(new Float32Array(box), [3, 3, 2]);

    r.texA = makeTex(gl.LINEAR_MIPMAP_LINEAR);
    r.texB = makeTex(gl.LINEAR_MIPMAP_LINEAR);
    r.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    r.spec = makeTex(gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, BARS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, st.specBytes);

    r.fluidTex = makeTex(gl.LINEAR);
    r.fbo = gl.createFramebuffer();
    r.fboW = r.fboH = 0;

    // particles: pos3 vel3 data4 (seed/uv.xy, age, kind), ping-ponged through transform feedback
    const init = new Float32Array(N * 10);
    const W = innerWidth, Hh = innerHeight;
    for (let i = 0; i < N; i++) {
      const o = i * 10;
      if (i < N_AMB) {
        init[o] = Math.random() * W; init[o + 1] = Math.random() * Hh; init[o + 2] = -520 + Math.random() * 700;
        init[o + 6] = Math.random(); init[o + 7] = Math.random(); init[o + 8] = Math.random() * 10; init[o + 9] = 0;
      } else {
        const k = i - N_AMB;
        init[o + 6] = (k % GRID + 0.5) / GRID; init[o + 7] = (Math.floor(k / GRID) + 0.5) / GRID; init[o + 8] = 5; init[o + 9] = 1;
      }
    }
    r.pbuf = [0, 1].map(() => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, init, gl.DYNAMIC_DRAW); return b; });
    r.pvao = r.pbuf.map(b => {
      const v = gl.createVertexArray();
      gl.bindVertexArray(v);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      [[0, 3, 0], [1, 3, 12], [2, 4, 24]].forEach(([l, n, off]) => { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, n, gl.FLOAT, false, 40, off); });
      gl.bindVertexArray(null);
      return v;
    });
    r.tf = gl.createTransformFeedback();
    r.cur = 0;
    r.cropA = [1, 1, 0, 0]; r.cropB = [1, 1, 0, 0];
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return r;
  }

  function uploadCover(tex, img) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    if (R.aniso) gl.texParameterf(gl.TEXTURE_2D, R.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  }

  /* ---------- cover changes ---------- */

  function onArtSrc() {
    const src = art.getAttribute('src');
    st.want = src;
    if (!src) { st.hasTex = false; st.dirty = true; return; }
    const img = new Image();
    if (/^https?:/i.test(src) && !src.startsWith(location.origin)) img.crossOrigin = 'anonymous';
    img.src = src;
    img.decode().then(() => {
      if (st.want !== src || !R || gl.isContextLost()) return;
      const animate = st.hasTex && sheet.classList.contains('open') && !Fx3D.reduceMotion && S.settings.npVisuals !== false;
      // the old cover becomes texB, the new one goes into texA
      if (animate) { const t = R.texA; R.texA = R.texB; R.texB = t; R.cropB = R.cropA; }
      try {
        uploadCover(R.texA, img);
        // object-fit: cover, like the <img> it replaces
        const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1, sx = Math.min(1, ih / iw), sy = Math.min(1, iw / ih);
        R.cropA = [sx, sy, (1 - sx) / 2, (1 - sy) / 2];
        st.hasOld = animate;
        st.hasTex = true;
      } catch (err) {
        // a remote cover without CORS: keep going without a texture
        st.hasTex = false; st.hasOld = false;
      }
      if (animate) { st.trans.active = true; st.trans.reset = true; pushWave(1); }
      st.dirty = true;
    }, () => {});
  }

  function pushWave(s) {
    const w = st.waves[st.waveIdx++ % 4];
    w.t = performance.now(); w.s = s;
  }

  /* ---------- spectrum ---------- */

  const binAt = i => 1.2 * Math.pow(340 / 1.2, i / BARS);
  function readSpectrum(dt, playing) {
    const got = playing && typeof AudioEngine !== 'undefined' && AudioEngine.spectrum && AudioEngine.spectrum(st.bins);
    const att = 1 - Math.exp(-dt * 28), rel = 1 - Math.exp(-dt * 4.5);
    for (let i = 0; i < BARS; i++) {
      let v = 0;
      if (got) {
        const lo = binAt(i), hi = binAt(i + 1);
        if (hi - lo < 1) {
          const x = (lo + hi) / 2, k = Math.floor(x), fr = x - k;
          v = st.bins[k] * (1 - fr) + st.bins[k + 1] * fr;
        } else {
          for (let b = Math.floor(lo); b < Math.ceil(hi); b++) v = Math.max(v, st.bins[b]);
        }
        const floor = 0.6 - 0.32 * i / BARS; // highs sit lower in the analyser
        v = Math.pow(Math.max(0, v / 255 - floor) / (1 - floor), 1.5);
      }
      const c = st.spec[i];
      st.spec[i] = c + (v - c) * (v > c ? att : rel);
      st.specBytes[i] = Math.min(255, st.spec[i] * 255) | 0;
    }
  }

  /* ---------- frame ---------- */

  function resize(w, h) {
    st.w = w; st.h = h;
    st.dpr = Math.min(1.5, devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(w * st.dpr));
    canvas.height = Math.max(1, Math.round(h * st.dpr));
    const fw = Math.max(1, Math.round(w * 0.5)), fh = Math.max(1, Math.round(h * 0.5));
    if (fw !== R.fboW || fh !== R.fboH) {
      R.fboW = fw; R.fboH = fh;
      gl.bindTexture(gl.TEXTURE_2D, R.fluidTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, R.fluidTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    st.dirty = true;
  }

  // column-major Ry(ry) * Rx(rx)
  function rotation(rx, ry) {
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
    // rows of Ry*Rx: [cy, sy*sx, sy*cx], [0, cx, -sx], [-sy, cy*sx, cy*cx]
    return new Float32Array([cy, 0, -sy, sy * sx, cx, cy * sx, sy * cx, -sx, cy * cx]);
  }

  // physics springs come from the shared Motion API (fx/motion.js); they only
  // tick while moving, and jump straight to the target under reduce motion
  const springs = {};
  function makeSprings() {
    const mk = (init, cfg) => typeof Motion !== 'undefined' ? Motion.spring(init, { ...cfg, overSheet: true }) : null;
    springs.tilt = mk({ x: 0, y: 0 }, { response: 0.95, damping: 0.5, precision: 0.0005 });
    springs.slide = mk(0, { response: 1.5, damping: 0.8, precision: 0.001 });
    springs.beat = mk(0, { response: 0.5, damping: 0.42, precision: 0.002 });
  }
  // retarget only on a real change, so a resting spring stays off the ticker
  function drive(name, target, eps) {
    const sp = springs[name];
    if (!sp) return typeof target === 'number' ? target : { ...target };
    const cur = sp.target;
    const moved = typeof target === 'number' ? Math.abs(cur - target) > eps : Object.keys(target).some(k => Math.abs(cur[k] - target[k]) > eps);
    if (moved) sp.set(target);
    return sp.value;
  }

  function frame(now, _dt, lv) {
    if (!live || !R || gl.isContextLost()) return;
    const rm = Fx3D.reduceMotion;
    const playing = typeof P !== 'undefined' && P.playing;
    if (playing !== st.wasPlaying) { st.wasPlaying = playing; st.dirty = true; }
    if (rm) {
      if (!st.dirty && now - st.lastStatic < 1000) return;
      st.lastStatic = now;
    } else if (now - st.lastDraw < 1000 / (playing || st.trans.active ? st.maxFps : 20) - 1) {
      return; // paused: 20 fps is plenty for slow drift
    }
    st.dirty = false;
    const dt = rm ? 0 : Math.min(0.05, (now - (st.lastDraw || now)) / 1000);
    st.lastDraw = now;

    const sr = sheet.getBoundingClientRect();
    if (Math.abs(sr.width - st.w) > 0.5 || Math.abs(sr.height - st.h) > 0.5 || Math.min(1.5, devicePixelRatio || 1) !== st.dpr) resize(sr.width, sr.height);
    if (!st.w || !st.h) return;
    const ar = art.getBoundingClientRect(), pr = playBtn.getBoundingClientRect();
    const Sz = ar.width || Math.min(st.w, st.h) * 0.44;
    const cx = ar.left - sr.left + ar.width / 2, cy = ar.top - sr.top + ar.height / 2;
    const lyrics = sheet.classList.contains('lyrics');
    const t = rm ? 40 : (now - st.t0) / 1000;
    const lvl = playing ? lv : { bass: 0, kick: 0, mid: 0, treble: 0 };

    // springs and easing
    const ptr = Fx3D.pointer;
    const tilt = drive('tilt', { x: rm ? 0 : -ptr.y * 0.1, y: rm ? 0 : ptr.x * 0.15 }, 0.0005);
    st.tx = tilt.x; st.ty = tilt.y;
    st.slide = drive('slide', playing ? (lyrics ? 0.26 : 0.5) : 0, 0.001);
    st.beat = drive('beat', rm ? 0 : Math.min(1, lvl.bass * 0.55 + lvl.kick * 2.6), 0.004);
    st.omega += ((playing ? RPM33 : 0) - st.omega) * (rm ? 1 : 1 - Math.exp(-dt * 1.7));
    st.spin = (st.spin + st.omega * dt) % TAU;
    const ease = rm ? 1 : 1 - Math.exp(-dt * 2.2);
    for (let i = 0; i < 3; i++) {
      st.tint[i] += (st.tintT[i] - st.tint[i]) * ease;
      for (let k = 0; k < 3; k++) st.pal[k][i] += (st.palT[k][i] - st.pal[k][i]) * ease;
    }
    const tint = st.tint.map(v => v / 255), pal = st.pal.map(c => c.map(v => v / 255));

    if (!rm && playing && lv.kick > 0.12 && now - st.lastWave > 420) { st.lastWave = now; pushWave(Math.min(1, 0.3 + lv.kick * 3)); }
    readSpectrum(dt || 0.016, playing && !rm);

    let trans = 1;
    if (st.trans.active) {
      if (st.trans.reset) { st.trans.reset = false; st.trans.start = now; trans = 0; }
      else {
        trans = Math.min(1, (now - st.trans.start) / TRANS_MS);
        if (now - st.trans.start > TRANS_MS + 1100) { st.trans.active = false; st.hasOld = false; }
      }
    }

    const scale = 1 + st.beat * 0.012;
    const S = Sz * scale, thick = Math.max(6, S * 0.028);
    const lift = 18;
    const center = [cx, cy, lift];
    const rot = rotation(st.tx, st.ty);
    const floorY = cy + S / 2 + S * 0.03;
    const cam = [st.w / 2, st.h * 0.42];
    const camPos = [cam[0], cam[1], D];
    const light = [-0.45 + ptr.x * 0.15, -0.75, 0.6];
    const W = canvas.width, H = canvas.height, k = st.dpr;
    const reflect = lyrics ? 0.06 : 0.1;

    const common = pr_ => { f2(pr_, 'uView', st.w, st.h); f2(pr_, 'uCam', cam[0], cam[1]); f1(pr_, 'uD', D); };

    // 1. fluid at half resolution
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbo);
    gl.viewport(0, 0, R.fboW, R.fboH);
    let p = R.fluid;
    gl.useProgram(p.p);
    const fs = R.fboW / st.w;
    f2(p, 'uRes', R.fboW, R.fboH);
    f2(p, 'uCenter', cx * fs, (st.h - cy) * fs);
    f2(p, 'uPtr', rm ? 0 : ptr.x, rm ? 0 : -ptr.y);
    f1(p, 'uT', t); f1(p, 'uHalf', S / 2 * fs); f1(p, 'uBass', Math.max(0, st.beat));
    f3(p, 'uTint', tint); f3(p, 'uP0', pal[0]); f3(p, 'uP1', pal[1]); f3(p, 'uP2', pal[2]);
    const wv = new Float32Array(16);
    st.waves.forEach((w, i) => { wv[i * 4] = rm ? 9 : (now - w.t) / 1000; wv[i * 4 + 1] = w.s; });
    gl.uniform4fv(loc(p, 'uWaves'), wv);
    gl.bindVertexArray(R.tri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    p = R.comp;
    gl.useProgram(p.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.fluidTex);
    i1(p, 'uFluid', 0);
    f2(p, 'uRes', W, H); f1(p, 'uT', t); f1(p, 'uFade', 1);
    f4(p, 'uCover', cx * k, (st.h - cy) * k, S / 2 * k, 0);
    const bloom = playing ? 0.1 + st.beat * 0.34 : 0.05;
    f4(p, 'uPlay', (pr.left - sr.left + pr.width / 2) * k, (st.h - (pr.top - sr.top + pr.height / 2)) * k, Math.max(20, pr.width) * k, pr.width ? bloom : 0);
    f3(p, 'uTint', tint);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const vinylR = S * 0.48, vinylOff = [st.slide * S * 0.52, 0, -thick / 2 - 2];
    // 3. spectrum ring, just behind the record so it slides and tilts with it
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    p = R.halo;
    gl.useProgram(p.p); common(p);
    const ext = vinylR * 1.3;
    f3(p, 'uCenter', center); gl.uniformMatrix3fv(loc(p, 'uRot'), false, rot);
    f3(p, 'uOffset', [vinylOff[0], 0, vinylOff[2] - 3]); f1(p, 'uR', ext); f1(p, 'uMirror', 0);
    f1(p, 'uRec', vinylR); f1(p, 'uExt', ext); f1(p, 'uAlpha', (lyrics ? 0.6 : 1) * Math.min(1, st.slide * 2.5)); f1(p, 'uIdle', playing ? 1 : 0.5);
    f3(p, 'uTint', tint);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.spec);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BARS, 1, gl.RED, gl.UNSIGNED_BYTE, st.specBytes);
    i1(p, 'uSpec', 0);
    gl.bindVertexArray(R.quad);
    if (st.slide > 0.01) gl.drawArrays(gl.TRIANGLES, 0, 6);

    const drawVinyl = mirror => {
      p = R.vinyl;
      gl.useProgram(p.p); common(p);
      f3(p, 'uCenter', center); gl.uniformMatrix3fv(loc(p, 'uRot'), false, rot);
      f3(p, 'uOffset', vinylOff); f1(p, 'uR', vinylR); f1(p, 'uMirror', mirror); f1(p, 'uFloor', floorY);
      f1(p, 'uSpin', st.spin); f1(p, 'uHalfS', S / 2); f1(p, 'uReflect', reflect);
      f1(p, 'uHasTex', st.hasTex ? 1 : 0); f4(p, 'uCropA', ...R.cropA);
      f3(p, 'uTint', tint); f3(p, 'uCamPos', camPos); f3(p, 'uLight', light);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.texA); i1(p, 'uTex', 0);
      gl.bindVertexArray(R.quad);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const drawBox = mirror => {
      p = R.box;
      gl.useProgram(p.p); common(p);
      f3(p, 'uCenter', center); f3(p, 'uSize', [S, S, thick]); gl.uniformMatrix3fv(loc(p, 'uRot'), false, rot);
      f1(p, 'uMirror', mirror); f1(p, 'uFloor', floorY); f1(p, 'uReflect', reflect);
      f1(p, 'uHasTex', st.hasTex ? 1 : 0); f1(p, 'uHasOld', st.hasOld ? 1 : 0); f1(p, 'uTrans', trans);
      f4(p, 'uCropA', ...R.cropA); f4(p, 'uCropB', ...R.cropB);
      f1(p, 'uRadius', Math.min(8, S * 0.018));
      f3(p, 'uTint', tint); f3(p, 'uCamPos', camPos); f3(p, 'uLight', light);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.texA); i1(p, 'uTex', 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.texB); i1(p, 'uTexOld', 1);
      gl.bindVertexArray(R.box.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 36);
      gl.activeTexture(gl.TEXTURE0);
    };

    // 4. the glossy floor: mirrored record then slab, painter's order
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (st.slide > 0.01) drawVinyl(1);
    drawBox(1);

    // 5-6. record and slab, depth tested; alpha-to-coverage smooths the round edges
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    if (st.slide > 0.01) drawVinyl(0);
    drawBox(0);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);

    // 7. particles: advance (transform feedback), then draw additively
    if (!rm && dt > 0) {
      p = R.update;
      gl.useProgram(p.p);
      f1(p, 'uDt', dt); f1(p, 'uT', t); f1(p, 'uKick', Math.min(0.4, lvl.kick)); f1(p, 'uTrans', st.trans.active ? trans : 1);
      f1(p, 'uHalf', S / 2); f1(p, 'uThick', thick); f2(p, 'uView', st.w, st.h);
      f3(p, 'uCenter', center); gl.uniformMatrix3fv(loc(p, 'uRot'), false, rot);
      const src = R.cur, dst = 1 - src;
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.bindVertexArray(R.pvao[src]);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, R.tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, R.pbuf[dst]);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, N);
      gl.endTransformFeedback();
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.disable(gl.RASTERIZER_DISCARD);
      R.cur = dst;
    }
    p = R.points;
    gl.useProgram(p.p); common(p);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    f1(p, 'uDpr', k); f1(p, 'uKick', Math.min(0.4, lvl.kick)); f1(p, 'uAlpha', lyrics ? 0.6 : 1);
    f1(p, 'uHasTex', st.hasTex ? 1 : 0); f1(p, 'uHasOld', st.hasOld ? 1 : 0);
    f4(p, 'uCropA', ...R.cropA); f4(p, 'uCropB', ...R.cropB);
    f3(p, 'uTint', tint); f3(p, 'uP0', pal[0]); f3(p, 'uP1', pal[1]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.texA); i1(p, 'uTex', 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.texB); i1(p, 'uTexOld', 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(R.pvao[R.cur]);
    gl.drawArrays(gl.POINTS, 0, N);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /* ---------- lyrics: sweep, depth and a spring scroll ---------- */

  const lyr = { el: null, spring: null, userUntil: 0 };
  function scrollLyricsTo(scroller, target) {
    if (lyr.el !== scroller || !lyr.spring) {
      if (lyr.spring) lyr.spring.stop();
      lyr.el = scroller;
      lyr.spring = typeof Motion !== 'undefined' ? Motion.spring(scroller.scrollTop, {
        response: 0.7, damping: 0.86, precision: 0.4, overSheet: true,
        onUpdate: v => { if (lyr.el && lyr.el.isConnected && performance.now() >= lyr.userUntil) lyr.el.scrollTop = v; }
      }) : null;
    }
    if (!lyr.spring || Fx3D.reduceMotion) { scroller.scrollTop = target; return; }
    // start from wherever the reader left it
    if (!lyr.spring.active) lyr.spring.jump(scroller.scrollTop);
    lyr.spring.set(target);
  }

  // Called by lyricsTick (player.js) when the active line changes. Returns
  // true when it handled the scroll for this container.
  function lyrics(container, idx, t, data) {
    if (!container || container.id !== 'npLyrics') return false;
    const scroller = container.querySelector('.lyr-scroll');
    if (!scroller) return false;
    if (!scroller.dataset.npWired) {
      scroller.dataset.npWired = '1';
      const user = () => { lyr.userUntil = performance.now() + 2500; };
      scroller.addEventListener('wheel', user, { passive: true });
      scroller.addEventListener('pointerdown', user, { passive: true });
    }
    const lines = scroller.querySelectorAll('.lyr-line');
    lines.forEach((el, i) => { const d = idx < 0 ? 3 : Math.min(5, Math.abs(i - idx)); if (el.dataset.d !== String(d)) { el.dataset.d = d; el.style.setProperty('--d', d); } });
    const el = lines[idx];
    if (!el) return true;
    const start = data.synced[idx][0], next = data.synced[idx + 1];
    const dur = Math.max(0.6, Math.min(9, (next ? next[0] : start + 4) - start - 0.15));
    el.style.setProperty('--lyr-dur', dur.toFixed(2) + 's');
    el.style.setProperty('--lyr-delay', (-Math.max(0, t + 0.25 - start)).toFixed(2) + 's');
    if (!sheet.classList.contains('lyrics') || !sheet.classList.contains('open')) {
      scroller.scrollTop = el.offsetTop - scroller.clientHeight / 2 + el.offsetHeight / 2;
      return true;
    }
    if (performance.now() < lyr.userUntil) return true;
    scrollLyricsTo(scroller, Math.max(0, el.offsetTop - scroller.clientHeight / 2 + el.offsetHeight / 2));
    return true;
  }

  /* ---------- init ---------- */

  function init() {
    sheet = document.getElementById('nowPlaying');
    art = document.getElementById('npArt');
    playBtn = document.getElementById('npPlay');
    if (!sheet || !art || !playBtn || typeof Fx3D === 'undefined' || !Fx3D.onFrame) return null;
    canvas = document.createElement('canvas');
    canvas.className = 'np-gl';
    canvas.setAttribute('aria-hidden', 'true');
    gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) return null;
    try { R = setup(); } catch (err) { console.warn('NowPlayingFX: falling back', err); gl.getExtension('WEBGL_lose_context')?.loseContext(); return null; }
    const fx = document.getElementById('npFx');
    if (fx) fx.after(canvas); else sheet.prepend(canvas);
    document.documentElement.classList.add('np-gl');
    live = true;
    makeSprings();

    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); live = false; });
    canvas.addEventListener('webglcontextrestored', () => {
      try { R = setup(); st.w = st.h = 0; st.hasTex = false; live = true; onArtSrc(); } catch (err) { console.warn('NowPlayingFX restore failed', err); }
    });
    new MutationObserver(onArtSrc).observe(art, { attributes: true, attributeFilter: ['src'] });
    onArtSrc();
    new MutationObserver(() => { st.dirty = true; }).observe(sheet, { attributes: true, attributeFilter: ['class'] });
    addEventListener('resize', () => { st.dirty = true; });

    Fx3D.onFrame(frame, { overSheet: true, visible: () => sheet.classList.contains('open') && S.settings.npVisuals !== false });

    // the session may have restored a track before this scene existed
    const t0 = typeof cur === 'function' && cur();
    if (t0 && t0.cover) {
      vibrantColor(t0.cover).then(rgb => { if (P.currentId === t0.id) st.tintT = rgb.slice(); });
      coverPalette(t0.cover).then(pal => { if (P.currentId === t0.id) st.palT = pal.slice(0, 3).map(c => c.slice()); });
    }
    return {
      setColor: rgb => { if (rgb) { st.tintT = rgb.slice(); st.dirty = true; } },
      setPalette: pal => { if (pal) { st.palT = pal.slice(0, 3).map(c => c.slice()); st.dirty = true; } },
      burst: () => { if (!Fx3D.reduceMotion) pushWave(1); },
      destroy: () => { live = false; }
    };
  }

  return {
    init, lyrics,
    // the 3D scene draws the cover itself (crossfadeArt skips its DOM swing)
    ownsCover: () => live && S.settings.npVisuals !== false,
    // debugging aid: { live, particles, hasTex, trans, w, h, dpr, lastDraw, slide }
    get stats() { return { live, particles: N, hasTex: st.hasTex, trans: st.trans.active, w: st.w, h: st.h, dpr: st.dpr, lastDraw: Math.round(st.lastDraw), slide: st.slide }; },
    // cap for the scene while playing (the shared ticker already caps at 120)
    setMaxFps: fps => { st.maxFps = Math.max(15, Math.min(120, fps || 120)); }
  };
})();
