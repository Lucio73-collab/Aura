# Aura

Local Electron music player with crossfade, an AI DJ (Ollama + Kokoro TTS) and a Navidrome/Subsonic NAS source.

## Commands
- Install: `npm install`
- Run: `npm start`
- Test: `node scripts/gen-test-audio.js` once (fixtures in `.test-music/`), then `npm test` (custom runner `test/run.js`)
- Build: `npm run dist` (Windows installer + portable), `npm run dist:linux` (AppImage)

## Layout
- `electron/main.js` main process, `electron/preload.js` bridge, `electron/lib/` library, store, NAS, DJ logic
- `renderer/` UI (`index.html`, `style.css`, `js/`, `css/`)
- `test/*.test.js` tests, `scripts/` dev helpers, `assets/` app icon
- `docs/assets/` README banner and social preview

## Conventions
- Music files are read only unless the user clicks Write tags
- NAS password is stored with OS encryption, never plain text
- No em dashes in docs; Conventional Commits (`feat:`, `fix:`, `docs:`)

## Never
- Commit `spotify.config.json`, library caches, `.env`, or anything from the user's AppData
- Push or create releases without explicit confirmation
