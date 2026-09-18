/* Kendrick Lamar — the crown of thorns.
   The Tiffany & Co. diamond crown of thorns from Mr. Morale & the Big
   Steppers (worn at Glastonbury 2022): a braided platinum band bristling with
   thorns, set with pavé diamonds that throw coloured fire. It turns under a
   single stage light, lifts on the kick, and the diamonds flare with the
   hi-hats. Flick it to spin it faster. */

ArtistStage.register({
  id: 'kendrick-lamar',
  names: ['Kendrick Lamar', 'Kendrick', 'K.Dot', 'K Dot', 'Oklama'],
  title: 'Crown of Thorns',
  note: 'Drag to spin · click to flick',
  mode: 'turntable',
  spin: 0.32,
  pitch: 0.5,
  fps: 30,
  fs: `
  const float R = .92;
  const float N = 18.;           // thorn sectors around the ring
  float gThorn;

  // one thorn per half-sector: alternating up and down, leaning outwards
  float thorn(vec3 lp, float id, float side) {
    float h = hash11(id * 7.13 + side * 3.7);
    float up = mod(id + side, 2.) < .5 ? 1. : -.75;
    vec3 base = vec3(R + .02, .0, side * .075);
    vec3 dir = normalize(vec3(.55 + .35 * h, up * (.55 + .45 * fract(h * 7.)), side * .12 + (fract(h * 13.) - .5) * .12));
    float len = .22 + .2 * fract(h * 31.);
    return sdRoundCone(lp, base, base + dir * len, .032, .003);
  }

  float map(vec3 p) {
    float a = atan(p.z, p.x);
    float rr = length(p.xz);
    vec2 q = vec2(rr - R, p.y);
    // three platinum strands braided around the ring
    float band = 1e9;
    for (int i = 0; i < 3; i++) {
      float ph = float(i) * 2.0944 + a * 6.;
      vec2 o = .07 * vec2(cos(ph), sin(ph));
      band = min(band, length(q - o) - .03);
    }
    band = smin(band, length(q) - .035, .03);
    // thorns, repeated around the ring in polar sectors
    float sec = 2. * PI / N;
    float id = floor(a / sec + .5);
    float la = a - id * sec;
    vec3 lp = vec3(rr * cos(la), p.y, rr * sin(la));
    float th = min(thorn(lp, id, -1.), thorn(lp, id, 1.));
    gThorn = th < band ? 1. : 0.;
    return smin(band, th, .025);
  }

  vec3 calcNormal(vec3 p) {
    const vec2 k = vec2(1, -1) * .001;
    return normalize(k.xyy * map(p + k.xyy) + k.yyx * map(p + k.yyx) + k.yxy * map(p + k.yxy) + k.xxx * map(p + k.xxx));
  }

  // the crown is a mirror, so it needs a bright world to reflect: a grey stage,
  // the spot overhead, a key softbox, a tinted strip and red bouncing off the floor
  vec3 crownEnv(vec3 d) {
    vec3 c = mix(vec3(.06, .06, .07), vec3(.42, .43, .47), smoothstep(-.5, 1., d.y));
    c += vec3(1., .97, .92) * 3.5 * smoothstep(.72, .95, dot(d, normalize(vec3(0., 1., .3))));
    c += vec3(1.) * 1.8 * smoothstep(.82, .96, dot(d, normalize(vec3(-.65, .35, .65))));
    c += uTint * 1.6 * smoothstep(.8, .96, dot(d, normalize(vec3(.8, .1, .55))));
    c += vec3(.9, .12, .08) * .28 * smoothstep(.3, 1., -d.y);
    return c;
  }

  vec3 fire(float h) { return .6 + .4 * cos(6.2832 * (h + vec3(0., .33, .67))); }

  void main() {
    vec3 ro, rd; vec2 uv;
    camRay(gl_FragCoord.xy, 5.4, 1.75, ro, rd, uv);
    float s = max(uIn, .001) * (1. + uBeat * .035);
    vec3 off = vec3(0., -.06 + (1. - uIn) * .5 + uBeat * .05 + .03 * sin(uT * .9), 0.);

    // backdrop: one hard stage light from above, a halo of tint around the crown
    vec3 col = vec3(0.); float alpha = 0.;
    float beam = exp(-pow(uv.x / (.16 + .22 * (uv.y + .5)), 2.)) * smoothstep(-.35, .5, uv.y);
    vec3 glow = vec3(1., .96, .9) * beam * (.07 + uBass * .06);
    glow += uTint * exp(-dot(uv, uv) * 6.) * (.16 + uBass * .2 + uHover * .06);
    glow += vec3(.9, .1, .08) * exp(-pow((uv.y + .38) * 9., 2.) - uv.x * uv.x * 3.) * .08;  // DAMN. red floor bounce
    float sh = exp(-pow(uv.x * 2.4, 2.) - pow((uv.y + .4) * 16., 2.)) * .45 * uIn;

    vec2 bb = bound(ro, rd, off, 1.45 * s);
    float mind = 1e9, tm = 0.;
    float yaw = uRot.x, pitch = uRot.y + uPoke * .15;
    if (bb.y > 0.) {
      float t = max(bb.x, 0.);
      bool hit = false;
      for (int i = 0; i < 110; i++) {
        vec3 p = (ro + rd * t - off) / s;
        p.yz *= rot(pitch); p.xz *= rot(yaw);
        float d = map(p) * s * .75;
        if (d < mind) { mind = d; tm = t; }
        if (d < .0012 * t) { hit = true; break; }
        t += d;
        if (t > bb.y) break;
      }
      if (hit) {
        vec3 p = (ro + rd * t - off) / s;
        p.yz *= rot(pitch); p.xz *= rot(yaw);
        map(p); float isThorn = gThorn;
        vec3 n = calcNormal(p);
        vec3 nl = n;                                  // object-space normal, for glints that stick to the surface
        n.xz *= rot(-yaw); n.yz *= rot(-pitch);
        vec3 v = -rd, r = reflect(rd, n);
        float fre = .04 + .96 * pow(1. - clamp(dot(n, v), 0., 1.), 5.);
        // platinum: a cool, bright mirror of the studio
        vec3 plat = vec3(.86, .88, .93);
        col = crownEnv(r) * plat * (.6 + .4 * fre) + plat * .05;
        // occlusion where strands and thorns cross
        float occ = clamp(map(p + nl * .05) / .05, 0., 1.);
        col *= .45 + .55 * occ;

        // pavé: tiny facets on a grid fixed to the metal, each tilted its own
        // way, catching one of three lights. Colour splits like diamond fire.
        vec3 cell = floor(p * 46.);
        vec3 hh = hash33(cell);
        float set = step(isThorn > .5 ? .3 : .12, hh.x);
        vec3 fn = normalize(nl + (hh - .5) * 1.2);
        fn.xz *= rot(-yaw); fn.yz *= rot(-pitch);
        vec3 fr = reflect(rd, fn);
        float g = pow(clamp(dot(fr, normalize(vec3(-.65, .35, .65))), 0., 1.), 40.)
                + pow(clamp(dot(fr, normalize(vec3(0., 1., .3))), 0., 1.), 50.) * 1.4
                + pow(clamp(dot(fr, normalize(vec3(.8, .1, .55))), 0., 1.), 40.) * .7;
        float tw = .55 + .45 * sin(uT * (2. + hh.y * 4.) + hh.z * 40.);
        col += fire(hh.y + dot(r, vec3(.4))) * g * set * tw * (3.5 + uTreble * 6. + uKick * 8.);
        alpha = 1.;
      }
    }
    if (alpha < 1. && mind < 1e8) {
      float px = 1.4 * tm / (uRes.y * 1.75);
      alpha = 1. - smoothstep(0., px, mind);
      col = vec3(.7, .72, .78);
    }
    col = col / (1. + col * .3);
    float fade = stageFade();
    o = vec4(col * alpha + glow * fade * (1. - alpha), alpha + (1. - alpha) * sh * fade);
  }
  `
});
