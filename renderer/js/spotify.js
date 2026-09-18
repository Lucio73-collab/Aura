/* spotify.js - Spotify UI: connect flow, search, artist/album browsing,
   Spotify playlists, liked-songs mirror, device picker, settings section.
   All Spotify HTTP happens in the main process (electron/lib/spotify.js);
   everything here just calls spApi.sp* (core.js) and renders what comes back.
   Errors from those calls carry a .code - PREMIUM_REQUIRED,
   NO_ACTIVE_DEVICE, PLAYER_REFUSED, REAUTH_REQUIRED, RATE_LIMITED,
   QUOTA_EXCEEDED, OFFLINE, SERVER_ERROR, FORBIDDEN, NOT_FOUND, BAD_REQUEST,
   UNKNOWN. */

const Sp = {
  status: { configured: false, connected: false, needsReauth: false, displayName: null },
  playlists: [],
  liked: new Set(),        // sp: track ids saved in the user's Spotify library
  likedKnown: new Set(),   // ids whose saved state has been checked
  searchMemo: new Map()    // 'q|offset' -> { at, res }, so re-renders don't re-spend quota
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function spErrMsg(e) {
  return ({
    PREMIUM_REQUIRED: 'Spotify Premium is required for playback control',
    NO_ACTIVE_DEVICE: 'No Spotify device found. Open Spotify on your computer or phone, then try again.',
    PLAYER_REFUSED: 'That Spotify device refused the command' + (e && e.message && e.message !== 'PLAYER_REFUSED' ? ': ' + e.message : ''),
    REAUTH_REQUIRED: 'Spotify session expired, reconnect it in Settings',
    RATE_LIMITED: 'Spotify is rate-limiting Aura right now, try again in a moment',
    QUOTA_EXCEEDED: 'This Spotify app has hit its API quota for now, try again later',
    OFFLINE: 'Can’t reach Spotify. Check your connection.',
    SERVER_ERROR: 'Spotify is having trouble right now, try again shortly',
    FORBIDDEN: 'Spotify refused that request',
    NOT_FOUND: 'That isn’t available on Spotify',
    NO_CLIENT_ID: 'Add a Spotify Client ID in Settings first',
    LOGIN_TIMEOUT: 'Spotify login timed out',
    LOGIN_CANCELLED: 'Spotify login was cancelled',
    PORT_IN_USE: 'Port 8888 is in use by another program, close it and try again'
  })[e && e.code] || ('Spotify error: ' + ((e && e.message) || 'unknown'));
}
// Cancelling the device picker is a choice, not an error worth a toast.
const spSilentError = e => e && (e.code === 'NO_DEVICE_PICKED' || e.code === 'LOGIN_RESTARTED');

const spRawId = id => String(id || '').replace(/^sp:/, '');
const isSpId = id => String(id || '').startsWith('sp:');

/* Ad-hoc Spotify tracks (search results, browse pages, playlists, liked
   mirror) live in S.spTracks, which indexLibrary() folds into S.byId on
   every library refresh - never into S.tracks/albums/artists, which stay
   the curated library - so playback/queue/rows keep working on them. */
function indexSpotifyTracks(tracks) {
  for (const t of (tracks || [])) {
    if (!t || !t.id) continue;
    S.spTracks.set(t.id, t);
    // a library copy (custom album / playlist stub) carries the curated album; keep it
    const lib = S.byId.get(t.id);
    if (!lib || !S.tracks.includes(lib)) S.byId.set(t.id, t);
  }
}

function spBadgeHTML() {
  return `<span class="sp-badge"><svg viewBox="0 0 24 24" class="sp-ic" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>Spotify</span>`;
}
function spLinkOut(url, label = 'Open in Spotify') { return url ? `<a class="sp-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>` : ''; }

// Where a Spotify track's album/artist links should go. A Spotify song filed
// into one of your own custom albums links to that album, not Spotify's.
function spAlbumHash(t) {
  if (!t || !t.albumId) return null;
  return isSpId(t.albumId) ? '#/spalbum/' + spRawId(t.albumId) : '#/album/' + t.albumId;
}
function spArtistRefs(t) {
  if (t.artistRefs && t.artistRefs.length) return t.artistRefs;
  const names = t.artists && t.artists.length ? t.artists : (t.artist ? [t.artist] : []);
  return names.map((name, i) => ({ name, id: i === 0 ? t.artistId : null }));
}
function spArtistLinksHTML(t) {
  return spArtistRefs(t).map(a => a.id
    ? `<span class="link" data-action="open-spartist" data-id="${esc(spRawId(a.id))}">${esc(a.name)}</span>`
    : esc(a.name)).join(', ');
}

/* Async pages render after route() already reset scroll and marked rows;
   this puts the page in place and redoes those bits. */
function spPaint(html, routeName, arg) {
  if (S.route.name !== routeName || S.route.arg !== arg) return false;
  const c = $('#content');
  c.innerHTML = html;
  if (S.routeScroll) c.scrollTo({ top: S.routeScroll, behavior: 'instant' });
  markPlayingRows();
  markLikeUI();
  setPlayingState(P.playing);
  if (typeof onContentScroll === 'function') onContentScroll();
  if (typeof syncLocateBtn === 'function') syncLocateBtn();
  return true;
}
function spLoadingHTML(label) {
  return `<div class="page center-page"><div class="pulse-dot"></div><h1>${esc(label)}</h1></div>`;
}
function spErrorPage(e, retryHash) {
  return `<div class="page center-page">
    <h1>Couldn’t load this from Spotify</h1>
    <div class="muted pad-b">${esc(spErrMsg(e))}</div>
    <div class="detail-actions" style="justify-content:center">
      <button class="btn primary" data-action="open-hash" data-hash="${esc(retryHash)}">Try again</button>
      <button class="btn" data-action="nav-back">Go back</button>
    </div>
  </div>`;
}

/* Spotify image URLs can expire (playlist covers within a day) while the
   metadata cache keeps them for weeks: hide a dead one so the placeholder
   background shows instead of a broken-image icon. */
document.addEventListener('error', e => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && /^https:\/\/[^/]*scdn\.co\//.test(img.src)) img.style.visibility = 'hidden';
}, true);

