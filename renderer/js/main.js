/* main.js — boot, router, delegation, drag/drop, shortcuts */

async function refreshPlaylists() { S.playlists = await window.aura.playlists(); renderPlaylistNav(); }

// Hidden in the tray or minimized: stop the 3D visuals and pause CSS
// animations. Registered up front, not in boot(), so the state main.js sends
// right after load (e.g. a start-hidden launch) can't arrive before a listener.
window.aura.on('win-visibility', visible => {
  Fx3D.setWindowVisible(visible);
  document.documentElement.classList.toggle('win-hidden', !visible);
});

async function boot() {
  buildMainNav();
  injectChromeIcons();
  loadSettings(await window.aura.settingsGet());
  setLiked(await window.aura.likedList());
  await refreshPlaylists();
  wireChrome();
  window.addEventListener('hashchange', route);
  await syncLibraryState();
  await refreshTaste();
  await restoreSession();
  startSessionAutosave();
  spBoot();
  applyStartPage();
  route();
  // restoreSession() (and route() itself) can render fresh track rows for
  // the restored track before anything has called setPlayingState - without
  // this, their equalizer bars default to animating, implying "playing" for
  // a track that's actually sitting paused.
  setPlayingState(P.playing);

  window.aura.on('cmd', c => {
    if (c === 'toggle') togglePlay();
    else if (c === 'next') next(true);
    else if (c === 'prev') prev();
    else if (c === 'pause') Playback.pause();
    // from the mini player
    else if (c === 'like') toggleLike(P.currentId);
    else if (c === 'shuffle') toggleShuffle();
    else if (c === 'repeat') cycleRepeat();
    else if (typeof c === 'string' && c.startsWith('seek:')) {
      const sec = Number(c.slice(5));
      if (Number.isFinite(sec) && Playback.hasTrack()) Playback.seek(Math.max(0, sec));
    }
  });
  window.aura.on('ollama', o => {
    if (o.running) toast('Ollama connected' + (o.model ? ' · ' + o.model : '') + (o.launched ? ' (auto-launched)' : ''));
  });
  window.aura.on('library-changed', onLibraryChangedOnDisk);
}

// Settings > Open on. Only a fresh boot with no route of its own is redirected.
function applyStartPage() {
  if (location.hash && location.hash !== '#' && location.hash !== '#/') return;
  const page = S.settings.startPage || 'home';
  const hash = page === 'last' ? S.settings.lastRoute : page === 'home' ? null : '#/' + page;
  if (hash) history.replaceState(null, '', hash);
}
const rememberRoute = debounce(hash => { S.settings.lastRoute = hash; window.aura.settingsSet({ lastRoute: hash }); }, 1500);

// The folder watcher (electron/main.js) rescanned after files changed on disk.
async function onLibraryChangedOnDisk({ before, after } = {}) {
  await refreshLibrary();
  S.needsSetup = !S.tracks.length && !(await window.aura.status()).folders.length;
  const typing = document.activeElement && document.activeElement.matches('#content input, #content textarea, #content select');
  if (!typing && !$('#modal:not(.hidden)')) route();
  renderQueue();
  const diff = (after || 0) - (before || 0);
  if (diff > 0) toast(diff + ' new song' + (diff === 1 ? '' : 's') + ' added to your library');
  else if (diff < 0) toast(-diff + ' song' + (diff === -1 ? '' : 's') + ' removed from your library');
}

async function syncLibraryState() {
  const st = await window.aura.status();
  if (st.scanning) { renderScanning(st); pollScan(); return; }
  if (!st.folders.length) { S.needsSetup = true; return; }
  if (!st.count) {
    // folders are configured but the scan hasn't produced anything yet: kick it off
    // and poll, instead of silently rendering an empty library forever.
    await window.aura.rescan();
    renderScanning(await window.aura.status());
    pollScan();
    return;
  }
  S.needsSetup = false;
  await refreshLibrary();
}

let scanTimer = null;
function pollScan() {
  clearInterval(scanTimer);
  scanTimer = setInterval(async () => {
    const st = await window.aura.status();
    const el = $('#scanCount');
    if (el) el.textContent = st.done + ' / ' + st.total + ' files';
    if (!st.scanning) {
      clearInterval(scanTimer);
      await refreshLibrary();
      // boot() carries on while a scan runs, so Home may already have cached
      // mixes and taste built from an empty library - rebuild both from the
      // finished scan or Home stays missing Made for you / Mixes for the session.
      _homeMixesCache = null;
      await refreshTaste();
      S.needsSetup = !S.tracks.length && !st.folders.length;
      route();
      if (st.count) toast('Library ready: ' + st.count + ' songs');
    }
  }, 700);
}

/* ---------- router ---------- */

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [pathPart, queryPart] = h.split('?');
  const [name, ...rest] = pathPart.split('/');
  const q = new URLSearchParams(queryPart || '');
  return { name: name || 'home', arg: rest.length ? decodeURIComponent(rest.join('/')) : null, q: q.get('q') || '' };
}

/* History bookkeeping. Every history entry gets an index stamped into its
   state the first time it's routed: a fresh navigation arrives with null
   state, while Back/Forward land on an entry that already has one. That's
   how scroll position gets restored only when you go back, and how the
   sidebar arrows know whether there's anywhere to go. */
const nav = { idx: 0, max: 0, lastKey: null, scroll: new Map() };

function stampHistory() {
  const st = history.state;
  if (st && typeof st.auraIdx === 'number') { nav.idx = st.auraIdx; return true; }
  nav.idx = nav.lastKey == null ? 0 : nav.idx + 1;
  nav.max = nav.idx;
  history.replaceState({ auraIdx: nav.idx }, '');
  return false;
}

function syncHistoryButtons() {
  $('#btnBack').disabled = nav.idx <= 0;
  $('#btnFwd').disabled = nav.idx >= nav.max;
}

function navigate(hash) {
  if (nowPlayingOpen()) closeNowPlaying();
  if (location.hash === hash) { route(); return; }
  location.hash = hash;
}

