/* lyrics.test.js — LRC parsing, pure logic, no network. */
const assert = require('assert');

module.exports = async function run() {
  delete require.cache[require.resolve('../electron/lib/lyrics')];
  const lyrics = require('../electron/lib/lyrics');

  const lrc = '[00:12.40]First line\n[00:15.00][00:45.00]Repeated line\n[00:20.10]Third line';
  const parsed = lyrics.parseLRC(lrc);
  assert.ok(parsed, 'a valid LRC block should parse to a synced array');
  assert.strictEqual(parsed.length, 4, 'a line with two timestamps should produce two entries');
  const times = parsed.map(([s]) => s);
  assert.deepStrictEqual(times, [...times].sort((a, b) => a - b), 'entries should come out sorted by time');
  assert.strictEqual(parsed[0][1], 'First line');
  assert.ok(parsed.some(([s, t]) => t === 'Repeated line' && Math.abs(s - 45) < 1e-6), 'the later duplicate timestamp should also be present');

  assert.strictEqual(lyrics.parseLRC('just plain text, no timestamps'), null, 'text with no [mm:ss] tags is not synced lyrics');
  assert.strictEqual(lyrics.parseLRC(''), null, 'empty input parses to null');

  const withCentiseconds = lyrics.parseLRC('[01:02.5]Half second');
  assert.ok(Math.abs(withCentiseconds[0][0] - 62.5) < 1e-6, 'single-digit fractional seconds should parse (.5 => 500ms via the 0.xxx pad)');

  return 'lyrics.js parseLRC: ok';
};