/* ---------- boot ---------- */

async function spBoot() {
  try { Sp.status = await spApi.spStatus(); } catch { return; }
  window.aura.onSpotifyStatus(st => {
    const wasConnected = Sp.status.connected;
    Sp.status = st;
    if (!st.connected) { Sp.playlists = []; Sp.liked.clear(); Sp.likedKnown.clear(); Sp.searchMemo.clear(); }
    renderSpotifySidebar();
    if (S.route.name === 'settings') renderSettings();
    if (st.connected && !wasConnected) refreshSpotifyPlaylists();
  });
  if (typeof Playback !== 'undefined') Playback.onDevicePicker(showDevicePickerModal);
  renderSpotifySidebar();
  if (Sp.status.connected) refreshSpotifyPlaylists();
}

/* ---------- now playing chrome ---------- */

function renderSpotifyNowPlayingNote(t) {
  const badge = $('#pbSpBadge'), link = $('#npSpLink'), note = $('#npSpotifyNote');
  if (!badge || !link || !note) return;
  const isSp = t && t.source === 'spotify';
  badge.hidden = !isSp;
  link.hidden = !(isSp && t.spotifyUrl);
  if (isSp && t.spotifyUrl) link.href = t.spotifyUrl;
  note.hidden = !isSp;
  note.textContent = isSp ? 'Playing via Spotify Connect · crossfade and automix don’t apply to Spotify tracks' : '';
}

function spotifyNowPlayingChipsHTML(t) {
  const chips = [];
  const albumHash = spAlbumHash(t);
  if (albumHash && t.album) chips.push(`<button class="chip" data-action="open-hash" data-hash="${esc(albumHash)}" title="Go to album">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : icon('disc')}<span>${esc(t.album)}</span></button>`);
  for (const a of spArtistRefs(t)) {
    if (!a.id) continue;
    chips.push(`<button class="chip" data-action="open-spartist" data-id="${esc(spRawId(a.id))}" title="Go to artist">${icon('user')}<span>${esc(a.name)}</span></button>`);
  }
  if (t.year) chips.push(`<span class="chip static">${icon('calendar')}<span>${esc(t.year)}</span></span>`);
  return chips.join('');
}

/* ---------- device picker ---------- */

let pendingDevicePick = null;
function deviceRowHTML(d) {
  const disabled = d.is_restricted;
  return `<button class="menu-item" data-action="sp-pick-device" data-id="${esc(d.id)}" ${disabled ? 'disabled title="This device can’t be controlled remotely"' : ''}>
    ${esc(d.name)}${d.is_active ? ' · active' : ''} <span class="muted">(${esc(d.type || 'device')}${disabled ? ', not controllable' : ''})</span></button>`;
}
function renderDevicePickerModal(devices, loading) {
  const rows = (devices || []).map(deviceRowHTML).join('');
  openModal(`<h3>Choose a Spotify device</h3>
    <div class="muted pad-b">Aura is a remote for Spotify Connect: the music plays in the Spotify app on the device you pick, never inside Aura. If yours isn’t listed, open Spotify on it and press Refresh.</div>
    <div class="modal-list">${loading ? '<div class="muted pad">Looking for devices…</div>' : (rows || '<div class="muted pad">No devices found. Open the Spotify app on this computer or your phone first.</div>')}</div>
    <div class="modal-actions"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn" data-action="sp-refresh-devices">Refresh</button></div>`);
}
function showDevicePickerModal(devices) {
  // A second request while one picker is open shares that picker.
  if (pendingDevicePick) return pendingDevicePick.promise;
  let resolveFn;
  const promise = new Promise(resolve => { resolveFn = resolve; });
  const entry = { promise, resolve: id => { if (pendingDevicePick === entry) pendingDevicePick = null; clearInterval(watcher); resolveFn(id); } };
  pendingDevicePick = entry;
  renderDevicePickerModal(devices);
  // closing the modal any other way (Cancel, backdrop, Escape, another
  // modal replacing it) means "no device". Checks the picker's own markup,
  // not the .open class, which is only added on the next animation frame.
  const watcher = setInterval(() => {
    const m = $('#modal');
    if (pendingDevicePick !== entry) { clearInterval(watcher); return; }
    if (m.classList.contains('hidden') || !m.querySelector('[data-action="sp-refresh-devices"]')) entry.resolve(null);
  }, 300);
  return promise;
}
async function pickSpotifyDevice(id) {
  const entry = pendingDevicePick;
  closeModal();
  if (entry) { entry.resolve(id); return; }
  // picked from Settings with nothing waiting: move current playback there
  try {
    await spApi.spTransfer(id, false);
    SpotifySource.setDevice(id);
    toast('Spotify device switched');
  } catch (e) { toast(spErrMsg(e)); }
}
async function refreshDevicePicker() {
  renderDevicePickerModal([], true);
  let devices = [];
  try { devices = await spApi.spDevices(); } catch (e) { toast(spErrMsg(e)); }
  if ($('#modal [data-action="sp-refresh-devices"]')) renderDevicePickerModal(devices);
}
const openDeviceSettingsPicker = refreshDevicePicker;

/* ---------- sidebar: Spotify playlists, clearly separate from Aura's own ---------- */

function renderSpotifySidebar() {
  const head = $('#spPlaylistsHead'), nav = $('#spPlaylistNav');
  if (!head || !nav) return;
  const show = !!Sp.status.connected;
  head.hidden = !show;
  nav.hidden = !show;
  if (!show) { nav.innerHTML = ''; return; }
  nav.innerHTML = Sp.playlists.map(p =>
    `<a href="#/spplaylist/${esc(p.id)}" class="nav-item pl" data-spplnav="${esc(p.id)}" title="${esc(p.name)}${p.isOwn ? '' : ' (by ' + esc(p.ownerName) + ')'}"><span class="pl-ico sp-dot"></span><span class="nav-label">${esc(p.name)}</span></a>`
  ).join('') || '<div class="muted" style="padding:6px 14px;font-size:12px">No Spotify playlists</div>';
  const r = S.route;
  $$('#spPlaylistNav .nav-item').forEach(a => a.classList.toggle('active', r.name === 'spplaylist' && a.dataset.spplnav === r.arg));
}

