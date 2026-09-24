/* nas.js - NAS (Navidrome / Subsonic) source, renderer side.
   NAS songs are ordinary library tracks (source: 'navidrome', ids "nd:<id>"):
   they come merged into the library by the main process, play through the
   same deck engine (audio comes from /track/nd%3A<id>, which the main process
   proxies with the credentials, so nothing secret ever reaches this page),
   and show up in Songs / Albums / Artists / search like local ones.

   This file adds what is NAS specific: the connection status (sidebar dot,
   dimming while offline), the Settings section, download-for-offline, NAS
   playlist creation and the live search top-up. Its own click handling uses
   data-nas attributes so it needs no cases in main.js. */

const Nas = { cfg: null, test: null, lastState: null, lastQ: '' };

/* Where a NAS failure is worth telling the user about, in plain words. */
function nasErrMsg(e) {
  const code = e && e.code, msg = (e && e.message) || '';
  return ({
    OFFLINE: 'Can’t reach the NAS. Are you at home or on Tailscale?',
    TIMEOUT: 'The NAS didn’t answer in time',
    AUTH: 'The NAS rejected the username or password',
    FORBIDDEN: 'The NAS user isn’t allowed to do that',
    NOT_FOUND: 'The NAS doesn’t have that any more',
    NO_ENCRYPTION: msg,
    BAD_CONFIG: msg,
    BAD_RESPONSE: 'That address doesn’t look like a Subsonic / Navidrome server',
    HTTP: msg || 'The NAS returned an error'
  })[code] || msg || 'NAS error';
}

const nasCounts = st => st && st.counts ? `${st.counts.tracks.toLocaleString()} songs · ${st.counts.albums.toLocaleString()} albums` : '';

/* { dot, text, sub } for the current status, shared by the sidebar and Settings. */
function nasSummary(st) {
  if (!st || !st.configured) return { dot: '', text: 'Not set up', sub: '' };
  const sync = st.sync && st.sync.running ? `Syncing library… ${st.sync.done}/${st.sync.total}` : '';
  switch (st.state) {
    case 'online': {
      let host = st.url || '';
      try { host = new URL(st.url).host; } catch {}
      const dl = st.downloads && st.downloads.active ? ` · Downloading ${st.downloads.done}/${st.downloads.total}` : '';
      return { dot: 'ok', text: 'Connected', sub: [`${st.home ? 'Home' : 'Away'} (${host})`, st.serverType ? `${st.serverType} ${String(st.serverVersion || '').split(' ')[0]}`.trim() : '', sync || nasCounts(st)].filter(Boolean).join(' · ') + dl };
    }
    case 'connecting': return { dot: 'warn', text: 'Connecting…', sub: nasCounts(st) };
    case 'auth-failed': return { dot: 'bad', text: 'Sign-in failed', sub: 'The NAS rejected the username or password. Update them below.' };
    default: return { dot: 'bad', text: 'Offline', sub: 'Can’t reach the NAS. Your cached library is still here, songs you downloaded still play. ' + (st.error ? '(' + st.error + ')' : '') };
  }
}

/* ---------- status: sidebar dot, root class, live updates ---------- */

function nasUnavailableNow() { return S.nas.configured && (S.nas.state === 'offline' || S.nas.state === 'auth-failed'); }

function nasApplyState() {
  const st = S.nas;
  document.documentElement.classList.toggle('nas-offline', nasUnavailableNow());
  let el = $('#nasStatus');
  if (!el) {
    const foot = document.querySelector('#sidebar .side-foot');
    if (!foot) return;
    el = document.createElement('div');
    el.id = 'nasStatus'; el.className = 'nas-status'; el.setAttribute('role', 'button'); el.tabIndex = 0;
    el.innerHTML = '<span class="nas-led"></span><span class="nas-txt"></span>';
    foot.parentNode.insertBefore(el, foot);
    const open = () => navigate('#/settings');
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }
  el.hidden = !st.configured;
  el.dataset.state = st.state;
  const sum = nasSummary(st);
  el.querySelector('.nas-txt').textContent = st.state === 'online' ? (st.downloads && st.downloads.active ? `NAS · ↓ ${st.downloads.done}/${st.downloads.total}` : 'NAS') : 'NAS ' + (st.state === 'connecting' ? 'connecting' : st.state === 'auth-failed' ? 'sign-in failed' : 'offline');
  el.title = 'NAS: ' + sum.text + (sum.sub ? ' - ' + sum.sub : '');
  nasPaintSettingsStatus();
}