function route() {
  // real navigation re-enters route() inside a view transition (fx/motion.js)
  if (typeof Motion !== 'undefined' && Motion.interceptRoute(route)) return;
  S.routeSeq = (S.routeSeq || 0) + 1; // async pages check this before painting
  AudioEngine.previewStop(0.5);
  S.ctxRegistry = {}; ctxSeq = 0;
  S.route = parseHash();
  const c = $('#content');
  const revisit = stampHistory();
  const key = nav.idx + '|' + location.hash;
  const same = key === nav.lastKey;
  // a re-render of the page you're on (cover fetched, modal closed...) keeps
  // your place; Back/Forward returns to where you were; anything new starts at the top
  const scrollTo = same ? c.scrollTop : revisit ? (nav.scroll.get(key) || 0) : 0;
  S.routeScroll = scrollTo; // async pages (Spotify) re-apply it once they've rendered
  nav.lastKey = key;
  syncHistoryButtons();
  if (!same) {
    c.dataset.enter = '1';
    clearTimeout(c._enterT);
    c._enterT = setTimeout(() => delete c.dataset.enter, 1100);
  }
  // horizontal scrollers (timeline, shelves) keep their place across a
  // same-page re-render too, or a background cover fetch yanks them back
  const H_SCROLL = '.timeline-wrap, .hscroll';
  const hScroll = same ? [...c.querySelectorAll(H_SCROLL)].map(el => el.scrollLeft) : null;
  if (S.needsSetup && S.route.name !== 'settings') { renderSetup(); markNav(); return; }
  switch (S.route.name) {
    case 'home': renderHome(); break;
    case 'songs': renderSongs(); break;
    case 'albums': renderAlbums(); break;
    case 'album': renderAlbum(S.route.arg); break;
    case 'artists': renderArtists(); break;
    case 'artist': renderArtist(S.route.arg); break;
    case 'discography': renderDiscography(S.route.arg); break;
    case 'recent': renderRecent(); break;
    case 'mix': renderMix(S.route.arg); break;
    case 'playlist': renderPlaylist(S.route.arg); break;
    case 'liked': renderLiked(); break;
    case 'search': renderSearch(S.route.q || S.route.arg || ''); break;
    case 'stats': renderStats(S.route.arg || '30d'); break;
    case 'settings': renderSettings(); break;
    case 'spartist': renderSpotifyArtist(S.route.arg); break;
    case 'spalbum': renderSpotifyAlbum(S.route.arg); break;
    case 'spplaylist': renderSpotifyPlaylist(S.route.arg); break;
    default: renderHome();
  }
  markNav();
  if (!['search', 'settings'].includes(S.route.name)) rememberRoute(location.hash || '#/home');
  renderSpotifySidebar();
  markPlayingRows();
  markLikeUI();
  c.scrollTo({ top: scrollTo, behavior: 'instant' });
  if (hScroll) c.querySelectorAll(H_SCROLL).forEach((el, i) => { if (hScroll[i] != null) el.scrollLeft = hScroll[i]; });
  if (S.followOnRoute) { S.followOnRoute = false; revealPlaying(false); }
  syncLocateBtn();
  onContentScroll();
}

/* Scroll-linked effects: remember the position for Back, parallax on the
   artist hero, and the compact sticky bar once the big header scrolls away. */
function onContentScroll() {
  const c = $('#content');
  if (nav.lastKey) nav.scroll.set(nav.lastKey, c.scrollTop);
  const hero = c.querySelector('.artist-hero, .home-hero');
  if (hero) hero.style.setProperty('--sy', Math.min(c.scrollTop, 600));
  const bar = c.querySelector('#stickyBar');
  const head = c.querySelector('#detailHead');
  if (bar && head) bar.classList.toggle('show', c.scrollTop > head.offsetHeight - 40);
}

/* ---------- chrome wiring ---------- */

function injectChromeIcons() {
  const set = (id, name) => { const el = document.getElementById(id); if (el) el.innerHTML = icon(name); };
  set('btnShuffle', 'shuffle'); set('btnPrev', 'prev'); set('btnPlay', 'play'); set('btnNext', 'next'); set('btnRepeat', 'repeat');
  set('btnSmart', 'sparkle'); set('btnLyrics', 'mic'); set('btnQueue', 'queue'); set('btnMute', 'volume'); set('btnExpand', 'chevUp');
  set('btnLike', 'heart'); set('npLike', 'heart');
  set('npShuffle', 'shuffle'); set('npPrev', 'prev'); set('npPlay', 'play'); set('npNext', 'next'); set('npRepeat', 'repeat');
  set('npMute', 'volume'); set('npQueueBtn', 'queue'); set('npLyricsBtn', 'mic'); set('npSleepBtn', 'moon'); set('npClose', 'chevDown');
  set('qpClose', 'x'); set('btnNewPlaylist', 'plus'); set('btnNewSpPlaylist', 'plus');
  set('btnBack', 'back'); set('btnFwd', 'forward'); set('npMore', 'dots');
  $('#searchWrap').insertAdjacentHTML('afterbegin', icon('search'));
}

