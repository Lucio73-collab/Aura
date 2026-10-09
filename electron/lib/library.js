/* library.js — scanning + the curated library merge. Pure Node. */
const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');
const { primaryArtist, splitArtists } = require('./artistName');
const { cleanTitle, titleFromFilename, trackNumberFromFilename, normalizeForKey } = require('./normalize');

let store = null;
let spotify = null;           // optional: electron/lib/spotify.js, for sp: track resolution
let sources = null;           // optional: sources/index.js registry, for NAS (nd:) tracks
let cacheFile = null;
let cache = {};
let raw = [];                 // scanned tracks (no overrides)
let fileById = new Map();     // trackId -> absolute path
let scan = { scanning: false, done: 0, total: 0, at: null };

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.webm']);

// Bump whenever a scan-time-derived field changes shape or meaning (like the
// albumArtist normalization below, or the title cleanup) so every cached
// entry is recomputed once instead of silently keeping stale values until
// the affected file changes.
const CACHE_VERSION = 11;

function init(storeModule, spotifyModule, sourcesModule) {
  store = storeModule;
  spotify = spotifyModule || null;
  sources = sourcesModule || null;
  cacheFile = path.join(store.dir(), 'library-cache.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache = (loaded && loaded.v === CACHE_VERSION) ? loaded.files : {};
  } catch { cache = {}; }
}

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

// Some rips mistakenly put the ALBUM's own name into the albumartist tag
// instead of the actual performing artist - seen on a whole Kanye West &
// Drake collab project where every file's albumartist tag literally says
// "WOLVES" (the album title). Taken at face value that manufactures a
// phantom "Wolves" artist that owns the album, while every track's own
// artist tag still (correctly) credits Kanye West. When the normalized
// albumartist matches the album title itself, it isn't a real artist name -
// fall back to the track's own artist tag, same as when there's no
// albumartist tag at all.
// A YouTube Music "DONDA 2" rip has the same problem one step removed: the
// albumartist tag is just "DONDA" on its own (not the full "DONDA, Kanye
// West, Ye" credit line), which isn't an exact match for "DONDA 2" so the
// check above misses it. isPrequelCredit recognizes it's the prequel's name
// plus a sequel marker either way, so it gets the same fallback to the
// track artist tag, which still has the real names to fall back onto.
function resolveAlbumArtist(rawAlbumArtist, rawArtist, hasAlbumTag, albumTag) {
  const album = hasAlbumTag ? albumTag : null;
  let albumArtist = primaryCredit(((rawAlbumArtist || rawArtist) || '').trim(), album);
  if (hasAlbumTag && (normalizeForKey(albumArtist) === normalizeForKey(albumTag) || isPrequelCredit(albumArtist, albumTag))) {
    albumArtist = primaryCredit(rawArtist, album);
  }
  return albumArtist;
}

// YouTube Music rips of a sequel credit the *first* album's name as the lead
// artist: every "DONDA 2" file's artist tag reads "DONDA, Kanye West, Ye", so
// taking the first name at face value files the whole album under a phantom
// "DONDA" artist. A credit that is exactly the album title plus a sequel
// marker ("2", "II", "Part 2", "Vol. 3") is the prequel's name, not a
// performer - skip it when another credit remains. A credit equal to the
// album title itself is deliberately NOT skipped from the artist tag: that's
// a self-titled album by a real group ("KIDS SEE GHOSTS, Pusha T" on "KIDS SEE
// GHOSTS"), which must stay KIDS SEE GHOSTS rather than go to the feature.
const SEQUEL_MARKER_RE = /^(?:(?:vol(?:ume)?|pt|part)\.?\s*)?(?:\d+|[ivx]+)$/i;
function isPrequelCredit(name, albumTitle) {
  const n = normalizeForKey(name), a = normalizeForKey(albumTitle);
  return !!n && a.startsWith(n + ' ') && SEQUEL_MARKER_RE.test(a.slice(n.length + 1).trim());
}
function realCredits(rawArtist, albumTitle) {
  const names = splitArtists(rawArtist);
  if (!albumTitle) return names;
  const real = names.filter(n => !isPrequelCredit(n, albumTitle));
  return real.length ? real : names;
}
function primaryCredit(rawArtist, albumTitle) {
  return realCredits(rawArtist, albumTitle)[0] || primaryArtist(rawArtist);
}