async function refreshSpotifyPlaylists() {
  try { Sp.playlists = await spApi.spMyPlaylists(); }
  catch (e) { if (e.code === 'REAUTH_REQUIRED') Sp.playlists = []; }
  renderSpotifySidebar();
}

async function createSpotifyPlaylistFlow(thenAddUris) {
  promptModal('New Spotify playlist', 'My Playlist', async name => {
    if (!name) return;
    try {
      const pl = await spApi.spCreatePlaylist(name, { isPublic: false });
      if (thenAddUris && thenAddUris.length) await spApi.spPlaylistAdd(pl.id, thenAddUris);
      await refreshSpotifyPlaylists();
      if (thenAddUris && thenAddUris.length) toast('Added to ' + pl.name);
      else navigate('#/spplaylist/' + pl.id);
    } catch (e) { toast(spErrMsg(e)); }
  });
}

/* Pick one of your own Spotify playlists to add songs to. */
let pendingSpAdd = null;
function addToSpotifyPlaylistModal(uris) {
  pendingSpAdd = uris.filter(Boolean);
  if (!pendingSpAdd.length) { toast('Only Spotify songs can go in a Spotify playlist'); return; }
  const own = Sp.playlists.filter(p => p.isOwn);
  openModal(`<h3>Add to Spotify playlist</h3>
    <div class="modal-list">${own.map(p => `<button class="menu-item" data-action="sp-atp" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('') || '<div class="muted pad">You don’t own any Spotify playlists yet</div>'}</div>
    <div class="modal-actions"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn primary" data-action="sp-atp-new">${icon('plus')}New Spotify playlist</button></div>`);
}
async function addPendingToSpotifyPlaylist(id) {
  const uris = pendingSpAdd || [];
  const pl = Sp.playlists.find(p => p.id === id);
  closeModal();
  try {
    await spApi.spPlaylistAdd(id, uris);
    toast('Added to ' + (pl ? pl.name : 'playlist'));
    if (S.route.name === 'spplaylist' && S.route.arg === id) route();
  } catch (e) { toast(spErrMsg(e)); }
}

/* ---------- settings section ---------- */

function spotifySettingsHTML() {
  const st = Sp.status;
  if (!st.configured) {
    return `<h2 class="set-h">Spotify</h2><div class="set-card">
      <div class="set-row"><div><div class="set-lbl">Connect Spotify</div><div class="muted">Paste the Client ID from a free Spotify Developer Dashboard app to enable Spotify search, browsing and playback control.</div></div></div>
      <div class="set-row">
        <input type="text" id="spClientIdInput" class="set-input" placeholder="Spotify Client ID" autocomplete="off" spellcheck="false" />
        <button class="btn primary small" data-action="sp-save-clientid">Save & connect</button>
      </div>
      <div class="set-row"><div class="muted">Don't have an app yet? <a class="link" href="#" data-action="sp-howto">Show me the setup steps</a></div></div>
    </div>`;
  }
  if (!st.connected) {
    return `<h2 class="set-h">Spotify</h2><div class="set-card">
      <div class="set-row"><div><div class="set-lbl">Connect your Spotify account</div><div class="muted">${st.needsReauth ? 'Your Spotify session expired or was revoked. Connect again to keep using Spotify in Aura. ' : ''}Search the catalogue and control playback on your Spotify Connect devices. Playback control needs Spotify Premium; Aura never plays Spotify audio itself.</div></div>
      <button class="btn primary small" data-action="sp-connect">${st.needsReauth ? 'Reconnect' : 'Connect Spotify'}</button></div>
      <div class="set-row"><div class="muted">Wrong Client ID? <a class="link" href="#" data-action="sp-howto">Change it</a></div></div>
    </div>`;
  }
  return `<h2 class="set-h">Spotify</h2><div class="set-card">
    <div class="set-row"><div><div class="set-lbl">${esc(st.displayName || 'Connected')}</div><div class="muted">Connected</div></div>
      <span class="dot ok"></span>
      <button class="btn small ghost" data-action="sp-disconnect">Disconnect</button></div>
    <div class="set-row"><div><div class="set-lbl">Playback device</div><div class="muted">Spotify songs play in the Spotify app on this device. Aura picks the active one automatically.</div></div>
      <button class="btn small" data-action="sp-choose-device">Choose device</button></div>
  </div>`;
}

async function saveSpotifyClientIdFlow(btn) {
  const inp = $('#spClientIdInput');
  const id = inp ? inp.value.trim() : '';
  if (!id) { toast('Paste your Client ID first'); return; }
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  try {
    Sp.status = await spApi.spSetClientId(id);
    toast('Client ID saved, opening Spotify login…');
    renderSettings();
    await connectSpotifyFlow();
  } catch (e) {
    toast(spErrMsg(e));
    renderSettings();
  }
}

async function showSpotifySetupModal() {
  let redirectUri = 'http://127.0.0.1:8888/callback';
  try { redirectUri = await spApi.spRedirectUri(); } catch {}
  openModal(`<h3>Connect Aura to Spotify</h3>
    <div class="muted pad-b">Takes about a minute, and it's free.</div>
    <ol class="setup-steps">
      <li>Open the <a class="link" href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify Developer Dashboard</a> and create an app.</li>
      <li>Add this exact Redirect URI (not <code>localhost</code>):
        <div class="copy-row"><code id="spRedirectUriText">${esc(redirectUri)}</code><button class="btn ghost small" data-action="sp-copy-redirect" data-value="${esc(redirectUri)}">Copy</button></div>
      </li>
      <li>Under "Which API/SDKs are you planning to use?", pick <b>Web API</b>.</li>
      <li>Save, then copy the <b>Client ID</b> from the app's settings page and paste it below.</li>
    </ol>
    <input type="text" id="spClientIdInput2" class="set-input" placeholder="Spotify Client ID" autocomplete="off" spellcheck="false" value="${esc(Sp.status.clientId || '')}" />
    <div class="modal-actions"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn primary" data-action="sp-save-clientid-modal">Save & connect</button></div>`, true);
}
async function saveSpotifyClientIdFromModal(btn) {
  const inp = $('#spClientIdInput2');
  const id = inp ? inp.value.trim() : '';
  if (!id) { toast('Paste your Client ID first'); return; }
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  try {
    Sp.status = await spApi.spSetClientId(id);
    closeModal();
    toast('Client ID saved, opening Spotify login…');
    if (S.route.name === 'settings') renderSettings();
    await connectSpotifyFlow();
  } catch (e) {
    toast(spErrMsg(e));
    if (btn) { btn.textContent = 'Save & connect'; btn.disabled = false; }
  }
}
function copyRedirectUri(value) {
  navigator.clipboard.writeText(value).then(() => toast('Redirect URI copied')).catch(() => toast('Could not copy, select and copy it manually'));
}

