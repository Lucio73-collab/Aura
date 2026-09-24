# NAS source log (feature/nas-source)

Working log for `AURA-NAS.md`. Newest decisions at the bottom of each section.

## 1. Architecture summary (what I found before changing anything)

**Processes.** Electron main (`electron/main.js`) owns all state and IO. The renderer
(`renderer/js/*`) is a plain-script page served from a local HTTP server
(`electron/lib/mediaServer.js`, `http://127.0.0.1:<random port>`). CSP is
`default-src 'self'; media-src 'self' blob:; connect-src 'self'`, so the renderer can
only talk to that origin. `preload.js` exposes `window.aura.*` (one `ipcRenderer.invoke`
per channel, registered with `H()` in main.js).

**Library.** `electron/lib/library.js` scans `settings.musicFolders` with `music-metadata`,
caches per-file results in `library-cache.json`, and `getLibrary()` merges scanned tracks
with `overrides.json` (per-track/album edits, custom albums/artists) into
`{ tracks, albums, artists, counts }`. Track ids are `md5(path).slice(0,16)`. Albums are
grouped by `albumKey`. Spotify tracks are the existing "second source": ids `sp:<id>`,
`source: 'spotify'`, resolved from `spotify-cache.json` stubs and only merged when a
custom album or playlist references them.

**Storage.** `electron/lib/store.js`: JSON files in `userData/data` (settings, playlists,
liked, plays, overrides, lyrics, loudness, session), debounced atomic writes.
Credentials precedent: `spotifyAuth.js` keeps its refresh token in `spotify-token.bin`
encrypted with `safeStorage`.

**Playback.** `renderer/js/playback.js` already has a *playback* source abstraction:
`LocalSource` (the Web Audio `AudioEngine`) and `SpotifySource` (Connect remote control),
selected by `track.source`. `audio.js` runs two `<audio>` decks (`crossOrigin=anonymous`,
routed through Web Audio) whose `src` is `/track/<id>`; crossfade/automix drive off
`el.duration/currentTime`, and the next track is preloaded on the idle deck via
`scheduleNext` as soon as the current track starts (`player.js scheduleUpcoming`).
Loudness matching fetches `/track/<id>` with a `Range` header.

**No *library* source abstraction existed**: local scanning is hard wired in
`library.js`, and the media server only knows local files.

**AI DJ.** `renderer/js/dj.js` builds prompts from renderer track objects
(`title, artist, album, year, genre, albumType, plays`), Ollama/Kokoro run via main.
It needs nothing but the track fields.

**Search / UI.** `renderSearch` filters `S.tracks/albums/artists` client side. Track rows,
album cards and menus are string templates in `views.js`; Settings sections are HTML
templates with delegated handlers.

## 2. Design decisions

1. **NAS tracks become first class library tracks** (`source: 'navidrome'`, id
   `nd:<songId>`), merged in `getLibrary()` from a metadata cache
   (`nas-library.json`). Everything that works on tracks (Songs, Albums, Artists, search,
   queue, playlists, likes, stats, DJ, recommendations) then works with no extra UI code.
2. **The password never reaches the renderer.** The renderer plays
   `/track/nd%3A<songId>`; the local media server proxies to Navidrome with a fresh
   token/salt per request (Range passthrough). Same origin, so Web Audio, crossfade,
   automix preload and loudness measurement work unchanged and CSP stays as is.
   Cover art likewise: `/nascover/<coverArtId>?w=N`, fetched by main, cached on disk.
3. **Source contract** in `electron/lib/sources/`: `index.js` (registry + contract docs),
   `localSource.js` (LocalSource, existing behavior behind the contract),
   `subsonicSource.js` (SubsonicSource). The wire client is `electron/lib/subsonic.js`. Spotify keeps its current integration; the contract has a
   `playback: 'stream' | 'remote'` flag so a SpotifySource can slot in later.
4. **Auth.** Server facts say no `apiKeyAuthentication`, so token auth
   (`t = md5(password + s)`, fresh random `s` per request). The client also supports the
   OpenSubsonic `apiKey` param (chosen automatically in Settings only if the server
   advertises the extension). `c=Aura`, `v` from `ping`, `f=json`.
5. **Credential** stored only via `safeStorage` (`nas-credential.bin`). If OS encryption
   is unavailable the credential is refused, not stored in plain text. All logged URLs and
   errors go through a masker that strips `u,t,s,p,apiKey,jwt`.
6. **Connection.** All server URLs are pinged at once (2.5 s timeout) and the first one in the
   configured order that answers wins; re-probe when offline (every 10 s), health check while
   online (every 15 s), immediately after a failed stream, and on network interface change
   (polled every 5 s) / system resume. The renderer gets `nas-status` pushes.
7. **Offline behavior.** NAS rows/cards are dimmed (`data-src="navidrome"` + `.nas-offline`
   on `#app`), a sidebar dot shows NAS state, recommendations/DJ skip NAS tracks while it is
   offline, and playing an unavailable track toasts and skips forward.