// A track numbered right after (or before) a tagged tracklist landing in the
// same folder ("016 -..." sitting next to a 15-track tagged album) is very
// unlikely to be a coincidence - a stray unrelated loose single would have
// no reason to number itself that way. Requires a real leading track number
// on both sides (trackNumberFromFilename's fallback is 0, which never
// matches a real neighbour range).
function isTrackNumberAdjacent(n, taggedNums) {
  if (!n || !taggedNums.length) return false;
  return n === Math.max(...taggedNums) + 1 || n === Math.min(...taggedNums) - 1;
}

// A track with no album tag normally becomes a standalone single (see the
// "no album tag" branch above). But a leaked/bonus cut ripped without tags
// and dropped into an existing album's own folder ("Graduation/015 -
// Bittersweet Poetry...") isn't a single, it's semi-unreleased *on that
// album*. Detect it by folder: if an untagged track shares a directory with
// tagged siblings that agree on one real album, adopt that album for it
// instead and flag it `bonus` so the UI can badge it, rather than spinning
// it out into its own single-track "album" named after the song. Two or
// more agreeing siblings are trusted on count alone; a single tagged
// neighbour still qualifies when the untagged track's own track number
// continues that neighbour's numbering (common on small EPs/deluxe bonus
// cuts, where only one or two tracks carry real tags). That adjacency chains:
// a yt-dlp playlist rip ("Donda/001 - ...opus" through "027 - ...") where
// only 001 got an album tag still numbers contiguously outward from it, so
// 002 attaches, which lets 003 attach, and so on - instead of 25 of the 27
// songs each becoming their own single. When the adopted tracks outnumber
// the tagged ones they're the album proper, not extras, so they aren't
// badged as bonus.
function attachBonusTracks(found) {
  const byDir = new Map();
  for (const f of found) {
    const dir = path.dirname(f.file);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  for (const group of byDir.values()) {
    const untagged = group.filter(f => f.track.albumKey.startsWith('sgl-'));
    if (!untagged.length) continue;
    const tagged = group.filter(f => !f.track.albumKey.startsWith('sgl-'));
    if (!tagged.length) continue;
    const counts = new Map();
    for (const f of tagged) counts.set(f.track.albumKey, (counts.get(f.track.albumKey) || 0) + 1);
    const [dominantKey, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const dominantTagged = tagged.filter(f => f.track.albumKey === dominantKey);
    const dominant = dominantTagged[0].track;
    const nums = dominantTagged.map(f => f.track.trackNo);
    const adopted = [];
    let pending = untagged;
    let grew = true;
    while (grew && pending.length) {
      grew = false;
      const rest = [];
      for (const f of pending) {
        if (dominantCount >= 2 || isTrackNumberAdjacent(f.track.trackNo, nums)) {
          adopted.push(f);
          nums.push(f.track.trackNo);
          grew = true;
        } else rest.push(f);
      }
      pending = rest;
    }
    const bonus = adopted.length <= tagged.length;
    for (const f of adopted) {
      f.track.album = dominant.album;
      f.track.albumKey = dominant.albumKey;
      f.track.albumArtist = dominant.albumArtist;
      f.track.bonus = bonus;
      f.track.hasArt = fs.existsSync(path.join(store.artDir(), f.track.albumKey + '.jpg'));
    }
  }
}

// A track ripped/imported twice under different paths in the same album (a
// drag-drop reimport into Aura's managed folder that duplicates a file
// already organized elsewhere, a browser re-download auto-renamed "...
// (2)") shows up twice in the tracklist and inflates the song count.
// Detected per album by matching track number + title with a near-identical
// duration - the duration check is what keeps this from misfiring on two
// genuinely different songs that happen to collide on title after cleanup
// (an "(Interlude)" versus the full song, for example, run a lot shorter).
// Keeps whichever copy is older (dateAdded), tie-broken by the shorter path
// (favors the original filename over an auto-renamed "(2)" duplicate). Only
// ever changes what's *shown* - neither copy is touched on disk.
function dedupeTracks(found) {
  const byAlbum = new Map();
  for (const f of found) {
    if (!byAlbum.has(f.track.albumKey)) byAlbum.set(f.track.albumKey, []);
    byAlbum.get(f.track.albumKey).push(f);
  }
  const drop = new Set();
  for (const group of byAlbum.values()) {
    const kept = new Map(); // "trackNo::title" -> the f currently being kept
    for (const f of group) {
      const key = f.track.trackNo + '::' + f.track.title.toLowerCase();
      const existing = kept.get(key);
      if (!existing) { kept.set(key, f); continue; }
      if (Math.abs(existing.track.duration - f.track.duration) > 2) continue; // different songs, title just collided
      const fIsOlder = f.track.dateAdded < existing.track.dateAdded ||
        (f.track.dateAdded === existing.track.dateAdded && f.file.length < existing.file.length);
      if (fIsOlder) { drop.add(existing); kept.set(key, f); }
      else drop.add(f);
    }
  }
  return found.filter(f => !drop.has(f));
}

async function rescan() {
  if (scan.scanning) return status();
  scan = { scanning: true, done: 0, total: 0, at: null };
  const folders = store.settings().musicFolders || [];
  const files = [];
  for (const f of folders) walk(f, files);
  scan.total = files.length;
  let found = [];
  let cacheChanged = false;

  for (const file of files) {
    scan.done++;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const sig = `${st.mtimeMs}:${st.size}`;
    let entry = cache[file];

    if (!entry || entry.sig !== sig) {
      try {
        const meta = await mm.parseFile(file, { duration: true });
        const c = meta.common;
        const id = store.id16(file);
        const artist = (c.artist || 'Unknown Artist').trim();
        // No album tag at all: treat it as a standalone single, Spotify-style
        // (named after the song itself) instead of dumping every untagged
        // track by the same artist into one shared "Unknown Album" bucket.
        const hasAlbumTag = !!(c.album && c.album.trim());
        const albumTag = hasAlbumTag ? c.album.trim() : null;
        const albumArtist = resolveAlbumArtist(c.albumartist, artist, hasAlbumTag, albumTag);
        // Ripped/downloaded files (yt-dlp and friends) routinely leave the
        // artist name, "feat. X", or "(Official Video)" junk baked into the
        // title tag itself. Clean that up automatically here, at read time,
        // so it never needs a manual per-file fix and no file is ever
        // touched just to display a track name correctly.
        const title = c.title
          ? cleanTitle(c.title.trim(), albumArtist)
          : titleFromFilename(path.basename(file), albumArtist);
        const album = hasAlbumTag ? albumTag : title;
        // Keyed on a normalized form so two rips of the same album tagged
        // with a different apostrophe/quote style or letter case still land
        // in one album instead of silently splitting into two because of a
        // cosmetic tag difference.
        const albumKey = hasAlbumTag ? store.id16(normalizeForKey(albumArtist) + '::' + normalizeForKey(album)) : ('sgl-' + id);
        const artPath = path.join(store.artDir(), albumKey + '.jpg');
        if (!fs.existsSync(artPath) && c.picture && c.picture.length) {
          try { fs.writeFileSync(artPath, c.picture[0].data); } catch {}
        }
        entry = {
          sig,
          track: {
            id,
            fileName: path.basename(file),
            title,
            artist, albumArtist, album, albumKey,
            // No track-number tag either: fall back to the leading number in
            // the filename ("001 - Title...") instead of 0, which otherwise
            // sorts an entire untagged rip alphabetically by title.
            trackNo: (c.track && c.track.no) || trackNumberFromFilename(path.basename(file), 0),
            discNo: (c.disk && c.disk.no) || 1,
            year: c.year || null,
            genre: (c.genre && c.genre[0]) || null,
            duration: Math.round(meta.format.duration || 0),
            dateAdded: Math.round(Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs))
          }
        };
        cache[file] = entry;
        cacheChanged = true;
      } catch (err) {
        console.warn('skipped:', path.basename(file), '(' + err.message + ')');
        continue;
      }
    }
    entry.track.hasArt = fs.existsSync(path.join(store.artDir(), entry.track.albumKey + '.jpg'));
    // copy: attachBonusTracks rewrites album fields per scan, and those must
    // not leak back into the cache (a once-adopted track would otherwise
    // look tagged on every later scan)
    found.push({ file, track: { ...entry.track } });
  }

  attachBonusTracks(found);
  found = dedupeTracks(found);

  // files just walked obviously exist; only the rest need a disk check
  const walked = new Set(files);
  for (const k of Object.keys(cache)) if (!walked.has(k) && !fs.existsSync(k)) { delete cache[k]; cacheChanged = true; }
  // an unchanged library (the usual watcher-triggered rescan) skips rewriting the whole cache
  if (cacheChanged || !fs.existsSync(cacheFile)) {
    try { fs.writeFileSync(cacheFile, JSON.stringify({ v: CACHE_VERSION, files: cache })); } catch {}
  }

  raw = found.map(f => f.track);
  fileById = new Map(found.map(f => [f.track.id, f.file]));
  scan = { scanning: false, done: scan.done, total: scan.total, at: Date.now() };
  console.log('Library ready:', raw.length, 'tracks');
  return status();
}

const status = () => ({ ...scan, count: raw.length, folders: store.settings().musicFolders || [] });
const filePath = id => fileById.get(id) || null;

/* ---------- curated merge: overrides + custom albums/artists ---------- */

// Every place a Spotify track can be referenced from Aura's own data: custom
// albums and local playlists (never the scanned library itself). Resolved
// from spotify.js's on-disk cache only - synchronous, never a network call -
// so getLibrary() stays sync. A track added to a custom album or playlist is
// always cached by then (adding one requires having fetched it first), so a
// miss here just means "not fetched yet", not an error.
function resolveSpotifyStubs(ov) {
  if (!spotify) return [];
  const ids = new Set();
  for (const ca of ov.customAlbums) for (const tid of ca.trackIds) if (tid.startsWith('sp:')) ids.add(tid.slice(3));
  for (const pl of store.playlists()) for (const it of pl.items) if (it.trackId.startsWith('sp:')) ids.add(it.trackId.slice(3));
  const stubs = [];
  for (const id of ids) { const t = spotify.getCachedTrack(id); if (t) stubs.push(t); }
  return stubs;
}

function getLibrary() {
  const ov = store.overrides();

  // 1. apply per-track overrides (Spotify stubs never have local overrides).
  // NAS tracks come from the source registry's metadata cache (no network)
  // and are grouped into albums/artists exactly like scanned files; their
  // album artist gets the same primary-credit normalization a scan applies.
  const remote = sources ? sources.remoteTracks().map(t => ({ ...t, albumArtist: primaryCredit(t.albumArtist, t.album) })) : [];
  const tracks = (remote.length ? raw.concat(remote) : raw).map(t => ({ ...t, ...(ov.tracks[t.id] || {}) })).concat(resolveSpotifyStubs(ov));
  const byId = new Map(tracks.map(t => [t.id, t]));

  // 2. which tracks are claimed by custom albums
  const claimed = new Map();
  for (const ca of ov.customAlbums) for (const tid of ca.trackIds) if (byId.has(tid)) claimed.set(tid, ca.id);

  // 3. auto albums (from tags) for unclaimed tracks, with album-level overrides applied.
  // Spotify tracks never get an auto album of their own - they only ever
  // surface inside a custom album/playlist that explicitly claims them.
  const albums = new Map();
  for (const t of tracks) {
    if (claimed.has(t.id) || t.source === 'spotify') continue;
    let a = albums.get(t.albumKey);
    if (!a) {
      const ao = ov.albums[t.albumKey] || {};
      a = {
        id: t.albumKey, custom: false, source: t.source || 'local',
        title: ao.title || t.album,
        artist: ao.artist || t.albumArtist,
        releaseDate: ao.releaseDate || t.albumReleaseDate || null,
        type: ao.type || t.albumType || 'album',
        unreleased: !!ao.unreleased,
        artFetchTried: !!ao.artFetchTried,
        cover: ao.coverFile ? ('/cover/' + ao.coverFile) : (t.hasArt ? ('/art/' + t.albumKey) : (t.source === 'navidrome' ? t.cover : null)),
        trackIds: [], dateAdded: 0, year: t.year || null
      };
      albums.set(t.albumKey, a);
    }
    a.trackIds.push(t.id);
    if (!a.cover && t.hasArt) a.cover = '/art/' + t.albumKey;
    a.dateAdded = Math.max(a.dateAdded, t.dateAdded);
    a.year = a.year || t.year;
  }
  for (const a of albums.values()) {
    a.trackIds.sort((x, y) => {
      const A = byId.get(x), B = byId.get(y);
      return (A.discNo - B.discNo) || (A.trackNo - B.trackNo) || A.title.localeCompare(B.title);
    });
    if (!a.releaseDate && a.year) a.releaseDate = a.year + '-01-01';
  }

  // 4. custom albums (your curated / unreleased ones)
  for (const ca of ov.customAlbums) {
    const ids = ca.trackIds.filter(id => byId.has(id));
    const claimedTracks = ids.map(id => byId.get(id));
    const firstArt = claimedTracks.find(t => t.hasArt);
    const firstSpotifyCover = claimedTracks.find(t => (t.source === 'spotify' || t.source === 'navidrome') && t.cover);
    albums.set(ca.id, {
      id: ca.id, custom: true, source: 'local',
      title: ca.title || 'Untitled',
      artist: ca.artist || 'Unknown Artist',
      releaseDate: ca.releaseDate || null,
      type: ca.type || 'album',
      unreleased: !!ca.unreleased,
      cover: ca.coverFile ? ('/cover/' + ca.coverFile) : (firstArt ? ('/art/' + firstArt.albumKey) : (firstSpotifyCover ? firstSpotifyCover.cover : null)),
      trackIds: ids,
      dateAdded: ca.createdAt || Date.now(),
      year: ca.releaseDate ? +ca.releaseDate.slice(0, 4) : null
    });
  }

  // 5. final tracks carry their display album + cover
  const albumOfTrack = new Map();
  for (const a of albums.values()) for (const id of a.trackIds) albumOfTrack.set(id, a.id);
  const outTracks = tracks.map(t => {
    const aid = albumOfTrack.get(t.id) || null;
    const a = aid ? albums.get(aid) : null;
    if (t.source === 'spotify') {
      // Spotify's artist names are already clean; skip the local
      // feat./junk-stripping heuristics meant for scanned file tags.
      // Inside a custom album it belongs to that album's artist and cover,
      // same as a local track would; everywhere else it keeps Spotify's.
      return {
        ...t, albumId: aid, album: a ? a.title : t.album,
        artistKey: a && a.custom ? a.artist : t.artistKey,
        cover: a && a.custom && a.cover ? a.cover : t.cover
      };
    }
    return {
      ...t,
      albumId: aid,
      album: a ? a.title : t.album,
      // artistKey is the normalized identity used for routing/grouping/recs;
      // `artist` itself is left as the raw tag (may list every collaborator)
      // so it still reads correctly wherever it's just displayed as text.
      // (a "DONDA" prequel credit on a "DONDA 2" track is skipped, see isPrequelCredit)
      // Deferring to the album's own resolved artist (already merge/override-
      // aware) keeps every track on an album under the same artist even when
      // that one track's own credit line disagrees - a compilation track
      // credited "John Legend, Travi$ Scott, ..." on Kanye's "Cruel Summer"
      // would otherwise fragment into its own "John Legend" artist page
      // despite the album itself correctly belonging to Kanye West, and an
      // album-artist override (like ¥$ -> Kanye West for VULTURES) would
      // otherwise never reach the tracks it applies to. Falls back to the
      // per-track computation only when a track has no resolved album at all.
      artistKey: a ? a.artist : primaryCredit(t.artist, t.albumKey.startsWith('sgl-') ? null : t.album),
      // every individually credited name (primary + features), for crediting
      // featured artists on their own page without changing who "owns" the track
      // (the NAS already tells us who is credited, no need to re-split a display string)
      artists: t.source === 'navidrome' && t.artists ? t.artists : realCredits(t.artist, t.albumKey.startsWith('sgl-') ? null : t.album),
      cover: a && a.cover ? a.cover : (t.hasArt ? '/art/' + t.albumKey : (t.cover || null))
    };
  });

  // 6. artists: album artists + track artists + custom artist entries (image, may be empty)
  const artists = new Map();
  const ensure = name => {
    if (!artists.has(name)) artists.set(name, { name, image: null, custom: false, customId: null, albumIds: [], trackCount: 0, appearsOn: [] });
    return artists.get(name);
  };
  for (const a of albums.values()) ensure(a.artist).albumIds.push(a.id);
  // A Spotify song that only sits in a local playlist shouldn't conjure up an
  // artist page in your library; one filed into a custom album does count.
  const countsForArtists = t => t.source !== 'spotify' || !!t.albumId && !String(t.albumId).startsWith('sp:');
  for (const t of outTracks) if (countsForArtists(t)) ensure(t.artistKey).trackCount++;
  // Featured (non-primary) credits attach an "appears on" pointer, and now
  // DO get a real entry even for a name that owns nothing of its own here -
  // that's what lets clicking a featured name on a track open a real page
  // for them instead of only ever reaching the primary artist. `appearsOnly`
  // (set below) tells the UI which artists these are, so they still don't
  // clutter the main Artists grid or search - they're reachable by clicking
  // their name on a track, not by browsing the artist directory.
  for (const t of outTracks) {
    if (!countsForArtists(t)) continue;
    for (const name of (t.artists || [])) {
      if (name === t.artistKey) continue;
      ensure(name).appearsOn.push(t.id);
    }
  }
  for (const ar of ov.artists) {
    const e = ensure(ar.name || 'Unknown Artist');
    e.custom = true; e.customId = ar.id;
    if (ar.imageFile) e.image = '/cover/' + ar.imageFile;
  }
  for (const e of artists.values()) e.appearsOnly = !e.custom && !e.trackCount && !e.albumIds.length;

  return {
    tracks: outTracks,
    albums: [...albums.values()],
    artists: [...artists.values()],
    counts: store.plays().counts,
    scannedAt: scan.at
  };
}

module.exports = { init, rescan, status, filePath, getLibrary, primaryArtist, resolveAlbumArtist };
