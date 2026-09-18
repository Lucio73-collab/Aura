/* player.js — sequencing (queue, shuffle, smart shuffle, repeat, history),
   stats logging, likes, media session, and all playback UI sync. */

const P = {
  currentId: null,
  ctx: { name: '', ids: [], originalIds: [], pos: -1, sourceType: '', sourceId: null, recs: new Set() },
  manual: [], history: [],
  shuffle: false, smart: false, repeat: 'off', dj: false,
  expectDirect: null, wrapOrder: null,
  listenMs: 0, lastTick: 0, counted: false, playing: false
};

const cur = () => S.byId.get(P.currentId);
// declusteredShuffle (core.js) spreads the same artist out instead of a plain
// random shuffle, which frequently clusters an artist's tracks back to back
const shuffled = arr => declusteredShuffle(arr);

const saveSettings = debounce(() => window.aura.settingsSet({ volume: Playback.getVolume(), repeat: P.repeat }), 700);

/* ---------- resume-on-launch ---------- */

// Saved on track change, on every play/pause toggle, and periodically while
// playing (see the engine-wiring block at the bottom) so a force-quit or
// crash never loses more than a few seconds of position. Only ever read back
// paused (see restoreSession) - closing and reopening Aura should never make
// it suddenly start playing on its own.
function saveSessionNow() {
  if (!P.currentId) return;
  window.aura.sessionSave({
    trackId: P.currentId,
    positionSec: Playback.pos().t || 0,
    ctx: { ids: P.ctx.ids, name: P.ctx.name, sourceType: P.ctx.sourceType, sourceId: P.ctx.sourceId, pos: P.ctx.pos },
    shuffle: P.shuffle,
    repeat: P.repeat
  }).catch(() => {});
}
const saveSession = debounce(saveSessionNow, 1000);
// Deferred to a call from boot() (main.js), not fired at module load, so
// this file stays loadable in the plain-Node vm sandbox smart-shuffle.test.js
// runs it in (which doesn't stub setInterval).
function startSessionAutosave() { setInterval(() => { if (P.playing) saveSession(); }, 20000); }

async function restoreSession() {
  let sess;
  try { sess = await window.aura.sessionGet(); } catch { return; }
  const t = sess && sess.trackId && S.byId.get(sess.trackId);
  if (!t || t.source === 'spotify') return; // no "preload paused" over Spotify Connect - see Playback.loadPaused
  const ctx = sess.ctx;
  const ids = (ctx && Array.isArray(ctx.ids) ? ctx.ids.filter(id => S.byId.has(id)) : []);
  if (!ids.length) ids.push(t.id);
  else if (!ids.includes(t.id)) ids.unshift(t.id);
  P.shuffle = !!sess.shuffle;
  P.repeat = sess.repeat || 'off';
  P.ctx = {
    name: (ctx && ctx.name) || t.title, ids, originalIds: ids.slice(),
    pos: Math.max(0, ids.indexOf(t.id)),
    sourceType: (ctx && ctx.sourceType) || 'list', sourceId: (ctx && ctx.sourceId) || null,
    recs: new Set(), autoplayFrom: null
  };
  P.history = [];
  P.currentId = t.id;
  Playback.loadPaused(t, sess.positionSec || 0);
  updateNowPlayingUI(t);
  updateMediaSession(t);
  loadLyricsFor(t);
  updateProgressUI(sess.positionSec || 0, t.duration);
  scheduleUpcoming();
  renderQueue();
  markPlayingRows();
  syncControls();
  broadcastState();
  // opt-in only (Settings > Playback): by default a relaunch never makes sound on its own
  if (S.settings.resumeOnLaunch) setTimeout(() => { if (Playback.isPaused() && P.currentId === t.id) Playback.resume(); }, 400);
}

function loadSettings(st) {
  S.settings = st;
  P.repeat = st.repeat || 'off';
  Playback.setVolume(st.volume ?? 0.9);
  AudioEngine.setOpts({ crossfade: st.crossfade ?? 5, automix: st.automix !== false, normalize: st.normalize !== false, fadePause: st.fadePause !== false, mono: !!st.monoAudio });
  applyPrefs(st);
  syncControls();
  setSliderFill($('#vol'), (st.volume ?? 0.9) * 100);
  setSliderFill($('#npVol'), (st.volume ?? 0.9) * 100);
  $('#vol').value = $('#npVol').value = Math.round((st.volume ?? 0.9) * 100);
}

/* ---------- context building ---------- */

function buildContext(ids, startId, meta) {
  const original = ids.slice();
  const order = P.shuffle ? [startId, ...shuffled(ids.filter(id => id !== startId))] : ids.slice();
  P.ctx = {
    name: meta.name || '', ids: order, originalIds: original,
    pos: order.indexOf(startId),
    sourceType: meta.sourceType || 'list', sourceId: meta.sourceId || null,
    recs: new Set(), autoplayFrom: null
  };
  if (P.smart) injectRecs();
}