function wireChrome() {
  const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);

  on('btnPlay', 'click', togglePlay); on('npPlay', 'click', togglePlay);
  on('btnNext', 'click', () => next(true)); on('npNext', 'click', () => next(true));
  on('btnPrev', 'click', prev); on('npPrev', 'click', prev);
  on('btnShuffle', 'click', toggleShuffle); on('npShuffle', 'click', toggleShuffle);
  on('btnRepeat', 'click', cycleRepeat); on('npRepeat', 'click', cycleRepeat);
  on('btnSmart', 'click', toggleSmart);
  on('btnLike', 'click', () => toggleLike(P.currentId)); on('npLike', 'click', () => toggleLike(P.currentId));
  on('btnQueue', 'click', () => openPanel('queue')); on('npQueueBtn', 'click', () => openPanel('queue'));
  on('btnLyrics', 'click', () => openPanel('lyrics'));
  on('qpClose', 'click', closePanel);
  on('pbDj', 'click', () => DJ.stop());
  on('btnMini', 'click', () => window.aura.openMini());
  on('btnGoSettings', 'click', () => location.hash = '#/settings');
  on('btnNewPlaylist', 'click', () => promptModal('New playlist', 'My Playlist', async name => {
    const pl = await window.aura.plCreate(name);
    await refreshPlaylists();
    location.hash = '#/playlist/' + pl.id;
  }));

  on('btnExpand', 'click', openNowPlaying);
  // links inside the bar (title -> album, artist names) navigate instead
  on('pbLeft', 'click', e => { if (!e.target.closest('#btnLike, #pbDj, [data-action]') && Playback.hasTrack()) openNowPlaying(); });
  on('btnBack', 'click', () => history.back());
  on('btnFwd', 'click', () => history.forward());
  // mouse side buttons
  window.addEventListener('mouseup', e => {
    if (e.button === 3) { e.preventDefault(); history.back(); }
    else if (e.button === 4) { e.preventDefault(); history.forward(); }
  });
  on('npMore', 'click', e => { if (!P.currentId) return; e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openTrackMenu(r.right - 240, r.bottom + 6, P.currentId); });
  wireFx();
  on('npClose', 'click', closeNowPlaying);
  on('npLyricsBtn', 'click', () => setNowPlayingLyrics(!$('#nowPlaying').classList.contains('lyrics')));
  $('#content').addEventListener('scroll', () => { syncLocateBtnSoon(); onContentScroll(); }, { passive: true });
  window.addEventListener('resize', syncLocateBtnSoon);
  on('npSleepBtn', 'click', openSleepMenu);
  on('tDur', 'click', () => setPref('showRemaining', !S.settings.showRemaining));
  $('#tDur').title = 'Switch between song length and time remaining';

  for (const [seekId] of [['seek'], ['npSeek']]) {
    const el = document.getElementById(seekId);
    el.addEventListener('pointerdown', () => {
      seekDragging = true;
      // clicking the thumb without moving it fires no 'change', which used to
      // leave the progress bar frozen until the next real seek
      window.addEventListener('pointerup', () => setTimeout(() => { seekDragging = false; }, 0), { once: true });
    });
    el.addEventListener('input', () => { setSliderFill(el, el.value / 10); progressShown.clear(); }); // the user moved it: resync progress next tick
    el.addEventListener('change', () => {
      const { dur } = Playback.pos();
      if (dur) Playback.seek((el.value / 1000) * dur);
      seekDragging = false;
    });
  }
  for (const volId of ['vol', 'npVol']) {
    const el = document.getElementById(volId);
    el.addEventListener('input', () => {
      Playback.setVolume(el.value / 100);
      for (const other of ['vol', 'npVol']) { const o = document.getElementById(other); o.value = el.value; setSliderFill(o, el.value); }
      for (const id of ['btnMute', 'npMute']) document.getElementById(id).innerHTML = icon(+el.value ? 'volume' : 'mute');
      saveSettings();
    });
  }
  let lastVol = 0.9;
  const muteToggle = () => {
    const v = Playback.getVolume();
    if (v > 0) { lastVol = v; Playback.setVolume(0); } else Playback.setVolume(lastVol || 0.9);
    const pct = Math.round(Playback.getVolume() * 100);
    for (const id of ['vol', 'npVol']) { const el = document.getElementById(id); el.value = pct; setSliderFill(el, pct); }
    for (const id of ['btnMute', 'npMute']) document.getElementById(id).innerHTML = icon(pct ? 'volume' : 'mute');
  };
  on('btnMute', 'click', muteToggle); on('npMute', 'click', muteToggle);

  // Typing refines one search entry instead of adding one per pause (Back
  // used to step through "ka", "kan", "kany"...), and clearing the box
  // returns to the page the search started from.
  let preSearchHash = null;
  $('#searchInput').addEventListener('input', debounce(e => {
    const v = e.target.value.trim();
    const onSearch = S.route.name === 'search';
    if (v.length >= 2) {
      const hash = '#/search?q=' + encodeURIComponent(v);
      if (onSearch) location.replace(hash);
      else { preSearchHash = location.hash || '#/home'; location.hash = hash; }
    } else if (onSearch) location.replace(preSearchHash || '#/home');
  }, 220));

  document.addEventListener('click', onGlobalClick);
  // right-click anything that represents a song, album or artist
  document.addEventListener('contextmenu', e => {
    const x = e.clientX, y = e.clientY;
    const song = e.target.closest('.row[data-id], .stat-row[data-id], .q-row[data-id]');
    if (song) { e.preventDefault(); openTrackMenu(x, y, song.dataset.id); return; }
    if (e.target.closest('#pbLeft, .np-stage, .np-head') && P.currentId) { e.preventDefault(); openTrackMenu(x, y, P.currentId); return; }
    const albumEl = e.target.closest('[data-action="open-album"][data-key], [data-action="play-album"][data-key]');
    if (albumEl && S.albumById.get(albumEl.dataset.key)) { e.preventDefault(); openAlbumMenu(x, y, S.albumById.get(albumEl.dataset.key)); return; }
    const artistEl = e.target.closest('[data-action="open-artist"][data-artist]');
    if (artistEl) { e.preventDefault(); openArtistMenu(x, y, artistEl.dataset.artist); }
  });
  document.addEventListener('keydown', onKey);
  wireDrag();
  wirePageCoverDrop();
  wireFileImportDrop();
}

/* ---------- 3D + motion ---------- */

let npFx = null;
function setNowPlayingFxColor(rgb) { if (npFx) npFx.setColor(rgb); }
function setNowPlayingFxPalette(pal) { if (npFx) npFx.setPalette(pal); }
function nowPlayingFxBurst() { if (npFx) npFx.burst(); }

function wireFx() {
  // The logo spins only while music plays or under the pointer. Idle, it holds
  // its last frame: a scene that never stops keeps the compositor redrawing the
  // whole window (glass blur included) every time it draws, so playing it
  // draws at 15 fps, the play ring's rate: at 24 px the slow spin can't tell.
  let brandHover = false, brandDrawn = false;
  const brand = $('#brandFx');
  brand.parentElement.addEventListener('pointerenter', () => { brandHover = true; });
  brand.parentElement.addEventListener('pointerleave', () => { brandHover = false; });
  Fx3D.mount(brand, { shape: 'ico', material: 'chrome', glow: 0, dust: 0, scale: 0.78, spin: [0.3, 0.55, 0.1], tilt: 0.3, parallax: 0, wobble: 0, pulse: 0.35, alpha: [0.25, 1], line: 0.9, fps: 15,
    visible: () => !brandDrawn || brandHover || (typeof P !== 'undefined' && P.playing),
    onFrame: () => { brandDrawn = true; } });

  // the whole sheet flows in the cover's colors with light and rings coming
  // off the cover; the cover leans a little toward the pointer and breathes
  // with the bass
  const wrap = $('#npArtWrap');
  // the full WebGL2 scene (fx/nowplaying.js); the ambient backdrop is the fallback
  npFx = (typeof NowPlayingFX !== 'undefined' && NowPlayingFX.init()) || Fx3D.mount($('#npFx'), {
    kind: 'ambient', anchor: $('#npArt'),
    visible: () => nowPlayingOpen() && S.settings.npVisuals !== false,
    onFrame: (lv, sc) => {
      if (Fx3D.reduceMotion) return;
      const beat = 1 + lv.bass * 0.012 + lv.kick * 0.035;
      wrap.style.transform = `perspective(1400px) rotateX(${(-sc.py * 3).toFixed(2)}deg) rotateY(${(sc.px * 4).toFixed(2)}deg) scale(${beat.toFixed(4)})`;
      wrap.style.setProperty('--gx', ((sc.px + 1) * 50).toFixed(1) + '%');
      wrap.style.setProperty('--gy', ((sc.py + 1) * 50).toFixed(1) + '%');
    }
  });

  Fx3D.wireTilt($('#content'), '.tilt', 12);

  // ink ripple from the exact press point on solid buttons
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest('.btn, .play-btn, .np-play, .big-play, .card-play, .tile-play, .chip');
    if (!b || b.disabled || Fx3D.reduceMotion) return;
    const r = b.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2;
    const ink = document.createElement('span');
    ink.className = 'ripple';
    ink.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.appendChild(ink);
    setTimeout(() => ink.remove(), 650);
  });
}

