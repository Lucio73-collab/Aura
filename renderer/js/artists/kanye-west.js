/* Kanye West — the Dropout Bear.
   The mascot from The College Dropout through Graduation, as a flocked
   designer-vinyl toy head with a gold halo floating over it (Jesus Is King,
   Sunday Service). It looks around on its own, nods on the kick, blinks now
   and then, and squashes when you poke it. Drag to turn it. */

ArtistStage.register({
  id: 'kanye-west',
  names: ['Kanye West', 'Ye', 'Kanye'],
  title: 'Dropout Bear',
  note: 'Drag to turn · click to poke',
  mode: 'sway',
  pitch: 0.06,
  fps: 30,
  fs: `
  float gMat;          // 1 flock, 2 gloss black (eyes, nose), 3 gold halo
  float gBlink;

  float map(vec3 p) {
    vec3 q = vec3(abs(p.x), p.y, p.z);
    float head = sdEllipsoid(p, vec3(1.0, .9, .86));
    float ear = sdEllipsoid(q - vec3(.68, .74, -.12), vec3(.34, .34, .2));
    float d = smin(head, ear, .1);
    float muzzle = sdEllipsoid(p - vec3(0., -.3, .66), vec3(.45, .33, .33));
    d = smin(d, muzzle, .12);
    // a soft groove under the nose
    d += .012 * (1. - smoothstep(0., .05, abs(p.x))) * (1. - smoothstep(.0, .12, abs(p.y + .36))) * step(.5, p.z);
    float nose = sdEllipsoid(p - vec3(0., -.17, .98), vec3(.17, .115, .1));
    float eye = sdEllipsoid(q - vec3(.34, .13, .765), vec3(.085, .1 * gBlink, .07));
    float feat = min(nose, eye);
    // halo: bobs on its own, lifts on the beat
    vec3 hp = p - vec3(0., 1.28 + .04 * sin(uT * 1.3) + uBeat * .06, -.05);
    hp.yz *= rot(.28);
    float halo = sdTorus(hp, .56, .035);
    float m = min(d, min(feat, halo));
    gMat = m == halo ? 3. : m == feat ? 2. : 1.;
    return m;
  }

  vec3 calcNormal(vec3 p) {
    const vec2 k = vec2(1, -1) * .0015;
    return normalize(k.xyy * map(p + k.xyy) + k.yyx * map(p + k.yyx) + k.yxy * map(p + k.yxy) + k.xxx * map(p + k.xxx));
  }

  float calcAO(vec3 p, vec3 n) {
    float occ = 0., sca = 1.;
    for (int i = 1; i <= 4; i++) {
      float h = .03 + .09 * float(i);
      occ += (h - map(p + n * h)) * sca; sca *= .7;
    }
    return clamp(1. - 2.2 * occ, 0., 1.);
  }

  void main() {
    vec3 ro, rd; vec2 uv;
    camRay(gl_FragCoord.xy, 5.6, 1.62, ro, rd, uv);
    float x = fract(uT * .23);
    gBlink = 1. - .9 * exp(-pow((x - .97) * 70., 2.)) - .9 * exp(-pow((x - .995) * 90., 2.));

    // object transform: intro scale, poke squash, head nod on the beat
    float s = max(uIn, .001);
    vec3 off = vec3(0., -.22 + (1. - uIn) * -.4 - uBeat * .05, 0.);
    float nod = uBeat * .22 + uPoke * .05;
    float squash = 1. + uPoke * .08;

    vec3 col = vec3(0.); float alpha = 0.;
    // backdrop: a warm glow and the halo's light pooling behind the head
    float r2 = dot(uv - vec2(0., .06), uv - vec2(0., .06));
    vec3 glow = mix(uTint, vec3(1., .72, .35), .35) * exp(-r2 * 7.) * (.22 + uBass * .25 + uHover * .08);
    glow += vec3(1., .78, .4) * exp(-dot(uv - vec2(0., .28), uv - vec2(0., .28)) * 30.) * (.1 + uBeat * .25);
    // contact shadow under the floating head
    float sh = exp(-pow((uv.x) * 3.2, 2.) - pow((uv.y + .42) * 18., 2.)) * .5 * uIn;

    vec2 bb = bound(ro, rd, off + vec3(0., .25, 0.), 1.55 * s);
    float mind = 1e9, tm = 0.;
    if (bb.y > 0.) {
      float t = max(bb.x, 0.);
      bool hit = false;
      for (int i = 0; i < 96; i++) {
        vec3 p = ro + rd * t - off;
        p /= s;
        p.y /= squash; p.xz *= squash;
        p.xz *= rot(uRot.x);
        p.yz *= rot(uRot.y + nod);
        p.xy *= rot(sin(uT * .6) * .06);
        float d = map(p) * s * .9;
        if (d < mind) { mind = d; tm = t; }
        if (d < .0015 * t) { hit = true; break; }
        t += d;
        if (t > bb.y) break;
      }
      if (hit) {
        vec3 wp = ro + rd * t;
        vec3 p = (wp - off) / s;
        p.y /= squash; p.xz *= squash;
        // same rotations, kept so the normal can be taken to world space
        mat2 ry = rot(uRot.x), rx = rot(uRot.y + nod), rz = rot(sin(uT * .6) * .06);
        p.xz *= ry; p.yz *= rx; p.xy *= rz;
        map(p); float mat = gMat;
        vec3 n = calcNormal(p);
        float ao = calcAO(p, n);
        // back to world space: inverse rotations in reverse order
        n.xy *= rot(-sin(uT * .6) * .06); n.yz *= rot(-(uRot.y + nod)); n.xz *= rot(-uRot.x);
        vec3 v = -rd, r = reflect(rd, n);
        vec3 L = normalize(vec3(-.55, .65, .55));
        float ndl = dot(n, L), wrap = clamp(ndl * .5 + .5, 0., 1.);
        float fre = pow(1. - clamp(dot(n, v), 0., 1.), 3.);
        float fill = clamp(dot(n, normalize(vec3(.9, -.1, .3))), 0., 1.);

        if (mat < 1.5) {
          // flock: brown plush, tan muzzle + inner ears, fuzz noise, velvet sheen
          vec3 q = vec3(abs(p.x), p.y, p.z);
          float muz = 1. - smoothstep(-.02, .03, sdEllipsoid(p - vec3(0., -.3, .7), vec3(.4, .3, .3)));
          float cup = 1. - smoothstep(-.02, .02, sdEllipsoid(q - vec3(.68, .74, .02), vec3(.21, .21, .14)));
          vec3 base = mix(vec3(.30, .16, .075), vec3(.78, .55, .34), max(muz, cup));
          base *= .82 + .3 * noise3(p * 38.) + .08 * noise3(p * 7.);
          col = base * (.16 + 1.05 * wrap * wrap) * ao;
          col += base * uTint * fill * .55 * ao;
          col += fre * mix(vec3(1., .78, .55), uTint, .45) * (.55 + uBass * .5) * ao;
          col += vec3(1., .75, .45) * pow(clamp(n.y, 0., 1.), 4.) * (.1 + uBeat * .25) * ao; // halo light from above
        } else if (mat < 2.5) {
          // gloss black eyes + nose: a sharp studio reflection and a catchlight
          col = vec3(.012, .01, .012) + studio(r) * (.05 + .5 * fre);
          col += vec3(1.) * pow(clamp(dot(r, L), 0., 1.), 90.) * 1.6;
          col *= mix(.6, 1., ao);
        } else {
          // gold halo, glowing
          vec3 gold = vec3(1., .74, .32);
          col = gold * (.55 + .45 * wrap) + studio(r) * gold * .8;
          col += gold * (.6 + uBass * 1.2 + uBeat * .8);
        }
        alpha = 1.;
      }
    }
    // silhouette anti-aliasing: a ray that grazed the edge gets partial
    // coverage in the rim-light colour (the edge of the head is always rim-lit)
    if (alpha < 1. && mind < 1e8) {
      float px = 1.4 * tm / (uRes.y * 1.62);
      alpha = 1. - smoothstep(0., px, mind);
      col = mix(vec3(1., .78, .55), uTint, .45) * .55;
    }
    col = col / (1. + col * .25);
    float fade = stageFade();
    o = vec4(col * alpha + glow * fade * (1. - alpha), alpha + (1. - alpha) * sh * fade);
  }
  `
});