function injectRecs() {
  const base = P.ctx.ids.filter(id => !P.ctx.recs.has(id));
  const seeds = trackList(base);
  const exclude = new Set([...P.ctx.ids, ...P.manual]);
  const head = P.ctx.ids.slice(0, P.ctx.pos + 1);
  const rest = P.ctx.ids.slice(P.ctx.pos + 1).filter(id => !P.ctx.recs.has(id));
  const keptRecs = new Set(head.filter(id => P.ctx.recs.has(id)));
  const out = head.slice();
  let k = 0;
  for (let i = 0; i < rest.length; i++) {
    out.push(rest[i]); k++;
    if (k % 3 === 0) {
      const [r] = recommend(seeds, exclude, 1);
      if (r) { out.push(r.id); exclude.add(r.id); keptRecs.add(r.id); }
    }
  }
  P.ctx.ids = out;
  P.ctx.recs = keptRecs;
}

function stripRecs() {
  const cut = P.ctx.pos + 1;
  P.ctx.ids = [...P.ctx.ids.slice(0, cut), ...P.ctx.ids.slice(cut).filter(id => !P.ctx.recs.has(id))];
  P.ctx.recs = new Set(P.ctx.ids.slice(0, cut).filter(id => P.ctx.recs.has(id)));
}

/* ---------- sequencing ---------- */

function peekNext(userSkip) {
  if (!userSkip && P.repeat === 'one' && P.currentId) return P.currentId;
  if (P.manual.length) return P.manual[0];
  if (P.dj && P.ctx.pos >= P.ctx.ids.length - 3) djRefill();
  if (P.ctx.pos + 1 < P.ctx.ids.length) return P.ctx.ids[P.ctx.pos + 1];
  if (P.repeat === 'all' && P.ctx.originalIds.length) {
    if (!P.wrapOrder) P.wrapOrder = P.shuffle ? shuffled(P.ctx.originalIds) : P.ctx.originalIds.slice();
    return P.wrapOrder[0];
  }
  // reached the natural end of a finite list (Recently Added, an album, a
  // playlist...) with nothing queued and repeat off: keep the music going
  // with similar songs instead of just stopping, like Spotify's autoplay
  if (!P.dj && S.settings.autoplay !== false && P.ctx.ids.length) {
    autoplayRefill();
    if (P.ctx.pos + 1 < P.ctx.ids.length) return P.ctx.ids[P.ctx.pos + 1];
  }
  return null;
}

function autoplayRefill() {
  if (P.ctx.autoplayFrom == null) P.ctx.autoplayFrom = P.ctx.ids.length;
  const seeds = trackList(P.ctx.ids.slice(-8));
  const exclude = new Set([...P.ctx.ids, ...P.manual]);
  let picks = recommend(seeds, exclude, 6);
  if (!picks.length) picks = shuffled(S.tracks.filter(t => !exclude.has(t.id))).slice(0, 6);
  if (!picks.length) return;
  P.ctx.ids.push(...picks.map(t => t.id));
  P.ctx.originalIds.push(...picks.map(t => t.id));
}

// Blocked while a "stop after this song" sleep timer is armed, so nothing
// else (queue changes, shuffle toggles...) can sneak a next track back in
// underneath it - see setSleepTimer below.
function scheduleUpcoming() {
  if (sleepAtTrackEnd) { Playback.scheduleNext(null); return; }
  Playback.scheduleNext(peekNext(false));
  if (P.dj && DJ.planAhead) DJ.planAhead();
}

/* ---------- sleep timer ---------- */

let sleepTimeoutId = null, sleepEndsAt = null, sleepAtTrackEnd = false, sleepMinutes = null;
const SLEEP_FADE_SEC = 8;

// mode: a number of minutes, 'end' (stop after the current song), or
// anything falsy to turn it off.
function setSleepTimer(mode) {
  clearTimeout(sleepTimeoutId);
  if (sleepEndsAt && sleepEndsAt - Date.now() < SLEEP_FADE_SEC * 1000 + 500) AudioEngine.setMusicLevel(1, 0.4); // cancelled mid fade-out
  sleepTimeoutId = null; sleepEndsAt = null; sleepAtTrackEnd = false; sleepMinutes = null;
  if (mode === 'end') {
    sleepAtTrackEnd = true;
    Playback.scheduleNext(null); // drop whatever was already preloaded next
    toast('Sleep timer: stopping after this song');
  } else if (typeof mode === 'number' && mode > 0) {
    sleepMinutes = mode;
    sleepEndsAt = Date.now() + mode * 60000;
    // with smooth pause on, local music drifts down over the last few
    // seconds instead of cutting out mid-line when you might be asleep
    const fade = S.settings.fadePause !== false && Playback.activeSource() === 'local' ? SLEEP_FADE_SEC : 0;
    const done = () => {
      Playback.pause();
      if (fade) setTimeout(() => AudioEngine.setMusicLevel(1, 0.05), 400);
      sleepEndsAt = null; sleepMinutes = null;
      syncSleepUI();
      toast('Sleep timer: playback paused');
    };
    sleepTimeoutId = setTimeout(() => {
      if (!fade || Playback.isPaused()) { done(); return; }
      AudioEngine.setMusicLevel(0, fade);
      sleepTimeoutId = setTimeout(done, fade * 1000);
    }, Math.max(0, mode * 60000 - fade * 1000));
    toast('Sleep timer set for ' + mode + ' min');
  } else {
    toast('Sleep timer off');
  }
  syncSleepUI();
}