8. **Away quality.** `format=mp3&maxBitRate=N&estimateContentLength=true` for transcoded
   streams (mp3 gives `<audio>` a usable duration, which crossfade needs; opus/ogg in a
   chunked stream does not). Separate quality for "home" (first URL) and "away" (other
   URLs), both default Original.

## 3. Docs consulted

- Subsonic API 1.16.1, https://www.subsonic.org/pages/api.jsp (token auth, stream,
  scrobble, getAlbumList2 size max 500, search3, playlists, error codes)
- OpenSubsonic, https://opensubsonic.netlify.app/docs/opensubsonic-api/ (apiKey auth,
  `openSubsonic/type/serverVersion`, `getOpenSubsonicExtensions`, extra song fields
  `bpm, replayGain, genres, artists, displayArtist`, `releaseTypes`, formPost, error 44)
- Server facts: `aura-server-facts.md` (Navidrome 0.64.1, API 1.16.1, no API keys,
  formPost, transcoding presets, non-admin `aura` user)

## 4. Environment notes

- Working tree had uncommitted user changes in `renderer/index.html`, `renderer/js/main.js`,
  `renderer/style.css`, `renderer/js/fx/*` and several untracked files. They are NOT part of
  this work and are left uncommitted; I only stage my own hunks.
- From this PC: LAN `/ping` returned 200; the Tailscale URL was unreachable from this machine
  at the time. No NAS credential is stored in Aura yet (no `nas-credential.bin`), so no
  authenticated live smoke test could run yet.

## 5. What was built

| Area | Where |
|---|---|
| Subsonic/OpenSubsonic client (token auth, url building, parsing, errors, masking) | `electron/lib/subsonic.js` |
| Source contract + registry, LocalSource | `electron/lib/sources/index.js`, `localSource.js` |
| SubsonicSource: config, `safeStorage` credential, connection picking, cache, sync, stream/cover fetch, scrobble queue, playlists, offline downloads | `electron/lib/sources/subsonicSource.js` |
| Local media server dispatches `/track/<id>` by source, proxies NAS audio (Range passthrough), serves `/nascover/<id>` | `electron/lib/mediaServer.js` |
| NAS tracks merged into the curated library (albums, artists, covers) | `electron/lib/library.js` |
| Main wiring, `nas:*` IPC, NAS-aware `pl:*` handlers, backup/reset exclusions | `electron/main.js`, `preload.js`, `store.js` |
| Renderer: status dot, Settings section, badges, offline dimming, search top-up, downloads, NAS playlist creation | `renderer/js/nas.js`, `renderer/css/nas.css`, `core.js`, `views.js` |
| Playback: refuse unreachable songs, skip failed/stalled/failed-preload songs, scrobbling, hover-preview guard | `renderer/js/playback.js`, `player.js`, `audio.js` |
| DJ: BPM (NAS songs only) added to the facts and prompt | `renderer/js/dj.js`, `electron/lib/ollama.js` |

## 6. Verification

**Automated** (`npm test`, 17/17): `subsonic-client` (spec md5 example, salt per request, url
building, parsing of sample responses, playlist/scrobble params, transcode params, every
error class, secret masking), `subsonic-source` (URL order, Tailscale fallback, auth failure,
offline restart from cache, incremental sync and removals, search top-up, playlist round trips,
library merge, stream proxy with Range, no credential in headers/files/logs, covers cached,
scrobble queue delivered later, offline download plays with the NAS off, forget wipes
everything), `nas-playback` (unavailability rules, recommendations, playNow gating, stall
watchdog, failure events; mutation-checked). The sample responses in `test/fixtures/subsonic`
were written to the documented shapes, not captured from the live server (it has no music yet).

**Driven end to end in the real app** (dev build, throwaway profile with no personal data, a
local fake Subsonic server that authenticates with real token auth and streams audio, real
`safeStorage`): Test connection (wrong / right password), Save & connect with a dead first
address and a working second one, credential file encrypted and absent from settings/cache/logs,
merged Albums grid with NAS covers and badges, NAS playlist page, NAS-only album with crossfade,
local -> NAS -> local -> NAS queue with crossfade, next-song preload while the current plays
(`Range: bytes=0-`), loudness sampling, "now playing" + counted scrobbles on the server, pause /
resume / seek, NAS killed while idle (noticed in ~3 s, dimming, red status, toast), shuffle never
starting on an unavailable song, app restart with the NAS down (instant, cached library), NAS
restarted (auto reconnect in ~9 s), a stream that returns 500 (skipped seamlessly, next good song
crossfades in), a stream that never starts (given up after the 10 s connect timeout), download an
album for offline then play it with the NAS off, NAS playlist add / remove / rename.
One real bug found this way: a failed *preloaded* song used to fade into a silent deck; fixed
(`loaderror` event, see `audio.js`).