async function connectSpotifyFlow(btn) {
  if (btn) { btn.textContent = 'Waiting for browser…'; btn.disabled = true; }
  try {
    await spApi.spLogin();
    toast('Spotify connected');
    Sp.searchMemo.clear();
    await refreshSpotifyPlaylists();
  } catch (e) {
    if (!spSilentError(e)) toast(spErrMsg(e));
  }
  try { Sp.status = await spApi.spStatus(); } catch {}
  if (S.route.name === 'settings') renderSettings();
  renderSpotifySidebar();
}
async function disconnectSpotifyFlow() {
  if (typeof Playback !== 'undefined' && Playback.activeSource() === 'spotify' && Playback.hasTrack()) Playback.stop();
  await spApi.spLogout();
  Sp.status = await spApi.spStatus();
  Sp.playlists = []; Sp.liked.clear(); Sp.likedKnown.clear(); Sp.searchMemo.clear();
  SpotifySource.setDevice(null);
  if (S.route.name === 'settings') renderSettings();
  renderSpotifySidebar();
  toast('Spotify disconnected');
}

/* ---------- liked state for Spotify rows (Spotify's own Liked Songs, never Aura's) ---------- */

async function refreshSpotifyLiked(tracks) {
  if (!Sp.status.connected) return;
  const todo = (tracks || []).filter(t => t && t.uri && !Sp.likedKnown.has(t.id));
  if (!todo.length) return;
  try {
    const flags = await spApi.spLibContains(todo.map(t => t.uri));
    todo.forEach((t, i) => { Sp.likedKnown.add(t.id); if (flags[i]) Sp.liked.add(t.id); else Sp.liked.delete(t.id); });
    markLikeUI();
  } catch {}
}
function isTrackLiked(id) { return isSpId(id) ? Sp.liked.has(id) : S.liked.has(id); }

async function toggleSpotifyLike(trackId) {
  const t = S.byId.get(trackId);
  if (!t || !t.uri) return;
  if (!Sp.status.connected) { toast('Connect Spotify in Settings to like Spotify songs'); return; }
  const was = Sp.liked.has(trackId);
  // optimistic, rolled back if Spotify refuses
  if (was) Sp.liked.delete(trackId); else Sp.liked.add(trackId);
  Sp.likedKnown.add(trackId);
  markLikeUI(); popLike(trackId);
  try {
    if (was) await spApi.spLibRemove([t.uri]); else await spApi.spLibSave([t.uri]);
    toast(was ? 'Removed from your Spotify Liked Songs' : 'Saved to your Spotify Liked Songs');
    if (S.route.name === 'liked') route();
  } catch (e) {
    if (was) Sp.liked.add(trackId); else Sp.liked.delete(trackId);
    markLikeUI();
    toast(spErrMsg(e));
  }
}

/* ---------- search: unified local + Spotify, sectioned, paginated ---------- */

const SEARCH_MEMO_MS = 5 * 60 * 1000;
async function spSearchCached(q, offset) {
  const key = q + '|' + offset;
  const hit = Sp.searchMemo.get(key);
  if (hit && Date.now() - hit.at < SEARCH_MEMO_MS) return hit.res;
  const res = await spApi.spSearch(q, ['track', 'album', 'artist'], 10, offset);
  Sp.searchMemo.set(key, { at: Date.now(), res });
  if (Sp.searchMemo.size > 60) Sp.searchMemo.delete(Sp.searchMemo.keys().next().value);
  return res;
}

