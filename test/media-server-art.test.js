/* media-server-art.test.js -- regression test for the /art/:key route
   silently 404ing on a standalone single/bonus track's cover. Those tracks
   get an albumKey shaped "sgl-<16 hex chars>" (see library.js), and the art
   file on disk is saved under that exact key. The old key sanitizer in
   mediaServer.js stripped every non-hex character - including the "sgl-"
   prefix itself - so the lookup path never matched the real filename. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

module.exports = async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mediaserver-'));
  const artDir = path.join(dataDir, 'art');
  fs.mkdirSync(artDir, { recursive: true });

  const normalKey = '1234567890abcdef';
  const singleKey = 'sgl-1234567890abcdef';
  fs.writeFileSync(path.join(artDir, normalKey + '.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  fs.writeFileSync(path.join(artDir, singleKey + '.jpg'), Buffer.from([0xff, 0xd8, 0xff]));

  delete require.cache[require.resolve('../electron/lib/mediaServer')];
  const mediaServer = require('../electron/lib/mediaServer');
  const store = { artDir: () => artDir, coversDir: () => dataDir };
  const library = { filePath: () => null };

  const { server, port } = await mediaServer.start(store, library);
  try {
    assert.strictEqual(await get(port, '/art/' + normalKey), 200, 'a plain hashed albumKey should still serve its art');
    assert.strictEqual(await get(port, '/art/' + singleKey), 200, 'a "sgl-" prefixed albumKey (standalone single/bonus track) must serve its art too');
    assert.strictEqual(await get(port, '/art/not-a-real-key'), 404, 'a key that is not a valid hash must be rejected, not just stripped down to something that happens to exist');
  } finally {
    server.close();
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  return 'mediaServer.js /art route: ok';
};