function syncSleepUI() {
  const el = $('#npSleepBtn');
  if (!el) return;
  const on = !!(sleepEndsAt || sleepAtTrackEnd);
  el.classList.toggle('on', on);
  el.title = sleepAtTrackEnd ? 'Sleep timer: stopping after this song'
    : sleepEndsAt ? 'Sleep timer: ' + Math.max(1, Math.round((sleepEndsAt - Date.now()) / 60000)) + ' min left'
    : 'Sleep timer';
}

function openSleepMenu() {
  const el = $('#npSleepBtn');
  const r = el.getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, [
    [null, 'Off'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '60 minutes'], ['end', 'End of current song']
  ].map(([v, l]) => ({ label: ((v === 'end' && sleepAtTrackEnd) || (v === sleepMinutes) ? '✓ ' : '') + l, act: () => setSleepTimer(v) })));
}

function playFrom(ids, index, meta) {
  if (!ids || !ids.length) return;
  index = Math.max(0, Math.min(index, ids.length - 1));
  P.dj = meta.sourceType === 'dj';
  if (!P.dj && DJ.active) DJ.stop(true);
  buildContext(ids, ids[index], meta);
  P.history = [];
  P.wrapOrder = null;
  direct(P.ctx.ids[P.ctx.pos]);
}

function direct(id) {
  P.expectDirect = id;
  Playback.playNow(S.byId.get(id));
}

function onStarted(id) {
  const prevId = P.currentId;
  finalizeListen();
  if (P.expectDirect === id) {
    P.expectDirect = null;
  } else if (P.repeat === 'one' && id === P.currentId) {
    /* looped in place */
  } else if (P.manual[0] === id) {
    if (P.currentId) P.history.push(P.currentId);
    P.manual.shift();
  } else if (P.wrapOrder && P.wrapOrder[0] === id) {
    if (P.currentId) P.history.push(P.currentId);
    P.ctx.ids = P.wrapOrder;
    P.ctx.pos = 0;
    P.ctx.recs = new Set();
    P.wrapOrder = null;
    if (P.smart) injectRecs();
  } else {
    const idx = P.ctx.ids.indexOf(id, P.ctx.pos + 1);
    if (idx > -1) { if (P.currentId) P.history.push(P.currentId); P.ctx.pos = idx; }
  }
  P.currentId = id;
  P.counted = false; P.listenMs = 0; P.lastTick = performance.now();
  const t = cur();
  if (t) {
    if (t.source === 'spotify') refreshSpotifyLiked([t]);
    updateNowPlayingUI(t);
    updateMediaSession(t);
    loadLyricsFor(t);
    notifyTrack(t);
    DJ.onTrackStart(t);
  }
  scheduleUpcoming();
  renderQueue();
  markPlayingRows();
  followPlayingAfterChange(prevId);
  broadcastState();
  saveSession();
}

function next(userSkip) {
  const n = peekNext(!!userSkip);
  if (!n) { finalizeListen(); Playback.stop(); return; }
  Playback.playNow(S.byId.get(n));
}

function prev() {
  const restartAfter = S.settings.prevRestartSec ?? 3; // 0: Previous always goes back a song
  if (restartAfter && Playback.pos().t > restartAfter) { Playback.seek(0); return; }
  let id = P.history.pop();
  let idx = id ? P.ctx.ids.lastIndexOf(id) : -1;
  if (!id) {
    // nothing played before this one yet (started mid-album, or just
    // relaunched): step back through the list itself instead of only
    // ever restarting the song
    if (P.ctx.pos < 1) { Playback.seek(0); return; }
    idx = P.ctx.pos - 1;
    id = P.ctx.ids[idx];
  }
  if (idx > -1) P.ctx.pos = idx;
  P.expectDirect = id;
  Playback.playNow(S.byId.get(id));
}

function togglePlay() {
  if (!Playback.hasTrack()) {
    // the list ran out (or the song was stopped): Play starts that song
    // again with its queue intact, not a random shuffle of the library
    const last = cur();
    if (last) { direct(last.id); return; }
    if (S.tracks.length) {
      P.shuffle = true;
      playFrom(S.tracks.map(t => t.id), Math.floor(Math.random() * S.tracks.length), { name: 'Your Library', sourceType: 'all' });
      syncControls();
    }
    return;
  }
  Playback.isPaused() ? Playback.resume() : Playback.pause();
}

/* ---------- modes ---------- */

function toggleShuffle() {
  P.shuffle = !P.shuffle;
  if (P.ctx.ids.length && P.currentId) {
    if (P.shuffle) {
      P.ctx.ids = [P.currentId, ...shuffled(P.ctx.originalIds.filter(id => id !== P.currentId))];
      P.ctx.pos = 0;
      P.ctx.recs = new Set();
      if (P.smart) injectRecs();
    } else {
      if (P.smart) P.smart = false;
      stripRecs();
      P.ctx.ids = P.ctx.originalIds.slice();
      P.ctx.pos = Math.max(0, P.ctx.ids.indexOf(P.currentId));
    }
    P.wrapOrder = null;
    scheduleUpcoming();
  }
  syncControls(); renderQueue();
  toast(P.shuffle ? 'Shuffle on' : 'Shuffle off');
}