let spSearchSeq = 0;
async function renderSpotifySearchSection(q, offset = 0) {
  const page = $('#content .page');
  if (!page || !Sp.status.connected || !q) return;
  const mySeq = ++spSearchSeq;
  const routeKey = location.hash;
  const moreBtn = $('#spSearchMoreWrap button');
  if (offset > 0 && moreBtn) { moreBtn.disabled = true; moreBtn.textContent = 'Loading…'; }
  if (offset === 0 && !$('#spSearchResults')) page.insertAdjacentHTML('beforeend', `<div id="spSearchResults"><div class="muted" style="padding:18px 0">Searching Spotify…</div></div>`);

  let res;
  try { res = await spSearchCached(q, offset); }
  catch (e) {
    if (mySeq !== spSearchSeq || location.hash !== routeKey) return;
    if (offset === 0) {
      const box = $('#spSearchResults');
      if (box) box.innerHTML = sectionHead('On Spotify') + `<div class="muted" style="padding:4px 0 18px">${esc(spErrMsg(e))} <a class="link" href="#" data-action="sp-search-retry" data-q="${esc(q)}">Try again</a></div>`;
    } else {
      toast(spErrMsg(e));
      if (moreBtn) { moreBtn.disabled = false; moreBtn.textContent = 'Load more from Spotify'; }
    }
    return;
  }
  if (mySeq !== spSearchSeq || S.route.name !== 'search' || location.hash !== routeKey) return; // superseded or navigated away

  indexSpotifyTracks(res.tracks.items);
  const moreLeft = (offset + 10) < res.tracks.total && res.tracks.items.length > 0;

  if (offset === 0) {
    const box = $('#spSearchResults');
    if (!box) return;
    if (!res.tracks.items.length && !res.albums.items.length && !res.artists.items.length) {
      box.innerHTML = sectionHead('On Spotify') + '<div class="muted" style="padding:4px 0 18px">Nothing found on Spotify.</div>';
      return;
    }
    const ctx = listCtx(res.tracks.items.map(t => t.id), 'Spotify search: ' + q, 'search');
    box.innerHTML = `
      ${res.artists.items.length ? sectionHead('Artists on Spotify') + `<div class="hscroll stagger">${res.artists.items.map(spArtistCardHTML).join('')}</div>` : ''}
      ${res.albums.items.length ? sectionHead('Albums on Spotify') + `<div class="hscroll stagger">${res.albums.items.map(spAlbumCardHTML).join('')}</div>` : ''}
      ${res.tracks.items.length ? sectionHead('Songs on Spotify') + `<div class="rows grid-simple" id="spSearchRows" data-ctxkey="${ctx}">${res.tracks.items.map((t, i) => trackRowHTML(t, i, { grid: 'simple' })).join('')}</div>` : ''}
      <div id="spSearchMoreWrap"></div>`;
  } else {
    const rows = $('#spSearchRows');
    const reg = rows && S.ctxRegistry[rows.dataset.ctxkey];
    if (!rows || !reg) return;
    // append to the same play context so clicking a later row plays that row
    const fresh = res.tracks.items.filter(t => !reg.ids.includes(t.id));
    const start = reg.ids.length;
    reg.ids.push(...fresh.map(t => t.id));
    rows.insertAdjacentHTML('beforeend', fresh.map((t, i) => trackRowHTML(t, start + i, { grid: 'simple' })).join(''));
  }
  const moreWrap = $('#spSearchMoreWrap');
  if (moreWrap) moreWrap.innerHTML = moreLeft ? `<button class="btn ghost" data-action="sp-search-more" data-q="${esc(q)}" data-offset="${offset + 10}">Load more from Spotify</button>` : '';
  markPlayingRows();
  setPlayingState(P.playing);
}

/* ---------- artist / album browsing (Spotify catalogue, not part of Aura's own library) ---------- */

function spArtistCardHTML(a) {
  return `<div class="card artist" data-action="open-spartist" data-id="${esc(spRawId(a.id))}">
    <div class="card-art round">${a.image ? `<img loading="lazy" src="${esc(a.image)}" alt="">` : initialsHTML(a.name)}</div>
    <div class="card-title center">${esc(a.name)}</div>
    <div class="card-sub center">Artist · Spotify</div>
  </div>`;
}
const SP_TYPE_LABEL = { album: 'Album', single: 'Single', compilation: 'Compilation' };
function spAlbumCardHTML(a, showArtist = true) {
  const sub = [a.releaseDate ? a.releaseDate.slice(0, 4) : '', a.albumType !== 'album' ? SP_TYPE_LABEL[a.albumType] || '' : (showArtist ? a.artist : 'Album')].filter(Boolean).join(' · ');
  return `<div class="card" data-action="open-spalbum" data-id="${esc(spRawId(a.id))}">
    <div class="card-art">${a.cover ? `<img loading="lazy" src="${esc(a.cover)}" alt="">` : `<span class="art-ph">${icon('music')}</span>`}
      <button class="card-play" data-action="sp-play-album" data-id="${esc(spRawId(a.id))}" title="Play">${icon('play')}</button></div>
    <div class="card-title">${esc(a.title)}</div>
    <div class="card-sub">${esc(sub) || '&nbsp;'}</div>
  </div>`;
}

async function renderSpotifyArtist(id) {
  if (!id) { navigate('#/search'); return; }
  const cachedHead = S.route.name === 'spartist' && S.route.arg === id;
  if (cachedHead) $('#content').innerHTML = spLoadingHTML('Loading artist…');
  let artist, albumsRes;
  try { [artist, albumsRes] = await Promise.all([spApi.spArtist(id), spApi.spArtistAlbums(id)]); }
  catch (e) { spPaint(spErrorPage(e, '#/spartist/' + id), 'spartist', id); return; }
  if (!artist) { spPaint(spErrorPage({ code: 'NOT_FOUND' }, '#/spartist/' + id), 'spartist', id); return; }

  const albums = [...(albumsRes.items || [])].sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  const groups = [
    ['Albums', 'album', albums.filter(a => a.albumType === 'album')],
    ['Singles & EPs', 'single', albums.filter(a => a.albumType === 'single')],
    ['Compilations', 'compilation', albums.filter(a => a.albumType === 'compilation')]
  ].filter(g => g[2].length);
  // No /artists/{id}/top-tracks any more (removed Feb 2026): substitute the
  // artist's own most-played tracks from Aura's local listening history.
  const nameKey = artist.name.toLowerCase();
  const myPlayed = [...S.byId.values()]
    .filter(t => (S.counts[t.id] || 0) > 0 && ((t.artists || [t.artistKey]).some(n => String(n).toLowerCase() === nameKey)))
    .sort((a, b) => (S.counts[b.id] || 0) - (S.counts[a.id] || 0)).slice(0, 5);
  const localArtist = S.artistByName.get(artist.name);
  const playedCtx = myPlayed.length ? listCtx(myPlayed.map(t => t.id), artist.name, 'list') : null;
  const latest = albums.find(a => a.albumType === 'album') || albums[0];

  spPaint(`<div class="page detail">
    <header class="detail-head artist-head" id="detailHead">
      <div class="detail-art round">${artist.image ? `<img src="${esc(artist.image)}" alt="">` : initialsHTML(artist.name)}</div>
      <div class="detail-info">
        <div class="eyebrow">Artist ${spBadgeHTML()}</div>
        <h1>${esc(artist.name)}</h1>
        <div class="detail-meta">${albums.length} release${albums.length === 1 ? '' : 's'} on Spotify${artist.genres && artist.genres.length ? ' · ' + esc(artist.genres.slice(0, 3).join(', ')) : ''}</div>
        <div class="detail-actions">
          ${latest ? `<button class="btn primary" data-action="sp-play-album" data-id="${esc(spRawId(latest.id))}" title="Play ${esc(latest.title)}">${icon('play')}Play latest</button>` : ''}
          ${localArtist && !localArtist.appearsOnly ? `<button class="btn" data-action="open-artist" data-artist="${esc(localArtist.name)}">${icon('user')}In your library</button>` : ''}
          ${spLinkOut(artist.spotifyUrl)}
        </div>
      </div>
    </header>
    ${myPlayed.length ? sectionHead('Your Most Played') + `<div class="rows grid-simple" data-ctxkey="${playedCtx}">${myPlayed.map((t, i) => trackRowHTML(t, i, { grid: 'simple' })).join('')}</div>` : ''}
    ${groups.map(([label, , list]) => sectionHead(label) + `<div class="grid-cards stagger">${list.map(a => spAlbumCardHTML(a, false)).join('')}</div>`).join('')}
    ${!albums.length ? '<div class="empty-state">No releases found on Spotify.</div>' : ''}
  </div>`, 'spartist', id);
  tintHeader(artist.image);
}