**Against the real server** (`192.168.2.210:4533`, from this PC): `GET /ping` 200; the real client
got the expected `AUTH 40 "Wrong username or password"` for a deliberately wrong password in 49 ms.
The Tailscale address (`100.114.107.79`) did not answer from this PC (timed out at the 3 s limit).
No NAS credential was stored in Aura, so the authenticated live smoke test was NOT run.

## 7. Manual test checklist (real NAS, please run once)

Settings > NAS: LAN `http://192.168.2.210:4533` first, Tailscale `http://100.114.107.79:4533` second,
user `aura`, your password.

- [ ] Test connection on the LAN address: "Connected via 192.168.2.210:4533 (first address, home)", API 1.16.1
- [ ] Off the LAN (or LAN address removed) with Tailscale up: "address #2, away"
- [ ] Wrong password: "The NAS rejected the username or password", status "Sign-in failed", no retry loop
- [ ] Copy some music to the NAS: it shows up within ~5 s + the next refresh (Settings > Refresh library, or wait up to 30 min)
- [ ] Albums / Artists / Songs show the NAS music with the teal dot and "NAS" in album subtitles; covers load
- [ ] Search finds NAS and local songs together; a song added a minute ago is found (search3 top-up)
- [ ] Play a NAS album; mixed local + NAS queue with crossfade 5 s and automix on (FLAC over the LAN, then MP3 over Tailscale)
- [ ] Turn the NAS off / unplug it: status goes red within ~15 s, NAS items dim, local music keeps playing
- [ ] Turn it back on: reconnects by itself, toast "NAS connected"
- [ ] Play a song for 45 s: Navidrome play count goes up (and the Now Playing entry shows in the Navidrome UI)
- [ ] NAS playlist appears in the sidebar; add, remove, rename from Aura; "New NAS playlist" from Add to playlist
- [ ] Quality away = MP3 192: on Tailscale the stream is transcoded (check Navidrome's Now Playing), duration and crossfade still right
- [ ] Album menu > Download for offline, then disconnect the NAS: it still plays, other NAS albums say unreachable
- [ ] AI DJ with NAS songs in the mix (BPM is mentioned to the model when the tags have it)

## 8. Skipped, read-only or limited (and why)

- **API keys**: the client supports the OpenSubsonic `apiKey` param and Settings has the switch, but Navidrome 0.64.1 does not advertise `apiKeyAuthentication`, so it is untested against a real server. Token auth is what runs.
- **Transcoded streams** (away quality): Navidrome ignores `Range` for them, so seeking past the buffered part of a transcoded song is limited. The chosen format is MP3 with `estimateContentLength=true` so the player still gets a duration. Original quality (default) seeks freely. `timeOffset` (transcodeOffset extension) is not used yet.
- **Hover taste previews** are not analysed for NAS songs (the highlight finder would download a whole song); they just start at 30 %.
- **Likes** stay local (Aura's Liked Songs). Not synced to Subsonic stars.
- **Lyrics**: NAS songs use Aura's existing path (saved, then LRCLIB). The server's `songLyrics` is not read yet.
- **ReplayGain / BPM**: BPM goes to the DJ. ReplayGain is stored on the track but the crossfade engine still measures loudness itself; seeding it from `replayGain` would be a small follow-up.
- **Edit tags / Write tags / Delete from disk / Import** are hidden for NAS songs and albums (they operate on local files). Album/track edits made in Aura are still Aura-side overrides.
- **Artist cards** do not carry a NAS mark (an artist can have local and NAS albums); albums, songs and playlists do.
- **Server clock for "Date added"** is the album's `created` time on the NAS.
- **Installed build**: nothing was installed or rebuilt. Your installed Aura is unchanged until you run `npm run dist` and the installer.
- Not touched: pre-existing uncommitted work in `renderer/index.html` (other than two lines for this feature), `renderer/js/main.js`, `renderer/style.css`, `renderer/js/fx/*`, the untracked era/Carti files, `AURA-NAS.md`, `aura-server-facts.md`.

## 9. Notes for a future SpotifySource

The contract in `sources/index.js` already has what Spotify needs: `idPrefix 'sp:'`, `playback: 'remote'`
(no `openStream`), `listTracks()` from `spotify-cache.json` stubs, `search(q)` and `listPlaylists()`.
What would move: `library.js resolveSpotifyStubs` would become `SpotifySource.listTracks()`,
`main.js` `sp:*` search/browse would sit behind `source.search`, and `Playback` in the renderer
(already source-aware: `track.source` picks the engine) would look the engine up from the registry
instead of `if (track.source === 'spotify')`. Two things NAS taught: (1) merge remote tracks into
`getLibrary()` from a synchronous cache so browsing never waits on the network, and (2) give every
source a `status()` and treat "unavailable" as a display state (dim + skip) instead of removing items.
