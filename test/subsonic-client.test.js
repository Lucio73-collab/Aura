/* subsonic-client.test.js - electron/lib/subsonic.js against sample responses
   (test/fixtures/subsonic, written to the documented Subsonic/OpenSubsonic
   shapes). Auth token generation, URL building, parsing, error handling.
   No network, no live server. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sub = require('../electron/lib/subsonic');

const fx = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'subsonic', name + '.json'), 'utf8');
const ok = body => new Response(body, { status: 200 });

function fakeFetch(routes) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url);
    calls.push({ url, path: u.pathname, q: u.searchParams });
    const key = u.pathname.replace('/rest/', '').replace('.view', '');
    const r = routes[key];
    if (!r) return new Response('nope', { status: 404 });
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(u) : ok(r);
  };
  f.calls = calls;
  return f;
}
const client = (routes, extra = {}) => {
  const f = fakeFetch(routes);
  return { c: new sub.SubsonicClient({ baseUrl: 'http://nas:4533/', user: 'aura', password: 'sesame', fetch: f, ...extra }), f };
};

module.exports = async function run() {
  /* --- token auth --- */
  // spec example: md5("sesame" + "c19b2d") = 26719a1196d2a940705a59634eb18eab
  assert.strictEqual(sub.md5hex('sesame' + 'c19b2d'), '26719a1196d2a940705a59634eb18eab');
  const a1 = sub.authParams({ user: 'aura', password: 'sesame', salt: 'c19b2d' });
  assert.deepStrictEqual(a1, { u: 'aura', t: '26719a1196d2a940705a59634eb18eab', s: 'c19b2d' });
  const salts = new Set(Array.from({ length: 20 }, () => sub.authParams({ user: 'aura', password: 'x' }).s));
  assert.strictEqual(salts.size, 20, 'salt is random per request');
  assert.ok([...salts].every(s => s.length >= 6));
  assert.deepStrictEqual(sub.authParams({ apiKey: 'K3Y' }), { apiKey: 'K3Y' }, 'api key replaces u/t/s');
  assert.throws(() => sub.authParams({ user: 'aura' }), e => e.code === 'AUTH');

  /* --- url building --- */
  assert.strictEqual(sub.normalizeBaseUrl('192.168.2.210:4533/'), 'http://192.168.2.210:4533');
  const { c, f } = client({ ping: fx('ping') });
  const url = new URL(c.url('stream', { id: 'abc' }));
  assert.strictEqual(url.origin + url.pathname, 'http://nas:4533/rest/stream.view');
  for (const [k, v] of [['c', 'Aura'], ['v', '1.16.1'], ['f', 'json'], ['u', 'aura'], ['id', 'abc']]) assert.strictEqual(url.searchParams.get(k), v, k);
  assert.ok(!url.search.includes('sesame'), 'password never in the url');
  assert.ok(url.searchParams.get('t') && url.searchParams.get('s'));
  const multi = new URL(c.url('createPlaylist', { name: 'n', songId: ['1', '2'], skip: null }));
  assert.deepStrictEqual(multi.searchParams.getAll('songId'), ['1', '2']);
  assert.ok(!multi.searchParams.has('skip'));
  // server-reported API version is what gets sent
  const c2 = new sub.SubsonicClient({ baseUrl: 'http://nas', user: 'u', password: 'p', apiVersion: '1.15.0' });
  assert.strictEqual(new URL(c2.url('ping')).searchParams.get('v'), '1.15.0');

  /* --- stream / transcode params --- */
  const orig = new URL(c.streamUrl('s1'));
  assert.ok(!orig.searchParams.has('format') && !orig.searchParams.has('maxBitRate') && !orig.searchParams.has('estimateContentLength'), 'original by default');
  const tc = new URL(c.streamUrl('s1', { format: 'mp3', maxBitRate: 192 }));
  assert.strictEqual(tc.searchParams.get('format'), 'mp3');
  assert.strictEqual(tc.searchParams.get('maxBitRate'), '192');
  assert.strictEqual(tc.searchParams.get('estimateContentLength'), 'true');
  assert.strictEqual(new URL(c.streamUrl('s1', { format: 'raw' })).searchParams.has('estimateContentLength'), false);

  /* --- ping + parsing --- */
  const p = await c.ping();
  assert.deepStrictEqual(p, { version: '1.16.1', type: 'navidrome', serverVersion: '0.64.1 (285dc4f3)', openSubsonic: true });
  assert.strictEqual(f.calls[0].path, '/rest/ping.view');

  const lib = client({ getArtists: fx('artists'), getAlbum: fx('album'), getAlbumList2: fx('albumlist2'), search3: fx('search3'), getPlaylists: fx('playlists'), getPlaylist: fx('playlist'), getOpenSubsonicExtensions: fx('extensions') });
  const artists = await lib.c.getArtists();
  assert.deepStrictEqual(artists.map(a => a.name), ['Kanye West', 'Kendrick Lamar']);
  const albums = await lib.c.getAlbumList2({ size: 9999 });
  assert.strictEqual(albums.length, 1);
  assert.strictEqual(lib.f.calls.find(x => x.path.includes('getAlbumList2')).q.get('size'), '500', 'size capped at the spec max');

  const { album, tracks } = await lib.c.getAlbum('al1');
  assert.strictEqual(album.name, 'Graduation');
  assert.strictEqual(tracks.length, 2);
  const [t1, t2] = tracks;
  assert.strictEqual(t1.id, 'nd:s1');
  assert.strictEqual(t1.source, 'navidrome');
  assert.strictEqual(t1.albumKey, 'nd-al1');
  assert.strictEqual(t1.cover, '/nascover/al-al1_650a1b2c', 'album cover id wins over per-song cover id');
  assert.strictEqual(t1.genre, 'Hip-Hop');
  assert.strictEqual(t1.duration, 195);
  assert.strictEqual(t1.bpm, 90);
  assert.deepStrictEqual(t1.replayGain, { trackGain: -6.5, albumGain: -7.1 });
  assert.strictEqual(t1.albumReleaseDate, '2007-09-11');
  assert.strictEqual(t1.albumType, 'album');
  assert.ok(t1.dateAdded > 0);
  assert.deepStrictEqual(t2.artists, ['Kanye West', 'Kid Cudi']);
  assert.strictEqual(t2.artist, 'Kanye West, Kid Cudi');
  assert.strictEqual(t2.albumArtist, 'Kanye West');
  assert.strictEqual(t2.discNo, 1);
  assert.ok(!('bpm' in t2) && !('replayGain' in t2), 'optional fields only when the server sends them');

  const s = await lib.c.search3('good');
  assert.strictEqual(s.songs[0].id, 'nd:s1');
  assert.strictEqual(s.albums[0].name, 'Graduation');
  assert.strictEqual(lib.f.calls.find(x => x.path.includes('search3')).q.get('query'), 'good');

  const pls = await lib.c.getPlaylists();
  assert.strictEqual(pls[0].id, 'pl1');
  const pl = await lib.c.getPlaylist('pl1');
  assert.deepStrictEqual(pl.songs.map(x => x.id), ['nd:s1']);

  const ext = await lib.c.getOpenSubsonicExtensions();
  assert.ok(ext.some(e => e.name === 'formPost'));
  assert.ok(!ext.some(e => e.name === 'apiKeyAuthentication'));

  /* --- playlist writes send the documented params --- */
  const w = client({ createPlaylist: '{"subsonic-response":{"status":"ok","version":"1.16.1","playlist":{"id":"pl9","name":"New"}}}', updatePlaylist: fx('ping'), deletePlaylist: fx('ping'), scrobble: fx('ping') });
  assert.deepStrictEqual(await w.c.createPlaylist('New', ['s1', 's2']), { id: 'pl9', name: 'New' });
  assert.deepStrictEqual(w.f.calls[0].q.getAll('songId'), ['s1', 's2']);
  await w.c.updatePlaylist('pl9', { songIdToAdd: ['s3'], songIndexToRemove: [0] });
  assert.strictEqual(w.f.calls[1].q.get('playlistId'), 'pl9');
  assert.strictEqual(w.f.calls[1].q.get('songIdToAdd'), 's3');
  assert.strictEqual(w.f.calls[1].q.get('songIndexToRemove'), '0');
  await w.c.replacePlaylist('pl9', ['s2']);
  assert.strictEqual(w.f.calls[2].path, '/rest/createPlaylist.view');
  assert.strictEqual(w.f.calls[2].q.get('playlistId'), 'pl9');
  await w.c.scrobble('s1', { submission: false });
  assert.strictEqual(w.f.calls[3].q.get('submission'), 'false');
  await w.c.scrobble('s1', { submission: true, time: 1700000000000 });
  assert.strictEqual(w.f.calls[4].q.get('submission'), 'true');
  assert.strictEqual(w.f.calls[4].q.get('time'), '1700000000000');

  /* --- errors --- */
  await assert.rejects(client({ ping: fx('error-auth') }).c.ping(), e => e.code === 'AUTH' && e.apiCode === 40);
  await assert.rejects(client({ getAlbum: fx('error-notfound') }).c.getAlbum('x'), e => e.code === 'NOT_FOUND');
  await assert.rejects(client({}).c.ping(), e => e.code === 'HTTP');
  await assert.rejects(client({ ping: 'not json' }).c.ping(), e => e.code === 'BAD_RESPONSE');
  await assert.rejects(client({ ping: '{"hello":1}' }).c.ping(), e => e.code === 'BAD_RESPONSE');
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  await assert.rejects(client({ ping: refused }).c.ping(), e => e.code === 'OFFLINE' && /ECONNREFUSED/.test(e.message));
  const timedOut = Object.assign(new Error('t'), { name: 'TimeoutError' });
  await assert.rejects(client({ ping: timedOut }).c.ping(), e => e.code === 'TIMEOUT');
  // a failing extensions call is not fatal (older servers), but auth failures are
  assert.deepStrictEqual(await client({ getOpenSubsonicExtensions: fx('error-notfound') }).c.getOpenSubsonicExtensions(), []);
  await assert.rejects(client({ getOpenSubsonicExtensions: fx('error-auth') }).c.getOpenSubsonicExtensions(), e => e.code === 'AUTH');

  /* --- secrets never survive masking --- */
  const leaky = 'GET http://nas:4533/rest/ping.view?u=aura&t=deadbeef&s=salt123&c=Aura&apiKey=K3Y&p=enc:7365 failed';
  const masked = sub.maskSecrets(leaky);
  for (const bad of ['aura&', 'deadbeef', 'salt123', 'K3Y', 'enc:7365']) assert.ok(!masked.includes(bad), bad + ' leaked: ' + masked);
  assert.ok(masked.includes('c=Aura'), 'non-secret params are kept');
  const err = new sub.SubsonicError('OFFLINE', 'boom ' + leaky);
  assert.ok(!err.message.includes('deadbeef'), 'errors mask on construction');

  return 'subsonic-client: token auth, url building, parsing, playlists, scrobble, transcode params, errors, masking';
};
