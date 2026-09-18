/* main.js — Electron main process for Aura */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, globalShortcut, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./lib/store');
const library = require('./lib/library');
const lyrics = require('./lib/lyrics');
const ollama = require('./lib/ollama');
const tts = require('./lib/tts');
const tags = require('./lib/tags');
const stats = require('./lib/stats');
const spotifyAuth = require('./lib/spotifyAuth');
const spotify = require('./lib/spotify');
const mediaServer = require('./lib/mediaServer');
const importer = require('./lib/importer');
const coverArt = require('./lib/coverArt');
const { primaryArtist } = require('./lib/artistName');
const normalize = require('./lib/normalize');

const defaultMusicDir = () => path.join(app.getPath('music'), 'Aura');

let win = null;
let mini = null;
let tray = null;
let httpServer = null;
let origin = null; // http://127.0.0.1:<port>, set once the media server is up
let lastState = { title: 'Not Playing', artist: '', playing: false, cover: null };

// launched by Windows at login with "Start hidden" on: stay in the tray
const launchedHidden = process.argv.includes('--hidden');

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on('second-instance', () => showMain());

function iconImage() {
  const p = path.join(__dirname, '..', 'assets', 'icon.png');
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

// Saved bounds are only reused while they still land on a connected
// display, so unplugging a monitor never opens Aura off-screen.
function savedBounds() {
  const b = store.settings().windowBounds;
  if (!b || !(b.width > 0) || !(b.height > 0)) return {};
  const onScreen = typeof b.x === 'number' && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 60;
  });
  return onScreen ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: b.width, height: b.height };
}

let boundsTimer = null;
function rememberBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    // while maximized keep the last restored size, so un-maximizing after a relaunch lands somewhere sensible
    const b = maximized ? (store.settings().windowBounds || {}) : win.getBounds();
    store.setSettings({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } });
  }, 500);
}

function createWindow() {
  const st = store.settings();
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640,
    ...savedBounds(),
    backgroundColor: '#0e0f12',
    show: false,
    icon: iconImage(),
    // frameless with a native overlay for the min/max/close buttons: Windows
    // draws and handles those itself, so they stay fully functional; the app
    // supplies its own draggable strip (see #sidebar::before in style.css).
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0e0f12', symbolColor: '#ececef', height: 40 }
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.loadURL(origin + '/index.html');
  win.once('ready-to-show', () => {
    if (st.windowBounds && st.windowBounds.maximized) win.maximize();
    if (!(launchedHidden && st.startHidden)) win.show();
  });
  win.webContents.on('did-finish-load', () => { if (win) { win.webContents.setZoomFactor(clampZoom(store.settings().zoom)); sendVisibility(); } });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberBounds);
  // backgroundThrottling is off (audio timers must keep running in the tray),
  // which also means the page never learns it's hidden: tell it, so the 3D
  // visuals and CSS animations stop drawing while nobody can see them.
  const sendVisibility = () => { if (win && !win.isDestroyed()) win.webContents.send('win-visibility', win.isVisible() && !win.isMinimized()); };
  for (const ev of ['show', 'hide', 'minimize', 'restore']) win.on(ev, sendVisibility);
  win.on('close', e => {
    if (app.isQuitting) return;
    if (store.settings().closeToTray !== false) { e.preventDefault(); win.hide(); }
    else app.isQuitting = true;
  });
  win.on('closed', () => { win = null; if (mini) { mini.close(); mini = null; } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

const MINI_W = 340, MINI_H = 156;
// Last spot the mini player was dragged to, if that display is still
// connected; otherwise the bottom-right corner of the primary work area.
function miniPosition() {
  const p = store.settings().miniBounds;
  if (p && typeof p.x === 'number' && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return p.x >= a.x - 40 && p.x + MINI_W <= a.x + a.width + 40 && p.y >= a.y - 10 && p.y + MINI_H <= a.y + a.height + 40;
  })) return { x: p.x, y: p.y };
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - MINI_W - 24, y: a.y + a.height - MINI_H - 24 };
}

