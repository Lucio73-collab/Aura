/* importer.test.js — copies real generated test WAVs into a fake library root
   and checks the Artist/Album folder structure and collision handling. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_MUSIC = path.join(__dirname, '..', '.test-music');

module.exports = async function run() {
  if (!fs.existsSync(TEST_MUSIC)) throw new Error('run `node scripts/gen-test-audio.js` first');
  const importer = require('../electron/lib/importer');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-import-'));

  const files = fs.readdirSync(TEST_MUSIC).map(f => path.join(TEST_MUSIC, f));

  // 1. sort-by-own-tags path (no forced target)
  const r1 = await importer.importFiles(files, root, null);
  assert.ok(r1.every(x => x.ok), 'all real tagged test files should import cleanly');
  assert.ok(fs.existsSync(path.join(root, 'Aura Test Artist', 'Aura Test Album', 'aura-test-01.wav')), 'file should land in <root>/<artist>/<album>/ from its own tags');
  assert.ok(fs.existsSync(path.join(root, 'Aura Test Artist Two', 'Aura Test Album Two', 'aura-test-03.wav')), 'a different artist/album should get its own folder');

  // 2. forced target overrides the file's own tags
  const r2 = await importer.importFiles([files[0]], root, { artist: 'Forced Artist', album: 'Forced Album' });
  assert.strictEqual(r2[0].ok, true);
  assert.strictEqual(r2[0].forced, true);
  assert.ok(fs.existsSync(path.join(root, 'Forced Artist', 'Forced Album', 'aura-test-01.wav')), 'an explicit target should be honored over the file\'s own tags');

  // 3. importing the same file again must not clobber the first copy
  const r3 = await importer.importFiles([files[0]], root, null);
  assert.strictEqual(r3[0].ok, true);
  assert.notStrictEqual(r3[0].dest, path.join(root, 'Aura Test Artist', 'Aura Test Album', 'aura-test-01.wav'), 'a re-import of the same filename must not overwrite the existing copy');
  assert.ok(fs.existsSync(r3[0].dest));

  // 4. path-hostile artist/album names get sanitized, not blindly joined into a path
  for (const hostile of ['../../evil', '..\\..\\evil', 'C:\\Windows', 'a/b/c']) {
    const cleaned = importer.sanitizeSegment(hostile);
    assert.ok(!cleaned.includes('\\') && !cleaned.includes('/'), 'sanitizeSegment must strip path separators from: ' + hostile);
  }

  // 5. a raw "Primary, Collaborator" artist tag must land in the *primary*
  // artist's folder, not get its own folder (the "Kanye West, Dwele" bug)
  const collabWav = buildTinyWav({ INAM: 'Collab Song', IART: 'Aura Test Artist, Some Guest', IPRD: 'Aura Test Album' });
  const collabFile = path.join(root, 'collab-src.wav');
  fs.writeFileSync(collabFile, collabWav);
  const r5 = await importer.importFiles([collabFile], root, null);
  assert.strictEqual(r5[0].ok, true);
  assert.ok(
    fs.existsSync(path.join(root, 'Aura Test Artist', 'Aura Test Album', 'collab-src.wav')),
    'a "Primary, Guest" artist tag should be sorted into the primary artist\'s folder, not a separate "Primary, Guest" folder'
  );
  assert.ok(!fs.existsSync(path.join(root, 'Aura Test Artist, Some Guest')), 'no separate collaborator-variant folder should be created');

  fs.rmSync(root, { recursive: true, force: true });
  return 'importer.js copy + organize: ok';
};

function buildTinyWav(tags) {
  const chunk = (id, data) => {
    const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    const size = Buffer.alloc(4); size.writeUInt32LE(data.length, 0);
    return Buffer.concat([Buffer.from(id, 'ascii'), size, data, pad]);
  };
  const info = chunk('LIST', Buffer.concat([Buffer.from('INFO', 'ascii'),
    ...Object.entries(tags).map(([id, val]) => chunk(id, Buffer.from(String(val) + '\0', 'ascii')))]));
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(16000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const body = Buffer.concat([chunk('fmt ', fmt), info, chunk('data', Buffer.alloc(400))]);
  return chunk('RIFF', Buffer.concat([Buffer.from('WAVE', 'ascii'), body]));
}
