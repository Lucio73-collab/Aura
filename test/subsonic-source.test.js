/* subsonic-source.test.js - SubsonicSource end to end against a fake Subsonic
   server (an injected fetch): server URL order, offline behavior, credential
   storage, incremental sync + persistent cache, search, streaming through the
   real local media server (Range passthrough, no credentials leaked), cover
   art, scrobble queue, playlists, and the merge into library.getLibrary().
   No network, no Electron. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const store = require('../electron/lib/store');
const library = require('../electron/lib/library');
const sources = require('../electron/lib/sources');
const localSource = require('../electron/lib/sources/localSource');
const subsonicSource = require('../electron/lib/sources/subsonicSource');
const mediaServer = require('../electron/lib/mediaServer');

const LAN = 'http://192.168.2.210:4533', TS = 'http://100.114.107.79:4533';
const PASSWORD = 'correct-horse-battery';
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const json = body => new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.64.1', openSubsonic: true, ...body } }), { status: 200 });
const failed = (code, message) => new Response(JSON.stringify({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } }), { status: 200 });

/* A tiny Navidrome: albums, songs, playlists, scrobbles, and which base URLs answer. */
function fakeServer() {
  const st = {
    reachable: new Set([LAN, TS]), calls: [], scrobbles: [], streamHits: [],
    albums: {
      a1: { id: 'a1', name: 'Graduation', artist: 'Kanye West', coverArt: 'al-a1_x', songCount: 2, duration: 300, created: '2026-09-01T00:00:00Z', year: 2007, releaseTypes: ['album'], songs: ['s1', 's2'] },
      a2: { id: 'a2', name: 'DAMN.', artist: 'Kendrick Lamar', coverArt: 'al-a2_x', songCount: 1, duration: 200, created: '2026-09-02T00:00:00Z', year: 2017, releaseTypes: ['album'], songs: ['s3'] }
    },
    songs: {
      s1: { id: 's1', title: 'Good Morning', track: 1, duration: 195, suffix: 'flac', albumId: 'a1', album: 'Graduation', artist: 'Kanye West', genre: 'Hip-Hop', bpm: 90 },
      s2: { id: 's2', title: 'Champion', track: 2, duration: 105, suffix: 'flac', albumId: 'a1', album: 'Graduation', artist: 'Kanye West', genre: 'Hip-Hop' },
      s3: { id: 's3', title: 'DNA.', track: 1, duration: 200, suffix: 'flac', albumId: 'a2', album: 'DAMN.', artist: 'Kendrick Lamar', genre: 'Hip-Hop' }
    },
    playlists: { p1: { id: 'p1', name: 'Gym', songIds: ['s1'], changed: 'c1' } },
    audio: Buffer.from('0123456789abcdefghij'), nextId: 100
  };
  const albumObj = a => ({ id: a.id, name: a.name, artist: a.artist, coverArt: a.coverArt, songCount: a.songs.length, duration: a.duration, created: a.created, year: a.year, releaseTypes: a.releaseTypes });
  const plObj = p => ({ id: p.id, name: p.name, songCount: p.songIds.length, changed: p.changed });
  st.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const base = u.origin;
    if (!st.reachable.has(base)) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
    const method = u.pathname.replace('/rest/', '').replace('.view', '');
    const q = u.searchParams;
    st.calls.push({ base, method, q });
    // auth: token = md5(password + salt), never the plain password
    if (q.get('u') !== 'aura' || q.get('t') !== md5(PASSWORD + q.get('s')) || u.search.includes(PASSWORD)) return failed(40, 'Wrong username or password');
    switch (method) {
      case 'ping': return json({});
      case 'getOpenSubsonicExtensions': return json({ openSubsonicExtensions: [{ name: 'formPost', versions: [1] }] });
      case 'getAlbumList2': { const list = Object.values(st.albums).map(albumObj); const off = +q.get('offset') || 0; return json({ albumList2: { album: list.slice(off, off + (+q.get('size') || 10)) } }); }
      case 'getAlbum': { const a = st.albums[q.get('id')]; if (!a) return failed(70, 'not found'); return json({ album: { ...albumObj(a), song: a.songs.map(id => ({ ...st.songs[id], created: a.created })) } }); }
      case 'search3': {
        const needle = q.get('query').toLowerCase();
        return json({ searchResult3: { song: Object.values(st.songs).filter(s => s.title.toLowerCase().includes(needle)) } });
      }
      case 'getPlaylists': return json({ playlists: { playlist: Object.values(st.playlists).map(plObj) } });
      case 'getPlaylist': { const p = st.playlists[q.get('id')]; return p ? json({ playlist: { ...plObj(p), entry: p.songIds.map(id => st.songs[id]) } }) : failed(70, 'no playlist'); }
      case 'createPlaylist': {
        const ids = q.getAll('songId'); let p = st.playlists[q.get('playlistId')];
        if (!p) { p = { id: 'p' + (st.nextId++), name: q.get('name'), songIds: [], changed: 'c' + st.nextId }; st.playlists[p.id] = p; }
        p.songIds = ids; p.changed = 'c' + (st.nextId++);
        return json({ playlist: plObj(p) });
      }
      case 'updatePlaylist': {
        const p = st.playlists[q.get('playlistId')];
        if (q.get('name')) p.name = q.get('name');
        for (const id of q.getAll('songIdToAdd')) p.songIds.push(id);
        for (const i of q.getAll('songIndexToRemove').map(Number).sort((a, b) => b - a)) p.songIds.splice(i, 1);
        p.changed = 'c' + (st.nextId++);
        return json({});
      }
      case 'deletePlaylist': delete st.playlists[q.get('id')]; return json({});
      case 'scrobble': st.scrobbles.push({ id: q.get('id'), submission: q.get('submission'), time: q.get('time') }); return json({});
      case 'getCoverArt': return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      case 'download': return st.songs[q.get('id')] ? new Response(st.audio, { status: 200, headers: { 'content-type': 'audio/flac' } }) : failed(70, 'nope');
      case 'stream': {
        st.streamHits.push({ base, id: q.get('id'), format: q.get('format'), maxBitRate: q.get('maxBitRate'), range: (opts.headers || {}).Range });
        if (!st.songs[q.get('id')]) return new Response('<subsonic-response status="failed"/>', { status: 200, headers: { 'content-type': 'text/xml' } });
        const range = (opts.headers || {}).Range, m = range && /bytes=(\d+)-(\d*)/.exec(range);
        if (m) { const a = +m[1], b = m[2] ? +m[2] : st.audio.length - 1; return new Response(st.audio.subarray(a, b + 1), { status: 206, headers: { 'content-type': 'audio/flac', 'content-range': `bytes ${a}-${b}/${st.audio.length}`, 'content-length': String(b - a + 1), 'accept-ranges': 'bytes' } }); }
        return new Response(st.audio, { status: 200, headers: { 'content-type': 'audio/flac', 'content-length': String(st.audio.length), 'accept-ranges': 'bytes' } });
      }
    }
    return failed(0, 'unknown method ' + method);
  };
  return st;
}

