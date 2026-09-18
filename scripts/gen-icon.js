/* gen-icon.js — draws Aura's app icon from math and writes assets/icon.png
   (1024px) plus assets/icon.ico (16-256, PNG-compressed frames).
   The mark is the same object as the in-app logo (renderer/js/fx3d.js): a
   geodesic sphere projected in perspective, edges shaded by depth, with a
   tilted orbit ring that passes behind and in front of it. Tiny sizes get
   a coarser mesh and heavier strokes so they stay legible in the taskbar.
   Run with: node scripts/gen-icon.js */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ASSETS = path.join(__dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const PHI = (1 + Math.sqrt(5)) / 2;

const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };

function geodesic(level) {
  let v = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]].map(norm);
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const cache = new Map(), next = [];
    const mid = (a, b) => {
      const k = Math.min(a, b) + '_' + Math.max(a, b);
      if (!cache.has(k)) { v.push(norm(v[a].map((x, i) => x + v[b][i]))); cache.set(k, v.length - 1); }
      return cache.get(k);
    };
    for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = next;
  }
  const seen = new Set(), e = [];
  for (const tri of f) for (let i = 0; i < 3; i++) {
    const a = tri[i], b = tri[(i + 1) % 3], k = Math.min(a, b) + '_' + Math.max(a, b);
    if (!seen.has(k)) { seen.add(k); e.push([a, b]); }
  }
  return { v, e };
}

function rotate([x, y, z], ax, ay) {
  const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
  const x1 = cy * x + sy * z, z1 = -sy * x + cy * z;
  return [x1, cx * y - sx * z1, sx * y + cx * z1];
}

// Superellipse ("squircle") |x|^5 + |y|^5 = r^5, smoother than a rounded rect
function squircle(cx, cy, r, n = 5, steps = 180) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = i / steps * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    pts.push([cx + r * Math.sign(c) * Math.pow(Math.abs(c), 2 / n), cy + r * Math.sign(s) * Math.pow(Math.abs(s), 2 / n)]);
  }
  return 'M' + pts.map(p => p.map(v => v.toFixed(2)).join(',')).join('L') + 'Z';
}

