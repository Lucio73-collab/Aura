/* album-artist-tag-bug.test.js -- regression test for a rip whose albumartist
   tag literally holds the ALBUM's own name instead of the real performing
   artist (seen on a Kanye West & Drake collab project, every file's
   albumartist tag says "WOLVES"). Taken at face value that manufactures a
   phantom "Wolves" artist owning the album, while every track's own artist
   tag still correctly credits Kanye West. Unit-tests library.js's
   resolveAlbumArtist directly rather than round-tripping through a real
   audio file: WAV/RIFF INFO tags (the format the other library.js tests
   build) have no distinct albumartist field at all, so they can't actually
   reproduce "albumartist tag disagrees with artist tag" in the first place -
   only a real ID3/MP4 file could, and this is the exact decision under test
   either way. */
const assert = require('assert');

module.exports = async function run() {
  for (const m of ['store', 'library']) delete require.cache[require.resolve('../electron/lib/' + m)];
  const library = require('../electron/lib/library');
  const { resolveAlbumArtist } = library;

  // the real bug: albumartist tag is literally the album title
  assert.strictEqual(
    resolveAlbumArtist('WOLVES', 'Kanye West & Drake', true, 'Wolves'),
    'Kanye West',
    'an albumartist tag matching the album title must fall back to the track artist, not manufacture a phantom artist'
  );

  // a normal, correctly-tagged album must be completely unaffected
  assert.strictEqual(
    resolveAlbumArtist('Kanye West', 'Kanye West', true, 'Graduation'),
    'Kanye West',
    'a real albumartist tag must be trusted as-is'
  );

  // no albumartist tag at all: falls back to the track artist, same as ever
  assert.strictEqual(
    resolveAlbumArtist(null, 'Kanye West', true, 'Graduation'),
    'Kanye West',
    'a missing albumartist tag should fall back to the track artist'
  );

  // a collaborator-style albumartist tag ("A & B") must still resolve to
  // the primary artist, same as it always did
  assert.strictEqual(
    resolveAlbumArtist('Kanye West & Drake', 'Kanye West & Drake', true, 'Some Other Album'),
    'Kanye West',
    'a real multi-artist albumartist tag should still collapse to the primary artist'
  );

  // an untagged (single) track never has this check applied at all
  assert.strictEqual(
    resolveAlbumArtist('WOLVES', 'Kanye West & Drake', false, null),
    'WOLVES',
    'the album-title-collision check only applies when there is a real album tag to compare against'
  );

  return 'library.js resolveAlbumArtist (album-title-as-albumartist bug): ok';
};