function toggleSmart() {
  if (!P.ctx.ids.length) { toast('Play something first'); return; }
  P.smart = !P.smart;
  if (P.smart) {
    if (!P.shuffle) {
      P.shuffle = true;
      P.ctx.ids = [P.currentId, ...shuffled(P.ctx.originalIds.filter(id => id !== P.currentId))];
      P.ctx.pos = 0;
      P.ctx.recs = new Set();
    }
    injectRecs();
    toast('Smart Shuffle on, weaving in suggestions');
  } else {
    stripRecs();
    toast('Smart Shuffle off');
  }
  P.wrapOrder = null;
  scheduleUpcoming();
  syncControls(); renderQueue();
}

function cycleRepeat() {
  P.repeat = P.repeat === 'off' ? 'all' : P.repeat === 'all' ? 'one' : 'off';
  P.wrapOrder = null;
  scheduleUpcoming();
  syncControls(); saveSettings();
  toast('Repeat ' + (P.repeat === 'off' ? 'off' : P.repeat === 'all' ? 'all' : 'one'));
}

/* ---------- queue ---------- */

function queueNext(id) { P.manual.unshift(id); scheduleUpcoming(); renderQueue(); toast('Playing next'); }
function queueAdd(id) { P.manual.push(id); scheduleUpcoming(); renderQueue(); toast('Added to queue'); }
function queueNextMany(ids, label) { if (!ids.length) return; P.manual.unshift(...ids); scheduleUpcoming(); renderQueue(); toast((label || ids.length + ' songs') + ' playing next'); }
function queueAddMany(ids, label) { if (!ids.length) return; P.manual.push(...ids); scheduleUpcoming(); renderQueue(); toast((label || ids.length + ' songs') + ' added to queue'); }

/* Song/album/artist radio: a few of the seeds first, then a long run of
   similar tracks from recommend(). Autoplay keeps extending it past the end. */
function startRadio(seedIds, name) {
  const seeds = trackList(seedIds).filter(t => t.source !== 'spotify');
  if (!seeds.length) return;
  const exclude = new Set(seeds.map(t => t.id));
  const picks = recommend(seeds, exclude, 30).map(t => t.id);
  const head = seeds.length > 1 ? shuffled(seeds.map(t => t.id)).slice(0, 3) : [seeds[0].id];
  P.shuffle = false; P.smart = false;
  playFrom([...head, ...picks.filter(id => !head.includes(id))], 0, { name: name + ' Radio', sourceType: 'radio' });
  syncControls();
  toast(name + ' Radio: similar songs from your library');
}

// Where "Playing from" should take you, or null for lists with no page of their own
function ctxSourceHash(ctx = P.ctx) {
  const id = ctx.sourceId;
  switch (ctx.sourceType) {
    case 'album': return id ? '#/album/' + id : null;
    case 'artist': return id ? '#/artist/' + encodeURIComponent(id) : null;
    case 'playlist': return id ? '#/playlist/' + id : null;
    case 'mix': return id ? '#/mix/' + encodeURIComponent(id) : null;
    case 'liked': return '#/liked';
    case 'all': return '#/songs';
    default: return null;
  }
}
const CTX_LABEL = { album: 'Playing from album', artist: 'Playing from artist', playlist: 'Playing from playlist', mix: 'Playing from mix', dj: 'Playing with', radio: 'Playing', search: 'Playing from search', single: 'Playing' };
function queueRemove(i) { P.manual.splice(i, 1); scheduleUpcoming(); renderQueue(); }
function clearQueue() { P.manual = []; scheduleUpcoming(); renderQueue(); toast('Queue cleared'); }

function queueJump(id) {
  const m = P.manual.indexOf(id);
  if (m > -1) {
    P.manual.splice(0, m); // clicked item becomes manual[0], consumed on start
    Playback.playNow(S.byId.get(id));
    return;
  }
  const idx = P.ctx.ids.indexOf(id, P.ctx.pos + 1);
  if (idx > -1) {
    if (P.currentId) P.history.push(P.currentId);
    P.ctx.pos = idx;
    P.expectDirect = id;
    Playback.playNow(S.byId.get(id));
  }
}

/* ---------- likes ---------- */