/* ---------- drop audio files anywhere to import them into the library ---------- */

const IMPORT_EXT_RE = /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i;

function wireFileImportDrop() {
  document.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', async e => {
    if (e.target.closest('.drop-cover')) return; // cover art drop zones handle their own images
    const files = [...e.dataTransfer.files].filter(f => IMPORT_EXT_RE.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    const paths = files.map(f => window.aura.getFilePath(f)).filter(Boolean);
    if (!paths.length) return;
    // dropping onto an album or artist detail page sorts straight into it;
    // anywhere else, each file is sorted by its own tags
    const page = e.target.closest('.page');
    const albumId = page && page.dataset.album;
    const target = albumId ? { artist: S.albumById.get(albumId).artist, album: S.albumById.get(albumId).title }
      : (S.route.name === 'artist' ? { artist: S.route.arg, album: 'Unknown Album' } : null);
    toast('Importing ' + paths.length + ' song' + (paths.length === 1 ? '' : 's') + '…');
    const res = await window.aura.importFiles(target, paths);
    toast(res.imported + ' song' + (res.imported === 1 ? '' : 's') + ' imported' + (res.failed && res.failed.length ? ', ' + res.failed.length + ' failed' : ''));
    S.needsSetup = false;
    renderScanning(await window.aura.status());
    pollScan();
  });
}

// The docked side panel doubles as Queue and Lyrics (tabs, Spotify-style) so
// browsing the rest of the library doesn't require leaving Now Playing.
// The docked panel is layered above the Now Playing sheet (so its Queue tab
// can slide over it), so its Lyrics tab must never be showing at the same
// time as the sheet: lyrics requested while the sheet is open go to the
// sheet's own lyrics column instead.
const nowPlayingOpen = () => $('#nowPlaying').classList.contains('open');
function setNowPlayingLyrics(on) {
  $('#nowPlaying').classList.toggle('lyrics', on);
  if (on) renderLyricsPanel();
}
function setPanelMode(mode) {
  if (mode === 'lyrics' && nowPlayingOpen()) { closePanel(); setNowPlayingLyrics(true); return; }
  const qp = $('#queuePanel');
  qp.dataset.mode = mode;
  $$('.qp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === mode));
  if (mode === 'lyrics') renderLyricsPanel(); else renderQueue();
}
function openPanel(mode) {
  if (mode === 'lyrics' && nowPlayingOpen()) { setNowPlayingLyrics(true); return; }
  const qp = $('#queuePanel');
  if (qp.classList.contains('open') && qp.dataset.mode === mode) { closePanel(); return; }
  qp.classList.add('open');
  $('#app').classList.add('queue-open');
  setPanelMode(mode);
}
function closePanel() {
  $('#queuePanel').classList.remove('open');
  $('#app').classList.remove('queue-open');
}
function openNowPlaying() {
  const np = $('#nowPlaying'), qp = $('#queuePanel');
  if (qp.classList.contains('open') && qp.dataset.mode === 'lyrics') { closePanel(); np.classList.add('lyrics'); }
  np.classList.add('open');
  np.setAttribute('aria-hidden', 'false');
  renderUpNext();
  $('#app').classList.add('np-open');
  if (np.classList.contains('lyrics')) renderLyricsPanel();
  // once the sheet has slid all the way up nothing behind it is visible, so
  // the page's own visuals can stop drawing (.52s matches #nowPlaying's transition)
  clearTimeout(npCoverTimer);
  npCoverTimer = setTimeout(() => { if (nowPlayingOpen()) Fx3D.setCovered(true); }, 560);
}
let npCoverTimer = null;
function closeNowPlaying() {
  clearTimeout(npCoverTimer);
  Fx3D.setCovered(false);
  const np = $('#nowPlaying');
  np.classList.remove('open');
  np.setAttribute('aria-hidden', 'true');
  $('#app').classList.remove('np-open');
}

// Mirrors the volume-slider input handler and muteToggle's UI sync (wireChrome
// above) so Up/Down arrows and the sliders never drift out of sync with each other.
function stepVolume(delta) {
  const pct = Math.max(0, Math.min(100, Math.round(Playback.getVolume() * 100 + delta)));
  Playback.setVolume(pct / 100);
  for (const id of ['vol', 'npVol']) { const el = document.getElementById(id); el.value = pct; setSliderFill(el, pct); }
  for (const id of ['btnMute', 'npMute']) document.getElementById(id).innerHTML = icon(pct ? 'volume' : 'mute');
  saveSettings();
}

function onKey(e) {
  // Jump-to-search works even while another input has focus (e.g. a modal
  // field) - every other shortcut below is suppressed while typing.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#searchInput').focus();
    $('#searchInput').select();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom((S.settings.zoom || 1) + 0.1); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom((S.settings.zoom || 1) - 0.1); return; }
    if (e.key === '0') { e.preventDefault(); setZoom(1); return; }
    if (e.key === ',') { e.preventDefault(); navigate('#/settings'); return; }
  }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); history.back(); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); history.forward(); return; }
  // a slider keeps focus after it's dragged; that shouldn't swallow Space and
  // the other shortcuts (arrows keep meaning seek/volume, not nudge the slider)
  if (e.target.matches('input[type="range"]')) {
    e.target.blur();
    if (e.key.startsWith('Arrow')) e.preventDefault();
  } else if (e.target.matches('input,textarea,select')) {
    if (e.key === 'Escape' && e.target.id === 'searchInput') e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowRight') { e.preventDefault(); next(true); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); $('#searchInput').select(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowRight') { e.preventDefault(); next(true); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  else if (e.key === 'ArrowRight') Playback.seek(Playback.pos().t + (S.settings.seekStep || 5));
  else if (e.key === 'ArrowLeft') Playback.seek(Playback.pos().t - (S.settings.seekStep || 5));
  else if (e.key === 'ArrowUp') { e.preventDefault(); stepVolume(S.settings.volumeStep || 5); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); stepVolume(-(S.settings.volumeStep || 5)); }
  else if (e.key === '?') shortcutsModal();
  else if (e.key === 'Escape') { closeNowPlaying(); hideMenu(); closeModal(); }
  else if (e.key.toLowerCase() === 'q') openPanel('queue');
  else if (e.key.toLowerCase() === 'l') toggleLike(P.currentId);
  else if (e.key.toLowerCase() === 'n' && Playback.hasTrack()) nowPlayingOpen() ? closeNowPlaying() : openNowPlaying();
  else if (e.key.toLowerCase() === 's') toggleShuffle();
  else if (e.key.toLowerCase() === 'r') cycleRepeat();
  else if (e.key.toLowerCase() === 'm') $('#btnMute').click();
  else if (e.key.toLowerCase() === 'y') openPanel('lyrics');
}