async function renderSpotifyAlbum(id) {
  if (!id) { navigate('#/search'); return; }
  $('#content').innerHTML = spLoadingHTML('Loading album…');
  let res;
  try { res = await spApi.spAlbumTracks(id); }
  catch (e) { spPaint(spErrorPage(e, '#/spalbum/' + id), 'spalbum', id); return; }
  if (!res || !res.album) { spPaint(spErrorPage({ code: 'NOT_FOUND' }, '#/spalbum/' + id), 'spalbum', id); return; }
  const album = res.album, tracks = res.items;
  indexSpotifyTracks(tracks);
  const ctx = listCtx(tracks.map(t => t.id), album.title, 'list');
  const typeLabel = SP_TYPE_LABEL[album.albumType] || 'Album';
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const artistLinks = (album.artistRefs && album.artistRefs.length ? album.artistRefs : [{ id: album.artistId, name: album.artist }])
    .map(a => a.id ? `<span class="link strong" data-action="open-spartist" data-id="${esc(spRawId(a.id))}">${esc(a.name)}</span>` : esc(a.name)).join(', ');
  const ok = spPaint(`<div class="page detail">
    <header class="detail-head" id="detailHead">
      <div class="detail-art">${album.cover ? `<img src="${esc(album.cover)}" alt="">` : `<span class="art-ph big">${icon('music')}</span>`}</div>
      <div class="detail-info">
        <div class="eyebrow">${typeLabel} ${spBadgeHTML()}</div>
        <h1>${esc(album.title)}</h1>
        <div class="detail-meta">
          ${artistLinks}${album.releaseDate ? ' · ' + esc(fmtRelease(album.releaseDate)) : ''} · ${tracks.length} song${tracks.length === 1 ? '' : 's'}, ${fmtLong(total)}
        </div>
        <div class="detail-actions">
          <button class="btn primary" data-action="ctx-play" data-ctx="${ctx}">${icon('play')}Play</button>
          <button class="btn" data-action="ctx-shuffle" data-ctx="${ctx}">${icon('shuffle')}Shuffle</button>
          <button class="icon-btn frame" data-action="sp-album-menu" data-ctx="${ctx}" title="More">${icon('dots')}</button>
          ${spLinkOut(album.spotifyUrl)}
        </div>
      </div>
    </header>
    <div class="rows grid-album" data-ctxkey="${ctx}">${tracks.map((t, i) => trackRowHTML(t, i, { grid: 'album', numbered: true })).join('')}</div>
    ${!tracks.length ? '<div class="empty-state">No songs on this release.</div>' : ''}
  </div>`, 'spalbum', id);
  if (!ok) return;
  tintHeader(album.cover);
  refreshSpotifyLiked(tracks);
}

function openSpotifyAlbumMenu(el) {
  const reg = S.ctxRegistry[el.dataset.ctx];
  if (!reg) return;
  const ids = reg.ids;
  const uris = ids.map(id => (S.byId.get(id) || {}).uri).filter(Boolean);
  const r = el.getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, [
    { label: 'Play next', icon: 'playNext', act: () => queueNextMany(ids, reg.name) },
    { label: 'Add to queue', icon: 'listPlus', act: () => queueAddMany(ids, reg.name) },
    { sep: true },
    { label: 'Add to Aura playlist…', icon: 'plus', act: () => addToPlaylistModal(ids) },
    Sp.status.connected ? { label: 'Add to Spotify playlist…', icon: 'plus', act: () => addToSpotifyPlaylistModal(uris) } : null
  ]);
}

/* Play a whole Spotify release straight from a card, without opening it. */
async function playSpotifyAlbum(id) {
  try {
    const res = await spApi.spAlbumTracks(id);
    if (!res || !res.items.length) { toast('Nothing to play on that release'); return; }
    indexSpotifyTracks(res.items);
    P.shuffle = false; P.smart = false;
    playFrom(res.items.map(t => t.id), 0, { name: res.album ? res.album.title : 'Spotify', sourceType: 'list' });
    syncControls();
  } catch (e) { toast(spErrMsg(e)); }
}

/* ---------- Spotify playlists (real ones, distinct from Aura's local playlists) ---------- */