function nasPaintSettingsStatus() {
  const row = $('#nasStatusRow');
  if (!row) return;
  const sum = nasSummary(S.nas);
  row.querySelector('.set-lbl').textContent = sum.text;
  row.querySelector('.muted').textContent = sum.sub;
  const dot = row.querySelector('.dot');
  dot.className = 'dot' + (sum.dot ? ' ' + sum.dot : '');
}

function nasOnStatus(st) {
  const prev = Nas.lastState;
  S.nas = st;
  Nas.lastState = st.state;
  nasApplyState();
  // only announce a change of reachability, not the first status of a launch
  if (prev && prev !== st.state && st.configured) {
    if (st.state === 'online' && (prev === 'offline' || prev === 'auth-failed')) toast('NAS connected' + (st.home ? '' : ' (away)'));
    else if (st.state === 'offline' && prev === 'online') toast('NAS went offline. Local music still works.');
  }
}

async function nasBoot() {
  try { nasOnStatus(await nasApi.status()); } catch {}
  window.aura.on('nas-status', nasOnStatus);
  window.aura.on('nas-library', debounce(async () => {
    await refreshLibrary();
    await refreshPlaylists();
    // Settings keeps whatever is typed into its fields; everything else can repaint
    if (S.route.name !== 'settings') route(); else nasPaintSettingsStatus();
    markPlayingRows();
  }, 900));
}
document.addEventListener('DOMContentLoaded', nasBoot);

// A NAS playlist edit that fails (NAS offline) surfaces as a rejected IPC call
// from the shared playlist handlers; say so instead of failing silently.
window.addEventListener('unhandledrejection', e => {
  const m = String((e.reason && e.reason.message) || '');
  if (!/NAS|Subsonic/i.test(m)) return;
  e.preventDefault();
  toast('NAS: ' + (m.split(/:\s/).pop() || 'that didn’t go through'));
});

/* ---------- badges + menu bits used by views.js ---------- */

const nasDotHTML = t => t && t.source === 'navidrome' ? '<span class="nas-dot" title="On your NAS"></span>' : '';
const nasSrcAttrs = t => t && t.source === 'navidrome' ? ` data-src="navidrome"${t.offline ? ' data-offline="1"' : ''}` : '';
const nasAlbumOffline = a => a.source === 'navidrome' && a.trackIds.length > 0 && a.trackIds.every(id => { const t = S.byId.get(id); return t && t.offline; });
const nasAlbumAttrs = a => a && a.source === 'navidrome' ? ` data-src="navidrome"${nasAlbumOffline(a) ? ' data-offline="1"' : ''}` : '';

function nasAlbumMenuItems(a) {
  if (!a || a.source !== 'navidrome') return [];
  const someOffline = a.trackIds.some(id => { const t = S.byId.get(id); return t && t.offline; });
  const items = [];
  if (!nasAlbumOffline(a)) items.push({ label: 'Download for offline', icon: 'refresh', act: () => nasDownloadAlbum(a) });
  if (someOffline) items.push({ label: 'Remove download', icon: 'trash', act: () => nasRemoveDownload(a) });
  return items.length ? [{ sep: true }, ...items] : [];
}

async function nasDownloadAlbum(a) {
  if (S.nas.downloads && S.nas.downloads.active) { toast('A download is already running'); return; }
  toast(`Downloading “${a.title}” from the NAS…`);
  try {
    const r = await nasApi.download(a.id);
    toast(r && r.downloaded ? `“${a.title}” is available offline` : 'Already downloaded');
  } catch (e) { toast(nasErrMsg(e)); }
}
async function nasRemoveDownload(a) {
  try { await nasApi.removeDownload(a.id); toast('Removed the offline copy'); } catch (e) { toast(nasErrMsg(e)); }
}

/* Extra button for the "Add to playlist" modal: a new playlist on the NAS. */
function nasNewPlaylistBtnHTML(ids) {
  const nd = (ids || []).filter(id => String(id).startsWith('nd:'));
  if (!nd.length || S.nas.state !== 'online') return '';
  return `<button class="btn" data-nas="new-playlist" data-ids="${esc(nd.join(','))}">${icon('plus')}New NAS playlist</button>`;
}