/* ---------- destructive actions (confirm + undo) ---------- */

function deleteCustomAlbum(a) {
  if (!a || !a.custom) return;
  confirmModal('Delete album?', `"${a.title}" will be removed. Local tracks return to their tag albums; nothing on disk is touched.`, 'Delete', async () => {
    // snapshot everything albumUpsert needs to recreate an equivalent album;
    // `cover` is a resolved /cover/<file> URL when an explicit cover was set
    // (vs. falling back to embedded art), so only that case is restorable -
    // a fallback cover just gets recomputed the same way once the tracks
    // are back.
    const coverFile = a.cover && a.cover.startsWith('/cover/') ? a.cover.slice('/cover/'.length) : undefined;
    const snapshot = { title: a.title, artist: a.artist, releaseDate: a.releaseDate, type: a.type, unreleased: a.unreleased, trackIds: a.trackIds.slice(), coverFile };
    await refreshLibrary(await window.aura.albumDelete(a.id));
    location.hash = '#/albums';
    toast('Album deleted, tracks returned to their tag albums', { label: 'Undo', act: async () => {
      const res = await window.aura.albumUpsert(snapshot);
      await refreshLibrary(res.library);
      location.hash = '#/album/' + res.album.id;
      toast('Album restored');
    } });
  });
}

/* ---------- import into a specific album / artist (from the ⋯ menus) ---------- */

async function importSongsInto(target) {
  const res = await window.aura.importFiles(target);
  if (!res.imported && !(res.failed && res.failed.length)) return; // picker cancelled
  toast(res.imported + ' song' + (res.imported === 1 ? '' : 's') + ' imported' + (res.failed && res.failed.length ? ', ' + res.failed.length + ' failed' : ''));
  S.needsSetup = false;
  renderScanning(await window.aura.status());
  pollScan();
}

function importSongsForArtist(artist) {
  promptModal('Which album are these songs for?', '', albumName => {
    if (albumName) importSongsInto({ artist, album: albumName });
  }, 'e.g. Greatest Hits');
}

/* ---------- following the playing song in track lists ---------- */

// scrollTop (within #content) of a track's row: the rendered row if there is
// one, otherwise its slot in a virtualized list that hasn't painted it yet.
function rowTopInContent(id) {
  if (!id) return null;
  const c = $('#content');
  const offset = el => el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
  const row = c.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (row) return offset(row);
  for (const list of c.querySelectorAll('[data-virtual]')) {
    const idx = (list._vItems || []).findIndex(t => t.id === id);
    if (idx > -1) return offset(list) + idx * ROW_H;
  }
  return null;
}

// 'above' | 'below' | 'visible', or null when the track isn't on this page.
// The top margin skips the sticky table header.
function rowPlacement(id) {
  const top = rowTopInContent(id);
  if (top == null) return null;
  const c = $('#content');
  if (top + ROW_H < c.scrollTop + 40) return 'above';
  if (top > c.scrollTop + c.clientHeight - 8) return 'below';
  return 'visible';
}

function revealPlaying(smooth) {
  const top = rowTopInContent(P.currentId);
  if (top == null) return;
  const c = $('#content');
  c.scrollTo({ top: Math.max(0, top - c.clientHeight / 2 + ROW_H / 2), behavior: smooth ? 'smooth' : 'instant' });
}

// Only follows when the song that just ended was on screen, so it never
// yanks the page away from somewhere the listener scrolled to on purpose.
function followPlayingAfterChange(prevId) {
  if (prevId && prevId !== P.currentId && rowPlacement(prevId) === 'visible') {
    const now = rowPlacement(P.currentId);
    if (now === 'above' || now === 'below') revealPlaying(true);
  }
  syncLocateBtnSoon();
}

function syncLocateBtn() {
  const btn = $('#locateBtn');
  const where = rowPlacement(P.currentId);
  const show = where === 'above' || where === 'below';
  btn.classList.toggle('show', show);
  if (show && btn.dataset.dir !== where) {
    btn.dataset.dir = where;
    btn.innerHTML = icon(where === 'above' ? 'chevUp' : 'chevDown') + '<span>Now playing</span>';
  }
}
let locateRaf = null;
function syncLocateBtnSoon() {
  if (locateRaf) return;
  locateRaf = requestAnimationFrame(() => { locateRaf = null; syncLocateBtn(); });
}

/* ---------- global click delegation ---------- */