async function renderSpotifyPlaylist(id) {
  if (!id) { navigate('#/home'); return; }
  $('#content').innerHTML = spLoadingHTML('Loading playlist…');
  let meta;
  try { meta = await spApi.spPlaylist(id); }
  catch (e) { spPaint(spErrorPage(e, '#/spplaylist/' + id), 'spplaylist', id); return; }
  if (S.route.name !== 'spplaylist' || S.route.arg !== id || !meta) return;

  let itemsRes = null, itemsErr = null;
  try { itemsRes = await spApi.spPlaylistItems(id); }
  catch (e) { itemsErr = e; }

  const tracks = itemsRes ? itemsRes.items.map(it => it.track).filter(Boolean) : [];
  indexSpotifyTracks(tracks);
  const ctx = listCtx(tracks.map(t => t.id), meta.name, 'list');
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const count = itemsRes ? tracks.length : (meta.total || 0);
  const notice = itemsErr
    ? `<div class="empty-state">${itemsErr.code === 'FORBIDDEN' || itemsErr.code === 'NOT_FOUND'
        ? 'Spotify only shares the song list of playlists you own or collaborate on. Open it in Spotify to listen.'
        : esc(spErrMsg(itemsErr))}</div>`
    : (!tracks.length ? `<div class="empty-state">${meta.isOwn ? 'This Spotify playlist is empty. Hit <b>Add songs</b>.' : 'No songs Aura can show from this playlist.'}</div>` : '');
  const ok = spPaint(`<div class="page detail" data-spplaylist="${esc(id)}" data-spown="${meta.isOwn ? 1 : 0}">
    <header class="detail-head" id="detailHead">
      <div class="detail-art">${meta.cover ? `<img src="${esc(meta.cover)}" alt="">` : `<span class="art-ph big">${icon('music')}</span>`}</div>
      <div class="detail-info">
        <div class="eyebrow">Spotify Playlist ${spBadgeHTML()}</div>
        <h1>${esc(meta.name)}</h1>
        <div class="detail-meta">${meta.ownerName ? 'By ' + esc(meta.ownerName) + ' · ' : ''}${count} song${count === 1 ? '' : 's'}${tracks.length ? ', ' + fmtLong(total) : ''}${itemsRes && itemsRes.skipped ? ` · ${itemsRes.skipped} not playable here` : ''}</div>
        <div class="detail-actions">
          ${tracks.length ? `<button class="btn primary" data-action="ctx-play" data-ctx="${ctx}">${icon('play')}Play</button>
          <button class="btn" data-action="ctx-shuffle" data-ctx="${ctx}">${icon('shuffle')}Shuffle</button>` : ''}
          ${meta.isOwn ? `<button class="btn" data-action="sp-playlist-add-songs" data-id="${esc(id)}">${icon('plus')}Add songs</button>` : ''}
          ${spLinkOut(meta.spotifyUrl)}
        </div>
      </div>
    </header>
    ${tracks.length ? `<div class="rows grid-full" data-ctxkey="${ctx}">${tracks.map((t, i) => trackRowHTML(t, i, { dateMs: itemsRes.items[i] && itemsRes.items[i].addedAt ? Date.parse(itemsRes.items[i].addedAt) : null })).join('')}</div>` : ''}
    ${notice}
  </div>`, 'spplaylist', id);
  if (!ok) return;
  tintHeader(meta.cover);
  refreshSpotifyLiked(tracks);
}

function spotifyPlaylistAddSongsModal(playlistId) {
  openModal(`<h3>Add songs to this Spotify playlist</h3>
    <input id="spAddSearch" type="text" placeholder="Search Spotify" />
    <div class="modal-list tall" id="spAddResults"><div class="muted pad">Type at least 2 characters.</div></div>
    <div class="modal-actions"><button class="btn primary" data-action="modal-close">Done</button></div>`, true);
  const res = $('#spAddResults'), inp = $('#spAddSearch');
  let seq = 0;
  const draw = async () => {
    const q = inp.value.trim();
    if (q.length < 2) { res.innerHTML = '<div class="muted pad">Type at least 2 characters.</div>'; return; }
    const my = ++seq;
    let out;
    try { out = await spApi.spSearch(q, ['track'], 10, 0); }
    catch (e) { if (my === seq && $('#spAddResults')) res.innerHTML = `<div class="muted pad">${esc(spErrMsg(e))}</div>`; return; }
    if (my !== seq || !$('#spAddResults')) return;
    indexSpotifyTracks(out.tracks.items);
    res.innerHTML = out.tracks.items.map(t => `<div class="add-row">
      <span class="q-art">${t.cover ? `<img loading="lazy" src="${esc(t.cover)}" alt="">` : icon('music')}</span>
      <span class="q-meta"><span class="q-title">${esc(t.title)}</span><span class="q-sub">${esc(t.artist)} · ${esc(t.album)}</span></span>
      <button class="btn small" data-action="sp-playlist-add-track" data-id="${esc(playlistId)}" data-uri="${esc(t.uri)}">+ Add</button>
    </div>`).join('') || '<div class="muted pad">No matches.</div>';
  };
  inp.addEventListener('input', debounce(draw, 300));
}
async function addTrackToSpotifyPlaylist(playlistId, uri, btn) {
  if (btn) btn.disabled = true;
  try {
    await spApi.spPlaylistAdd(playlistId, [uri]);
    if (btn) { btn.textContent = 'Added'; btn.classList.add('ghost'); }
  } catch (e) { if (btn) btn.disabled = false; toast(spErrMsg(e)); }
}
async function removeTrackFromSpotifyPlaylist(playlistId, uri) {
  try { await spApi.spPlaylistRemove(playlistId, [uri]); toast('Removed from playlist'); route(); }
  catch (e) { toast(spErrMsg(e)); }
}

/* ---------- add Spotify search results into Aura's own custom albums (Phase S5.4) ----------
   window.aura.albumSetTracks / plAdd just store id strings - they already
   work transparently for 'sp:' ids, so the only thing missing is a way to
   search Spotify from inside the existing "Add songs" modal. */