function iconSVG(small) {
  const S = 1024, C = S / 2, R = small ? 318 : 292, D = 3.6;
  const { v, e } = geodesic(small ? 0 : 1);
  const ax = 0.42, ay = 0.58;
  const P = v.map(p => {
    const [x, y, z] = rotate(p, ax, ay);
    const k = D / (D - z);
    return [C + x * R * k, C + 18 + y * R * k, z];
  });

  // orbit: circle of radius RR tilted about X then Z, split into segments
  const ring = [];
  const tiltX = 0.36, tiltZ = -0.42, RR = 1.38;
  for (let i = 0; i <= 128; i++) {
    const a = i / 128 * Math.PI * 2;
    let x = Math.cos(a) * RR, y = 0, z = Math.sin(a) * RR;
    [y, z] = [y * Math.cos(tiltX) - z * Math.sin(tiltX), y * Math.sin(tiltX) + z * Math.cos(tiltX)];
    [x, y] = [x * Math.cos(tiltZ) - y * Math.sin(tiltZ), x * Math.sin(tiltZ) + y * Math.cos(tiltZ)];
    const k = D / (D - z);
    ring.push([C + x * R * k, C + 18 + y * R * k, z]);
  }
  const ringSegs = (front) => {
    let d = '';
    for (let i = 0; i < ring.length - 1; i++) {
      const z = (ring[i][2] + ring[i + 1][2]) / 2;
      if ((z >= 0) !== front) continue;
      d += `M${ring[i][0].toFixed(1)},${ring[i][1].toFixed(1)}L${ring[i + 1][0].toFixed(1)},${ring[i + 1][1].toFixed(1)}`;
    }
    return d;
  };

  // edges grouped into depth bands: back faint and thin, front bright and thick
  const BANDS = 5, bands = Array.from({ length: BANDS }, () => '');
  for (const [a, b] of e) {
    const z = (P[a][2] + P[b][2]) / 2;
    const band = Math.min(BANDS - 1, Math.floor((z + 1) / 2 * BANDS));
    bands[band] += `M${P[a][0].toFixed(1)},${P[a][1].toFixed(1)}L${P[b][0].toFixed(1)},${P[b][1].toFixed(1)}`;
  }
  const sw = small ? 34 : 13;
  const edgePaths = bands.map((d, i) => {
    const f = i / (BANDS - 1);
    return d ? `<path d="${d}" stroke="url(#edge)" stroke-width="${(sw * (0.45 + 0.75 * f)).toFixed(1)}" stroke-opacity="${(0.16 + 0.84 * f * f).toFixed(2)}"/>` : '';
  }).join('');
  const nodes = small ? '' : P.filter(p => p[2] > 0.25).map(p =>
    `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(7 + 9 * p[2]).toFixed(1)}" fill="#eef4ff" fill-opacity="${(0.55 + 0.45 * p[2]).toFixed(2)}"/>`).join('');

  const bead = ring.reduce((best, p) => (p[2] > 0 && p[0] > best[0] ? p : best), [0, 0, 0]);
  const shape = small ? `<rect x="0" y="0" width="${S}" height="${S}" rx="220"/>` : `<path d="${squircle(C, C, 470)}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <radialGradient id="bg" cx="38%" cy="26%" r="85%">
      <stop offset="0" stop-color="#23263a"/><stop offset=".55" stop-color="#11121a"/><stop offset="1" stop-color="#07080c"/>
    </radialGradient>
    <radialGradient id="halo" cx="50%" cy="52%" r="50%">
      <stop offset="0" stop-color="#5b8dff" stop-opacity=".55"/><stop offset=".45" stop-color="#7a5cff" stop-opacity=".18"/><stop offset="1" stop-color="#7a5cff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="edge" x1="200" y1="180" x2="820" y2="860" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8fe3ff"/><stop offset=".45" stop-color="#6aa5ff"/><stop offset="1" stop-color="#b07cff"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${small ? 22 : 16}"/></filter>
    <clipPath id="clip">${shape}</clipPath>
  </defs>
  <g clip-path="url(#clip)">
    <rect width="${S}" height="${S}" fill="url(#bg)"/>
    <circle cx="${C}" cy="${C + 18}" r="${R * 1.55}" fill="url(#halo)"/>
    <g fill="none" stroke-linecap="round">
      ${small ? '' : `<path d="${ringSegs(false)}" stroke="url(#edge)" stroke-width="9" stroke-opacity=".35"/>`}
      <g filter="url(#glow)" opacity=".85">${edgePaths}</g>
      ${edgePaths}
      ${nodes}
      <path d="${ringSegs(true)}" stroke="#bfe0ff" stroke-width="${small ? 30 : 12}" stroke-opacity=".9" ${small ? 'opacity="0"' : ''}/>
    </g>
    ${small ? '' : `<circle cx="${bead[0].toFixed(1)}" cy="${bead[1].toFixed(1)}" r="46" fill="#9fd0ff" filter="url(#glow)"/><circle cx="${bead[0].toFixed(1)}" cy="${bead[1].toFixed(1)}" r="20" fill="#fff"/>`}
    ${small ? '' : `<path d="${squircle(C, C, 470)}" fill="url(#rim)"/>`}
  </g>
  ${small ? '' : `<path d="${squircle(C, C, 469)}" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="3"/>`}
</svg>`;
}

async function main() {
  const detailed = Buffer.from(iconSVG(false));
  const simple = Buffer.from(iconSVG(true));
  fs.writeFileSync(path.join(ASSETS, 'icon.svg'), detailed);
  await sharp(detailed).resize(1024, 1024).png().toFile(path.join(ASSETS, 'icon.png'));

  const pngs = await Promise.all(SIZES.map(s => sharp(s <= 32 ? simple : detailed, { density: 72 * s / 1024 * 4 }).resize(s, s).png().toBuffer()));

  const count = SIZES.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(count, 4);

  for (let i = 0; i < count; i++) {
    const s = SIZES[i];
    const buf = pngs[i];
    const entryOff = 6 + i * 16;
    header.writeUInt8(s === 256 ? 0 : s, entryOff + 0);   // width
    header.writeUInt8(s === 256 ? 0 : s, entryOff + 1);   // height
    header.writeUInt8(0, entryOff + 2);                    // color count
    header.writeUInt8(0, entryOff + 3);                    // reserved
    header.writeUInt16LE(1, entryOff + 4);                 // planes
    header.writeUInt16LE(32, entryOff + 6);                // bit count
    header.writeUInt32LE(buf.length, entryOff + 8);        // bytes in resource
    header.writeUInt32LE(offset, entryOff + 12);           // offset
    offset += buf.length;
  }

  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), Buffer.concat([header, ...pngs]));
  console.log('Wrote icon.svg, icon.png (1024), icon.ico (' + SIZES.join(',') + ')');
}

main().catch(e => { console.error(e); process.exit(1); });