async function onGlobalClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) { if (!e.target.closest('#ctxMenu')) hideMenu(); return; }
  const act = el.dataset.action;
  if (act !== 'menu-item') hideMenu();

  switch (act) {
    case 'row-play': {
      if (e.target.closest('[data-action]') !== el) break;
      const id = el.dataset.id;
      if (id === P.currentId) { togglePlay(); break; }
      const wrap = el.closest('[data-ctxkey]');
      const reg = wrap && S.ctxRegistry[wrap.dataset.ctxkey];
      if (reg) playFrom(reg.ids, +el.dataset.index, reg);
      else playFrom([id], 0, { name: 'Song', sourceType: 'single' });
      break;
    }
    case 'row-menu': { e.stopPropagation(); const r = el.getBoundingClientRect(); openTrackMenu(r.left - 160, r.bottom + 6, el.dataset.id); break; }
    case 'like': toggleLike(el.dataset.id); break;
    case 'menu-item': { const fn = menuActs[+el.dataset.mi]; hideMenu(); if (fn) fn(); break; }

    case 'open-album': {
      if (!el.dataset.key) break;
      const target = '#/album/' + el.dataset.key;
      const fromNowPlaying = nowPlayingOpen();
      if (fromNowPlaying) closeNowPlaying();
      if (location.hash === target) { if (fromNowPlaying) revealPlaying(true); break; }
      if (fromNowPlaying) S.followOnRoute = true;
      location.hash = target;
      break;
    }
    case 'open-artist': navigate('#/artist/' + encodeURIComponent(el.dataset.artist)); break;
    case 'open-hash': navigate(el.dataset.hash); break;
    case 'open-search': {
      $('#searchInput').value = el.dataset.q;
      navigate('#/search?q=' + encodeURIComponent(el.dataset.q));
      break;
    }
    case 'np-from': { const h = ctxSourceHash(); if (h) { S.followOnRoute = true; navigate(h); } break; }
    case 'np-art': {
      const t = cur();
      if (t && t.albumId && t.source !== 'spotify') { S.followOnRoute = true; navigate('#/album/' + t.albumId); }
      else if (t && t.source === 'spotify' && spAlbumHash(t)) navigate(spAlbumHash(t));
      break;
    }
    case 'play-artist': playArtist(el.dataset.artist, false); break;
    case 'artist-radio': startRadio(S.tracks.filter(t => t.artistKey === el.dataset.artist).map(t => t.id), el.dataset.artist); break;
    case 'album-radio': { const a = S.albumById.get(el.dataset.id); if (a) startRadio(a.trackIds, a.title); break; }
    case 'toggle-more': {
      const list = el.parentElement.querySelector('.collapsible');
      const open = list.classList.toggle('expanded');
      el.textContent = open ? 'Show less' : 'Show more';
      break;
    }
    case 'locate-playing': revealPlaying(true); break;
    case 'open-mix': navigate('#/mix/' + encodeURIComponent(el.dataset.genre)); break;
    case 'open-discography': {
      S.discoFilter = { artist: el.dataset.artist, type: el.dataset.type || 'all' };
      navigate('#/discography/' + encodeURIComponent(el.dataset.artist));
      break;
    }
    case 'disco-filter': { S.discoFilter = { artist: el.dataset.artist, type: el.dataset.type }; renderDiscography(el.dataset.artist); break; }
    case 'play-album': playAlbum(S.albumById.get(el.dataset.key), false); break;

    case 'ctx-play': { const r = S.ctxRegistry[el.dataset.ctx]; if (r && r.ids.length) { P.shuffle = false; P.smart = false; playFrom(r.ids, 0, r); syncControls(); } break; }
    case 'ctx-shuffle': { const r = S.ctxRegistry[el.dataset.ctx]; if (r && r.ids.length) { P.smart = false; P.shuffle = true; playFrom(r.ids, Math.floor(Math.random() * r.ids.length), r); syncControls(); } break; }
    case 'ctx-smart': { const r = S.ctxRegistry[el.dataset.ctx]; if (r && r.ids.length) { P.shuffle = true; P.smart = true; playFrom(r.ids, Math.floor(Math.random() * r.ids.length), r); syncControls(); toast('Smart Shuffle, suggestions marked ✦'); } break; }
    case 'shuffle-all': { P.smart = false; P.shuffle = true; playFrom(S.tracks.map(t => t.id), Math.floor(Math.random() * S.tracks.length), { name: 'Your Library', sourceType: 'all' }); syncControls(); break; }
    case 'start-dj': DJ.start(); break;

    case 'sort': {
      const store = el.dataset.store, key = el.dataset.key;
      if (store === 'none') break;
      if (store === 'songs') { const s = S.songSort; s.key === key ? s.dir *= -1 : (s.key = key, s.dir = 1); renderSongs(); }
      else if (store.startsWith('pl:')) {
        const id = store.slice(3);
        const s = S.plSort[id] || (S.plSort[id] = { key: 'custom', dir: 1 });
        s.key === key ? s.dir *= -1 : (s.key = key, s.dir = 1);
        id === 'liked' ? renderLiked() : renderPlaylist(id);
      }
      markPlayingRows(); markLikeUI();
      break;
    }

    case 'pl-rename': {
      const id = el.closest('[data-pl]').dataset.pl;
      const pl = S.playlists.find(p => p.id === id);
      promptModal('Rename playlist', pl.name, async name => { if (!name) return; await window.aura.plUpdate(id, { name }); await refreshPlaylists(); route(); });
      break;
    }
    case 'pl-menu': {
      const id = el.dataset.id;
      const r = el.getBoundingClientRect();
      showMenu(r.left, r.bottom + 6, [
        { label: 'Rename', act: () => { const pl = S.playlists.find(p => p.id === id); promptModal('Rename playlist', pl.name, async name => { if (!name) return; await window.aura.plUpdate(id, { name }); await refreshPlaylists(); route(); }); } },
        { label: 'Add songs', act: () => addSongsModal('playlist', id) },
        { label: 'Export as M3U…', act: async () => {
          const res = await window.aura.plExportM3U(id);
          if (res.canceled) return;
          if (!res.ok) { toast(res.error || 'Export failed'); return; }
          toast(`Exported ${res.exported} song${res.exported === 1 ? '' : 's'}` + (res.skipped ? `, ${res.skipped} skipped (Spotify or missing files)` : ''));
        } },
        { label: 'Delete playlist', danger: true, act: () => {
          const pl = S.playlists.find(p => p.id === id);
          confirmModal('Delete playlist?', `"${pl ? pl.name : 'This playlist'}" and its ${pl ? pl.items.length : 0} song${pl && pl.items.length === 1 ? '' : 's'} will be removed.`, 'Delete', async () => {
            await window.aura.plDelete(id);
            await refreshPlaylists();
            location.hash = '#/home';
            toast('Playlist deleted', pl ? { label: 'Undo', act: async () => {
              const restored = await window.aura.plCreate(pl.name);
              await window.aura.plUpdate(restored.id, { items: pl.items, coverFile: pl.coverFile });
              await refreshPlaylists();
              location.hash = '#/playlist/' + restored.id;
              toast('Playlist restored');
            } } : undefined);
          });
        } }
      ]);
      break;
    }
    case 'pl-sort': {
      const id = el.dataset.id;
      const curSort = S.plSort[id] || { key: 'custom' };
      const r = el.getBoundingClientRect();
      showMenu(r.left, r.bottom + 6, [['custom', 'Custom order'], ['title', 'Title'], ['album', 'Album'], ['date', 'Date added'], ['duration', 'Duration']]
        .map(([k, l]) => ({ label: (curSort.key === k ? '✓ ' : '') + l, act: () => { S.plSort[id] = { key: k, dir: k === 'date' ? -1 : 1 }; renderPlaylist(id); markPlayingRows(); markLikeUI(); } })));
      break;
    }
    case 'pl-add': addSongsModal('playlist', el.dataset.id); break;
    case 'album-add-songs': addSongsModal('album', el.dataset.id); break;

    case 'add-track': {
      const target = el.dataset.target, id = el.dataset.id, trackId = el.dataset.track;
      if (target === 'playlist') {
        const pl = await window.aura.plAdd(id, [trackId]);
        const i = S.playlists.findIndex(p => p.id === pl.id);
        if (i > -1) S.playlists[i] = pl;
        renderPlaylistNav();
      } else {
        const a = S.albumById.get(id);
        await refreshLibrary(await window.aura.albumSetTracks(id, [...a.trackIds, trackId]));
      }
      el.textContent = 'Added'; el.disabled = true; el.classList.add('ghost');
      break;
    }
    case 'atp': {
      const pl = await window.aura.plAdd(el.dataset.pl, pendingAdd || []);
      const i = S.playlists.findIndex(p => p.id === pl.id);
      if (i > -1) S.playlists[i] = pl;
      renderPlaylistNav(); closeModal(); toast('Added to ' + pl.name);
      break;
    }
    case 'atp-new': {
      const ids = pendingAdd;
      closeModal();
      promptModal('New playlist', 'My Playlist', async name => {
        const pl = await window.aura.plCreate(name);
        await window.aura.plAdd(pl.id, ids || []);
        await refreshPlaylists();
        toast('Added to ' + pl.name);
      });
      break;
    }

    case 'new-album': albumEditorModal(null); break;
    case 'new-album-for': albumEditorModal(null, { artist: el.dataset.artist }); break;
    case 'new-artist': artistEditorModal(null); break;
    case 'album-menu': { const r = el.getBoundingClientRect(); openAlbumMenu(r.left, r.bottom + 6, S.albumById.get(el.dataset.id), true); break; }
    // no closeModal() here on purpose: confirmModal below replaces this
    // modal's own content in place (openModal always overwrites it fresh) -
    // closing first would leave a stale hide-timeout that could yank the
    // confirm dialog back shut a moment after it opens
    case 'album-del': deleteCustomAlbum(S.albumById.get(el.dataset.id)); break;
    case 'artist-menu': { const r = el.getBoundingClientRect(); openArtistMenu(r.left, r.bottom + 6, el.dataset.artist, S.route.name === 'artist'); break; }

    case 'q-play': queueJump(el.dataset.id); break;
    case 'q-remove': e.stopPropagation(); queueRemove(+el.dataset.idx); break;
    case 'clear-queue': clearQueue(); break;
    case 'panel-tab': setPanelMode(el.dataset.tab); break;

    case 'lyr-fetch': {
      const t = cur(); if (!t) break;
      el.textContent = 'Searching…';
      const data = await window.aura.lyricsFetch(t.id, { artist: t.artistKey, title: t.title, album: t.album, duration: t.duration });
      S.lyricsCache.set(t.id, data || null);
      renderLyricsPanel();
      toast(data ? 'Lyrics found' : 'No lyrics found for this one');
      break;
    }
    case 'lyr-edit': { const t = cur(); if (t) lyricsEditModal(t); break; }
    case 'lyr-seek': Playback.seek(+el.dataset.t); break;

    case 'stats-range': renderStats(el.dataset.range); break;
    case 'add-folder': {
      await window.aura.addFolder();
      const st = await window.aura.status();
      if (st.folders.length) { S.needsSetup = false; renderScanning(st); pollScan(); }
      break;
    }
    case 'rm-folder': { await window.aura.removeFolder(el.dataset.folder); renderScanning(await window.aura.status()); pollScan(); break; }
    case 'rescan': { await window.aura.rescan(); renderScanning(await window.aura.status()); pollScan(); break; }
    case 'use-default-folder': {
      await window.aura.useDefaultFolder();
      const st = await window.aura.status();
      S.needsSetup = false; renderScanning(st); pollScan();
      break;
    }
    case 'import-songs': {
      el.textContent = 'Importing…'; el.disabled = true;
      const target = el.dataset.artist ? { artist: el.dataset.artist, album: el.dataset.album } : null;
      const res = await window.aura.importFiles(target);
      if (res.imported || (res.failed && res.failed.length)) {
        toast(res.imported + ' song' + (res.imported === 1 ? '' : 's') + ' imported' + (res.failed && res.failed.length ? ', ' + res.failed.length + ' failed' : ''));
        S.needsSetup = false;
        renderScanning(await window.aura.status());
        pollScan();
      } else {
        el.textContent = 'Import songs…'; el.disabled = false;
      }
      break;
    }
    case 'import-songs-for-artist': importSongsForArtist(el.dataset.artist); break;
    case 'launch-ollama': {
      el.textContent = 'Launching…';
      const r = await window.aura.ollamaLaunch();
      toast(r.running ? 'Ollama is running' : 'Could not start Ollama. Is it installed?');
      renderSettings();
      break;
    }
    case 'dl-voice': {
      el.textContent = 'Downloading…'; el.disabled = true;
      const stt = await window.aura.ttsDownload();
      toast(stt === 'ready' ? 'Kokoro voice ready' : 'Kokoro unavailable, will use system voices');
      renderSettings();
      break;
    }
    case 'open-mini': window.aura.openMini(); break;
    case 'set-accent': {
      setPref('accent', el.dataset.accent);
      $$('.swatch').forEach(s => s.classList.toggle('on', s === el));
      break;
    }
    case 'open-data-folder': window.aura.openDataFolder(); break;
    case 'quit-app': window.aura.quitApp(); break;
    case 'clear-lyrics': {
      const n = await window.aura.clearFetchedLyrics();
      S.lyricsCache.clear();
      if (cur()) loadLyricsFor(cur());
      toast(n ? `Cleared lyrics for ${n} song${n === 1 ? '' : 's'}` : 'No downloaded lyrics to clear');
      break;
    }
    case 'clear-loudness': {
      const n = await window.aura.clearLoudness();
      AudioEngine.clearLoudness();
      toast(n ? `Loudness will be re-measured for ${n} song${n === 1 ? '' : 's'} as they play` : 'Nothing measured yet');
      break;
    }
    case 'reset-stats':
      confirmModal('Reset listening stats?', 'Play counts, listening history and Stats are wiped for good. Home recommendations start learning from scratch. Consider a backup first.', 'Reset stats', async () => {
        await window.aura.statsReset();
        await refreshLibrary();
        await refreshTaste();
        _homeMixesCache = null;
        toast('Listening stats reset');
      });
      break;
    case 'reset-settings':
      confirmModal('Restore default settings?', 'Every preference goes back to its default. Your music folders, playlists, likes and edits stay as they are.', 'Restore defaults', async () => {
        loadSettings(await window.aura.settingsReset());
        renderSettings();
        toast('Settings restored to defaults');
      });
      break;
    case 'backup-data': {
      const btn = el; btn.disabled = true; const label = btn.textContent; btn.textContent = 'Backing up…';
      const res = await window.aura.backupData();
      btn.disabled = false; btn.textContent = label;
      if (res.canceled) break;
      toast(res.ok ? 'Backed up to ' + res.path : (res.error || 'Backup failed'));
      break;
    }
    case 'reload-all': {
      const btn = el; btn.disabled = true; const label = btn.innerHTML; btn.textContent = 'Reloading…';
      const lib = await window.aura.reloadAll();
      indexLibrary(lib);
      loadSettings(await window.aura.settingsGet());
      setLiked(await window.aura.likedList());
      await refreshPlaylists();
      await refreshTaste();
      btn.disabled = false; btn.innerHTML = label;
      S.needsSetup = !S.tracks.length && !(await window.aura.status()).folders.length;
      route();
      toast('Reloaded');
      break;
    }

    case 'modal-close': closeModal(); break;
    case 'modal-save': doModalSave(); break;

    /* ---------- Spotify ---------- */
    case 'open-spartist': if (el.dataset.id) navigate('#/spartist/' + el.dataset.id); break;
    case 'open-spalbum': if (el.dataset.id) navigate('#/spalbum/' + el.dataset.id); break;
    case 'sp-play-album': e.stopPropagation(); playSpotifyAlbum(el.dataset.id); break;
    case 'sp-album-menu': openSpotifyAlbumMenu(el); break;
    case 'sp-atp': addPendingToSpotifyPlaylist(el.dataset.id); break;
    case 'sp-atp-new': { const uris = pendingSpAdd; closeModal(); createSpotifyPlaylistFlow(uris); break; }
    case 'sp-choose-device': openDeviceSettingsPicker(); break;
    case 'sp-search-retry': e.preventDefault(); Sp.searchMemo.clear(); { const box = $('#spSearchResults'); if (box) box.remove(); } renderSpotifySearchSection(el.dataset.q, 0); break;
    case 'nav-back': history.back(); break;
    case 'sp-connect': e.preventDefault(); connectSpotifyFlow(el); break;
    case 'sp-save-clientid': saveSpotifyClientIdFlow(el); break;
    case 'sp-save-clientid-modal': saveSpotifyClientIdFromModal(el); break;
    case 'sp-howto': e.preventDefault(); showSpotifySetupModal(); break;
    case 'sp-copy-redirect': copyRedirectUri(el.dataset.value); break;
    case 'sp-disconnect': disconnectSpotifyFlow(); break;
    case 'sp-pick-device': pickSpotifyDevice(el.dataset.id); break;
    case 'sp-refresh-devices': refreshDevicePicker(); break;
    case 'sp-like': toggleSpotifyLike(el.dataset.id); break;
    case 'sp-search-more': renderSpotifySearchSection(el.dataset.q, +el.dataset.offset); break;
    case 'sp-add-to-playlist': addToPlaylistModal(el.dataset.ids.split(',')); break;
    case 'sp-new-playlist': createSpotifyPlaylistFlow(); break;
    case 'sp-playlist-add-songs': spotifyPlaylistAddSongsModal(el.dataset.id); break;
    case 'sp-playlist-add-track': addTrackToSpotifyPlaylist(el.dataset.id, el.dataset.uri, el); break;
  }
}