function createMini() {
  if (mini) { mini.show(); mini.focus(); return; }
  mini = new BrowserWindow({
    width: MINI_W, height: MINI_H, ...miniPosition(),
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: true,
    resizable: false, maximizable: false, fullscreenable: false, show: false,
    alwaysOnTop: store.settings().miniOnTop !== false, skipTaskbar: true, title: 'Aura Mini',
    icon: iconImage(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mini.loadURL(origin + '/miniplayer.html');
  mini.once('ready-to-show', () => mini && mini.show());
  let moveTimer = null;
  const savePos = () => {
    clearTimeout(moveTimer); moveTimer = null;
    if (!mini || mini.isDestroyed()) return;
    const [x, y] = mini.getPosition();
    store.setSettings({ miniBounds: { x, y } });
  };
  mini.on('move', () => { clearTimeout(moveTimer); moveTimer = setTimeout(savePos, 400); });
  mini.on('close', () => { if (moveTimer) savePos(); });
  mini.on('closed', () => { mini = null; });
  mini.webContents.on('did-finish-load', () => mini && mini.webContents.send('state', lastState));
}

const sendCmd = c => { if (win) win.webContents.send('cmd', c); };
const showMain = () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } };
const clampZoom = z => Math.max(0.7, Math.min(1.6, Number(z) || 1));

/* ---------- settings with side effects outside the renderer ---------- */

const MEDIA_KEYS = [['MediaPlayPause', 'toggle'], ['MediaNextTrack', 'next'], ['MediaPreviousTrack', 'prev'], ['MediaStop', 'pause']];
function registerMediaKeys() {
  for (const [key] of MEDIA_KEYS) { try { globalShortcut.unregister(key); } catch {} }
  if (store.settings().mediaKeys === false) return;
  for (const [key, cmd] of MEDIA_KEYS) { try { globalShortcut.register(key, () => sendCmd(cmd)); } catch {} }
}

// A dev run (electron .) would register the bare electron.exe, which opens
// Electron's default app at login instead of Aura, so packaged builds only.
function applyLoginItem() {
  if (!app.isPackaged) return;
  try { app.setLoginItemSettings({ openAtLogin: !!store.settings().openAtLogin, args: ['--hidden'] }); } catch {}
}

/* Watches the music folders and quietly rescans (debounced) when audio
   files appear, change or disappear, so songs dropped in from Explorer or a
   downloader show up without pressing Rescan. The scan is incremental
   (library-cache.json), so this stays cheap. */
const WATCH_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i;
let watchers = [], watchTimer = null;
function refreshWatchers() {
  for (const w of watchers) { try { w.close(); } catch {} }
  watchers = [];
  clearTimeout(watchTimer);
  if (store.settings().watchFolders === false) return;
  for (const dir of store.settings().musicFolders || []) {
    try {
      const w = fs.watch(dir, { recursive: true }, (ev, file) => {
        // non-audio files are ignored; extensionless names are folders being renamed/removed
        if (file && path.extname(file) && !WATCH_EXT.test(file)) return;
        scheduleWatchRescan();
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {}
  }
}
function scheduleWatchRescan() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    if (library.status().scanning) { scheduleWatchRescan(); return; }
    const before = library.status().count;
    await library.rescan();
    const after = library.status().count;
    if (win) win.webContents.send('library-changed', { before, after });
  }, 2500);
}

function applySettingSideEffects(patch) {
  if (!patch) return;
  if ('mediaKeys' in patch) registerMediaKeys();
  if ('openAtLogin' in patch) applyLoginItem();
  if ('zoom' in patch && win) win.webContents.setZoomFactor(clampZoom(store.settings().zoom));
  if ('miniOnTop' in patch && mini) mini.setAlwaysOnTop(store.settings().miniOnTop !== false);
  if ('watchFolders' in patch || 'musicFolders' in patch) refreshWatchers();
}

function buildTray() {
  tray = new Tray(iconImage().resize({ width: 16, height: 16 }));
  const menu = () => Menu.buildFromTemplate([
    { label: lastState.title + (lastState.artist ? ' · ' + lastState.artist : ''), enabled: false },
    { type: 'separator' },
    { label: lastState.playing ? 'Pause' : 'Play', click: () => sendCmd('toggle') },
    { label: 'Next', click: () => sendCmd('next') },
    { label: 'Previous', click: () => sendCmd('prev') },
    { type: 'separator' },
    { label: 'Mini player', click: () => createMini() },
    { label: 'Show Aura', click: showMain },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setToolTip('Aura');
  tray.setContextMenu(menu());
  tray.on('click', showMain);
  let shown = null;
  return () => {
    const key = lastState.title + '\n' + lastState.artist + '\n' + lastState.playing;
    if (key === shown) return; // cover-only or repeated updates: the menu would come out identical
    shown = key;
    tray.setContextMenu(menu()); tray.setToolTip(lastState.title === 'Not Playing' ? 'Aura' : 'Aura · ' + lastState.title + ' · ' + lastState.artist); };
}

/* ---------- boot ---------- */

app.whenReady().then(async () => {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  store.init(dataDir);
  app.setAppUserModelId('dev.lucio.aura'); // Windows only shows toast notifications for an app with an id
  spotifyAuth.init(store);
  spotify.init(store);
  library.init(store, spotify);
  lyrics.init(store, library);
  ollama.init(store);
  tts.init(store);
  tags.init(library);
  stats.init(store, library);
  spotifyAuth.onChange(st => { if (win) win.webContents.send('spotify-status', st); });

  const srv = await mediaServer.start(store, library);
  httpServer = srv.server;
  origin = 'http://127.0.0.1:' + srv.port;

  createWindow();
  const refreshTray = buildTray();

  ipcMain.on('state:update', (e, s) => {
    if ('id' in s && s.id !== lastState.id) lastState.pos = 0; // new song: the old position no longer applies
    lastState = { ...lastState, ...s };
    refreshTray();
    if (mini) mini.webContents.send('state', lastState);
  });
  // position ticks (~1/s) only matter to the mini player; kept out of
  // state:update so they never touch the tray
  ipcMain.on('state:pos', (e, t, dur) => {
    lastState.pos = t; lastState.duration = dur || lastState.duration;
    if (mini) mini.webContents.send('pos', t, dur);
  });
  ipcMain.on('cmd', (e, c) => sendCmd(c));
  ipcMain.on('mini', (e, a) => {
    if (a === 'show-main') { showMain(); if (mini) mini.close(); }
    else if (a === 'close' && mini) mini.close();
  });

  registerMediaKeys();
  applyLoginItem();

  library.rescan().then(refreshWatchers, refreshWatchers);

  // Ollama: check and auto-launch if needed, and settle which model the DJ
  // uses. The model itself is only loaded when the DJ starts (dj:warm): a
  // 14B model holds ~10 GB of VRAM for 30 minutes, too much to take at every
  // launch for a DJ that may never be switched on.
  (async () => {
    const res = await ollama.ensureRunning();
    if (res.running) {
      const model = await ollama.pickModel();
      if (win) win.webContents.send('ollama', { running: true, model, launched: res.launched });
    } else if (win) {
      win.webContents.send('ollama', { running: false, launched: res.launched });
    }
  })();
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => {
  store.flush();
  globalShortcut.unregisterAll();
  if (httpServer) httpServer.close();
});
app.on('window-all-closed', () => {
  // Aura lives in the tray; closing the window (or the mini player) should not exit the app.
  if (process.platform !== 'darwin' && app.isQuitting) app.quit();
});

/* ---------- IPC: library ---------- */

const H = (ch, fn) => ipcMain.handle(ch, (e, ...a) => fn(...a));

H('lib:status', () => library.status());
H('lib:get', () => library.getLibrary());
H('lib:rescan', () => library.status().scanning ? library.status() : library.rescan());
// Full reload: re-reads every store file (settings, overrides, liked, plays,
// lyrics, loudness, playlists, session) off disk, then rescans the music
// folders, so edits made outside Aura while it was running (a hand-fixed
// overrides.json, a restored backup, files added/removed on disk) take
// effect without quitting the app.
H('app:reloadAll', async () => {
  store.reload();
  if (!library.status().scanning) await library.rescan();
  return library.getLibrary();
});
// Moves the file to the Recycle Bin (shell.trashItem, not a permanent
// delete) so a wrong click is still recoverable from outside Aura even
// though Aura itself has no undo for this one. The caller is expected to
// rescan afterward so the track drops out of the library.
H('lib:deleteTrackFile', async (trackId) => {
  const file = library.filePath(trackId);
  if (!file) return { ok: false, error: 'File not found' };
  try {
    await shell.trashItem(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
H('lib:addFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return store.settings().musicFolders;
  const folders = [...new Set([...(store.settings().musicFolders || []), ...r.filePaths])];
  store.setSettings({ musicFolders: folders });
  library.rescan();
  refreshWatchers();
  return folders;
});
H('lib:removeFolder', (folder) => {
  const folders = (store.settings().musicFolders || []).filter(f => f !== folder);
  store.setSettings({ musicFolders: folders });
  library.rescan();
  refreshWatchers();
  return folders;
});

/* ---------- IPC: default library folder + importing files into it ---------- */

function addFolderToSettings(dir) {
  const folders = [...new Set([...(store.settings().musicFolders || []), dir])];
  store.setSettings({ musicFolders: folders });
  refreshWatchers();
  return folders;
}

H('lib:defaultFolder', () => ({
  path: defaultMusicDir(),
  active: (store.settings().musicFolders || []).includes(defaultMusicDir())
}));
H('lib:useDefaultFolder', () => {
  const dir = defaultMusicDir();
  fs.mkdirSync(dir, { recursive: true });
  addFolderToSettings(dir);
  library.rescan();
  return dir;
});
H('lib:ensureArtistFolder', (name) => {
  const dir = path.join(defaultMusicDir(), importer.sanitizeSegment(primaryArtist(name)));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});
H('lib:ensureAlbumFolder', (artist, album) => {
  const dir = path.join(defaultMusicDir(), importer.sanitizeSegment(primaryArtist(artist)), importer.sanitizeSegment(album));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});
const IMPORT_AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.webm']);
H('lib:importFiles', async (target, filePaths) => {
  let paths = filePaths;
  if (paths && paths.length) {
    // filePaths comes straight from a renderer-side drag-drop, unlike the file
    // picker below it isn't restricted to audio by an OS-level filter
    paths = paths.filter(p => IMPORT_AUDIO_EXT.has(path.extname(p).toLowerCase()));
  } else {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'webm'] }]
    });
    if (r.canceled || !r.filePaths.length) return { imported: 0, results: [] };
    paths = r.filePaths;
  }
  if (!paths.length) return { imported: 0, results: [] };

  const dir = defaultMusicDir();
  fs.mkdirSync(dir, { recursive: true });
  addFolderToSettings(dir);

  const results = await importer.importFiles(paths, dir, target);
  // when the destination artist/album was explicitly forced (not just guessed
  // from the file's own tags), pin it with an override too, so grouping is
  // correct even for formats we can't rewrite tags in (anything but MP3).
  for (const res of results) {
    if (res.ok && res.forced) {
      const trackId = store.id16(res.dest);
      store.overrideTrack(trackId, { artist: res.artist, albumArtist: res.artist, album: res.album });
    }
  }
  library.rescan();
  return { imported: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok), dir };
});

/* ---------- IPC: playlists / liked ---------- */

H('pl:list', () => store.playlists());
H('pl:create', (name) => store.plCreate(name));
H('pl:update', (id, patch) => store.plUpdate(id, patch));
H('pl:delete', (id) => store.plDelete(id));
H('pl:add', (id, trackIds) => store.plAdd(id, trackIds));
H('pl:remove', (id, trackId) => store.plRemove(id, trackId));
H('pl:exportM3U', async (plId) => {
  const pl = store.playlists().find(p => p.id === plId);
  if (!pl) return { ok: false, error: 'Playlist not found' };
  const lib = library.getLibrary();
  const byId = new Map(lib.tracks.map(t => [t.id, t]));
  const lines = ['#EXTM3U'];
  let exported = 0, skipped = 0;
  for (const item of pl.items) {
    // Spotify tracks (sp: ids) and anything missing its file on disk right
    // now can't be referenced by a local M3U path, so they're just skipped
    // rather than writing a broken entry.
    const t = byId.get(item.trackId);
    const file = t && !item.trackId.startsWith('sp:') ? library.filePath(item.trackId) : null;
    if (!t || !file) { skipped++; continue; }
    lines.push(`#EXTINF:${Math.round(t.duration || 0)},${t.artist} - ${t.title}`);
    lines.push(file);
    exported++;
  }
  const r = await dialog.showSaveDialog(win, {
    title: 'Export playlist as M3U',
    defaultPath: path.join(app.getPath('music'), importer.sanitizeSegment(pl.name) + '.m3u'),
    filters: [{ name: 'M3U Playlist', extensions: ['m3u', 'm3u8'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, lines.join('\n') + '\n', 'utf8');
    return { ok: true, path: r.filePath, exported, skipped };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
H('liked:list', () => store.liked());
H('liked:toggle', (trackId) => store.likedToggle(trackId));

/* ---------- IPC: curation ---------- */

H('meta:track', (trackId, patch) => { store.overrideTrack(trackId, patch); return library.getLibrary(); });
H('meta:write', (trackId, fields) => tags.writeToFile(trackId, fields));
H('meta:lookupReleaseDate', (artist, album) => normalize.lookupReleaseDate(artist, album));
H('tags:writeBatch', (items) => tags.writeBatch(items));
H('album:upsert', (data) => { const al = store.albumUpsert(data); return { album: al, library: library.getLibrary() }; });
H('album:override', (albumKey, patch) => { store.overrideAlbum(albumKey, patch); return library.getLibrary(); });
H('album:delete', (id) => { store.albumDelete(id); return library.getLibrary(); });
H('album:tracks', (id, trackIds) => { store.albumSetTracks(id, trackIds); return library.getLibrary(); });
H('artist:upsert', (data) => { const ar = store.artistUpsert(data); return { artist: ar, library: library.getLibrary() }; });
H('artist:delete', (id) => { store.artistDelete(id); return library.getLibrary(); });

H('album:fetchArt', async (albumId) => {
  const before = library.getLibrary();
  const album = before.albums.find(a => a.id === albumId);
  if (!album || album.custom || album.cover) return { ok: false, library: before };
  const markTried = () => { store.overrideAlbum(albumId, { artFetchTried: true }); return { ok: false, library: library.getLibrary() }; };
  const url = await coverArt.findAlbumArtUrl(album.artist, album.title);
  if (!url) return markTried();
  const img = await coverArt.download(url);
  if (!img) return markTried();
  const name = store.newId() + '.' + img.ext;
  try { fs.writeFileSync(path.join(store.coversDir(), name), img.buf); } catch { return markTried(); }
  store.overrideAlbum(albumId, { coverFile: name, artFetchTried: true });
  return { ok: true, library: library.getLibrary() };
});

H('cover:set', (dataUrl) => {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'png' ? 'png' : (m[1].toLowerCase() === 'webp' ? 'webp' : 'jpg');
  const name = store.newId() + '.' + ext;
  try {
    fs.writeFileSync(path.join(store.coversDir(), name), Buffer.from(m[2], 'base64'));
    return name;
  } catch { return null; }
});

/* ---------- IPC: lyrics / stats ---------- */

H('lyrics:get', (trackId) => lyrics.getLyrics(trackId));
H('lyrics:save', (trackId, text) => lyrics.saveLyrics(trackId, text));
H('lyrics:fetch', async (trackId, meta) => {
  const found = await lyrics.fetchLRCLIB(meta);
  if (found) store.lyricsSave(trackId, found);
  return found;
});
H('stats:log', (evt) => store.logPlay(evt));
H('stats:get', (range) => stats.getStats(range));
H('stats:events', (range) => stats.getEvents(range));
H('stats:taste', () => stats.getTasteProfile());

/* ---------- IPC: DJ / Ollama / TTS / settings / windows ---------- */

H('dj:lines', (ctx) => ollama.djLine(ctx));
H('dj:warm', () => ollama.warm());
H('dj:release', () => ollama.release());
H('dj:speak', async (text) => {
  const buf = await tts.speak(text);
  return buf ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : null;
});
H('tts:status', () => tts.status());
H('tts:download', async () => { await tts.load(); return tts.status(); });
H('ollama:status', async () => ({ running: await ollama.ping(), model: store.settings().djModel }));
H('ollama:models', () => ollama.listModels());
H('ollama:launch', () => ollama.ensureRunning().then(async r => { if (r.running) await ollama.pickModel(); return r; }));

H('set:get', () => store.settings());
H('set:set', (patch) => { const st = store.setSettings(patch); applySettingSideEffects(patch); return st; });
H('set:reset', () => {
  const st = store.resetSettings();
  applySettingSideEffects({ mediaKeys: 1, openAtLogin: 1, zoom: 1, miniOnTop: 1, watchFolders: 1 });
  return st;
});

// maintenance buttons in Settings
H('data:openFolder', () => shell.openPath(store.dir()));
H('data:clearFetchedLyrics', () => store.lyricsClearFetched());
H('data:clearLoudness', () => store.loudnessClear());
H('stats:reset', () => { store.resetPlays(); return true; });

H('loudness:get', () => store.loudness());
H('loudness:set', (trackId, factor) => store.loudnessSet(trackId, factor));

H('session:get', () => store.session());
H('session:save', (patch) => store.sessionSave(patch));

// Copies Aura's whole data folder (playlists, likes, overrides/custom
// albums, stats, lyrics cache, loudness cache, custom covers/art - every
// bit of curation that lives only in Aura, not in the music files
// themselves) into a timestamped subfolder the user picks. Never touches
// the music library itself.
H('data:backup', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a folder to save the backup in' });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dest = path.join(r.filePaths[0], `Aura Backup ${stamp}`);
  try {
    store.flush();
    // thumbs/ is a regenerable cache of downscaled art, not curation
    const thumbs = path.join(store.dir(), 'thumbs');
    fs.cpSync(store.dir(), dest, { recursive: true, filter: src => src !== thumbs });
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

H('win:mini', () => { createMini(); if (win) win.minimize(); return true; });
H('win:show', () => { showMain(); return true; });
H('app:quit', () => { app.isQuitting = true; app.quit(); return true; });

/* ---------- IPC: Spotify ----------
   Errors never throw across this boundary (Electron's structured clone drops
   custom properties off a thrown Error, which would lose the .code the
   renderer needs to show the right message). Failures come back as a plain
   { __spotifyError, code, message } object instead; preload.js turns that
   back into a real Error with .code set, on the renderer side of the wire. */
const HS = (ch, fn) => ipcMain.handle(ch, async (e, ...a) => {
  try { return await fn(...a); }
  catch (err) { return { __spotifyError: true, code: err.code || 'UNKNOWN', message: err.message || String(err) }; }
});

HS('sp:status', () => spotifyAuth.status());
HS('sp:setClientId', id => spotifyAuth.setClientId(id));
HS('sp:login', () => spotifyAuth.login());
HS('sp:logout', () => { spotifyAuth.disconnect(); return true; });
HS('sp:redirectUri', () => spotifyAuth.REDIRECT_URI);

HS('sp:search', (q, types, limit, offset) => spotify.search(q, types, limit, offset));
HS('sp:artist', id => spotify.getArtist(id));
HS('sp:artistAlbums', (id, opts) => spotify.getArtistAlbums(id, opts));
HS('sp:album', id => spotify.getAlbum(id));
HS('sp:albumTracks', (id, opts) => spotify.getAlbumTracks(id, opts));
HS('sp:track', id => spotify.getTrack(id));

HS('sp:playbackState', () => spotify.getPlaybackState());
HS('sp:devices', () => spotify.getDevices());
HS('sp:transfer', (deviceId, play) => spotify.transferPlayback(deviceId, play));
HS('sp:playUris', (uris, deviceId, positionMs) => spotify.playUris(uris, deviceId, positionMs));
HS('sp:playContext', (contextUri, offsetUri, deviceId) => spotify.playContext(contextUri, offsetUri, deviceId));
HS('sp:pause', deviceId => spotify.pausePlayback(deviceId));
HS('sp:resume', deviceId => spotify.resumePlayback(deviceId));
HS('sp:seek', (ms, deviceId) => spotify.seek(ms, deviceId));
HS('sp:next', deviceId => spotify.skipNext(deviceId));
HS('sp:previous', deviceId => spotify.skipPrevious(deviceId));
HS('sp:shuffle', (state, deviceId) => spotify.setShuffle(state, deviceId));
HS('sp:repeat', (state, deviceId) => spotify.setRepeat(state, deviceId));
HS('sp:volume', (pct, deviceId) => spotify.setVolume(pct, deviceId));
HS('sp:queueAdd', (uri, deviceId) => spotify.addToQueue(uri, deviceId));

HS('sp:savedTracks', opts => spotify.getSavedTracks(opts));
HS('sp:savedAlbums', opts => spotify.getSavedAlbums(opts));
HS('sp:libSave', uris => spotify.saveToLibrary(uris));
HS('sp:libRemove', uris => spotify.removeFromLibrary(uris));
HS('sp:libContains', uris => spotify.checkLibrary(uris));

HS('sp:createPlaylist', (name, opts) => spotify.createPlaylist(name, opts));
HS('sp:myPlaylists', opts => spotify.getMyPlaylists(opts));
HS('sp:playlist', id => spotify.getPlaylist(id));
HS('sp:playlistItems', (id, opts) => spotify.getPlaylistItems(id, opts));
HS('sp:playlistAdd', (id, uris) => spotify.addPlaylistItems(id, uris));
HS('sp:playlistRemove', (id, uris) => spotify.removePlaylistItems(id, uris));

HS('sp:recentlyPlayed', opts => spotify.getRecentlyPlayed(opts));
HS('sp:topItems', (type, opts) => spotify.getTopItems(type, opts));