function setLiked(list) { S.liked = new Map((list || []).map(l => [l.trackId, l.addedAt])); }
async function toggleLike(id) {
  if (!id) return;
  // Spotify songs like/unlike in your Spotify library, not Aura's own Liked Songs
  if (String(id).startsWith('sp:')) { toggleSpotifyLike(id); return; }
  const wasLiked = S.liked.has(id);
  setLiked(await window.aura.likedToggle(id));
  markLikeUI();
  popLike(id);
  if (S.route.name === 'liked') route();
  toast(wasLiked ? 'Removed from Liked Songs' : 'Added to Liked Songs');
}
// little heart bounce on every heart that just changed
function popLike(id) {
  const els = $$(`.row-like[data-id="${id}"]`);
  if (id === P.currentId) els.push($('#btnLike'), $('#npLike'));
  for (const el of els) { if (!el) continue; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
}
function markLikeUI() {
  const likedNow = P.currentId && isTrackLiked(P.currentId);
  $('#btnLike').classList.toggle('on', !!likedNow);
  $('#npLike').classList.toggle('on', !!likedNow);
  $$('.row-like').forEach(b => b.classList.toggle('on', isTrackLiked(b.dataset.id)));
  broadcastState();
}

/* ---------- stats ---------- */

function tickListen() {
  const now = performance.now();
  const d = now - P.lastTick;
  P.lastTick = now;
  if (!P.playing) return;
  if (d > 0 && d < 2000) P.listenMs += d;
  const t = cur();
  if (!P.counted && t && (P.listenMs > t.duration * 400 || P.listenMs > 45000)) P.counted = true;
}

function finalizeListen() {
  if (P.currentId && P.listenMs > 1500) {
    window.aura.statsLog({ trackId: P.currentId, ms: Math.round(P.listenMs), counted: P.counted });
    if (P.counted) S.counts[P.currentId] = (S.counts[P.currentId] || 0) + 1;
  }
  P.listenMs = 0; P.counted = false;
}

/* ---------- UI sync ---------- */

function setSliderFill(el, pct) { if (el) el.style.setProperty('--p', Math.max(0, Math.min(100, pct)) + '%'); }

/* Skipping/transitioning tracks used to hard-cut the Now Playing art the
   instant metadata updated, which looked broken next to the audio's own
   smooth crossfade. This clones whatever's showing now, drops the clone on
   top as a ghost, and dissolves it away while the real element underneath
   already shows the new art - so both covers are genuinely visible at once
   for a moment, matching the audio crossfade instead of popping. */
function crossfadeArt(el, src) {
  if (!el) return;
  const already = el.getAttribute('src') || null;
  if (already === (src || null)) return;
  // the WebGL scene draws this cover and dissolves it into particles itself
  if (el.id === 'npArt' && typeof NowPlayingFX !== 'undefined' && NowPlayingFX.ownsCover()) {
    if (src) { el.src = src; el.classList.remove('empty'); } else { el.removeAttribute('src'); el.classList.add('empty'); }
    return;
  }
  // the Now Playing cover swaps like a card in 3D: the old one swings out
  // and away, the new one swings in from the other side
  if (already && el.id === 'npArt' && $('#nowPlaying').classList.contains('open') && !Fx3D.reduceMotion) {
    const ghost = el.cloneNode(true);
    ghost.removeAttribute('id');
    Object.assign(ghost.style, { position: 'absolute', inset: '0', margin: 'auto', zIndex: 2, pointerEvents: 'none' });
    el.parentElement.appendChild(ghost);
    ghost.animate([
      { transform: 'none', opacity: 1, filter: 'blur(0)' },
      { transform: 'perspective(1200px) translate3d(-38%, 0, -260px) rotateY(48deg)', opacity: 0, filter: 'blur(6px)' }
    ], { duration: 650, easing: 'cubic-bezier(.23, 1, .32, 1)', fill: 'forwards' }).finished.then(() => ghost.remove(), () => ghost.remove());
    el.animate([
      { transform: 'perspective(1200px) translate3d(38%, 0, -260px) rotateY(-48deg)', opacity: 0 },
      { transform: 'none', opacity: 1 }
    ], { duration: 820, easing: 'cubic-bezier(.3, 1.2, .4, 1)' });
    if (typeof nowPlayingFxBurst === 'function') nowPlayingFxBurst();
  } else if (already) {
    const wrap = el.parentElement;
    const ghost = el.cloneNode(true);
    ghost.removeAttribute('id');
    Object.assign(ghost.style, { position: 'absolute', inset: '0', zIndex: 2, transition: 'opacity .45s ease', opacity: '1' });
    wrap.appendChild(ghost);
    requestAnimationFrame(() => { ghost.style.opacity = '0'; });
    setTimeout(() => ghost.remove(), 500);
  }
  if (src) { el.src = src; el.classList.remove('empty'); }
  else { el.removeAttribute('src'); el.classList.add('empty'); }
}

function updateNowPlayingUI(t) {
  $('#playerBar').classList.remove('empty');
  const isSp = t.source === 'spotify';
  const albumKey = !isSp && t.albumId ? t.albumId : '';
  const spAlbum = isSp ? spAlbumHash(t) : null;
  $('#pbTitle').innerHTML = albumKey ? `<span class="link" data-action="open-album" data-key="${albumKey}" title="Go to album">${esc(t.title)}</span>`
    : spAlbum ? `<span class="link" data-action="open-hash" data-hash="${esc(spAlbum)}" title="Go to album">${esc(t.title)}</span>` : esc(t.title);
  $('#pbArtist').innerHTML = artistCreditsHTML(t);
  $('#pbArt').innerHTML = t.cover ? `<img src="${artUrl(t.cover, ART_SM)}" alt="">` : icon('music');
  const npTitle = $('#npTitle');
  npTitle.textContent = t.title;
  npTitle.classList.toggle('link', !!(albumKey || spAlbum));
  delete npTitle.dataset.action; delete npTitle.dataset.key; delete npTitle.dataset.hash;
  if (albumKey) { npTitle.dataset.action = 'open-album'; npTitle.dataset.key = albumKey; }
  else if (spAlbum) { npTitle.dataset.action = 'open-hash'; npTitle.dataset.hash = spAlbum; }
  const albumHTML = albumKey ? `<span class="link" data-action="open-album" data-key="${albumKey}">${esc(t.album)}</span>`
    : spAlbum ? `<span class="link" data-action="open-hash" data-hash="${esc(spAlbum)}">${esc(t.album)}</span>` : esc(t.album || '');
  $('#npArtist').innerHTML = artistCreditsHTML(t) + (t.album ? ' · ' + albumHTML : '');
  $('#npArtWrap').classList.toggle('clickable', !!(albumKey || spAlbum));
  $('#npArtWrap').style.setProperty('--cover', t.cover ? `url(${JSON.stringify(artUrl(t.cover, ART_SM * 2))})` : 'none'); // blurred 56px: a small copy looks identical
  renderNowPlayingChips(t);
  renderPlayingFrom();
  crossfadeArt($('#npArt'), artUrl(t.cover, ART_XL));
  crossfadeArt($('#npBg'), artUrl(t.cover, ART_SM * 2)); // blurred 80px
  document.title = t.title + ' · ' + t.artist;
  markLikeUI();
  $('#nowPlaying').classList.toggle('via-spotify', isSp);
  renderSpotifyNowPlayingNote(t);
  vibrantColor(t.cover).then(rgb => {
    if (P.currentId !== t.id) return;
    $('#nowPlaying').style.setProperty('--tint', rgb.join(','));
    $('#playerBar').style.setProperty('--tint', rgb.join(','));
    if (typeof setNowPlayingFxColor === 'function') setNowPlayingFxColor(rgb);
    if (S.settings.accent === 'album') setAccentRGB(rgb);
    P.tint = rgb; broadcastState();
  });
  coverPalette(t.cover).then(pal => {
    if (P.currentId === t.id && typeof setNowPlayingFxPalette === 'function') setNowPlayingFxPalette(pal);
  });
}

/* Windows toast on song change, only while Aura isn't the focused window
   (when you're looking at it the player bar already says what's on). */
let lastNotified = null;
function notifyTrack(t) {
  if (!S.settings.notifyTrackChange || lastNotified === t.id || document.hasFocus() || typeof Notification === 'undefined') return;
  lastNotified = t.id;
  try {
    const n = new Notification(t.title, {
      body: [t.artist, t.album].filter(Boolean).join(' · '),
      icon: t.cover ? new URL(artUrl(t.cover, ART_SM * 2), location.href).href : undefined,
      silent: true
    });
    n.onclick = () => window.aura.showWindow();
  } catch {}
}

/* Everything about the song you might want to jump to, as chips under the
   title: the album (with its cover), each credited artist (with their photo),
   the release year (opens the discography), the genre (searches it), and how
   often you've played it. */
function renderNowPlayingChips(t) {
  const el = $('#npChips');
  if (!el) return;
  if (t.source === 'spotify') { el.innerHTML = spotifyNowPlayingChipsHTML(t); return; }
  const chips = [];
  const album = t.albumId && S.albumById.get(t.albumId);
  if (album) chips.push(`<button class="chip" data-action="open-album" data-key="${album.id}" title="Go to album">${album.cover ? `<img src="${artUrl(album.cover, ART_SM)}" alt="">` : icon('disc')}<span>${esc(album.title)}</span></button>`);
  for (const name of (t.artists || [t.artistKey]).filter(Boolean)) {
    const ar = S.artistByName.get(name);
    const img = ar && artistImage(ar);
    chips.push(`<button class="chip" data-action="open-artist" data-artist="${esc(name)}" title="Go to artist">${img ? `<img class="round" src="${artUrl(img, ART_SM)}" alt="">` : icon('user')}<span>${esc(name)}</span></button>`);
  }
  const year = album && album.releaseDate ? String(album.releaseDate).slice(0, 4) : t.year;
  if (year) chips.push(`<button class="chip" data-action="open-discography" data-artist="${esc(album ? album.artist : t.artistKey)}" title="See the discography">${icon('calendar')}<span>${esc(year)}</span></button>`);
  if (t.genre) chips.push(`<button class="chip" data-action="open-search" data-q="${esc(t.genre)}" title="More ${esc(t.genre)}">${icon('tag')}<span>${esc(t.genre)}</span></button>`);
  const plays = S.counts[t.id] || 0;
  if (plays) chips.push(`<span class="chip static">${icon('chart')}<span>${plays} play${plays === 1 ? '' : 's'}</span></span>`);
  el.innerHTML = chips.join('');
}

function renderPlayingFrom() {
  const btn = $('#npFrom');
  if (!btn) return;
  const name = P.ctx.sourceType === 'dj' ? 'DJ' : P.ctx.name;
  btn.hidden = !name;
  $('#npFromLbl').textContent = CTX_LABEL[P.ctx.sourceType] || 'Playing from';
  $('#npFromName').textContent = name || '';
  btn.classList.toggle('link', !!ctxSourceHash());
}

function renderUpNext() {
  const el = $('#npUpNext');
  if (!el) return;
  const id = P.manual[0] || P.ctx.ids[P.ctx.pos + 1];
  const t = id && S.byId.get(id);
  el.hidden = !t;
  if (!t) return;
  el.innerHTML = `<div class="q-row" data-action="q-play" data-id="${t.id}" title="Play now">
    <span class="upnext-lbl">Up next</span>
    <div class="q-art">${t.cover ? `<img src="${artUrl(t.cover, ART_SM)}" alt="">` : icon('music')}</div>
    <div class="q-meta"><div class="q-title">${esc(t.title)}</div><div class="q-sub">${artistCreditsHTML(t)}</div></div>
  </div>`;
}

function setPlayingState(on) {
  $('#btnPlay').innerHTML = icon(on ? 'pause' : 'play');
  $('#npPlay').innerHTML = icon(on ? 'pause' : 'play');
  $('#nowPlaying').classList.toggle('paused', !on);
  $$('.eq').forEach(e => e.classList.toggle('paused', !on));
}

let seekDragging = false;
// Runs 4-5 times a second: only touch what actually changed, since every
// write (even of an identical value) invalidates style and layout.
const progressShown = new Map();
function setIfChanged(sel, prop, value) {
  const key = sel + prop;
  if (progressShown.get(key) === value) return;
  progressShown.set(key, value);
  const el = $(sel);
  if (prop === 'fill') setSliderFill(el, value); else el[prop] = value;
}
function updateProgressUI(t, dur) {
  if (!seekDragging) {
    // 0.1% steps: finer than a pixel on the seek bar
    const pct = dur ? Math.round((t / dur) * 1000) : 0;
    for (const sel of ['#seek', '#npSeek']) { setIfChanged(sel, 'value', pct); setIfChanged(sel, 'fill', pct / 10); }
  }
  setIfChanged('#tCur', 'textContent', fmtTime(t));
  setIfChanged('#tDur', 'textContent', S.settings.showRemaining ? '-' + fmtTime(Math.max(0, dur - t)) : fmtTime(dur));
  setIfChanged('#npCur', 'textContent', fmtTime(t));
  setIfChanged('#npDur', 'textContent', '-' + fmtTime(Math.max(0, dur - t)));
}

function syncControls() {
  for (const [id, on] of [['#btnShuffle', P.shuffle], ['#npShuffle', P.shuffle], ['#btnSmart', P.smart]]) $(id).classList.toggle('on', on);
  for (const id of ['#btnRepeat', '#npRepeat']) {
    $(id).classList.toggle('on', P.repeat !== 'off');
    $(id).classList.toggle('one', P.repeat === 'one');
  }
  $('#pbDj').classList.toggle('show', DJ.active);
  broadcastState();
}

function renderQueue() {
  const el = $('#queueList');
  if (!el) return;
  const rows = [];
  const c = cur();
  if (c) rows.push('<div class="qp-sec">Now Playing</div>' + queueRowHTML(c, -1, false, false, true));
  if (P.manual.length) {
    rows.push('<div class="qp-sec">Next in Queue</div>');
    P.manual.forEach((id, i) => { const t = S.byId.get(id); if (t) rows.push(queueRowHTML(t, i, true, false, false)); });
  }
  const upcoming = P.ctx.ids.slice(P.ctx.pos + 1, P.ctx.pos + 31);
  // once the original list runs out and autoplay has picked up from there,
  // label that tail separately so it's clear why new stuff shows up after
  // "Recently Added"/an album/etc. ends
  const splitAt = P.ctx.autoplayFrom != null ? Math.max(0, P.ctx.autoplayFrom - (P.ctx.pos + 1)) : upcoming.length;
  const original = upcoming.slice(0, splitAt), auto = upcoming.slice(splitAt);
  if (original.length) {
    const from = esc(P.ctx.name || 'Library');
    rows.push(`<div class="qp-sec">Next from: ${ctxSourceHash() ? `<span class="link" data-action="np-from">${from}</span>` : from}</div>`);
    for (const id of original) { const t = S.byId.get(id); if (t) rows.push(queueRowHTML(t, -1, false, P.ctx.recs.has(id), false)); }
  }
  if (auto.length) {
    rows.push('<div class="qp-sec">Autoplay</div>');
    for (const id of auto) { const t = S.byId.get(id); if (t) rows.push(queueRowHTML(t, -1, false, true, false)); }
  }
  el.innerHTML = rows.join('') || '<div class="qp-empty">Nothing queued yet. Use the ⋯ menu on any song.</div>';
  renderUpNext();
}

function queueRowHTML(t, manualIdx, removable, isRec, isNow) {
  return `<div class="q-row ${isNow ? 'now' : ''}" data-action="q-play" data-id="${t.id}">
    <div class="q-art">${t.cover ? `<img loading="lazy" decoding="async" src="${artUrl(t.cover, ART_SM)}" alt="">` : icon('music')}</div>
    <div class="q-meta">
      <div class="q-title">${isRec ? '<span class="rec" title="Suggested for you">✦</span> ' : ''}${esc(t.title)}</div>
      <div class="q-sub">${artistCreditsHTML(t)}</div>
    </div>
    ${removable ? `<button class="icon-btn q-x" data-action="q-remove" data-idx="${manualIdx}" title="Remove">${icon('x')}</button>` : `<span class="q-dur">${fmtTime(t.duration)}</span>`}
  </div>`;
}

function markPlayingRows() {
  $$('.row.playing').forEach(r => r.classList.remove('playing'));
  if (P.currentId) $$(`.row[data-id="${P.currentId}"]`).forEach(r => r.classList.add('playing'));
}

// Feeds the tray and the mini player (electron/main.js). Cheap enough to call
// on every like/shuffle/repeat change so the mini player never goes stale.
function broadcastState() {
  const t = cur();
  window.aura.sendState({
    id: t ? t.id : null,
    title: t ? t.title : 'Not Playing',
    artist: t ? t.artist : '',
    album: t ? t.album || '' : '',
    cover: t ? t.cover : null,
    duration: t ? t.duration || 0 : 0,
    playing: P.playing,
    liked: !!(t && isTrackLiked(t.id)),
    shuffle: P.shuffle,
    repeat: P.repeat,
    tint: P.tint || null
  });
}
// Position for the mini player: at most once a second (it interpolates in
// between), and immediately on a seek since that changes the whole second.
let lastPosSec = -1;
function broadcastPos(t, dur) {
  const s = Math.floor(t);
  if (s === lastPosSec) return;
  lastPosSec = s;
  window.aura.sendPos(t, dur);
}

/* ---------- media session ---------- */

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: t.cover ? [{ src: artUrl(t.cover, ART_LG), sizes: '512x512', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => Playback.resume());
    navigator.mediaSession.setActionHandler('pause', () => Playback.pause());
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', () => next(true));
    navigator.mediaSession.setActionHandler('seekto', e => { if (e.seekTime != null) Playback.seek(e.seekTime); });
  } catch {}
}