/* ---------- drag reorder (playlists + custom albums) ---------- */

let drag = null;
function wireDrag() {
  document.addEventListener('dragstart', e => {
    const row = e.target.closest('.rows.draggable .row');
    if (!row) return;
    const wrap = row.closest('[data-reorder]');
    drag = { from: +row.dataset.index, key: wrap.dataset.reorder };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragover', e => {
    if (!drag) return;
    const row = e.target.closest('.rows.draggable .row');
    if (!row) return;
    e.preventDefault();
    $$('.row.drop-target').forEach(r => r.classList.remove('drop-target'));
    row.classList.add('drop-target');
  });
  document.addEventListener('drop', async e => {
    if (!drag) return;
    const row = e.target.closest('.rows.draggable .row');
    const d = drag;
    cleanupDrag();
    if (!row) return;
    e.preventDefault();
    const to = +row.dataset.index;
    if (to === d.from) return;
    if (d.key.startsWith('pl:')) {
      const plId = d.key.slice(3);
      const pl = S.playlists.find(p => p.id === plId);
      const items = pl.items = reorderVisible(pl.items, i => S.byId.has(i.trackId), d.from, to);
      await window.aura.plUpdate(plId, { items });
      renderPlaylist(plId);
    } else if (d.key.startsWith('album:')) {
      const alId = d.key.slice(6);
      const a = S.albumById.get(alId);
      const ids = reorderVisible(a.trackIds, id => S.byId.has(id), d.from, to);
      await refreshLibrary(await window.aura.albumSetTracks(alId, ids));
      renderAlbum(alId);
    }
    markPlayingRows(); markLikeUI();
  });
  document.addEventListener('dragend', cleanupDrag);
}
/* Moves the from-th shown entry to the to-th shown slot. Entries the page
   doesn't show (a Spotify song not loaded this session, a file missing right
   now) keep their place; filtering them out before saving used to delete
   them from the playlist for good, and shifted which album track moved. */
