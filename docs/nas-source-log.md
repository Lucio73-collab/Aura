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
   `local.js` (LocalSource, existing behavior behind the contract), `subsonic.js`
   (SubsonicSource). Spotify keeps its current integration; the contract has a
   `playback: 'stream' | 'remote'` flag so a SpotifySource can slot in later.
4. **Auth.** Server facts say no `apiKeyAuthentication`, so token auth
   (`t = md5(password + s)`, fresh random `s` per request). The client also supports the
   OpenSubsonic `apiKey` param (chosen automatically in Settings only if the server
   advertises the extension). `c=Aura`, `v` from `ping`, `f=json`.
5. **Credential** stored only via `safeStorage` (`nas-credential.bin`). If OS encryption
   is unavailable the credential is refused, not stored in plain text. All logged URLs and
   errors go through a masker that strips `u,t,s,p,apiKey,jwt`.
6. **Connection.** Server URLs tried in order with a 2.5 s timeout each, first reachable
   wins; re-probe when offline (20 s), periodic health check while online (60 s), and on
   network interface change / system resume. Renderer gets `nas-status` pushes.
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

## 5. Progress

(see commits on `feature/nas-source`)
