/* fx/artiststage.js — a custom 3D piece per artist, standing to the right of
   the name in the artist hero (in place of the record crate).

   Each artist is one file in js/artists/ that calls ArtistStage.register()
   with a fragment shader. The stage prepends PRELUDE (uniforms + SDF helpers)
   and owns everything else: its own small WebGL2 canvas, the shared Fx3D
   ticker (so the tray/minimise pause, sheet-cover skip and fps cap apply),
   audio levels, drag-to-spin with inertia, click "poke", the intro, and
   handing the context back when the page goes away.

   Uniforms every piece gets:
     uRes      canvas size in px
     uT        seconds since mount (frozen under reduce motion)
     uRot      yaw, pitch in radians (auto motion + drag + pointer parallax)
     uIn       intro, 0 -> 1 with a little overshoot
     uBeat     a spring on the bass/kick: overshoots and settles on each hit
     uBass, uMid, uTreble, uKick   raw audio levels (0 when nothing plays)
     uPoke     a spring kicked by clicking the piece
     uHover    0..1, eased, pointer over the piece
     uTint     the page tint (from the artist photo), 0..1 rgb */

const ArtistStage = (() => {
  if (typeof Fx3D === 'undefined') return { register() {}, mount: () => false, has: () => false };
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
  const defs = new Map();

  const VS = `#version 300 es
  const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;

  const PRELUDE = `#version 300 es
  precision highp float;
  uniform vec2 uRes, uRot;
  uniform float uT, uIn, uBeat, uBass, uMid, uTreble, uKick, uPoke, uHover;
  uniform vec3 uTint;
  out vec4 o;
  #define PI 3.14159265
  mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
  float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash31(vec3 p) { p = fract(p * .1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  vec3 hash33(vec3 p) { p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), u.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), u.x), u.y),
               mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), u.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), u.x), u.y), u.z);
  }
  float smin(float a, float b, float k) { float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
  float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.) / k1; }
  float sdTorus(vec3 p, float R, float r) { return length(vec2(length(p.xz) - R, p.y)) - r; }
  // iq's round cone: a capsule whose radius runs r1 at a to r2 at b
  float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
    vec3 ba = b - a; float l2 = dot(ba, ba), rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1. / l2;
    vec3 pa = p - a; float y = dot(pa, ba), z = y - l2;
    vec3 xv = pa * l2 - ba * y; float x2 = dot(xv, xv), y2 = y * y * l2, z2 = z * z * l2;
    float k = sign(rr) * rr * rr * x2;
    if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
    if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
    return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
  }
  // camera on +z looking at the origin; uv is height-normalised
  void camRay(vec2 fc, float dist, float focal, out vec3 ro, out vec3 rd, out vec2 uv) {
    uv = (fc - .5 * uRes) / uRes.y;
    ro = vec3(0., 0., dist);
    rd = normalize(vec3(uv, -focal));
  }
  // ray vs sphere, returns (near, far) or (-1) on a miss: skip empty pixels cheaply
  vec2 bound(vec3 ro, vec3 rd, vec3 c, float r) {
    vec3 oc = ro - c; float b = dot(oc, rd), h = b * b - dot(oc, oc) + r * r;
    if (h < 0.) return vec2(-1.);
    h = sqrt(h); return vec2(-b - h, -b + h);
  }
  // dark studio with a big key softbox up-left and a tinted strip on the right
  vec3 studio(vec3 d) {
    vec3 c = mix(vec3(.015, .016, .02), vec3(.06, .065, .08), smoothstep(-.4, .9, d.y));
    c += vec3(1.) * 2.2 * smoothstep(.86, .97, dot(d, normalize(vec3(-.55, .65, .5))));
    c += uTint * 1.6 * smoothstep(.9, .985, dot(d, normalize(vec3(.9, .05, .25))));
    c += vec3(1., .95, .9) * .5 * smoothstep(.93, .99, dot(d, normalize(vec3(.2, .95, -.2))));
    return c;
  }
  // 1 in the middle, 0 at the canvas edges: backdrop light (glows, beams,
  // shadows) must fade out before the edge or the canvas shows as a box
  float stageFade() {
    vec2 f = gl_FragCoord.xy / uRes;
    vec2 e = smoothstep(0., .22, f) * smoothstep(0., .22, 1. - f);
    return e.x * e.y;
  }
  #line 1
  `;

  /* A piece: { id, names: [...], title, fs, mode: 'turntable'|'sway', spin, fps, scale } */
  function register(def) {
    const d = Object.assign({ mode: 'sway', spin: 0.35, fps: 30, scale: 0.8, pitch: 0 }, def);
    for (const n of d.names || []) defs.set(norm(n), d);
  }
  const get = name => defs.get(norm(name)) || null;

  let cur = null;

  function unmount() {
    if (!cur) return;
    const c = cur; cur = null;
    c.unsub && c.unsub();
    c.ro.disconnect(); c.io.disconnect();
    try { c.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
    c.wrap.remove();
    c.head.classList.remove('has-stage');
  }

  function readTint(page) {
    const v = page && getComputedStyle(page).getPropertyValue('--tint');
    const m = v && v.match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
    return m ? [m[1] / 255, m[2] / 255, m[3] / 255] : null;
  }

  function mount(head, name, enter) {
    unmount();
    const def = get(name);
    if (!def || !head) return false;
    const wrap = document.createElement('div');
    wrap.className = 'as-stage';
    wrap.dataset.piece = def.id;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', def.title || name);
    wrap.appendChild(canvas);
    if (def.title) wrap.insertAdjacentHTML('beforeend', `<div class="as-cap"><span class="as-title">${esc(def.title)}</span>${def.note ? `<span class="as-note">${esc(def.note)}</span>` : ''}</div>`);

    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: 'low-power' });
    if (!gl) return false;
    let P;
    try { P = Fx3D.program(gl, VS, PRELUDE + def.fs); }
    catch (err) { console.warn('ArtistStage: ' + def.id + ' shader failed', err); return false; }
    const vao = gl.createVertexArray();

    if (enter) wrap.classList.add('entering');
    head.appendChild(wrap);
    head.classList.add('has-stage');

    const page = head.closest('.page');
    const c = cur = {
      def, head, wrap, canvas, gl, P, vao, lost: false,
      w: 0, h: 0, dpr: 1, onScreen: true, dirty: true,
      t0: performance.now(), enter: enter && !Fx3D.reduceMotion,
      tint: readTint(page) || [0.35, 0.45, 0.9], tintTarget: null, tintAt: 0,
      yaw: 0, pitch: 0, yawV: 0, dragYaw: 0, dragPitch: 0, px: 0, py: 0,
      beat: 0, beatV: 0, poke: 0, pokeV: 0, hover: 0, hovering: false, drag: null
    };
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); c.lost = true; });

    const size = () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      c.dpr = Math.min(devicePixelRatio || 1, 1.5) * def.scale;
      c.w = r.width; c.h = r.height;
      const W = Math.max(1, Math.round(r.width * c.dpr)), H = Math.max(1, Math.round(r.height * c.dpr));
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      c.dirty = true;
    };
    c.ro = new ResizeObserver(size); c.ro.observe(canvas);
    c.io = new IntersectionObserver(es => { c.onScreen = es[es.length - 1].isIntersecting; if (c.onScreen) c.dirty = true; });
    c.io.observe(canvas);

    // drag to spin (inertia on release), click to poke
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      c.drag = { x: e.clientX, y: e.clientY, moved: 0, t: performance.now() };
      c.yawV = 0; c.dirty = true;
      wrap.classList.add('grabbing');
    });
    canvas.addEventListener('pointermove', e => {
      if (!c.drag) return;
      const dx = e.clientX - c.drag.x, dy = e.clientY - c.drag.y;
      c.drag.x = e.clientX; c.drag.y = e.clientY; c.drag.moved += Math.abs(dx) + Math.abs(dy);
      c.dragYaw += dx * 0.012;
      c.dragPitch = clamp(c.dragPitch + dy * 0.008, -0.7, 0.7);
      c.yawV = dx * 0.012 * 60 * 0.5 + c.yawV * 0.5;
      c.dirty = true;
    });
    const release = e => {
      if (!c.drag) return;
      if (c.drag.moved < 4) { c.pokeV += 9; c.yawV += def.mode === 'turntable' ? 7 : 0; }
      c.drag = null; c.dirty = true;
      wrap.classList.remove('grabbing');
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    wrap.addEventListener('pointerenter', () => { c.hovering = true; c.dirty = true; });
    wrap.addEventListener('pointerleave', () => { c.hovering = false; c.dirty = true; });

    c.unsub = Fx3D.onFrame((now, dt, lv) => {
      if (!canvas.isConnected) { if (cur === c) unmount(); return; }
      if (c.lost || !c.w) return;
      const reduce = Fx3D.reduceMotion;
      if (reduce && !c.dirty) return;
      c.dirty = false;
      step(c, now, dt || 1 / 30, lv, reduce, page);
      draw(c, now, lv, reduce);
    }, { fps: def.fps, visible: () => c.onScreen || !canvas.isConnected });  // detached: run once more to clean up

    size();
    return true;
  }

  // springs: x'' = -k (x - target) - d x'
  function spring(x, v, target, k, d, dt) {
    const a = -k * (x - target) - d * v;
    v += a * dt; x += v * dt;
    return [x, v];
  }

  function step(c, now, dt, lv, reduce, page) {
    const def = c.def;
    // page tint arrives async (vibrantColor); re-read it now and then, ease towards it
    if (now - c.tintAt > 700) { c.tintAt = now; c.tintTarget = readTint(page) || c.tintTarget; }
    if (c.tintTarget) for (let i = 0; i < 3; i++) c.tint[i] += (c.tintTarget[i] - c.tint[i]) * (reduce ? 1 : 0.06);

    if (reduce) { c.beat = 0; c.poke = 0; c.hover = c.hovering ? 1 : 0; return; }
    // hold on to the ticker while anything is still settling
    c.hover += ((c.hovering ? 1 : 0) - c.hover) * Math.min(1, dt * 8);

    // spin: turntable keeps whatever you flick it with and drifts back to its
    // cruise speed; sway pieces look around and ease back to facing you
    if (!c.drag) {
      if (def.mode === 'turntable') {
        c.yawV += (def.spin - c.yawV) * Math.min(1, dt * 0.9);
        c.dragYaw += c.yawV * dt;
      } else {
        c.dragYaw += c.yawV * dt;
        c.yawV *= Math.pow(0.04, dt);
        c.dragYaw += (0 - c.dragYaw) * Math.min(1, dt * 1.6);
      }
      c.dragPitch += (0 - c.dragPitch) * Math.min(1, dt * 2);
    }
    c.px += (Fx3D.pointer.x - c.px) * Math.min(1, dt * 3);
    c.py += (Fx3D.pointer.y - c.py) * Math.min(1, dt * 3);

    [c.beat, c.beatV] = spring(c.beat, c.beatV, Math.min(1.2, lv.kick * 2.4 + lv.bass * 0.25), 170, 11, dt);
    [c.poke, c.pokeV] = spring(c.poke, c.pokeV, 0, 120, 7, dt);
  }

  const backOut = x => { const s = 1.5; x -= 1; return x * x * ((s + 1) * x + s) + 1; };

  function draw(c, now, lv, reduce) {
    const { gl, P, def } = c, U = P.u;
    const t = reduce ? 12 : (now - c.t0) / 1000;
    const e = c.enter ? clamp((t - 0.25) / 1.1, 0, 1) : 1;
    const sway = def.mode === 'sway' && !reduce ? Math.sin(t * 0.45) * 0.42 + Math.sin(t * 0.23 + 1) * 0.18 : 0;
    const yaw = c.dragYaw + sway + c.px * 0.25 + (c.enter ? (1 - e) * (1 - e) * -2.4 : 0);
    const pitch = def.pitch + c.dragPitch + c.py * 0.12;

    gl.viewport(0, 0, c.canvas.width, c.canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(P.p);
    const set1 = (n, v) => U[n] != null && gl.uniform1f(U[n], v);
    U.uRes && gl.uniform2f(U.uRes, c.canvas.width, c.canvas.height);
    U.uRot && gl.uniform2f(U.uRot, yaw, pitch);
    U.uTint && gl.uniform3f(U.uTint, c.tint[0], c.tint[1], c.tint[2]);
    set1('uT', t);
    set1('uIn', e >= 1 ? 1 : backOut(e));
    set1('uBeat', c.beat);
    set1('uPoke', c.poke);
    set1('uHover', c.hover);
    const a = reduce ? { bass: 0, mid: 0, treble: 0, kick: 0 } : lv;
    set1('uBass', a.bass); set1('uMid', a.mid); set1('uTreble', a.treble); set1('uKick', a.kick);
    gl.bindVertexArray(c.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    if (c.enter && e < 1) c.dirty = true;
  }

  return {
    register, mount, unmount,
    has: name => !!get(name),
    get pieces() { return [...new Set(defs.values())].map(d => d.id); },
    get state() { return cur ? { piece: cur.def.id, w: cur.canvas.width, h: cur.canvas.height, lost: cur.lost } : null; }
  };
})();