function reorderVisible(list, isShown, from, to) {
  const slots = [];
  list.forEach((x, i) => { if (isShown(x)) slots.push(i); });
  if (from >= slots.length || to >= slots.length) return list.slice();
  const shown = slots.map(i => list[i]);
  const [moved] = shown.splice(from, 1);
  shown.splice(to, 0, moved);
  const out = list.slice();
  slots.forEach((i, k) => { out[i] = shown[k]; });
  return out;
}
function cleanupDrag() { drag = null; $$('.row.dragging,.row.drop-target').forEach(r => r.classList.remove('dragging', 'drop-target')); }

/* ---------- cover drop + paste on album/artist/playlist headers ---------- */

function wirePageCoverDrop() {
  const handle = async (zone, dataUrl) => {
    const file = await window.aura.setCover(dataUrl);
    if (!file) { toast('Could not save image'); return; }
    const kind = zone.dataset.coverKind;
    if (kind === 'album') {
      const a = S.albumById.get(zone.dataset.coverId);
      if (a.custom) { const res = await window.aura.albumUpsert({ id: a.id, coverFile: file }); await refreshLibrary(res.library); }
      else await refreshLibrary(await window.aura.albumOverride(a.id, { coverFile: file }));
    } else if (kind === 'artist') {
      const res = await window.aura.artistUpsert({ id: zone.dataset.coverId || undefined, name: zone.dataset.coverName, imageFile: file });
      await refreshLibrary(res.library);
    } else if (kind === 'playlist') {
      await window.aura.plUpdate(zone.dataset.coverId, { coverFile: file });
      await refreshPlaylists();
    }
    route();
    toast('Cover updated');
  };
  document.addEventListener('dragover', e => {
    const z = e.target.closest('.detail-head .drop-cover');
    if (z) { e.preventDefault(); z.classList.add('over'); }
  });
  document.addEventListener('dragleave', e => {
    const z = e.target.closest('.detail-head .drop-cover');
    if (z) z.classList.remove('over');
  });
  document.addEventListener('drop', e => {
    const z = e.target.closest('.detail-head .drop-cover');
    if (!z) return;
    e.preventDefault();
    z.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) readImg(f, d => handle(z, d));
  });
  document.addEventListener('paste', e => {
    const z = $('#content .detail-head .drop-cover');
    if (!z || $('#modal:not(.hidden) #coverZone')) return;
    if (!['album', 'artist', 'playlist'].includes(z.dataset.coverKind)) return;
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        readImg(item.getAsFile(), d => handle(z, d));
        break;
      }
    }
  });
}

boot();
