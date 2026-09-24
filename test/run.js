/* run.js — plain node assertion tests, no framework. Run with: node test/run.js */
const tests = ['store.test.js', 'library.test.js', 'stats.test.js', 'lyrics.test.js', 'smart-shuffle.test.js', 'importer.test.js', 'multi-artist.test.js', 'singles.test.js', 'bonus-track.test.js', 'album-key-normalize.test.js', 'dedupe-tracks.test.js', 'media-server-art.test.js', 'album-artist-tag-bug.test.js', 'spotify-client.test.js', 'subsonic-client.test.js', 'subsonic-source.test.js', 'nas-playback.test.js'];

(async () => {
  let failed = 0;
  for (const f of tests) {
    try {
      const msg = await require('./' + f)();
      console.log('PASS -', msg);
    } catch (e) {
      failed++;
      console.error('FAIL -', f, '\n  ', e && e.stack || e);
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