function wireSpotifyIntoAddSongsModal(target, id) {
  if (!Sp.status.connected) return;
  const host = $('#addResults');
  if (!host || $('#spAddInline')) return;
  host.insertAdjacentHTML('beforeend', '<div id="spAddInline"></div>');
  const inp = $('#addSearch');
  inp.placeholder = 'Search your library and Spotify';
  let seq = 0;
  const draw = async () => {
    const q = inp.value.trim();
    // the local list re-renders #addResults on every keystroke, wiping this block
    if (!$('#spAddInline') && $('#addResults')) $('#addResults').insertAdjacentHTML('beforeend', '<div id="spAddInline"></div>');
    const wrap = $('#spAddInline');
    if (!wrap) return;
    if (q.length < 2) { wrap.innerHTML = ''; return; }
    const my = ++seq;
    wrap.innerHTML = '<div class="muted" style="padding:8px 4px">Searching Spotify…</div>';
    let out;
    try { out = await spApi.spSearch(q, ['track'], 10, 0); }
    catch (e) { if (my === seq && $('#spAddInline')) $('#spAddInline').innerHTML = `<div class="muted" style="padding:8px 4px">${esc(spErrMsg(e))}</div>`; return; }
    const w = $('#spAddInline');
    if (my !== seq || !w) return;
    indexSpotifyTracks(out.tracks.items);
    const already = target === 'playlist'
      ? new Set((S.playlists.find(p => p.id === id) || { items: [] }).items.map(i => i.trackId))
      : new Set((S.albumById.get(id) || { trackIds: [] }).trackIds);
    w.innerHTML = (out.tracks.items.length ? `<div class="muted" style="padding:10px 4px 2px">On Spotify</div>` : '') +
      out.tracks.items.map(t => `<div class="add-row">
        <span class="q-art">${t.cover ? `<img loading="lazy" src="${esc(t.cover)}" alt="">` : icon('music')}</span>
        <span class="q-meta"><span class="q-title"><span class="sp-dot" title="Spotify"></span>${esc(t.title)}</span><span class="q-sub">${esc(t.artist)} · ${esc(t.album)}</span></span>
        <button class="btn small ${already.has(t.id) ? 'ghost' : ''}" data-action="add-track" data-target="${target}" data-id="${id}" data-track="${t.id}" ${already.has(t.id) ? 'disabled' : ''}>${already.has(t.id) ? 'Added' : '+ Add'}</button>
      </div>`).join('');
  };
  inp.addEventListener('input', debounce(draw, 320));
}

/* ---------- Liked Songs: Spotify mirror shown as its own clearly-labeled section ---------- */

async function renderSpotifyLikedSection() {
  const page = $('#content .page');
  if (!page || !Sp.status.connected) return;
  const routeKey = location.hash;
  let json;
  try { json = await spApi.spSavedTracks({ limit: 50 }); }
  catch (e) {
    if (S.route.name === 'liked' && location.hash === routeKey && $('#content .page') === page) {
      page.insertAdjacentHTML('beforeend', `<div id="spLikedSection">${sectionHead('Liked on Spotify')}<div class="muted">${esc(spErrMsg(e))}</div></div>`);
    }
    return;
  }
  if (S.route.name !== 'liked' || $('#content .page') !== page || $('#spLikedSection')) return;
  const tracks = json.items.map(i => i.track);
  indexSpotifyTracks(tracks);
  for (const t of tracks) { Sp.liked.add(t.id); Sp.likedKnown.add(t.id); }
  const ctx = listCtx(tracks.map(t => t.id), 'Liked on Spotify', 'list');
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  page.insertAdjacentHTML('beforeend', `<div id="spLikedSection">
    ${sectionHead('Liked on Spotify')}
    <div class="muted" style="margin:-8px 0 10px">${json.total > tracks.length ? `Latest ${tracks.length} of ${json.total}` : `${tracks.length} song${tracks.length === 1 ? '' : 's'}`}, ${fmtLong(total)} · kept separate from Aura's own Liked Songs</div>
    ${tracks.length ? `<div class="detail-actions" style="margin-bottom:10px"><button class="btn primary small" data-action="ctx-play" data-ctx="${ctx}">${icon('play')}Play</button><button class="btn small" data-action="ctx-shuffle" data-ctx="${ctx}">${icon('shuffle')}Shuffle</button></div>` : ''}
    <div class="rows grid-simple" data-ctxkey="${ctx}">${tracks.map((t, i) => trackRowHTML(t, i, { grid: 'simple' })).join('')}</div>
    ${!tracks.length ? '<div class="empty-state">No liked songs on Spotify yet.</div>' : ''}
  </div>`);
  markPlayingRows();
  setPlayingState(P.playing);
}

/* ---------- track context menu for Spotify-sourced tracks ---------- */

function openSpotifyTrackMenu(x, y, t) {
  const liked = Sp.liked.has(t.id);
  const albumHash = spAlbumHash(t);
  const refs = spArtistRefs(t).filter(a => a.id);
  const items = [
    { head: t.title, sub: t.artist + (t.album ? ' · ' + t.album : ''), cover: t.cover },
    { label: 'Play next', icon: 'playNext', act: () => queueNext(t.id) },
    { label: 'Add to queue', icon: 'listPlus', act: () => queueAdd(t.id) },
    { sep: true },
    Sp.status.connected ? { label: liked ? 'Remove from Spotify Liked Songs' : 'Save to Spotify Liked Songs', icon: 'heart', act: () => toggleSpotifyLike(t.id) } : null,
    { label: 'Add to Aura playlist…', icon: 'plus', act: () => addToPlaylistModal([t.id]) },
    Sp.status.connected && t.uri ? { label: 'Add to Spotify playlist…', icon: 'plus', act: () => addToSpotifyPlaylistModal([t.uri]) } : null,
    { sep: true }
  ];
  if (albumHash) items.push({ label: 'Go to album', icon: 'disc', act: () => navigate(albumHash) });
  for (const a of refs.slice(0, 4)) items.push({ label: refs.length > 1 ? 'Go to ' + a.name : 'Go to artist', icon: 'user', act: () => navigate('#/spartist/' + spRawId(a.id)) });
  const page = $('#content .page');
  const spplId = page && page.dataset.spplaylist;
  if (spplId && page.dataset.spown === '1') items.push({ label: 'Remove from this Spotify playlist', danger: true, act: () => removeTrackFromSpotifyPlaylist(spplId, t.uri) });
  const albumId = page && page.dataset.album;
  if (albumId && page.dataset.custom === '1') {
    items.push({ label: 'Remove from this album', danger: true, act: async () => {
      const a = S.albumById.get(albumId);
      if (!a) return;
      await refreshLibrary(await window.aura.albumSetTracks(albumId, a.trackIds.filter(id => id !== t.id)));
      route();
    }});
  }
  const plId = page && page.dataset.pl;
  if (plId) items.push({ label: 'Remove from this playlist', danger: true, act: async () => { await window.aura.plRemove(plId, t.id); await refreshPlaylists(); route(); } });
  if (t.spotifyUrl) items.push({ label: 'Open in Spotify', icon: 'external', act: () => window.open(t.spotifyUrl, '_blank') });
  showMenu(x, y, items);
}