const get = (port, urlPath, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: urlPath, headers }, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

module.exports = async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-nas-'));
  store.init(dir);
  const secretsOn = { available: () => true, encrypt: s => Buffer.from('ENC:' + Buffer.from(s).reverse().toString('hex')), decrypt: b => Buffer.from(b.toString().slice(4), 'hex').reverse().toString() };
  const logs = [];
  const server = fakeServer();
  const make = (secrets = secretsOn) => subsonicSource.create({ store, fetch: server.fetch, secrets, log: (...a) => logs.push(a.join(' ')), timing: { netPollMs: 3600000 } });
  let nas = make();

  /* --- unconfigured: nothing happens, nothing throws --- */
  nas.start();
  assert.strictEqual(nas.status().state, 'unconfigured');
  assert.deepStrictEqual(nas.listTracks(), []);
  assert.strictEqual(server.calls.length, 0, 'no network before it is configured');

  /* --- credential is refused without OS encryption, and never written in plain text --- */
  const noEnc = make({ available: () => false });
  await assert.rejects(noEnc.setCredential(PASSWORD), e => e.code === 'NO_ENCRYPTION');
  assert.ok(!fs.existsSync(path.join(dir, 'nas-credential.bin')));

  /* --- configure: LAN first, Tailscale second --- */
  await assert.rejects(nas.setConfig({ servers: ['ftp://nas'] }), e => e.code === 'BAD_CONFIG');
  await nas.setConfig({ servers: [LAN, TS], username: 'aura' });
  assert.strictEqual(nas.status().state, 'unconfigured', 'no credential yet');
  await nas.setCredential(PASSWORD);
  const credBytes = fs.readFileSync(path.join(dir, 'nas-credential.bin'));
  assert.ok(!credBytes.includes(PASSWORD) && !credBytes.toString().includes(PASSWORD), 'credential file is not plain text');
  store.flush();
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes(PASSWORD), 'password not in settings.json');
  assert.deepStrictEqual(store.settings().nas.servers, [LAN, TS], 'server list is saved (not secret)');
  assert.strictEqual(nas.status().state, 'online');
  assert.strictEqual(nas.status().url, LAN, 'LAN wins when both answer');
  assert.strictEqual(nas.status().home, true);
  assert.strictEqual(nas.status().apiVersion, '1.16.1');
  assert.strictEqual(nas.getConfig().hasCredential, true);
  assert.ok(!JSON.stringify(nas.getConfig()).includes(PASSWORD) && !JSON.stringify(nas.status()).includes(PASSWORD), 'no credential in config/status');
  await nas.syncLibrary();

  /* --- sync + cache --- */
  assert.strictEqual(nas.listTracks().length, 3);
  const t1 = nas.listTracks().find(t => t.id === 'nd:s1');
  assert.strictEqual(t1.source, 'navidrome');
  assert.strictEqual(t1.cover, '/nascover/al-a1_x');
  assert.strictEqual(t1.bpm, 90);
  assert.deepStrictEqual(nas.listPlaylists().map(p => [p.id, p.name, p.items.map(i => i.trackId)]), [['ndpl:p1', 'Gym', ['nd:s1']]]);
  const albumFetches = () => server.calls.filter(c => c.method === 'getAlbum').length;
  assert.strictEqual(albumFetches(), 2);
  await nas.syncLibrary();
  assert.strictEqual(albumFetches(), 2, 'unchanged albums are not refetched');
  // a new song appears on the NAS (album signature changes) and one album disappears
  server.albums.a1.songs.push('s4'); server.albums.a1.duration = 400;
  server.songs.s4 = { id: 's4', title: 'Stronger', track: 3, duration: 100, suffix: 'flac', albumId: 'a1', album: 'Graduation', artist: 'Kanye West' };
  delete server.albums.a2;
  let libEvents = 0; nas.onLibraryChange(() => libEvents++);
  await nas.syncLibrary();
  assert.strictEqual(albumFetches(), 3, 'only the changed album is refetched');
  assert.deepStrictEqual(nas.listTracks().map(t => t.id).sort(), ['nd:s1', 'nd:s2', 'nd:s4']);
  assert.ok(libEvents >= 1, 'renderer is told the library changed');

  /* --- restart while the NAS is off: cached library still there, status offline --- */
  nas.stop();
  server.reachable.clear();
  nas = make();
  nas.start();
  await nas.connect();
  assert.strictEqual(nas.status().state, 'offline');
  assert.strictEqual(nas.isOnline(), false);
  assert.strictEqual(nas.listTracks().length, 3, 'browsing works from the cache while offline');
  assert.ok(nas.status().error && !nas.status().error.includes(PASSWORD));
  await assert.rejects(nas.openStream('nd:s1'), e => e.code === 'OFFLINE');
  assert.strictEqual(await nas.coverArt('never-cached', 400), null);

  /* --- offline scrobbles are queued, then delivered once it is back --- */
  nas.scrobble('nd:s1', { submission: true, time: 1700000000000 });
  nas.scrobble('nd:s2', { submission: false }); // "now playing" is simply dropped
  assert.strictEqual(server.scrobbles.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'nas-scrobbles.json')));

  /* --- Tailscale fallback: LAN down, tailnet up --- */
  server.reachable = new Set([TS]);
  await nas.connect();
  assert.strictEqual(nas.status().state, 'online');
  assert.strictEqual(nas.status().url, TS);
  assert.strictEqual(nas.status().home, false);
  await new Promise(r => setTimeout(r, 30));
  assert.deepStrictEqual(server.scrobbles.filter(s => s.submission === 'true').map(s => [s.id, s.time]), [['s1', '1700000000000']], 'queued play delivered');

  /* --- wrong password is reported as auth-failed, no retry loop --- */
  server.reachable = new Set([LAN, TS]);
  const bad = make();
  bad.start();
  await bad.setConfig({ servers: [LAN], username: 'aura' });
  await bad.setCredential('wrong');
  assert.strictEqual(bad.status().state, 'auth-failed');
  assert.strictEqual(bad.status().errorCode, 'AUTH');
  assert.ok(!logs.join('\n').includes('wrong') && !logs.join('\n').includes(PASSWORD), 'credentials never logged');
  await bad.setCredential(PASSWORD);
  assert.strictEqual(bad.status().state, 'online');
  nas = bad; // same store/config

  /* --- test connection from unsaved form values --- */
  const t = await nas.test({ servers: [TS, LAN], username: 'aura', credential: PASSWORD });
  assert.ok(t.ok); assert.strictEqual(t.index, 0); assert.strictEqual(t.url, TS); assert.strictEqual(t.apiKeySupported, false);
  const tBad = await nas.test({ servers: [LAN], username: 'aura', credential: 'nope' });
  assert.ok(!tBad.ok && tBad.code === 'AUTH');
  assert.strictEqual(nas.status().state, 'online', 'testing does not disturb the live connection');

  /* --- search folds unknown hits into the cache --- */
  await nas.syncLibrary();
  server.albums.a2 = { id: 'a2', name: 'DAMN.', artist: 'Kendrick Lamar', coverArt: 'al-a2_x', songCount: 1, duration: 200, created: '2026-09-02T00:00:00Z', year: 2017, songs: ['s3'] };
  const found = await nas.search('dna');
  assert.strictEqual(found.added, 1);
  assert.ok(nas.listTracks().some(x => x.id === 'nd:s3'));
  assert.strictEqual((await nas.search('dna')).added, 0, 'already cached');

  /* --- playlists: create / add / remove / rename / replace / delete round trip through the server --- */
  const made = await nas.createPlaylist('Focus', ['nd:s1', 'sp:ignored', 'nd:s2']);
  assert.strictEqual(made.name, 'Focus');
  assert.deepStrictEqual(made.items.map(i => i.trackId), ['nd:s1', 'nd:s2']);
  await nas.addToPlaylist(made.id, ['nd:s3', 'nd:s1']);
  assert.deepStrictEqual(nas.listPlaylists().find(p => p.id === made.id).items.map(i => i.trackId), ['nd:s1', 'nd:s2', 'nd:s3'], 'duplicates are not re-added');
  await nas.removeFromPlaylist(made.id, 'nd:s2');
  assert.deepStrictEqual(nas.listPlaylists().find(p => p.id === made.id).items.map(i => i.trackId), ['nd:s1', 'nd:s3']);
  await nas.renamePlaylist(made.id, 'Deep Focus');
  assert.strictEqual(nas.listPlaylists().find(p => p.id === made.id).name, 'Deep Focus');
  await nas.setPlaylistItems(made.id, ['nd:s3', 'nd:s1']);
  assert.deepStrictEqual(server.playlists[made.id.replace('ndpl:', '')].songIds, ['s3', 's1']);
  await nas.deletePlaylist(made.id);
  assert.ok(!nas.listPlaylists().some(p => p.id === made.id));

  /* --- the merge into the curated library --- */
  const music = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-nas-music-'));
  store.setSettings({ musicFolders: [music] });
  sources.reset();
  sources.register(localSource.create(library));
  sources.register(nas);
  library.init(store, null, sources);
  await library.rescan();
  const lib = library.getLibrary();
  const nasTracks = lib.tracks.filter(x => x.source === 'navidrome');
  assert.strictEqual(nasTracks.length, nas.listTracks().length);
  const grad = lib.albums.find(a => a.title === 'Graduation');
  assert.ok(grad && grad.source === 'navidrome');
  assert.strictEqual(grad.artist, 'Kanye West');
  assert.strictEqual(grad.cover, '/nascover/al-a1_x');
  assert.deepStrictEqual(grad.trackIds, ['nd:s1', 'nd:s2', 'nd:s4'], 'ordered by track number');
  assert.ok(lib.artists.some(a => a.name === 'Kendrick Lamar' && a.trackCount === 1));
  const merged = lib.tracks.find(x => x.id === 'nd:s1');
  assert.strictEqual(merged.artistKey, 'Kanye West');
  assert.strictEqual(merged.cover, '/nascover/al-a1_x');
  assert.strictEqual(merged.albumId, grad.id);
  // local tracks are unaffected by a source with no files, and work with no sources at all
  library.init(store);
  assert.strictEqual(library.getLibrary().tracks.filter(x => x.source === 'navidrome').length, 0);
  library.init(store, null, sources);

  /* --- streaming through the local media server --- */
  const srv = await mediaServer.start(store, library, sources);
  try {
    const full = await get(srv.port, '/track/' + encodeURIComponent('nd:s1'));
    assert.strictEqual(full.status, 200);
    assert.ok(full.body.equals(server.audio));
    assert.strictEqual(full.headers['content-type'], 'audio/flac');
    assert.strictEqual(full.headers['accept-ranges'], 'bytes');
    const part = await get(srv.port, '/track/' + encodeURIComponent('nd:s1'), { Range: 'bytes=5-9' });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.body.toString(), '56789');
    assert.strictEqual(part.headers['content-range'], 'bytes 5-9/20');
    assert.strictEqual(server.streamHits.at(-1).range, 'bytes=5-9', 'Range reaches the NAS');
    assert.strictEqual(server.streamHits.at(-1).format, null, 'original format by default');
    for (const h of Object.values(full.headers)) assert.ok(!String(h).includes(PASSWORD), 'no credential in response headers');
    const gone = await get(srv.port, '/track/' + encodeURIComponent('nd:missing'));
    assert.strictEqual(gone.status, 503, 'a failure body (xml) from the NAS is not passed to the player as audio');
    assert.strictEqual(gone.body.length, 0);
    // quality: home (LAN, index 0) and away (Tailscale) are independent
    await nas.setConfig({ servers: [LAN, TS], qualityHome: 'original', qualityAway: 'mp3-192' });
    await get(srv.port, '/track/' + encodeURIComponent('nd:s1'));
    assert.strictEqual(server.streamHits.at(-1).format, null, 'still original on the LAN');
    server.reachable = new Set([TS]); await nas.connect();
    await get(srv.port, '/track/' + encodeURIComponent('nd:s1'));
    assert.strictEqual(server.streamHits.at(-1).format, 'mp3');
    assert.strictEqual(server.streamHits.at(-1).maxBitRate, '192');
    // cover art: fetched once, then served from disk
    const before = server.calls.filter(c => c.method === 'getCoverArt').length;
    const c1 = await get(srv.port, '/nascover/al-a1_x?w=128');
    assert.strictEqual(c1.status, 200); assert.strictEqual(c1.headers['content-type'], 'image/jpeg');
    await get(srv.port, '/nascover/al-a1_x?w=100');
    assert.strictEqual(server.calls.filter(c => c.method === 'getCoverArt').length - before, 1, 'cached on disk');
    // NAS goes away: covers keep serving from cache, streams answer 503 (player skips)
    server.reachable.clear(); await nas.connect();
    assert.strictEqual((await get(srv.port, '/nascover/al-a1_x?w=128')).status, 200);
    assert.strictEqual((await get(srv.port, '/track/' + encodeURIComponent('nd:s1'))).status, 503);
  } finally { srv.server.close(); }

  /* --- offline download: plays with the NAS off --- */
  server.reachable = new Set([LAN, TS]); await nas.connect();
  await nas.syncLibrary();
  assert.strictEqual(nas.isAlbumDownloaded('nd-a1'), false);
  const got = await nas.downloadAlbum('nd-a1');
  assert.strictEqual(got.downloaded, 3);
  assert.strictEqual(nas.isAlbumDownloaded('nd-a1'), true);
  assert.strictEqual(nas.status().downloads.active, false);
  assert.strictEqual(nas.listTracks().filter(x => x.offline).length, 3, 'downloaded tracks are flagged offline');
  server.reachable.clear(); await nas.connect();
  const local = await nas.openStream('nd:s1');
  assert.strictEqual(local.kind, 'file', 'a downloaded song plays with the NAS off');
  assert.ok(fs.readFileSync(local.path).equals(server.audio));
  await assert.rejects(nas.openStream('nd:s3'), e => e.code === 'OFFLINE', 'not downloaded and NAS off: unavailable');
  assert.strictEqual(nas.removeDownload('nd-a1'), 3);
  assert.ok(!fs.existsSync(local.path));
  server.reachable = new Set([LAN, TS]); await nas.connect();

  /* --- forget wipes credential + cache --- */
  await nas.forget();
  assert.ok(!fs.existsSync(path.join(dir, 'nas-credential.bin')));
  assert.strictEqual(nas.listTracks().length, 0);
  assert.strictEqual(nas.status().state, 'unconfigured');
  nas.stop();

  return 'subsonic-source: server order, offline, credential, sync/cache, search, playlists, library merge, stream proxy, covers, scrobbles';
};