/* ---------- search top-up ---------- */

// The library cache already has everything from the last sync; this asks the
// server itself (search3) so a song added a minute ago is found too.
const nasSearchLater = debounce(async () => {
  const q = Nas.lastQ;
  if (!q || S.nas.state !== 'online') return;
  try {
    const r = await nasApi.search(q);
    if (r && r.added && S.route.name === 'search' && (S.route.q || S.route.arg || '').trim().toLowerCase() === q) {
      await refreshLibrary();
      route();
    }
  } catch {}
}, 500);
function nasSearchSupplement(q) {
  if (!S.nas.configured || String(q).length < 2) return;
  Nas.lastQ = String(q).trim().toLowerCase();
  nasSearchLater();
}

/* ---------- Settings section ---------- */

async function nasPrefetchSettings() {
  try { [Nas.cfg, S.nas] = await Promise.all([nasApi.getConfig(), nasApi.status()]); }
  catch { Nas.cfg = Nas.cfg || { servers: [], username: '', authMode: 'password', qualityHome: 'original', qualityAway: 'original', hasCredential: false, encryptionAvailable: true }; }
}

function nasSettingsHTML() {
  const c = Nas.cfg || { servers: [], username: '', authMode: 'password', qualityHome: 'original', qualityAway: 'original', hasCredential: false, encryptionAvailable: true };
  const sum = nasSummary(S.nas);
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`;
  const quality = (id, cur) => `<select class="select" id="${id}">${opt('original', 'Original (no transcoding)', cur)}${opt('mp3-320', 'MP3 320 kbps', cur)}${opt('mp3-192', 'MP3 192 kbps', cur)}${opt('mp3-128', 'MP3 128 kbps', cur)}</select>`;
  const t = Nas.test;
  return `<h2 class="set-h">NAS (Navidrome)</h2>
  <div class="set-card" id="nasCard">
    <div class="set-row" id="nasStatusRow"><div><div class="set-lbl">${esc(sum.text)}</div><div class="muted">${esc(sum.sub)}</div></div>
      <div class="set-ctl"><span class="dot ${sum.dot}"></span>${S.nas.configured ? '<button class="btn small" data-nas="refresh">Refresh library</button>' : ''}</div></div>
    <div class="set-row"><div><div class="set-lbl">Server addresses</div><div class="muted">One per line, tried in order. Put the home (LAN) address first, then Tailscale.</div></div>
      <textarea id="nasServers" class="set-input nas-servers" rows="2" spellcheck="false" autocomplete="off" placeholder="http://192.168.2.210:4533&#10;http://100.114.107.79:4533">${esc((c.servers || []).join('\n'))}</textarea></div>
    <div class="set-row"><div><div class="set-lbl">Username</div></div>
      <input type="text" id="nasUser" class="set-input" value="${esc(c.username || '')}" placeholder="aura" autocomplete="off" spellcheck="false" /></div>
    <div class="set-row"><div><div class="set-lbl">${c.authMode === 'apikey' ? 'API key' : 'Password'}</div><div class="muted">${c.encryptionAvailable === false ? 'Windows secure storage is unavailable here, so a password can’t be saved.' : c.hasCredential ? 'Saved, encrypted by Windows. Leave empty to keep it.' : 'Stored encrypted by Windows, never in plain text.'}</div></div>
      <input type="password" id="nasSecret" class="set-input" placeholder="${c.hasCredential ? '••••••••' : (c.authMode === 'apikey' ? 'API key' : 'Password')}" autocomplete="new-password" spellcheck="false" /></div>
    <div class="set-row"><div><div class="set-lbl">Sign in with</div><div class="muted">${S.nas.apiKeySupported ? 'This server supports API keys.' : 'API keys need a server that supports them (Navidrome 0.64 does not).'}</div></div>
      <select class="select" id="nasAuthMode">${opt('password', 'Password', c.authMode)}${opt('apikey', 'API key', c.authMode)}</select></div>
    <div class="set-row"><div><div class="set-lbl">Quality at home</div><div class="muted">On the first (LAN) address.</div></div>${quality('nasQualityHome', c.qualityHome)}</div>
    <div class="set-row"><div><div class="set-lbl">Quality away</div><div class="muted">On any other address. Lower quality saves mobile data. Songs you download always play as they are.</div></div>${quality('nasQualityAway', c.qualityAway)}</div>
    <div class="set-row"><div class="set-ctl"><button class="btn primary small" data-nas="save">Save & connect</button><button class="btn small" data-nas="test">Test connection</button>
      ${S.nas.configured || c.hasCredential ? '<button class="btn small ghost danger" data-nas="forget">Disconnect…</button>' : ''}</div></div>
    <div class="set-row nas-test-row" id="nasTestOut" ${t ? '' : 'hidden'}>${t ? nasTestHTML(t) : ''}</div>
  </div>`;
}

function nasTestHTML(t) {
  if (!t.ok) return `<div class="nas-test bad">${esc(t.message || nasErrMsg(t))}</div>`;
  let host = t.url;
  try { host = new URL(t.url).host; } catch {}
  return `<div class="nas-test ok">Connected via ${esc(host)} (${t.home ? 'first address, home' : 'address #' + (t.index + 1) + ', away'}) · ${esc(t.serverType || 'Subsonic server')} ${esc(String(t.serverVersion || '').split(' ')[0])} · API ${esc(t.apiVersion)}${t.apiKeySupported ? ' · supports API keys' : ''}</div>`;
}

const nasForm = () => ({
  servers: $('#nasServers').value, username: $('#nasUser').value, authMode: $('#nasAuthMode').value,
  qualityHome: $('#nasQualityHome').value, qualityAway: $('#nasQualityAway').value
});

async function nasSave(btn) {
  const f = nasForm(), secret = $('#nasSecret').value;
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Connecting…';
  try {
    await nasApi.setConfig(f);
    if (secret) await nasApi.setCredential(secret);
    $('#nasSecret').value = '';
    Nas.cfg = await nasApi.getConfig();
    S.nas = await nasApi.status();
    nasApplyState();
    toast(S.nas.state === 'online' ? 'NAS connected' : S.nas.configured ? nasSummary(S.nas).text : 'Saved. Enter the password to connect.');
    if (S.route.name === 'settings') renderSettings();
  } catch (e) { toast(nasErrMsg(e)); }
  finally { btn.disabled = false; btn.textContent = label; }
}

async function nasTestConnection(btn) {
  const f = nasForm(), secret = $('#nasSecret').value;
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Testing…';
  try {
    Nas.test = await nasApi.test({ servers: f.servers.split(/[\s,]+/).filter(Boolean), username: f.username, authMode: f.authMode, credential: secret || undefined });
  } catch (e) { Nas.test = { ok: false, code: e.code, message: nasErrMsg(e) }; }
  finally { btn.disabled = false; btn.textContent = label; }
  const out = $('#nasTestOut');
  if (out) { out.hidden = false; out.innerHTML = nasTestHTML(Nas.test); }
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-nas]');
  if (!el) return;
  e.preventDefault();
  switch (el.dataset.nas) {
    case 'save': nasSave(el); break;
    case 'test': nasTestConnection(el); break;
    case 'refresh': {
      el.disabled = true; const label = el.textContent; el.textContent = 'Refreshing…';
      try { await nasApi.refresh(false); toast('NAS library refreshed'); } catch (err) { toast(nasErrMsg(err)); }
      el.disabled = false; el.textContent = label;
      break;
    }
    case 'forget':
      confirmModal('Disconnect the NAS?', 'Removes the saved password, the cached NAS library and any offline downloads from this PC. Nothing on the NAS itself is touched.', 'Disconnect', async () => {
        try { await nasApi.forget(); Nas.cfg = await nasApi.getConfig(); Nas.test = null; S.nas = await nasApi.status(); nasApplyState(); await refreshLibrary(); await refreshPlaylists(); toast('NAS disconnected'); route(); }
        catch (err) { toast(nasErrMsg(err)); }
      });
      break;
    case 'new-playlist': {
      const ids = (el.dataset.ids || '').split(',').filter(Boolean);
      closeModal();
      promptModal('New NAS playlist', '', async name => {
        try { await nasApi.createPlaylist(name, ids); await refreshPlaylists(); toast(`Created “${name}” on the NAS`); }
        catch (err) { toast(nasErrMsg(err)); }
      }, 'Playlist name');
      break;
    }
  }
});
