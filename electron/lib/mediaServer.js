/* mediaServer.js — local-origin HTTP server.
   Serves the renderer UI, track audio (with Range support), album art and
   custom covers all from the same http://127.0.0.1:<port> origin so the
   Web Audio graph, canvas reads and CSP all see one same-origin document
   instead of a separate aura:// scheme. Port is OS-assigned and never
   hardcoded; renderer code reaches these routes with plain relative paths
   (/track/:id, /art/:key, /cover/:name) so nothing downstream needs to know
   the port either. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const RENDERER_DIR = path.join(__dirname, '..', '..', 'renderer');

// Optional: sharp is only needed for downscaled art. Without it every size
// request just gets the original file, exactly as before.
let sharp = null;
try { sharp = require('sharp'); sharp.cache(false); } catch {} // thumbs live on disk, no need to hold decoded images in RAM too

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.webm': 'audio/webm'
};

function safeStaticPath(pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try { rel = decodeURIComponent(rel); } catch { return null; }
  rel = rel.replace(/^\/+/, '');
  const target = path.normalize(path.join(RENDERER_DIR, rel));
  const base = RENDERER_DIR + path.sep;
  if (target !== RENDERER_DIR && !target.startsWith(base)) return null; // traversal guard
  return target;
}

/* Validators for everything but audio: an unchanged image or script comes
   back as a bodyless 304 instead of being re-read, re-sent and re-decoded.
   no-cache still revalidates every time, so an edited file shows up at once. */
// a file removed between stat and read must not throw an uncaught stream error in the main process
const pipeFile = (file, res, range) => fs.createReadStream(file, range).on('error', () => res.destroy()).pipe(res);
const etagOf = st => '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
function sendFile(req, res, file, st, type, cache = 'no-cache') {
  const etag = etagOf(st);
  const headers = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  pipeFile(file, res);
}
const statFile = file => { try { const st = fs.statSync(file); return st.isFile() ? st : null; } catch { return null; } };

/* ---------- downscaled art ----------
   Embedded covers are often 3000px+ (one here is a 3464px PNG: 48 MB once
   decoded) while most places draw them at 40-200px. ?w=N serves a JPEG no
   wider than N, generated once with sharp and kept in data/thumbs; it is
   rebuilt whenever the source file is newer. Widths snap to a few buckets so
   the cache stays small. */
const THUMB_WIDTHS = [128, 256, 400, 640, 1024];
const thumbJobs = new Map();
function thumbWidth(u) {
  const w = parseInt(u.searchParams.get('w'), 10);
  if (!sharp || !(w > 0)) return 0;
  return THUMB_WIDTHS.find(x => x >= w) || 0; // bigger than every bucket: the original
}
function thumbFor(src, srcStat, dir, name, w) {
  const out = path.join(dir, name + '-' + w + '.jpg');
  const have = statFile(out);
  if (have && have.mtimeMs >= srcStat.mtimeMs) return Promise.resolve(out);
  if (thumbJobs.has(out)) return thumbJobs.get(out);
  const job = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = out + '.' + process.pid + '.tmp';
    await sharp(src, { failOn: 'none' }).rotate()
      .resize(w, w, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#0e0f12' })
      .jpeg({ quality: 86 })
      .toFile(tmp);
    fs.renameSync(tmp, out);
    return out;
  })().finally(() => thumbJobs.delete(out));
  return job;
}
async function serveImage(req, res, u, store, file, name, type, cache) {
  const st = statFile(file);
  if (!st) { res.writeHead(404); res.end(); return; }
  const w = thumbWidth(u);
  if (w) {
    try {
      const out = await thumbFor(file, st, path.join(path.dirname(store.artDir()), 'thumbs'), name, w);
      const ost = statFile(out);
      if (ost) return sendFile(req, res, out, ost, 'image/jpeg', cache);
    } catch {} // undecodable image: fall through to the original
  }
  sendFile(req, res, file, st, type, cache);
}

function serveStatic(req, res, pathname) {
  const file = safeStaticPath(pathname);
  const st = file && statFile(file);
  if (!st) { res.writeHead(404); res.end('Not found'); return; }
  sendFile(req, res, file, st, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

function serveTrack(req, res, library, rawId) {
  let id; try { id = decodeURIComponent(rawId); } catch { id = rawId; }
  const file = library.filePath(id);
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404); res.end(); return; }
  const total = stat.size;
  const type = AUDIO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end > total - 1) end = total - 1;
    if (start > end || start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type
    });
    pipeFile(file, res, { start, end });
  } else {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    pipeFile(file, res);
  }
}

function serveArt(req, res, u, store, key) {
  // albumKey is either a plain 16-hex-char hash, or "sgl-" + one (see
  // library.js) for a standalone single/bonus track. Stripping to
  // [^a-f0-9] used to also strip the "sgl-" prefix itself (s/g/l aren't hex
  // digits), so every art request for one of those never matched the real
  // on-disk filename and silently 404'd - art for any untagged single or
  // bonus track never showed despite hasArt correctly reporting true. An
  // exact allow-list pattern (not a character strip) both fixes that and is
  // the safer way to validate this against path traversal.
  const raw = String(key || '');
  const clean = /^(sgl-)?[a-f0-9]{16}$/i.test(raw) ? raw : '';
  if (!clean) { res.writeHead(404); res.end(); return; }
  serveImage(req, res, u, store, path.join(store.artDir(), clean + '.jpg'), 'art-' + clean, 'image/jpeg').catch(() => res.destroy());
}

function serveCover(req, res, u, store, name) {
  const clean = String(name || '').replace(/[\\/]/g, '');
  const dir = store.coversDir();
  const file = path.normalize(path.join(dir, clean));
  if (!clean || (file !== dir && !file.startsWith(dir + path.sep))) { res.writeHead(404); res.end(); return; }
  // cover files get a fresh random name every time one is set, so they never change
  serveImage(req, res, u, store, file, 'cover-' + clean.replace(/\.[^.]*$/, ''), MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'max-age=31536000, immutable').catch(() => res.destroy());
}

function start(store, library) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[0] === 'track' && parts[1]) return serveTrack(req, res, library, parts[1]);
        if (parts[0] === 'art' && parts[1]) return serveArt(req, res, u, store, parts[1]);
        if (parts[0] === 'cover' && parts[1]) return serveCover(req, res, u, store, parts.slice(1).join('/'));
        return serveStatic(req, res, u.pathname);
      } catch {
        try { res.writeHead(500); res.end(); } catch {}
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { start };
