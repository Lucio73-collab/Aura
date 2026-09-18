/* spotify-client.test.js - electron/lib/spotify.js against a fake Web API:
   current (Feb 2026+) page-size limits, playlist `item` entries, the new
   DELETE body, 429 / quota handling, and error-code mapping. No network. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

module.exports = async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-spotify-'));

  // spotifyAuth pulls in electron; hand it a stub and a fixed token.
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { shell: { openExternal() {} }, safeStorage: { isEncryptionAvailable: () => false } };
    return origLoad.call(this, req, ...rest);
  };
  for (const m of ['spotify', 'spotifyAuth']) delete require.cache[require.resolve('../electron/lib/' + m)];
  const auth = require('../electron/lib/spotifyAuth');
  const spotify = require('../electron/lib/spotify');
  Module._load = origLoad;
  auth.getAccessToken = async () => 'tok';
  auth.status = () => ({ connected: true, userId: 'me' });
  spotify.init({ dir: () => dir });

  const calls = [];
  const routes = [];
  const on = (method, re, fn) => routes.push({ method, re, fn });
  const json = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers });
  const origFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    calls.push({ method, path: u.pathname, q: Object.fromEntries(u.searchParams), body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) if (r.method === method && r.re.test(u.pathname)) return r.fn(u, opts);
    return json(404, { error: { status: 404, message: 'no route' } });
  };

  try {
    const album = i => ({ id: 'al' + i, name: 'Album ' + i, album_type: i % 3 ? 'single' : 'album', release_date: '20' + String(10 + i) + '-01-01', images: [{ url: 'https://i.scdn.co/x' + i }], artists: [{ id: 'ar1', name: 'Kanye West' }] });

    /* artist albums: limit must never exceed 10, and every page is fetched */
    on('GET', /^\/v1\/artists\/ar1\/albums$/, u => {
      const limit = +u.searchParams.get('limit'), offset = +u.searchParams.get('offset');
      if (limit > 10) return json(400, { error: { status: 400, message: 'Invalid limit' } });
      const items = [];
      for (let i = offset; i < Math.min(offset + limit, 23); i++) items.push(album(i));
      return json(200, { total: 23, items });
    });
    const disco = await spotify.getArtistAlbums('sp:ar1');
    assert.strictEqual(disco.items.length, 23, 'whole discography across pages');
    assert.ok(calls.filter(c => c.path.endsWith('/albums')).every(c => +c.q.limit <= 10), 'limit <= 10');
    const before = calls.length;
    await spotify.getArtistAlbums('ar1');
    assert.strictEqual(calls.length, before, 'discography cached');

    /* search clamps its limit to 10 and normalizes artist refs */
    on('GET', /^\/v1\/search$/, u => {
      if (+u.searchParams.get('limit') > 10) return json(400, { error: { status: 400, message: 'Invalid limit' } });
      return json(200, { tracks: { total: 1, items: [{ id: 't1', type: 'track', uri: 'spotify:track:t1', name: 'Song', duration_ms: 200000, artists: [{ id: 'ar1', name: 'Kanye West' }, { id: 'ar2', name: 'Ty Dolla $ign' }], album: album(1) }] } });
    });
    const sr = await spotify.search('x', ['track'], 50, 0);
    assert.strictEqual(sr.tracks.items[0].artistRefs.length, 2);
    assert.strictEqual(sr.tracks.items[0].artistRefs[1].id, 'sp:ar2');
    assert.strictEqual(sr.tracks.items[0].albumId, 'sp:al1');

    /* playlist items: `item` (new) and `track` (deprecated) both work, episodes/local files skipped, limit <= 50 */
    on('GET', /^\/v1\/playlists\/pl1\/items$/, u => {
      if (+u.searchParams.get('limit') > 50) return json(400, { error: { status: 400, message: 'Invalid limit' } });
      return json(200, { total: 3, items: [
        { added_at: '2026-01-01T00:00:00Z', item: { id: 't2', type: 'track', name: 'New shape', duration_ms: 1000, artists: [], album: album(2) } },
        { added_at: '2026-01-01T00:00:00Z', track: { id: 't3', type: 'track', name: 'Old shape', duration_ms: 1000, artists: [], album: album(3) } },
        { added_at: '2026-01-01T00:00:00Z', item: { id: 'e1', type: 'episode', name: 'Podcast' } }
      ] });
    });
    const pli = await spotify.getPlaylistItems('pl1');
    assert.deepStrictEqual(pli.items.map(i => i.track.title), ['New shape', 'Old shape']);
    assert.strictEqual(pli.skipped, 1);

    /* DELETE body uses `items` now */
    on('DELETE', /^\/v1\/playlists\/pl1\/items$/, () => json(200, { snapshot_id: 's' }));
    await spotify.removePlaylistItems('pl1', ['spotify:track:t2']);
    assert.deepStrictEqual(calls[calls.length - 1].body, { items: [{ uri: 'spotify:track:t2' }] });

    /* playlist ownership from owner id */
    on('GET', /^\/v1\/playlists\/pl1$/, () => json(200, { id: 'pl1', name: 'Mine', owner: { id: 'me', display_name: 'Lucio' }, items: { total: 3 } }));
    const meta = await spotify.getPlaylist('pl1');
    assert.strictEqual(meta.isOwn, true);
    assert.strictEqual(meta.total, 3);

    /* quota exhaustion fails fast instead of hanging on Retry-After */
    on('GET', /^\/v1\/albums\/quota$/, () => json(429, { error: { status: 429, message: 'quota', reason: 'QUOTA_EXCEEDED' } }, { 'retry-after': '86400' }));
    const t0 = Date.now();
    await assert.rejects(spotify.getAlbum('quota'), e => e.code === 'QUOTA_EXCEEDED');
    assert.ok(Date.now() - t0 < 2000, 'no long sleep on quota');

    /* a long Retry-After fails fast with RATE_LIMITED, then the queue recovers */
    on('GET', /^\/v1\/albums\/slow$/, () => json(429, null, { 'retry-after': '120' }));
    await assert.rejects(spotify.getAlbum('slow'), e => e.code === 'RATE_LIMITED');
    await assert.rejects(spotify.getTrack('whatever'), e => e.code === 'RATE_LIMITED', 'queue refuses while paused');
    spotify._test.resetQueue();

    /* player errors map to distinct codes */
    on('PUT', /^\/v1\/me\/player\/play$/, (u) => u.searchParams.get('device_id') === 'gone'
      ? json(404, { error: { status: 404, message: 'Device not found' } })
      : json(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }));
    await assert.rejects(spotify.playUris(['spotify:track:t1'], 'gone'), e => e.code === 'NO_ACTIVE_DEVICE');
    await assert.rejects(spotify.playUris(['spotify:track:t1'], 'dev'), e => e.code === 'PREMIUM_REQUIRED');
    on('PUT', /^\/v1\/me\/player\/pause$/, () => json(403, { error: { status: 403, message: 'Restriction violated', reason: 'UNKNOWN' } }));
    await assert.rejects(spotify.pausePlayback('dev'), e => e.code === 'PLAYER_REFUSED');

    /* catalogue 404 is NOT_FOUND, not a device error */
    await assert.rejects(spotify.getArtist('nope'), e => e.code === 'NOT_FOUND');

    /* network failure maps to OFFLINE */
    const f = global.fetch;
    global.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(spotify.getAlbum('offline'), e => e.code === 'OFFLINE');
    global.fetch = f;
  } finally {
    global.fetch = origFetch;
  }
  return 'spotify.js client limits, pagination, playlist items, 429/quota and error codes: ok';
};