/* ---------- lyrics sync ---------- */

async function loadLyricsFor(t) {
  if (!S.lyricsCache.has(t.id)) {
    S.lyricsCache.set(t.id, 'loading');
    // a failed read must not leave the song stuck on "Loading…" for the session
    let data = await window.aura.lyricsGet(t.id).catch(() => null);
    // nothing embedded/saved locally: try LRCLIB automatically instead of
    // making the user open the lyrics panel and click "Search" every time
    if (!data && S.settings.autoLyrics !== false) {
      data = await window.aura.lyricsFetch(t.id, { artist: t.artistKey, title: t.title, album: t.album, duration: t.duration }).catch(() => null);
    }
    S.lyricsCache.set(t.id, data || null);
  }
  renderLyricsPanel();
}

// Keeps both lyrics surfaces (full-screen tab, docked panel) highlighted and
// scrolled together regardless of which one - if either - is actually open,
// so reopening either later lands already scrolled to the current line
// instead of jumping.
let lastLyrIdx = -1, lastLyrScroll = 0;
function lyricsTick(t) {
  const data = S.lyricsCache.get(P.currentId);
  if (!data || data === 'loading' || !data.synced) return;
  let idx = -1;
  for (let i = 0; i < data.synced.length; i++) { if (data.synced[i][0] <= t + 0.25) idx = i; else break; }
  if (idx === lastLyrIdx) return;
  lastLyrIdx = idx;
  const canScroll = performance.now() - lastLyrScroll > 350;
  for (const id of ['npLyrics', 'dockLyrics']) {
    const container = document.getElementById(id);
    if (!container) continue;
    container.querySelectorAll('.lyr-line').forEach((el, i) => el.classList.toggle('on', i === idx));
    const el = container.querySelector(`.lyr-line[data-i="${idx}"]`);
    if (typeof NowPlayingFX !== 'undefined' && NowPlayingFX.lyrics(container, idx, t, data)) continue;
    if (el && canScroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (canScroll) lastLyrScroll = performance.now();
}

/* ---------- engine wiring ---------- */

Playback.on('started', onStarted);
Playback.on('time', (t, dur, id) => { if (id !== P.currentId) return; tickListen(); updateProgressUI(t, dur); lyricsTick(t); broadcastPos(t, dur); });
Playback.on('playstate', p => { P.playing = p; P.lastTick = performance.now(); setPlayingState(p); broadcastState(); saveSession(); });
Playback.on('stopped', () => {
  finalizeListen(); P.playing = false; setPlayingState(false); broadcastState();
  if (sleepAtTrackEnd) { sleepAtTrackEnd = false; syncSleepUI(); toast('Sleep timer: stopped after this song'); }
});
Playback.on('error', e => {
  if (spSilentError(e)) return;
  toast(spErrMsg(e), e && e.code === 'REAUTH_REQUIRED' ? { label: 'Settings', act: () => navigate('#/settings') } : undefined);
});

window.addEventListener('beforeunload', () => { finalizeListen(); saveSessionNow(); });
