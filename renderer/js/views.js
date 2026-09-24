/* views.js — page renderers, components, menus, modal editors */

/* ---------- virtualized row list (Songs page, any library size) ---------- */

const ROW_H = 48; // matches .row { height: 48px } in style.css

/* Renders only the rows in view (plus a buffer) into `container`, keyed off
   #content's scroll position. Row height is fixed, so no measurement pass is
   needed. The scroll/resize listeners self-remove the first time they notice
   `container` is no longer in the document (page navigated away). */
function mountVirtualRows(container, items, renderRow) {
  const contentEl = $('#content');
  container.style.position = 'relative';
  container.style.height = (items.length * ROW_H) + 'px';
  container.dataset.virtual = '1';
  container._vItems = items;

  let raf = null;
  function paint() {
    const top = container.offsetTop;
    const scrollTop = contentEl.scrollTop;
    const viewportH = contentEl.clientHeight;
    const relative = Math.max(0, scrollTop - top);
    const BUFFER = 6;
    const start = Math.max(0, Math.floor(relative / ROW_H) - BUFFER);
    const end = Math.min(items.length, start + Math.ceil(viewportH / ROW_H) + BUFFER * 2);
    let html = '';
    for (let i = start; i < end; i++) html += renderRow(items[i], i, i * ROW_H);
    container.innerHTML = html;
  }
  function onScrollOrResize() {
    if (!document.body.contains(container)) {
      contentEl.removeEventListener('scroll', onScrollOrResize);
      window.removeEventListener('resize', onScrollOrResize);
      return;
    }
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; paint(); });
  }
  contentEl.addEventListener('scroll', onScrollOrResize);
  window.addEventListener('resize', onScrollOrResize);
  paint();
}

/* ---------- shared components ---------- */

// born paused unless music is playing: a running CSS animation ticks the
// compositor at the display's full refresh rate (360 Hz here), and a row
// rendered while paused never gets setPlayingState's .paused toggle
const eqHTML = () => `<span class="eq${typeof P !== 'undefined' && P.playing ? '' : ' paused'}"><span></span><span></span><span></span><span></span></span>`;
const sectionHead = (title, href) => `<div class="sec-head"><h2>${esc(title)}</h2>${href ? `<a class="see-all" href="${href}">See all</a>` : ''}</div>`;
// Artist without a photo: their initial reads as intentional, a grey silhouette as missing data.
const initialsHTML = name => `<span class="art-ph initials">${esc(String(name || '?').trim().charAt(0).toUpperCase())}</span>`;

function albumCardHTML(a, showArtist = true) {
  const year = a.releaseDate ? fmtRelease(a.releaseDate).split(',').pop().trim() : (a.year || '');
  const who = a.type !== 'album' ? TYPE_LABEL[a.type]
    : showArtist ? `<span class="link" data-action="open-artist" data-artist="${esc(a.artist)}">${esc(a.artist)}</span>` : 'Album';
  const sub = [year, who, a.unreleased ? 'Unreleased' : '', a.source === 'navidrome' ? 'NAS' : ''].filter(Boolean).join(' · ');
  return `<div class="card" data-action="open-album" data-key="${a.id}"${nasAlbumAttrs(a)}>
    <div class="card-art tilt">
      ${a.cover ? `<img loading="lazy" decoding="async" src="${artUrl(a.cover, ART_MD)}" alt="">` : `<span class="art-ph">${icon('music')}</span>`}
      <span class="glare"></span>
      <button class="card-play" data-action="play-album" data-key="${a.id}" title="Play">${icon('play')}</button>
    </div>
    <div class="card-title">${esc(a.title)}</div>
    <div class="card-sub">${sub || '&nbsp;'}</div>
  </div>`;
}

/* An auto-generated mix (Home's genre mixes): opens its own page listing the
   mix's tracks, same as an album card would; the play button on the art
   still shuffle-plays it directly without navigating. */
function mixCardHTML(genre, title, sub, ctxKey, coverUrls) {
  const arts = [...new Set(coverUrls.filter(Boolean))].slice(0, 4);
  const art = arts.length >= 4
    ? `<div class="mosaic">${arts.map(u => `<img loading="lazy" decoding="async" src="${artUrl(u, ART_SM * 2)}" alt="">`).join('')}</div>`
    : arts.length ? `<img loading="lazy" decoding="async" src="${artUrl(arts[0], ART_MD)}" alt="">` : `<span class="art-ph">${icon('music')}</span>`;
  return `<div class="card" data-action="open-mix" data-genre="${esc(genre)}">
    <div class="card-art tilt">${art}<span class="glare"></span><button class="card-play" data-action="ctx-shuffle" data-ctx="${ctxKey}" title="Shuffle play">${icon('shuffle')}</button></div>
    <div class="card-title">${esc(title)}</div>
    <div class="card-sub">${esc(sub)}</div>
  </div>`;
}

function artistCardHTML(ar) {
  const img = artistImage(ar);
  return `<div class="card artist" data-action="open-artist" data-artist="${esc(ar.name)}">
    <div class="card-art round tilt">${img ? `<img loading="lazy" decoding="async" src="${artUrl(img, ART_MD)}" alt="">` : initialsHTML(ar.name)}<span class="glare"></span>
      <button class="card-play" data-action="play-artist" data-artist="${esc(ar.name)}" title="Play">${icon('play')}</button></div>
    <div class="card-title center">${esc(ar.name)}</div>
    <div class="card-sub center">${ar.trackCount} song${ar.trackCount === 1 ? '' : 's'}</div>
  </div>`;
}

// Main artist + every featured credit ("Kanye West, Kid Cudi"), each its own
// link so a featured name opens their own page instead of the whole credit
// only ever routing to the primary artist. Spotify tracks keep one plain
// string - their artist names are already clean and don't carry the same
// local feat./collaborator parsing.
function artistCreditsHTML(t) {
  if (t.source === 'spotify') return spArtistLinksHTML(t);
  if (!t.artists) return esc(t.artist);
  return t.artists.map(n => `<span class="link" data-action="open-artist" data-artist="${esc(n)}">${esc(n)}</span>`).join(', ');
}

function trackRowHTML(t, i, o = {}) {
  const grid = o.grid || 'full';
  const playing = P.currentId === t.id;
  const isSp = t.source === 'spotify';
  const liked = o.forceLiked != null ? o.forceLiked : isTrackLiked(t.id);
  let cells = '';
  if (grid !== 'simple') {
    const num = grid === 'album' ? (o.numbered ? i + 1 : (t.trackNo || i + 1)) : i + 1;
    cells += `<div class="row-num"><span class="n">${num}</span>${eqHTML()}<button class="row-playbtn" title="Play">${icon('play')}</button></div>`;
  }
  if (grid !== 'album') {
    cells += `<div class="row-art">${t.cover ? `<img loading="lazy" decoding="async" src="${artUrl(t.cover, ART_SM)}" alt="">` : `<span class="art-ph">${icon('music')}</span>`}${grid === 'simple' ? eqHTML() : ''}</div>`;
  }
  cells += `<div class="row-main"><div class="row-title">${isSp ? '<span class="sp-dot" title="Spotify"></span>' : nasDotHTML(t)}${esc(t.title)}${t.bonus ? '<span class="tag" title="Found alongside this album, not on its official tracklist">Bonus</span>' : ''}</div><div class="row-sub">${artistCreditsHTML(t)}</div></div>`;
  if (grid === 'popular') {
    const plays = S.counts[t.id] || 0;
    cells += `<div class="row-plays">${plays ? plays.toLocaleString() + ' play' + (plays === 1 ? '' : 's') : ''}</div>`;
  }
  if (grid === 'full') {
    const albumHash = isSp ? spAlbumHash(t) : null;
    cells += `<div class="row-album">${t.albumId && !isSp ? `<span class="link" data-action="open-album" data-key="${t.albumId}">${esc(t.album)}</span>`
      : albumHash ? `<span class="link" data-action="open-hash" data-hash="${esc(albumHash)}">${esc(t.album)}</span>` : esc(t.album)}</div>`;
    cells += `<div class="row-date">${fmtDate(o.dateMs != null ? o.dateMs : t.dateAdded)}</div>`;
  }
  if (grid !== 'simple') cells += `<button class="icon-btn row-like ${liked ? 'on' : ''}" data-action="${isSp ? 'sp-like' : 'like'}" data-id="${t.id}" title="Like">${icon('heart')}</button>`;
  cells += `<div class="row-dur">${fmtTime(t.duration)}</div>
    <button class="icon-btn row-more" data-action="row-menu" data-id="${t.id}" title="More">${icon('dots')}</button>`;
  const style = o.top != null ? ` style="position:absolute;top:${o.top}px;left:0;right:0;"` : '';
  return `<div class="row grid-${grid} ${playing ? 'playing' : ''}" data-action="row-play" data-id="${t.id}" data-index="${i}"${nasSrcAttrs(t)}${o.draggable ? ' draggable="true"' : ''}${style}>${cells}</div>`;
}

function tableHeadHTML(sort, storeKey) {
  const col = (key, label, cls) => `<button class="th ${cls} ${sort.key === key ? 'on' : ''}" data-action="sort" data-store="${storeKey}" data-key="${key}">${label}${sort.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button>`;
  return `<div class="thead grid-full">
    <div class="th num">#</div><div class="th"></div>
    ${col('title', 'Title', 'main')}
    ${col('album', 'Album', 'album')}
    ${col('date', 'Date added', 'date')}
    <div class="th"></div>
    ${col('duration', icon('clock'), 'dur')}
    <div class="th"></div>
  </div>`;
}

function sortEntries(entries, sort) {
  if (sort.key === 'custom') return entries;
  const cmp = {
    title: (a, b) => a.t.title.localeCompare(b.t.title),
    album: (a, b) => (a.t.album || '').localeCompare(b.t.album || '') || ((a.t.trackNo || 0) - (b.t.trackNo || 0)),
    date: (a, b) => (a.dateMs || 0) - (b.dateMs || 0),
    duration: (a, b) => a.t.duration - b.t.duration
  }[sort.key] || (() => 0);
  return [...entries].sort((a, b) => cmp(a, b) * sort.dir);
}

/* ---------- nav ---------- */

const NAVS = [
  ['home', 'Home', 'home'],
  ['artists', 'Artists', 'user'], ['albums', 'Albums', 'grid'],
  ['songs', 'Songs', 'music'], ['liked', 'Liked Songs', 'heart'], ['stats', 'Stats', 'chart']
];

function buildMainNav() {
  $('#mainNav').innerHTML = NAVS.map(([r, l, i]) => `<a href="#/${r}" class="nav-item" data-nav="${r}">${icon(i)}<span class="nav-label">${l}</span></a>`).join('');
}

function renderPlaylistNav() {
  $('#playlistNav').innerHTML = S.playlists.map(p =>
    `<a href="#/playlist/${p.id}" class="nav-item pl" data-plnav="${p.id}"${p.source === 'navidrome' ? ' title="NAS playlist"' : ''}><span class="pl-ico">${p.source === 'navidrome' ? '<span class="nas-pl-dot"></span>' : icon('queue')}</span><span class="nav-label">${esc(p.name)}</span></a>`
  ).join('');
  markNav();
}

function markNav() {
  const r = S.route;
  const alias = { album: 'albums', artist: 'artists' };
  $$('#mainNav .nav-item').forEach(a => a.classList.toggle('active', a.dataset.nav === (alias[r.name] || r.name)));
  $$('#playlistNav .nav-item').forEach(a => a.classList.toggle('active', r.name === 'playlist' && a.dataset.plnav === r.arg));
}

/* ---------- system views ---------- */

function renderScanning(st) {
  $('#content').innerHTML = `<div class="page center-page">
    <canvas class="scan-fx" id="scanFx"></canvas>
    <h1>Scanning your library</h1>
    <div class="muted" id="scanCount">${st.done} / ${st.total} files</div>
  </div>`;
  Fx3D.mount($('#scanFx'), { kind: 'halo', inner: 0.1, gap: 0.062, rings: 7, tickRing: 1, speed: 4, parallax: 0, audio: false });
}

async function renderSetup() {
  const seq = S.routeSeq;
  const def = await window.aura.defaultFolder();
  if (seq !== S.routeSeq) return;
  $('#content').innerHTML = `<div class="page center-page">
    <div class="setup-card">
      <canvas class="scan-fx" id="setupFx"></canvas>
      <div class="brand big">Aura</div>
      <h1>Point Aura at your music</h1>
      <p class="muted">Pick the folder(s) with your files, or start fresh with a dedicated Aura folder you build up from inside the app. Aura reads titles, albums and artwork straight from the tags and never modifies anything unless you ask it to.</p>
      <button class="btn primary lg" data-action="use-default-folder">${icon('plus')} Start fresh with ${esc(def.path)}</button>
      <button class="btn lg" data-action="add-folder">${icon('plus')} Or point at an existing folder</button>
    </div>
  </div>`;
  Fx3D.mount($('#setupFx'), { kind: 'halo', inner: 0.1, gap: 0.062, rings: 7, tickRing: 1, speed: 1.5, parallax: 0, audio: false });
}

/* ---------- pages ---------- */

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/* Spotify-style quick tiles: what you were just listening to, one click away */
function quickTilesHTML() {
  const tiles = [];
  if (S.liked.size) {
    const ids = [...S.liked.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).filter(id => S.byId.has(id));
    if (ids.length) tiles.push({ hash: '#/liked', title: 'Liked Songs', art: `<span class="liked-cover">${icon('heart')}</span>`, play: `data-action="ctx-play" data-ctx="${listCtx(ids, 'Liked Songs', 'liked')}"` });
  }
  const seen = new Set();
  for (const id of S.recentPlayed || []) {
    const t = S.byId.get(id);
    if (!t || !t.albumId || seen.has(t.albumId)) continue;
    seen.add(t.albumId);
    const a = S.albumById.get(t.albumId);
    if (a) tiles.push({ hash: '#/album/' + a.id, title: a.title, art: a.cover ? `<img src="${artUrl(a.cover, ART_SM)}" alt="">` : icon('music'), play: `data-action="play-album" data-key="${a.id}"` });
    if (tiles.length >= 5) break;
  }
  for (const pl of S.playlists) {
    if (tiles.length >= 8) break;
    const ids = pl.items.map(i => i.trackId).filter(id => S.byId.has(id));
    const cover = pl.coverFile ? '/cover/' + pl.coverFile : (trackList(ids).find(t => t.cover) || {}).cover;
    tiles.push({ hash: '#/playlist/' + pl.id, title: pl.name, art: cover ? `<img src="${artUrl(cover, ART_SM)}" alt="">` : icon('queue'), play: ids.length ? `data-action="ctx-play" data-ctx="${listCtx(ids, pl.name, 'playlist', pl.id)}"` : '' });
  }
  for (const a of sortByRelease(S.albums)) {
    if (tiles.length >= 8) break;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    tiles.push({ hash: '#/album/' + a.id, title: a.title, art: a.cover ? `<img src="${artUrl(a.cover, ART_SM)}" alt="">` : icon('music'), play: `data-action="play-album" data-key="${a.id}"` });
  }
  if (!tiles.length) return '';
  return `<div class="quick-tiles stagger">${tiles.map(t => `<div class="tile" data-action="open-hash" data-hash="${t.hash}">
    <div class="tile-art">${t.art}</div><div class="tile-title">${esc(t.title)}</div>
    ${t.play ? `<button class="tile-play" ${t.play} title="Play">${icon('play')}</button>` : ''}
  </div>`).join('')}</div>`;
}

function renderHome() {
  // Discovery/taste-driven content leads; raw "stuff I just imported" chronology
  // is left out of Home entirely.
  const madeForYouTracks = homeMadeForYou();
  const mixes = homeMixes();
  const tops = topPlayedArtists(10);
  const recentPlayedTracks = trackList((S.recentPlayed || []).filter(id => id !== P.currentId)).slice(0, 6);
  const releases = sortByRelease(S.albums.filter(a => a.releaseDate)).slice(0, 12);

  const mfyCtx = listCtx(madeForYouTracks.map(t => t.id), 'Made For You', 'list');
  const mixCtxs = mixes.map(m => listCtx(m.ids, m.genre + ' Mix', 'list'));
  const recentPlayedCtx = listCtx(recentPlayedTracks.map(t => t.id), 'Recently Played', 'list');
  const totalTime = S.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  $('#content').innerHTML = `<div class="page home">
    <header class="home-hero">
      <canvas class="hero-fx" id="homeFx"></canvas>
      <div class="hh-text">
        <div class="eyebrow">${esc(today)}</div>
        <h1>${greeting()}</h1>
        <div class="hh-stats"><span><b data-count="${S.tracks.length}">0</b> songs</span><span><b data-count="${S.albums.length}">0</b> releases</span><span><b>${fmtLong(totalTime)}</b> of music</span></div>
        <div class="head-actions">
          <button class="btn primary" data-action="shuffle-all" title="Shuffle all ${S.tracks.length} songs">${icon('shuffle')}Shuffle all</button>
          <button class="btn" data-action="start-dj" title="Endless mix from your library, with a spoken DJ between songs">${icon('mic')}Start DJ</button>
        </div>
      </div>
    </header>
    ${quickTilesHTML()}
    ${madeForYouTracks.length ? sectionHead('Made for you') + `<div class="two-col rows" data-ctxkey="${mfyCtx}">${madeForYouTracks.map((t, i) => trackRowHTML(t, i, { grid: 'simple' })).join('')}</div>` : ''}
    ${mixes.length ? sectionHead('Mixes') + `<div class="hscroll stagger">${mixes.map((m, i) => mixCardHTML(m.genre, m.genre + ' Mix', m.ids.length + ' songs', mixCtxs[i], trackList(m.ids).map(t => t.cover))).join('')}</div>` : ''}
    ${recentPlayedTracks.length ? sectionHead('Recently played') + `<div class="two-col rows" data-ctxkey="${recentPlayedCtx}">${recentPlayedTracks.map((t, i) => trackRowHTML(t, i, { grid: 'simple' })).join('')}</div>` : ''}
    ${tops.length ? sectionHead('Your top artists', '#/artists') + `<div class="hscroll stagger">${tops.map(artistCardHTML).join('')}</div>` : ''}
    ${releases.length ? sectionHead('Latest releases', '#/albums') + `<div class="hscroll stagger">${releases.map(a => albumCardHTML(a)).join('')}</div>` : ''}
  </div>`;
  const fx = Fx3D.mount($('#homeFx'), { kind: 'halo', cx: 0.84, cy: 0.5, inner: 0.2, gap: 0.14, rings: 12, tickRing: 1, alpha: 0.9 });
  const seedCover = (cur() && cur().cover) || (recentPlayedTracks[0] && recentPlayedTracks[0].cover) || (releases[0] && releases[0].cover);
  vibrantColor(seedCover).then(rgb => {
    if (fx) fx.setColor(rgb);
    const hero = $('#content .home-hero');
    if (hero) hero.style.setProperty('--tint', rgb.join(','));
  });
  Fx3D.countUp($('#content'));
}

function renderSongs() {
  const sort = S.songSort;
  const list = [...S.tracks].sort((a, b) => ({
    title: () => a.title.localeCompare(b.title),
    album: () => a.album.localeCompare(b.album) || (a.trackNo - b.trackNo),
    date: () => a.dateAdded - b.dateAdded,
    duration: () => a.duration - b.duration
  }[sort.key] || (() => 0))() * sort.dir);
  const ctx = listCtx(list.map(t => t.id), 'Songs', 'all');
  $('#content').innerHTML = `<div class="page">
    <div class="page-head"><h1>Songs</h1>
      <div class="head-actions">
        <button class="btn primary" data-action="ctx-play" data-ctx="${ctx}">${icon('play')}Play</button>
        <button class="btn" data-action="ctx-shuffle" data-ctx="${ctx}">${icon('shuffle')}Shuffle</button>
      </div>
    </div>
    ${tableHeadHTML(sort, 'songs')}
    <div class="rows grid-full" data-ctxkey="${ctx}" id="songsRows"></div>
  </div>`;
  // virtualized: the library can be huge (10k+ tracks), so only the rows
  // actually in view are ever in the DOM, no matter how large `list` is.
  mountVirtualRows($('#songsRows'), list, (t, i, top) => trackRowHTML(t, i, { top }));
}

function renderAlbums() {
  const list = sortByRelease(S.albums);
  $('#content').innerHTML = `<div class="page">
    <div class="page-head"><h1>Albums</h1>
      <div class="head-actions"><button class="btn" data-action="new-album">${icon('plus')}New album</button></div>
    </div>
    <div class="grid-cards stagger">${list.map(a => albumCardHTML(a)).join('')}</div>
    ${!list.length ? '<div class="empty-state">No albums yet. Add a music folder in Settings, or create one manually.</div>' : ''}
  </div>`;
}

function renderAlbum(id) {
  const a = S.albumById.get(id);
  if (!a) { location.hash = '#/albums'; return; }
  const tracks = albumTracks(a);
  const ctx = listCtx(tracks.map(t => t.id), a.title, 'album', a.id);
  const total = albumDuration(a);
  const owner = S.artistByName.get(a.artist);
  const ownerImg = owner && artistImage(owner);
  const genres = new Map();
  for (const t of tracks) if (t.genre) genres.set(t.genre, (genres.get(t.genre) || 0) + 1);
  const genre = [...genres.entries()].sort((x, y) => y[1] - x[1])[0];
  const plays = tracks.reduce((sum, t) => sum + (S.counts[t.id] || 0), 0);
  const when = a.releaseDate ? fmtRelease(a.releaseDate) : (a.year || null);
  const metaBits = [
    `<span class="meta-artist link strong" data-action="open-artist" data-artist="${esc(a.artist)}">${ownerImg ? `<img src="${artUrl(ownerImg, ART_SM)}" alt="">` : ''}${esc(a.artist)}</span>`,
    when ? `<span class="link" data-action="open-discography" data-artist="${esc(a.artist)}" title="See the discography">${esc(when)}</span>` : null,
    `${tracks.length} song${tracks.length === 1 ? '' : 's'}, ${fmtLong(total)}`,
    genre ? `<span class="link" data-action="open-search" data-q="${esc(genre[0])}" title="More ${esc(genre[0])}">${esc(genre[0])}</span>` : null,
    plays ? `${plays.toLocaleString()} play${plays === 1 ? '' : 's'}` : null
  ].filter(Boolean).join(' · ');
  const more = artistAlbums(a.artist).filter(x => x.id !== a.id).slice(0, 16);
  $('#content').innerHTML = `<div class="page detail" data-album="${a.id}" data-custom="${a.custom ? 1 : 0}">
    <div class="sticky-bar dx-glass" id="stickyBar"><div class="sb-inner">
      ${tracks.length ? `<button class="big-play small" data-action="ctx-play" data-ctx="${ctx}" title="Play">${icon('play')}</button>` : ''}
      ${a.cover ? `<img class="sb-art" src="${artUrl(a.cover, ART_SM)}" alt="">` : ''}<span class="sb-title">${esc(a.title)}</span>
    </div></div>
    <header class="detail-head" id="detailHead">
      <div class="detail-art drop-cover tilt" data-cover-kind="album" data-cover-id="${a.id}" title="Drop or paste a cover here">
        ${a.cover ? `<img src="${artUrl(a.cover, ART_LG)}" alt="">` : `<span class="art-ph big">${icon('music')}</span>`}<span class="glare"></span>
      </div>
      <div class="detail-info">
        <div class="eyebrow">${TYPE_LABEL[a.type] || 'Album'}${a.unreleased ? '<span class="tag">Unreleased</span>' : ''}</div>
        <h1>${esc(a.title)}</h1>
        <div class="detail-meta">${metaBits}</div>
        <div class="detail-actions">
          <button class="btn primary" data-action="ctx-play" data-ctx="${ctx}">${icon('play')}Play</button>
          <button class="btn" data-action="ctx-shuffle" data-ctx="${ctx}">${icon('shuffle')}Shuffle</button>
          ${tracks.length ? `<button class="icon-btn frame" data-action="album-radio" data-id="${a.id}" title="Album radio: similar songs">${icon('radio')}</button>` : ''}
          <button class="icon-btn frame" data-action="album-menu" data-id="${a.id}" title="More">${icon('dots')}</button>
        </div>
      </div>
    </header>
    <div class="rows grid-album ${a.custom ? 'draggable' : ''}" data-ctxkey="${ctx}" ${a.custom ? `data-reorder="album:${a.id}"` : ''}>
      ${tracks.map((t, i) => trackRowHTML(t, i, { grid: 'album', numbered: a.custom, draggable: a.custom })).join('')}
    </div>
    ${more.length ? sectionHead('More by ' + a.artist, '#/discography/' + encodeURIComponent(a.artist)) + `<div class="hscroll stagger">${more.map(x => albumCardHTML(x, false)).join('')}</div>` : ''}
    ${!tracks.length ? `<div class="empty-state">No songs in this album yet.<br><button class="btn primary" data-action="import-songs" data-artist="${esc(a.artist)}" data-album="${esc(a.title)}" style="margin-top:14px">${icon('plus')}Import songs</button> <button class="btn" data-action="album-add-songs" data-id="${a.id}" style="margin-top:14px">${icon('plus')}Add from library</button></div>` : ''}
  </div>`;
  tintHeader(a.cover);
}

function renderArtists() {
  // appearsOnly artists (feature-only credits, own nothing here) stay out of
  // the directory - reach them by clicking their name on the track that
  // credits them instead.
  const list = S.artists.filter(a => !a.appearsOnly).sort((x, y) => x.name.localeCompare(y.name));
  $('#content').innerHTML = `<div class="page">
    <div class="page-head"><h1>Artists</h1>
      <div class="head-actions"><button class="btn" data-action="new-artist">${icon('plus')}New artist</button></div>
    </div>
    <div class="grid-cards stagger">${list.map(artistCardHTML).join('')}</div>
    ${!list.length ? '<div class="empty-state">No artists yet.</div>' : ''}
  </div>`;
}

const releaseYear = a => a.releaseDate ? +String(a.releaseDate).slice(0, 4) : (a.year ? +a.year : null);

// Release date as a fractional year (2010-11-22 -> 2010.89) for the timeline axis
function releaseYearFrac(a) {
  const d = a.releaseDate ? String(a.releaseDate) : '';
  const m = d.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (m) return +m[1] + (m[2] ? (+m[2] - 1) / 12 : 0.5) + (m[3] ? (+m[3] - 1) / 372 : 0);
  return a.year ? +a.year + 0.5 : null;
}

/* Releases laid out on a real time axis. Each release sits at its date;
   covers go into four lanes (two above the axis, two below). When a cluster of
   releases lands closer together than the lanes can hold (a week of 2016
   drops), the axis stretches locally: the node is nudged right to the first
   free spot and everything after it shifts along, so covers never stack. */
function timelineHTML(albums) {
  const dated = albums.map(a => ({ a, y: releaseYearFrac(a) })).filter(x => x.y).sort((p, q) => p.y - q.y);
  if (dated.length < 2) return '';
  const minY = Math.floor(dated[0].y), maxY = Math.ceil(dated[dated.length - 1].y + 0.01);
  const span = Math.max(1, maxY - minY);
  const PAD = 48;
  const W0 = Math.max(880, dated.length * 46, span * 90);
  const xOf = y => PAD + (y - minY) / span * (W0 - PAD * 2);
  // GAP: covers sharing a lane; NEAR: an outer lane's stem runs through the
  // inner lane's covers on the same side, so keep those apart too
  const GAP = 62, NEAR = 34, laneLast = [-1e9, -1e9, -1e9, -1e9], order = [1, 2, 0, 3];
  const pair = { 0: 1, 1: 0, 2: 3, 3: 2 };
  const earliest = l => Math.max(laneLast[l] + GAP, laneLast[pair[l]] + NEAR);
  let shift = 0;
  const placed = dated.map(({ a, y }) => {
    const base = xOf(y) + shift;
    let lane = order.find(l => earliest(l) <= base);
    let x = base;
    if (lane == null) {
      lane = order.reduce((best, l) => earliest(l) < earliest(best) ? l : best, order[0]);
      x = earliest(lane);
      shift += x - base;
    }
    laneLast[lane] = x;
    return { a, y, x, lane };
  });
  const W = W0 + shift;
  // ticks follow the stretched axis: interpolate between placed releases
  const tickX = Y => {
    if (Y <= placed[0].y) return xOf(Y);
    for (let i = 1; i < placed.length; i++) {
      const p = placed[i - 1], q = placed[i];
      if (Y <= q.y) return q.y === p.y ? q.x : p.x + (Y - p.y) / (q.y - p.y) * (q.x - p.x);
    }
    return xOf(Y) + shift;
  };
  const nodes = placed.map(({ a, x, lane }, i) => `<div class="tl-node lane-${lane}" style="left:${x.toFixed(1)}px;--d:${Math.min(i, 30)}" data-action="open-album" data-key="${a.id}">
      <span class="tl-stem"></span><span class="tl-dot"></span>
      <span class="tl-cover">${a.cover ? `<img loading="lazy" decoding="async" src="${artUrl(a.cover, ART_MD)}" alt="">` : icon('disc')}</span>
      <span class="tl-label"><b>${esc(a.title)}</b>${esc(a.releaseDate ? fmtRelease(a.releaseDate) : String(a.year || ''))}<span class="tl-taste"><i></i><i></i><i></i><span class="tl-song"></span></span></span>
    </div>`);
  const step = span > 30 ? 5 : span > 14 ? 2 : 1;
  const ticks = [];
  for (let y = minY; y <= maxY; y += step) ticks.push(`<span class="tl-tick" style="left:${tickX(y).toFixed(1)}px">${y}</span>`);
  return sectionHead('Timeline') + `<div class="timeline-wrap" id="timelineWrap"><div class="timeline" style="width:${Math.round(W)}px"><div class="tl-axis"></div>${ticks.join('')}${nodes.join('')}</div></div>`;
}

/* Hover a release on the timeline for a little taste of it: after a short
   dwell (so sweeping across doesn't set anything off) the album's most-played
   song fades in quietly at its strongest stretch, and fades back out when the
   pointer moves on. Sliding to the next album crossfades between them. */
function previewTrackFor(a) {
  const ids = a.trackIds.map(id => S.byId.get(id)).filter(t => t && t.source !== 'spotify');
  if (!ids.length) return null;
  const score = (t, i) => (S.counts[t.id] || 0) * 2 + (S.liked.has(t.id) ? 3 : 0) + (t.duration >= 110 ? 1 : 0) + (i > 0 && i < 4 ? 0.5 : 0);
  return ids.map((t, i) => [t, score(t, i)]).sort((p, q) => q[1] - p[1])[0][0];
}

function wireTimelinePreview(wrap) {
  if (!wrap || S.settings.hoverPreview === false) return;
  let current = null, dwell = 0, leaveT = 0;
  const clear = node => {
    clearTimeout(dwell);
    clearTimeout(leaveT); leaveT = 0;
    if (!node) return;
    node.classList.remove('tl-loading', 'previewing');
    AudioEngine.previewStop(0.8);
  };
  const blocked = () => {
    const c = cur();
    return (typeof DJ !== 'undefined' && DJ.speaking) || AudioEngine.inBreak() || (P.playing && c && c.source === 'spotify');
  };
  const enter = node => {
    const a = S.albumById.get(node.dataset.key);
    const t = a && previewTrackFor(a);
    if (!t) return;
    const song = node.querySelector('.tl-song');
    if (song) song.textContent = t.title;
    // over a playing song, wait a little longer so passing by doesn't dip it
    dwell = setTimeout(async () => {
      if (current !== node || leaveT || blocked()) return;
      node.classList.add('tl-loading');
      const ok = await AudioEngine.previewStart(t.id, { onEnd: () => node.classList.remove('previewing') });
      node.classList.remove('tl-loading');
      if (ok && current === node) node.classList.add('previewing');
    }, P.playing ? 650 : 420);
    // start working out the good part while the pointer settles
    setTimeout(() => { if (current === node && !blocked()) AudioEngine.previewPrepare(t.id); }, 160);
  };
  wrap.addEventListener('pointerover', e => {
    const node = e.target.closest('.tl-node');
    if (node && node === current) {
      // back on the same release after brushing the gap beside it
      if (leaveT) { clearTimeout(leaveT); leaveT = 0; if (!node.classList.contains('previewing') && !node.classList.contains('tl-loading')) enter(node); }
      return;
    }
    // the empty space between covers: give the pointer a moment to reach the
    // next release so the taste (and the song under it) doesn't pump in and out
    if (!node) {
      if (current && !leaveT) leaveT = setTimeout(() => { const n = current; current = null; clear(n); }, 450);
      return;
    }
    clearTimeout(leaveT); leaveT = 0;
    // moving straight onto another album: let the new taste crossfade in
    // instead of stopping the old one first
    if (current) { clearTimeout(dwell); current.classList.remove('tl-loading', 'previewing'); if (!node) AudioEngine.previewStop(0.8); }
    current = node;
    if (node) enter(node);
  });
  wrap.addEventListener('pointerleave', () => { clear(current); current = null; });
  wrap.addEventListener('click', () => { clear(current); current = null; }, true);
}

function renderArtist(name) {
  const ar = S.artistByName.get(name);
  if (!ar) { location.hash = '#/artists'; return; }
  const albums = artistAlbums(name);
  const own = S.tracks.filter(t => t.artistKey === name);
  const features = (ar.appearsOn || []).map(id => S.byId.get(id)).filter(t => t && t.artistKey !== name);
  const popular = [...own].sort((a, b) => (S.counts[b.id] || 0) - (S.counts[a.id] || 0) || (+S.liked.has(b.id)) - (+S.liked.has(a.id))).slice(0, 10);
  // a feature-only artist owns nothing of their own to play/shuffle - fall
  // back to what they DO have here, their feature credits, so the header
  // buttons still do something instead of silently acting on an empty list.
  const allIds = own.length ? own.map(t => t.id) : features.map(t => t.id);
  const ctxAll = listCtx(allIds, name, 'artist', name);
  const ctxPop = listCtx(popular.map(t => t.id), name + ' · Popular', 'artist', name);
  const ctxFeat = listCtx(features.map(t => t.id), name + ' · Appears On', 'artist', name);
  const latest = albums.find(a => a.releaseDate);
  const img = artistImage(ar);
  const groups = [
    ['Albums', 'album', albums.filter(a => a.type === 'album')],
    ['Singles & EPs', 'single', albums.filter(a => a.type === 'single' || a.type === 'ep')],
    ['Mixtapes', 'mixtape', albums.filter(a => a.type === 'mixtape')]
  ].filter(g => g[2].length);

  const plays = own.reduce((sum, t) => sum + (S.counts[t.id] || 0), 0);
  const runtime = own.reduce((sum, t) => sum + (t.duration || 0), 0);
  const likedCount = own.filter(t => S.liked.has(t.id)).length;
  const years = albums.map(releaseYear).filter(Boolean);
  const yMin = years.length ? Math.min(...years) : null, yMax = years.length ? Math.max(...years) : null;
  const active = yMin ? (yMin === yMax ? String(yMin) : yMin + '–' + yMax) : null;
  const unreleased = albums.filter(a => a.unreleased).length;
  const stat = (val, label, count, viz) => `<div class="stat-card"${viz ? ` data-viz="${viz}"` : ''}><div class="sc-val" ${count ? `data-count="${val}"` : ''}>${count ? '0' : esc(val)}</div><div class="sc-lbl">${label}</div></div>`;

  $('#content').innerHTML = `<div class="page detail artist-page">
    <div class="sticky-bar" id="stickyBar"><div class="sb-inner">
      ${allIds.length ? `<button class="big-play small" data-action="ctx-play" data-ctx="${ctxAll}" title="Play">${icon('play')}</button>` : ''}
      <span class="sb-title">${esc(name)}</span>
    </div></div>
    <header class="detail-head artist-hero" id="detailHead">
      <div class="ah-bg">${img ? `<img src="${artUrl(img, ART_MD)}" alt="">` : ''}</div>
      <div class="ah-inner">
        <div class="ah-photo">
          <span class="ah-ring"></span>
          <div class="detail-art round drop-cover tilt" data-cover-kind="artist" data-cover-name="${esc(name)}" data-cover-id="${ar.customId || ''}" title="Drop or paste a photo here">
            ${img ? `<img src="${artUrl(img, ART_LG)}" alt="">` : initialsHTML(name)}<span class="glare"></span>
          </div>
        </div>
        <div class="detail-info">
          <div class="eyebrow ah-eyebrow">${ar.appearsOnly ? 'Featured artist' : `<span class="ah-verified">${icon('verified')}</span>Artist`}</div>
          <h1 class="ah-name">${esc(name)}</h1>
          <div class="detail-meta">${[active ? 'Active ' + active : '', `${albums.length} release${albums.length === 1 ? '' : 's'}`, `${own.length} song${own.length === 1 ? '' : 's'}`, features.length ? `${features.length} feature${features.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
    </header>
    <div class="ah-actions">
      ${allIds.length ? `<button class="big-play" data-action="ctx-play" data-ctx="${ctxAll}" title="Play">${icon('play')}</button>
      <button class="icon-btn frame lg" data-action="ctx-shuffle" data-ctx="${ctxAll}" title="Shuffle">${icon('shuffle')}</button>
      <button class="btn" data-action="artist-radio" data-artist="${esc(name)}" title="Similar songs from your library">${icon('radio')}Radio</button>` : ''}
      <button class="icon-btn frame lg" data-action="artist-menu" data-artist="${esc(name)}" title="More">${icon('dots')}</button>
    </div>
    <div class="ah-stats stagger">
      ${stat(own.length, 'Songs', true, 'songs')}
      ${stat(albums.length, 'Releases', true, 'releases')}
      ${stat(Math.round(runtime / 3600), 'Hours of music', true, 'hours')}
      ${stat(plays, 'Your plays', true, 'plays')}
      ${stat(likedCount, 'Liked', true, 'liked')}
      ${unreleased ? stat(unreleased, 'Unreleased', true, 'unreleased') : active ? stat(active, 'Years active', false, 'active') : ''}
    </div>
    <div class="ah-split ${latest ? '' : 'solo'}">
      ${popular.length ? `<section class="ah-popular">${sectionHead('Popular')}
        <div class="rows grid-popular collapsible" data-ctxkey="${ctxPop}">${popular.map((t, i) => trackRowHTML(t, i, { grid: 'popular' })).join('')}</div>
        ${popular.length > 5 ? '<button class="text-btn show-more" data-action="toggle-more">Show more</button>' : ''}
      </section>` : ''}
      ${latest ? `<section class="ah-latest">${sectionHead('Latest release')}
        <div class="latest-card" data-action="open-album" data-key="${latest.id}">
          <div class="lc-art tilt">${latest.cover ? `<img src="${artUrl(latest.cover, ART_MD)}" alt="">` : `<span class="art-ph">${icon('music')}</span>`}<span class="glare"></span>
            <button class="card-play" data-action="play-album" data-key="${latest.id}" title="Play">${icon('play')}</button></div>
          <div class="lr-date">${fmtRelease(latest.releaseDate)}${latest.unreleased ? '<span class="tag">Unreleased</span>' : ''}</div>
          <div class="lr-title">${esc(latest.title)}</div>
          <div class="lr-sub">${TYPE_LABEL[latest.type] || 'Album'} · ${latest.trackIds.length} song${latest.trackIds.length === 1 ? '' : 's'}</div>
        </div>
      </section>` : ''}
    </div>
    ${timelineHTML(albums)}
    ${groups.map(([label, type, list]) => `<div class="sec-head"><h2 class="link" data-action="open-discography" data-artist="${esc(name)}" data-type="${type}" title="See the full discography">${esc(label)}</h2><a class="see-all" data-action="open-discography" data-artist="${esc(name)}" data-type="${type}">See all</a></div><div class="hscroll stagger">${list.map(a => albumCardHTML(a, false)).join('')}</div>`).join('')}
    ${features.length ? sectionHead('Appears on') + `<div class="rows grid-simple" data-ctxkey="${ctxFeat}">${features.map((t, i) => trackRowHTML(t, i, { grid: 'simple' })).join('')}</div>` : ''}
  </div>`;

  vibrantColor(img).then(rgb => {
    const page = $('#content .artist-page');
    if (page) page.style.setProperty('--tint', rgb.join(','));
  });
  const tl = $('#timelineWrap');
  if (tl) tl.scrollLeft = tl.scrollWidth;
  wireTimelinePreview(tl);
  Fx3D.countUp($('#content'));
}

const DISCO_FILTERS = [
  ['all', 'All'], ['album', 'Albums'], ['single', 'Singles & EPs'], ['mixtape', 'Mixtapes'], ['unreleased', 'Unreleased']
];

function renderDiscography(name) {
  const ar = S.artistByName.get(name);
  if (!ar) { location.hash = '#/artists'; return; }
  const albums = artistAlbums(name);
  if (!S.discoFilter || S.discoFilter.artist !== name) S.discoFilter = { artist: name, type: 'all' };
  const groups = {
    all: albums,
    album: albums.filter(a => a.type === 'album'),
    single: albums.filter(a => a.type === 'single' || a.type === 'ep'),
    mixtape: albums.filter(a => a.type === 'mixtape'),
    unreleased: albums.filter(a => a.unreleased)
  };
  const tabs = DISCO_FILTERS.filter(([k]) => k === 'all' || groups[k].length);
  const active = groups[S.discoFilter.type] ? S.discoFilter.type : 'all';
  const list = groups[active];
  const img = artistImage(ar);
  $('#content').innerHTML = `<div class="page detail">
    <header class="detail-head artist-head compact" id="detailHead">
      <div class="detail-art round">${img ? `<img src="${artUrl(img, ART_LG)}" alt="">` : initialsHTML(name)}</div>
      <div class="detail-info">
        <div class="eyebrow">Discography</div>
        <h1>${esc(name)}</h1>
        <div class="detail-meta">${albums.length} release${albums.length === 1 ? '' : 's'}</div>
      </div>
    </header>
    <div class="tabs disco-tabs">${tabs.map(([k, label]) => `<button class="tab ${active === k ? 'on' : ''}" data-action="disco-filter" data-artist="${esc(name)}" data-type="${k}">${label}<span class="tab-count">${groups[k].length}</span></button>`).join('')}</div>
    <div class="grid-cards stagger" id="discoGrid">${list.map(a => albumCardHTML(a, false)).join('')}</div>
    ${!list.length ? '<div class="empty-state">Nothing here yet.</div>' : ''}
  </div>`;
  tintHeader(img);
}

function renderMix(genre) {
  const m = homeMixes().find(x => x.genre === genre);
  if (!m) { location.hash = '#/home'; return; }
  const list = trackList(m.ids);
  const ctx = listCtx(m.ids, genre + ' Mix', 'mix', genre);
  const total = list.reduce((s, t) => s + t.duration, 0);
  const arts = [...new Set(list.map(t => t.cover).filter(Boolean))].slice(0, 4);
  const mosaic = arts.length >= 4
    ? `<div class="mosaic">${arts.map(u => `<img src="${artUrl(u, ART_MD)}" alt="">`).join('')}</div>`
    : arts.length ? `<img src="${artUrl(arts[0], ART_LG)}" alt="">` : `<span class="art-ph big">${icon('music')}</span>`;
  $('#content').innerHTML = `<div class="page detail">
    <header class="detail-head" id="detailHead">
      <div class="detail-art">${mosaic}</div>
      <div class="detail-info">
        <div class="eyebrow">Mix</div>
        <h1>${esc(genre)} Mix</h1>
        <div class="detail-meta">${list.length} song${list.length === 1 ? '' : 's'}, ${fmtLong(total)}</div>
        <div class="detail-actions">
          <button class="btn primary" data-action="ctx-play" data-ctx="${ctx}">${icon('play')}Play</button>
          <button class="btn" data-action="ctx-shuffle" data-ctx="${ctx}">${icon('shuffle')}Shuffle</button>
          <button class="icon-btn frame" data-action="ctx-smart" data-ctx="${ctx}" title="Smart Shuffle: shuffle with suggestions woven in">${icon('sparkle')}</button>
        </div>
      </div>
    </header>
    ${list.length ? tableHeadHTML({ key: '', dir: 1 }, 'none') : ''}
    <div class="rows grid-full" data-ctxkey="${ctx}">${list.map((t, i) => trackRowHTML(t, i)).join('')}</div>
  </div>`;
  tintHeader(arts[0]);
}

function renderRecent() {
  const albums = [...S.albums].sort((a, b) => b.dateAdded - a.dateAdded);
  const latest = [...S.tracks].sort((a, b) => b.dateAdded - a.dateAdded).slice(0, 25);
  const ctx = listCtx(latest.map(t => t.id), 'Recently Added', 'list');
  $('#content').innerHTML = `<div class="page">
    <h1>Recently Added</h1>
    <div class="grid-cards stagger">${albums.map(a => albumCardHTML(a)).join('')}</div>
    ${latest.length ? sectionHead('Latest songs') + tableHeadHTML({ key: '', dir: 1 }, 'none') + `<div class="rows grid-full" data-ctxkey="${ctx}">${latest.map((t, i) => trackRowHTML(t, i)).join('')}</div>` : ''}
  </div>`;
}

function renderPlaylist(id) {
  const pl = S.playlists.find(p => p.id === id);
  if (!pl) { location.hash = '#/home'; return; }
  const entries = pl.items.map(it => ({ t: S.byId.get(it.trackId), dateMs: it.addedAt })).filter(e => e.t);
  const sort = S.plSort[id] || (S.plSort[id] = { key: 'custom', dir: 1 });
  const view = sortEntries(entries, sort);
  const ids = view.map(e => e.t.id);
  const ctx = listCtx(ids, pl.name, 'playlist', id);
  const total = entries.reduce((s, e) => s + e.t.duration, 0);
  const arts = [...new Set(entries.map(e => e.t.cover).filter(Boolean))].slice(0, 4);
  const mosaic = arts.length >= 4
    ? `<div class="mosaic">${arts.map(u => `<img src="${artUrl(u, ART_MD)}" alt="">`).join('')}</div>`
    : arts.length ? `<img src="${artUrl(arts[0], ART_LG)}" alt="">` : `<span class="art-ph big">${icon('music')}</span>`;
  const sortLabels = { custom: 'Custom order', title: 'Title', album: 'Album', date: 'Date added', duration: 'Duration' };
  $('#content').innerHTML = `<div class="page detail" data-pl="${id}">
    <header class="detail-head" id="detailHead">
      <div class="detail-art drop-cover" data-cover-kind="playlist" data-cover-id="${id}" title="Drop or paste a cover here">${pl.coverFile ? `<img src="${artUrl('/cover/' + pl.coverFile, ART_LG)}" alt="">` : mosaic}</div>
      <div class="detail-info">
        <div class="eyebrow">${pl.source === 'navidrome' ? 'NAS playlist' : 'Playlist'}</div>
        <h1 class="editable" data-action="pl-rename" title="Click to rename">${esc(pl.name)}</h1>
        <div class="detail-meta">${entries.length} song${entries.length === 1 ? '' : 's'}, ${fmtLong(total)}</div>
        <div class="detail-actions">
          <button class="btn primary" data-action="ctx-play" data-ctx="${ctx}">${icon('play')}Play</button>
          <button class="btn" data-action="ctx-shuffle" data-ctx="${ctx}">${icon('shuffle')}Shuffle</button>
          <button class="icon-btn frame" data-action="ctx-smart" data-ctx="${ctx}" title="Smart Shuffle: shuffle with suggestions woven in">${icon('sparkle')}</button>
          <button class="btn" data-action="pl-add" data-id="${id}">${icon('plus')}Add songs</button>
          <button class="icon-btn frame" data-action="pl-menu" data-id="${id}" title="More">${icon('dots')}</button>
          <span class="spacer"></span>
          <button class="btn ghost" data-action="pl-sort" data-id="${id}">${esc(sortLabels[sort.key])} ${icon('chevDown')}</button>
        </div>
      </div>
    </header>
    ${entries.length ? tableHeadHTML(sort, 'pl:' + id) : ''}
    <div class="rows grid-full ${sort.key === 'custom' ? 'draggable' : ''}" data-ctxkey="${ctx}" ${sort.key === 'custom' ? `data-reorder="pl:${id}"` : ''}>
      ${view.map((e, i) => trackRowHTML(e.t, i, { dateMs: e.dateMs, draggable: sort.key === 'custom' })).join('')}
    </div>
    ${!entries.length ? '<div class="empty-state">This playlist is empty. Hit <b>Add songs</b> or use the ⋯ menu on any track.</div>' : ''}
  </div>`;
  tintHeader(pl.coverFile ? '/cover/' + pl.coverFile : arts[0]);
}

function renderLiked() {
  const entries = [...S.liked.entries()].map(([trackId, addedAt]) => ({ t: S.byId.get(trackId), dateMs: addedAt })).filter(e => e.t);
  const sort = S.plSort.liked || (S.plSort.liked = { key: 'date', dir: -1 });
  const view = sortEntries(entries, sort);
  const ctx = listCtx(view.map(e => e.t.id), 'Liked Songs', 'liked');
  const total = entries.reduce((s, e) => s + e.t.duration, 0);
  $('#content').innerHTML = `<div class="page detail">
    <header class="detail-head" id="detailHead" style="background:linear-gradient(180deg, rgba(42,92,184,.3), transparent)">
      <div class="detail-art liked-cover">${icon('heart')}</div>
      <div class="detail-info">
        <div class="eyebrow">Playlist</div>
        <h1>Liked Songs</h1>
        <div class="detail-meta">${entries.length} song${entries.length === 1 ? '' : 's'}, ${fmtLong(total)}</div>
        <div class="detail-actions">
          <button class="btn primary" data-action="ctx-play" data-ctx="${ctx}">${icon('play')}Play</button>
          <button class="btn" data-action="ctx-shuffle" data-ctx="${ctx}">${icon('shuffle')}Shuffle</button>
          <button class="icon-btn frame" data-action="ctx-smart" data-ctx="${ctx}" title="Smart Shuffle: shuffle with suggestions woven in">${icon('sparkle')}</button>
        </div>
      </div>
    </header>
    ${entries.length ? tableHeadHTML(sort, 'pl:liked') : ''}
    <div class="rows grid-full" data-ctxkey="${ctx}">${view.map((e, i) => trackRowHTML(e.t, i, { dateMs: e.dateMs })).join('')}</div>
    ${!entries.length ? '<div class="empty-state">Songs you like end up here. Tap the heart on any track.</div>' : ''}
  </div>`;
  renderSpotifyLikedSection();
}

function renderSearch(q) {
  const shown = (q || '').trim();
  q = shown.toLowerCase();
  const tr = S.tracks.filter(t => (t.title + ' ' + t.artist + ' ' + t.album + ' ' + (t.genre || '')).toLowerCase().includes(q)).slice(0, 50);
  const al = S.albums.filter(a => (a.title + ' ' + a.artist).toLowerCase().includes(q)).slice(0, 14);
  // appearsOnly artists (feature-only credits with no track/album of their
  // own) are reachable by clicking their name on a track, not via search -
  // otherwise every one-off collaborator ever credited clutters results.
  const ar = S.artists.filter(a => !a.appearsOnly && a.name.toLowerCase().includes(q)).slice(0, 14);
  const ctx = listCtx(tr.map(t => t.id), 'Search', 'search');
  $('#content').innerHTML = `<div class="page">
    <h1>Results for \u201C${esc(shown)}\u201D</h1>
    ${ar.length ? sectionHead('Artists') + `<div class="hscroll stagger">${ar.map(artistCardHTML).join('')}</div>` : ''}
    ${al.length ? sectionHead('Albums') + `<div class="hscroll stagger">${al.map(a => albumCardHTML(a)).join('')}</div>` : ''}
    ${tr.length ? sectionHead('Songs') + tableHeadHTML({ key: '', dir: 1 }, 'none') + `<div class="rows grid-full" data-ctxkey="${ctx}">${tr.map((t, i) => trackRowHTML(t, i)).join('')}</div>` : ''}
    ${!tr.length && !al.length && !ar.length ? '<div class="empty-state">Nothing found.</div>' : ''}
  </div>`;
  if (q) { renderSpotifySearchSection(q); nasSearchSupplement(q); }
}

async function renderStats(range = '30d') {
  const seq = S.routeSeq;
  if (!S.route.arg && S.statsRange) range = S.statsRange; // keep the picked range across in-place re-renders
  const [st, ev] = await Promise.all([window.aura.statsGet(range), window.aura.statsEvents(range)]);
  if (seq !== S.routeSeq) return; // navigated elsewhere while this loaded
  const maxA = st.topArtists[0]?.ms || 1;
  const hm = ms => { const m = Math.round(ms / 60000); return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min'; };
  const recentCtx = listCtx(st.recent.map(r => r.trackId), 'Recently Played', 'list');
  const topCtx = listCtx(st.topTracks.map(x => x.id).filter(id => S.byId.has(id)), 'Top songs', 'list');
  const maxT = st.topTracks[0]?.ms || 1;
  let topIdx = 0;
  const songsHTML = st.topTracks.length ? `<div class="stat-list sv-songlist" data-ctxkey="${topCtx}">${st.topTracks.slice(0, 10).map((x, i) => {
    const t = S.byId.get(x.id); if (!t) return '';
    return `<div class="stat-row" data-action="row-play" data-id="${t.id}" data-index="${topIdx++}" title="Play" style="--p:${(x.ms / maxT).toFixed(3)}">
      <span class="rank">${i + 1}</span>
      <span class="q-art">${t.cover ? `<img loading="lazy" decoding="async" src="${artUrl(t.cover, ART_SM)}" alt="">` : icon('music')}</span>
      <span class="stat-main"><span class="q-title">${t.albumId ? `<span class="link" data-action="open-album" data-key="${t.albumId}">${esc(t.title)}</span>` : esc(t.title)}</span><span class="q-sub">${artistCreditsHTML(t)} · ${x.plays} play${x.plays === 1 ? '' : 's'}</span></span>
      <span class="stat-time">${hm(x.ms)}</span></div>`;
  }).join('')}</div>` : '<div class="sv-empty">No songs played in this range yet.</div>';
  const restHTML = `
    ${st.topArtists.length ? sectionHead('Top artists') + `<div class="stat-list">${st.topArtists.map((x, i) =>
      `<div class="stat-row" data-action="open-artist" data-artist="${esc(x.name)}">
        <span class="rank">${i + 1}</span>
        <span class="stat-main"><span class="q-title">${esc(x.name)}</span>
          <span class="bar"><span style="width:${Math.round(x.ms / maxA * 100)}%"></span></span></span>
        <span class="stat-time">${hm(x.ms)}</span></div>`).join('')}</div>` : ''}
    ${st.recent.length ? sectionHead('Recently played') + `<div class="two-col rows" data-ctxkey="${recentCtx}">${st.recent.map((r, i) => { const t = S.byId.get(r.trackId); return t ? trackRowHTML(t, i, { grid: 'simple' }) : ''; }).join('')}</div>` : ''}`;
  const c = $('#content');
  const page = c.querySelector('.sv-page');
  if (page) { // range switch or in-place re-render: keep the charts and morph them
    page.querySelector('.sv-songs-body').innerHTML = songsHTML;
    page.querySelector('.sv-rest').innerHTML = restHTML;
    StatsViz.update(page, st, ev, range);
    return;
  }
  c.innerHTML = `<div class="page sv-page">
    <div class="page-head sv-head"><h1>Stats</h1>${StatsViz.tabsHTML(range)}</div>
    ${StatsViz.shellHTML()}
    <div class="sv-rest">${restHTML}</div>
  </div>`;
  const pg = c.querySelector('.sv-page');
  pg.querySelector('.sv-songs-body').innerHTML = songsHTML;
  StatsViz.mount(pg, st, ev, range);
}

/* ---------- appearance + behaviour prefs that apply outside the Settings page ---------- */

// [text/icon accent, fill behind white text, fill hover]
const ACCENTS = {
  blue: ['#6aa5ff', '#2b6fdf', '#3479ea'],
  purple: ['#b18cff', '#7446e0', '#7f52ea'],
  pink: ['#ff7eb6', '#d63b7f', '#e04689'],
  red: ['#ff7a70', '#d23c32', '#dd473d'],
  orange: ['#ffa45c', '#c85f16', '#d56a20'],
  green: ['#5fd98a', '#1f9d55', '#25a95d'],
  teal: ['#4fd6d0', '#178f8a', '#1c9b95']
};
const LYRICS_ZOOM = { s: 0.85, m: 1, l: 1.2, xl: 1.4 };
const hexRGB = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

function setAccentVars(accent, fill, hover, rgb) {
  const r = document.documentElement.style;
  r.setProperty('--accent', accent);
  r.setProperty('--accent-fill', fill);
  r.setProperty('--accent-fill-hover', hover);
  r.setProperty('--accent-soft', `rgba(${rgb.join(',')}, .12)`);
}
// "Match album art": the cover's vibrant colour, with darker fills so white text stays readable
function setAccentRGB(rgb) {
  if (!rgb) return;
  const shade = k => `rgb(${rgb.map(v => Math.round(v * k)).join(',')})`;
  setAccentVars(`rgb(${rgb.join(',')})`, shade(0.58), shade(0.66), rgb);
}

function applyPrefs(st) {
  const root = document.documentElement;
  if (st.accent === 'album') {
    const t = typeof cur === 'function' && cur();
    vibrantColor(t && t.cover).then(rgb => { if (S.settings.accent === 'album') setAccentRGB(rgb); });
  } else {
    const [a, f, h] = ACCENTS[st.accent] || ACCENTS.blue;
    setAccentVars(a, f, h, hexRGB(a));
  }
  const rm = st.reduceMotion === 'on' || (st.reduceMotion !== 'off' && Fx3D.systemReduceMotion);
  Fx3D.setReduceMotion(rm);
  root.classList.toggle('reduce-motion', rm);
  root.style.setProperty('--lyr-zoom', LYRICS_ZOOM[st.lyricsSize] || 1);
  const fxOff = st.npVisuals === false;
  root.classList.toggle('no-np-fx', fxOff);
  if (fxOff || rm) { const w = $('#npArtWrap'); if (w) w.style.transform = ''; }
}

// Save one preference and apply whatever it changes right away.
function setPref(key, value) {
  S.settings[key] = value;
  window.aura.settingsSet({ [key]: value });
  switch (key) {
    case 'fadePause': AudioEngine.setOpts({ fadePause: value !== false }); break;
    case 'monoAudio': AudioEngine.setOpts({ mono: !!value }); break;
    case 'showRemaining': { const p = Playback.pos(); if (Playback.hasTrack()) updateProgressUI(p.t, p.dur); break; }
    case 'accent': case 'reduceMotion': case 'npVisuals': case 'lyricsSize': applyPrefs(S.settings); break;
  }
}

function setZoom(z) {
  z = Math.round(Math.max(0.7, Math.min(1.6, z)) * 100) / 100;
  setPref('zoom', z);
  toast('Zoom ' + Math.round(z * 100) + '%');
  const sel = $('#setZoom');
  if (sel) sel.value = String(z);
}

/* ---------- keyboard shortcuts reference ---------- */

function shortcutList() {
  const seek = S.settings.seekStep || 5, vol = S.settings.volumeStep || 5;
  return [
    ['Playback', [
      ['Space', 'Play / pause'], ['Ctrl →', 'Next song'], ['Ctrl ←', 'Previous song'],
      ['→ / ←', `Seek ${seek}s forward / back`], ['↑ / ↓', `Volume up / down ${vol}%`],
      ['M', 'Mute'], ['S', 'Shuffle'], ['R', 'Repeat'], ['L', 'Like the playing song']
    ]],
    ['Views', [
      ['N', 'Now Playing'], ['Q', 'Queue'], ['Y', 'Lyrics'], ['Ctrl K  or  /', 'Search'],
      ['Alt ← / Alt →', 'Back / forward'], ['Ctrl ,', 'Settings'], ['?', 'This list'], ['Esc', 'Close whatever is open']
    ]],
    ['Window', [
      ['Ctrl +  or  Ctrl −', 'Zoom in / out'], ['Ctrl 0', 'Reset zoom'],
      ['Media keys', 'Play/pause, next, previous (works from any app)']
    ]]
  ];
}
const shortcutsHTML = () => shortcutList().map(([group, rows]) =>
  `<div class="kbd-group"><div class="kbd-head">${group}</div>${rows.map(([k, l]) =>
    `<div class="kbd-row"><span>${esc(l)}</span><span class="kbd-keys">${k.split(/\s{2,}/).map(part => part === 'or' ?`<span class="kbd-or">${part}</span>` : `<kbd>${esc(part)}</kbd>`).join(' ')}</span></div>`).join('')}</div>`).join('');

function shortcutsModal() {
  openModal(`<h3>Keyboard shortcuts</h3><div class="kbd-grid">${shortcutsHTML()}</div>
    <div class="modal-actions"><button class="btn primary" data-action="modal-close">Done</button></div>`, true);
}

/* ---------- Settings page ---------- */

const START_PAGES = [['home', 'Home'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['liked', 'Liked Songs'], ['stats', 'Stats'], ['last', 'Where I left off']];

async function renderSettings() {
  const seq = S.routeSeq;
  const st = await window.aura.settingsGet();
  S.settings = st;
  const [oll, ttsState, def] = await Promise.all([window.aura.ollamaStatus(), window.aura.ttsStatus(), window.aura.defaultFolder(), nasPrefetchSettings()]);
  // the Ollama check can take a moment: don't paint Settings over a page opened meanwhile
  if (seq !== S.routeSeq) return;
  const folders = (st.musicFolders || []).map(f =>
    `<div class="folder-row"><span class="folder-path">${esc(f)}</span><button class="icon-btn" data-action="rm-folder" data-folder="${esc(f)}" title="Remove">${icon('x')}</button></div>`).join('');
  const toggle = (id, on) => `<button class="switch ${on ? 'on' : ''}" id="${id}" role="switch" aria-checked="${on}"><span></span></button>`;
  // generic controls: data-set names the settings key, wired once below
  const pref = (key, on) => `<button class="switch ${on ? 'on' : ''}" data-set="${key}" role="switch" aria-checked="${on}"><span></span></button>`;
  const choice = (key, value, options, id) => `<select class="select" data-set="${key}"${id ? ` id="${id}"` : ''}>${options.map(([v, l]) =>
    `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const row = (label, sub, ctl) => `<div class="set-row"><div><div class="set-lbl">${label}</div>${sub ? `<div class="muted">${sub}</div>` : ''}</div>${ctl}</div>`;
  const accent = st.accent || 'blue';

  $('#content').innerHTML = `<div class="page settings">
    <div class="set-top">
      <h1>Settings</h1>
      <div class="set-search">${icon('search')}<input id="setSearch" type="text" placeholder="Search settings" autocomplete="off" spellcheck="false" value="${esc(S.settingsFilter || '')}"></div>
    </div>
    <div class="set-nomatch muted" id="setNoMatch" hidden>No settings match that.</div>

    <h2 class="set-h">Library</h2>
    <div class="set-card">
      ${folders || '<div class="muted set-row">No folders yet.</div>'}
      <div class="set-row"><button class="btn" data-action="add-folder">${icon('plus')}Add folder</button>
      <button class="btn ghost" data-action="rescan">Rescan library</button></div>
      <div class="set-row"><div><div class="set-lbl">${def.active ? 'Default Aura folder' : 'Use the default Aura folder'}</div><div class="muted">${esc(def.path)}${def.active ? ' · organized as Artist / Album' : ''}</div></div>
        ${def.active ? '<span class="dot ok"></span>' : `<button class="btn small" data-action="use-default-folder">Add it</button>`}</div>
      ${row('Import songs', 'Pick files from anywhere, Aura sorts them into Artist / Album folders and adds them to your library', `<button class="btn small" data-action="import-songs">${icon('plus')}Import songs…</button>`)}
      ${row('Watch folders for changes', 'Songs added, edited or deleted in your music folders show up on their own, no Rescan needed', pref('watchFolders', st.watchFolders !== false))}
      ${row('Fetch missing artwork online', 'Looks up cover art for releases with no embedded image (iTunes lookup, cached once found)', toggle('setFetchArt', st.fetchArt !== false))}
    </div>

    <h2 class="set-h">Playback</h2>
    <div class="set-card">
      <div class="set-row"><div><div class="set-lbl">Crossfade</div><div class="muted">Songs blend into each other</div></div>
        <div class="set-ctl"><input type="range" class="slider" id="setFade" min="0" max="12" step="1" value="${st.crossfade ?? 5}"><span class="muted" id="setFadeVal">${st.crossfade ?? 5}s</span></div></div>
      ${row('Automix', 'Skip quiet outros and start the blend early, DJ style', toggle('setAutomix', st.automix !== false))}
      ${row('Match volume between songs', "Evens out loud and quiet masters so crossfades don't jump in volume", toggle('setNormalize', st.normalize !== false))}
      ${row('Smooth pause and resume', 'A quick fade instead of a hard cut. The sleep timer also fades out gently.', pref('fadePause', st.fadePause !== false))}
      ${row('Autoplay', 'Keep playing similar songs when a list, album or playlist runs out', toggle('setAutoplay', st.autoplay !== false))}
      ${row('Resume playing on launch', 'Pick up where you left off and start playing right away, instead of waiting paused', pref('resumeOnLaunch', !!st.resumeOnLaunch))}
      ${row('Previous button', 'What Previous does once a song is already playing', choice('prevRestartSec', st.prevRestartSec ?? 3, [[3, 'Restart after 3 seconds'], [10, 'Restart after 10 seconds'], [0, 'Always go back a song']]))}
      ${row('Mono audio', 'Both ears get the full mix, handy with one earbud', pref('monoAudio', !!st.monoAudio))}
      ${row('Arrow key seek', '← and → jump by', choice('seekStep', st.seekStep || 5, [[5, '5 seconds'], [10, '10 seconds'], [15, '15 seconds'], [30, '30 seconds']]))}
      ${row('Arrow key volume', '↑ and ↓ change volume by', choice('volumeStep', st.volumeStep || 5, [[2, '2%'], [5, '5%'], [10, '10%']]))}
      ${row('Auto-fetch lyrics online', 'Looks up LRCLIB automatically for songs with no embedded or saved lyrics', toggle('setAutoLyrics', st.autoLyrics !== false))}
      ${row('Preview albums on hover', "Hovering a release on an artist's timeline plays a quiet taste of its best part", toggle('setHoverPreview', st.hoverPreview !== false))}
    </div>

    <h2 class="set-h">Appearance</h2>
    <div class="set-card">
      ${row('Accent colour', 'Buttons, sliders and the playing song', `<div class="swatches">${Object.entries(ACCENTS).map(([k, [a]]) =>
        `<button class="swatch ${accent === k ? 'on' : ''}" data-action="set-accent" data-accent="${k}" style="background:${a}" title="${k[0].toUpperCase() + k.slice(1)}"></button>`).join('')}
        <button class="swatch album ${accent === 'album' ? 'on' : ''}" data-action="set-accent" data-accent="album" title="Match album art"></button></div>`)}
      ${row('Zoom', 'Makes everything bigger or smaller (Ctrl + / Ctrl −)', choice('zoom', st.zoom || 1, [[0.8, '80%'], [0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%'], [1.5, '150%']].concat([0.8, 0.9, 1, 1.1, 1.25, 1.5].includes(st.zoom || 1) ? [] : [[st.zoom, Math.round(st.zoom * 100) + '%']]), 'setZoom'))}
      ${row('Open on', 'The page Aura shows when it starts', choice('startPage', st.startPage || 'home', START_PAGES))}
      ${row('Reduce motion', 'Calms the 3D effects, tilts and animations', choice('reduceMotion', st.reduceMotion || 'system', [['system', 'Match Windows'], ['on', 'On'], ['off', 'Off']]))}
      ${row('Now Playing visuals', 'The moving backdrop in the cover colors, with light and rings that follow the music. Turn off to save battery.', pref('npVisuals', st.npVisuals !== false))}
      ${row('Lyrics size', '', choice('lyricsSize', st.lyricsSize || 'm', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Extra large']]))}
      ${row('Show time remaining', 'The player bar counts down instead of showing the song length (or click the time)', pref('showRemaining', !!st.showRemaining))}
    </div>

    <h2 class="set-h">DJ</h2>
    <div class="set-card">
      <div class="set-row"><div><div class="set-lbl">Ollama</div><div class="muted" id="ollStatus">${oll.running ? 'Connected · writing lines with ' + esc(oll.model || 'auto') : 'Not running'}</div></div>
        <div class="set-ctl"><span class="dot ${oll.running ? 'ok' : ''}"></span><button class="btn small" data-action="launch-ollama">Launch</button></div></div>
      ${row('Launch Ollama with Aura', 'Starts ollama serve on boot and warms the model', toggle('setAutoOllama', st.autoLaunchOllama !== false))}
      ${row('DJ model', 'Which local model writes the lines', `<select id="setModel" class="select"><option>${esc(st.djModel || 'auto')}</option></select>`)}
      ${row('DJ voice', 'Speaks between segments', toggle('setDjVoice', st.djVoiceEnabled !== false))}
      ${row('Voice', 'Kokoro voice, ranked by training quality (A best)', `<select id="setDjVoicePick" class="select">${KOKORO_VOICES.map(([id, grade]) => `<option value="${id}" ${(st.djVoice || 'af_heart') === id ? 'selected' : ''}>${id} (${grade})</option>`).join('')}</select>`)}
      <div class="set-row"><div><div class="set-lbl">Kokoro voice engine</div><div class="muted" id="ttsStatus">${ttsState === 'ready' ? 'Ready, fully local' : ttsState === 'standby' ? 'Ready, loads when the DJ talks' : ttsState === 'loading' ? 'Downloading model…' : ttsState === 'failed' ? 'Unavailable, using system voices' : 'Downloads on first use (~300 MB, one time)'}</div></div>
        <button class="btn small" data-action="dl-voice">${ttsState === 'ready' ? 'Loaded' : ttsState === 'standby' ? 'Load now' : 'Download now'}</button></div>
      ${row('Talk every', 'Tracks between DJ lines', `<select id="setEvery" class="select">${[3, 4, 5, 6].map(n => `<option value="${n}" ${st.djEvery === n ? 'selected' : ''}>${n} tracks</option>`).join('')}</select>`)}
    </div>

    ${nasSettingsHTML()}

    ${spotifySettingsHTML()}

    <h2 class="set-h">App and window</h2>
    <div class="set-card">
      ${row('Launch Aura when Windows starts', 'Signs in with you, so your music is one media key away', pref('openAtLogin', !!st.openAtLogin))}
      ${row('Start hidden in the tray', 'When launched at sign-in, stay in the tray instead of opening the window', pref('startHidden', !!st.startHidden))}
      ${row('Closing the window', 'What the X button does', choice('closeToTray', st.closeToTray !== false ? 'tray' : 'quit', [['tray', 'Keep playing in the tray'], ['quit', 'Quit Aura']]))}
      ${row('Media keys', 'Play/pause, next and previous keys control Aura from any app', pref('mediaKeys', st.mediaKeys !== false))}
      ${row('Song change notifications', "A Windows notification when the song changes while Aura isn't in front", pref('notifyTrackChange', !!st.notifyTrackChange))}
      ${row('Mini player', 'Small window with the essentials', `<button class="btn small" data-action="open-mini">Open</button>`)}
      ${row('Keep mini player on top', 'Stays above other windows', pref('miniOnTop', st.miniOnTop !== false))}
    </div>

    <h2 class="set-h">Keyboard shortcuts</h2>
    <div class="set-card kbd-card">
      <div class="kbd-grid">${shortcutsHTML()}</div>
    </div>

    <h2 class="set-h">Data and maintenance</h2>
    <div class="set-card">
      ${row('Back up your data', 'Playlists, likes, custom albums, stats and lyrics - saved to a folder you pick. Your music files are never touched or copied.', `<button class="btn small" data-action="backup-data">Back up…</button>`)}
      ${row('Open data folder', "Where Aura keeps playlists, edits, stats and covers", `<button class="btn small" data-action="open-data-folder">Open</button>`)}
      ${row('Reload everything', "Re-reads your library and all saved data from disk - use this after editing tags, files or Aura's data folder outside the app", `<button class="btn small" data-action="reload-all">${icon('refresh')}Reload</button>`)}
      ${row('Clear downloaded lyrics', 'Forgets lyrics fetched from LRCLIB so they are looked up fresh. Lyrics you typed or edited are kept.', `<button class="btn small" data-action="clear-lyrics">Clear</button>`)}
      ${row('Re-measure loudness', 'Forgets volume matching and silence detection, so every song is measured again as it plays', `<button class="btn small" data-action="clear-loudness">Reset</button>`)}
      ${row('Reset listening stats', 'Clears play counts, history, Stats and what Made For You learns from', `<button class="btn small ghost danger" data-action="reset-stats">Reset…</button>`)}
      ${row('Restore default settings', 'Every preference on this page goes back to default. Folders, playlists and likes are untouched.', `<button class="btn small ghost danger" data-action="reset-settings">Restore…</button>`)}
      ${row('Quit Aura', 'Fully exits, instead of staying in the tray', `<button class="btn small" data-action="quit-app">Quit</button>`)}
      ${row('Aura 1.0', 'Your edits live in Aura\'s data folder. Files are never modified unless you use Write tags.', '')}
    </div>
  </div>`;

  $('#setFade').addEventListener('input', e => {
    const v = +e.target.value;
    $('#setFadeVal').textContent = v + 's';
    AudioEngine.setOpts({ crossfade: v });
    window.aura.settingsSet({ crossfade: v });
  });
  wireSwitch('setAutomix', on => { AudioEngine.setOpts({ automix: on }); window.aura.settingsSet({ automix: on }); });
  wireSwitch('setNormalize', on => { AudioEngine.setOpts({ normalize: on }); window.aura.settingsSet({ normalize: on }); });
  wireSwitch('setFetchArt', on => { S.settings.fetchArt = on; window.aura.settingsSet({ fetchArt: on }); if (on) queueMissingArt(); });
  wireSwitch('setAutoLyrics', on => { S.settings.autoLyrics = on; window.aura.settingsSet({ autoLyrics: on }); });
  wireSwitch('setHoverPreview', on => { S.settings.hoverPreview = on; window.aura.settingsSet({ hoverPreview: on }); });
  wireSwitch('setAutoplay', on => { S.settings.autoplay = on; window.aura.settingsSet({ autoplay: on }); });
  wireSwitch('setAutoOllama', on => window.aura.settingsSet({ autoLaunchOllama: on }));
  wireSwitch('setDjVoice', on => { S.settings.djVoiceEnabled = on; window.aura.settingsSet({ djVoiceEnabled: on }); });
  $('#setDjVoicePick').addEventListener('change', e => { S.settings.djVoice = e.target.value; window.aura.settingsSet({ djVoice: e.target.value }); });
  $('#setEvery').addEventListener('change', e => { S.settings.djEvery = +e.target.value; window.aura.settingsSet({ djEvery: +e.target.value }); });

  for (const el of $$('#content .switch[data-set]')) {
    el.addEventListener('click', () => {
      const on = !el.classList.contains('on');
      el.classList.toggle('on', on);
      el.setAttribute('aria-checked', on);
      setPref(el.dataset.set, on);
    });
  }
  for (const el of $$('#content select[data-set]')) {
    el.addEventListener('change', () => {
      const key = el.dataset.set, raw = el.value;
      if (key === 'closeToTray') setPref(key, raw === 'tray');
      else setPref(key, /^-?\d+(\.\d+)?$/.test(raw) ? +raw : raw);
    });
  }

  const search = $('#setSearch');
  search.addEventListener('input', () => { S.settingsFilter = search.value; filterSettings(); });
  filterSettings();

  window.aura.ollamaModels().then(models => {
    if (!models.length) return;
    const sel = $('#setModel');
    if (!sel) return;
    sel.innerHTML = models.map(m => `<option value="${esc(m.name)}" ${m.name === st.djModel ? 'selected' : ''}>${esc(m.name)}${m.parameterSize ? ' (' + esc(m.parameterSize) + ')' : ''}</option>`).join('');
    sel.addEventListener('change', e => { S.settings.djModel = e.target.value; window.aura.settingsSet({ djModel: e.target.value, djModelChosen: true }); });
  });
}

// Hides rows (and whole sections) that don't mention every typed word; a
// section whose heading matches stays whole.
function filterSettings() {
  const words = (S.settingsFilter || '').toLowerCase().split(/\s+/).filter(Boolean);
  let any = false;
  for (const h of $$('#content .settings .set-h')) {
    const card = h.nextElementSibling;
    if (!card || !card.classList.contains('set-card')) continue;
    const headHit = words.length && words.every(w => h.textContent.toLowerCase().includes(w));
    let shown = 0;
    for (const r of card.querySelectorAll('.set-row, .kbd-row, .folder-row, .sp-set, .set-card > *:not(.set-row)')) {
      const hit = !words.length || headHit || words.every(w => r.textContent.toLowerCase().includes(w));
      r.classList.toggle('filtered', !hit);
      if (hit) shown++;
    }
    for (const g of card.querySelectorAll('.kbd-group')) g.classList.toggle('filtered', !g.querySelector('.kbd-row:not(.filtered)'));
    const hide = words.length && !shown;
    h.classList.toggle('filtered', !!hide);
    card.classList.toggle('filtered', !!hide);
    if (!hide) any = true;
  }
  const nm = $('#setNoMatch');
  if (nm) nm.hidden = any || !words.length;
}

function wireSwitch(id, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', () => {
    const on = !el.classList.contains('on');
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', on);
    cb(on);
  });
}

async function tintHeader(coverUrl) {
  const h = $('#detailHead');
  if (!h || !coverUrl) return;
  const [r, g, b] = await vibrantColor(coverUrl);
  const hh = $('#detailHead');
  if (!hh) return;
  hh.style.background = `radial-gradient(120% 140% at 0% 0%, rgba(${r},${g},${b},.34), transparent 60%), linear-gradient(180deg, rgba(${r},${g},${b},.18), transparent)`;
  const page = hh.closest('.page');
  if (page) page.style.setProperty('--tint', `${r},${g},${b}`);
}

/* ---------- context menu ---------- */

let menuActs = [];
/* items: { label, act, icon?, danger? } | { sep: true } | { head, sub?, cover?, round? } */
function showMenu(x, y, items) {
  const m = $('#ctxMenu');
  items = items.filter(Boolean);
  // no leading/trailing/double separators when optional items dropped out
  items = items.filter((it, i) => !it.sep || (i > 0 && i < items.length - 1 && !items[i - 1].sep && !items[i - 1].head));
  menuActs = items.map(i => i.act);
  m.innerHTML = items.map((i, idx) => {
    if (i.sep) return '<div class="menu-sep"></div>';
    if (i.head) return `<div class="menu-head">${i.cover ? `<img class="${i.round ? 'round' : ''}" src="${artUrl(i.cover, ART_SM)}" alt="">` : `<span class="menu-head-ph">${icon(i.headIcon || 'music')}</span>`}<div class="menu-head-meta"><div class="menu-head-title">${esc(i.head)}</div>${i.sub ? `<div class="menu-head-sub">${esc(i.sub)}</div>` : ''}</div></div>`;
    return `<button class="menu-item ${i.danger ? 'danger' : ''}" data-action="menu-item" data-mi="${idx}">${i.icon ? icon(i.icon) : '<span class="ic"></span>'}<span>${esc(i.label)}</span></button>`;
  }).join('');
  m.classList.remove('hidden', 'open');
  const r = m.getBoundingClientRect();
  const left = Math.max(10, Math.min(x, innerWidth - r.width - 10));
  const top = Math.max(10, Math.min(y, innerHeight - r.height - 10));
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  m.style.transformOrigin = `${x > left + r.width / 2 ? 'right' : 'left'} ${y > top + r.height / 2 ? 'bottom' : 'top'}`;
  requestAnimationFrame(() => m.classList.add('open'));
}
function hideMenu() { const m = $('#ctxMenu'); m.classList.remove('open'); m.classList.add('hidden'); menuActs = []; }

const goArtist = name => navigate('#/artist/' + encodeURIComponent(name));

function openTrackMenu(x, y, trackId) {
  const t = S.byId.get(trackId);
  if (!t) return;
  if (t.source === 'spotify') { openSpotifyTrackMenu(x, y, t); return; }
  const artists = (t.artists && t.artists.length ? t.artists : [t.artistKey]).filter(Boolean);
  const items = [
    { head: t.title, sub: t.artist + (t.album ? ' · ' + t.album : ''), cover: t.cover },
    { label: 'Play next', icon: 'playNext', act: () => queueNext(trackId) },
    { label: 'Add to queue', icon: 'listPlus', act: () => queueAdd(trackId) },
    { label: 'Start song radio', icon: 'radio', act: () => startRadio([trackId], t.title) },
    { sep: true },
    { label: S.liked.has(trackId) ? 'Remove from Liked Songs' : 'Add to Liked Songs', icon: 'heart', act: () => toggleLike(trackId) },
    { label: 'Add to playlist…', icon: 'plus', act: () => addToPlaylistModal([trackId]) },
    { sep: true },
    t.albumId ? { label: 'Go to album', icon: 'disc', act: () => navigate('#/album/' + t.albumId) } : null,
    ...artists.map(n => ({ label: artists.length > 1 ? 'Go to ' + n : 'Go to artist', icon: 'user', act: () => goArtist(n) })),
    { label: 'Copy song info', icon: 'copy', act: () => navigator.clipboard.writeText(`${t.title} - ${t.artist}${t.album ? ' (' + t.album + ')' : ''}`).then(() => toast('Copied to clipboard'), () => toast('Could not copy')) },
    { sep: true },
    t.source === 'navidrome' ? null : { label: 'Edit tags', icon: 'edit', act: () => tagEditorModal(t) },
    { label: 'Edit lyrics', icon: 'mic', act: () => lyricsEditModal(t) }
  ];
  // Bonus tracks are auto-attached to an album by folder heuristics (see
  // library.js attachBonusTracks) - let a misfire be corrected with one
  // click instead of forcing a trip through Edit tags. The override just
  // clears the badge; the track stays on the album it was matched to (use
  // Edit tags' Album field to move it elsewhere entirely).
  if (t.bonus) items.push({ label: 'Not a bonus track', icon: 'x', act: async () => { await refreshLibrary(await window.aura.overrideTrack(t.id, { bonus: false })); route(); markPlayingRows(); toast('No longer marked as bonus'); } });
  items.push({ sep: true });
  const page = $('#content .page');
  const plId = page && page.dataset.pl;
  if (plId) items.push({ label: 'Remove from this playlist', icon: 'x', danger: true, act: async () => { await window.aura.plRemove(plId, trackId); await refreshPlaylists(); route(); } });
  const albumId = page && page.dataset.album;
  if (albumId && page.dataset.custom === '1') {
    items.push({ label: 'Remove from this album', icon: 'x', danger: true, act: async () => {
      const a = S.albumById.get(albumId);
      await refreshLibrary(await window.aura.albumSetTracks(albumId, a.trackIds.filter(id => id !== trackId)));
      route();
    }});
  }
  if (t.source !== 'navidrome') items.push({ label: 'Delete from disk', icon: 'trash', danger: true, act: () => {
    confirmModal('Delete this song?', `"${t.title}" will be moved to the Recycle Bin. This can't be undone from inside Aura.`, 'Delete', async () => {
      const res = await window.aura.deleteTrackFile(trackId);
      if (!res.ok) { toast(res.error || 'Could not delete file'); return; }
      await window.aura.rescan();
      await refreshLibrary();
      route();
      toast('Deleted, moved to Recycle Bin');
    });
  } });
  showMenu(x, y, items);
}

function playAlbum(a, shuffle) {
  if (!a || !a.trackIds.length) return;
  P.smart = false; P.shuffle = !!shuffle;
  playFrom(a.trackIds, shuffle ? Math.floor(Math.random() * a.trackIds.length) : 0, { name: a.title, sourceType: 'album', sourceId: a.id });
  syncControls();
}

function playArtist(name, shuffle) {
  const ids = S.tracks.filter(t => t.artistKey === name).map(t => t.id);
  if (!ids.length) return;
  P.smart = false; P.shuffle = !!shuffle;
  playFrom(ids, shuffle ? Math.floor(Math.random() * ids.length) : 0, { name, sourceType: 'artist', sourceId: name });
  syncControls();
}

// onPage: opened from that album's own page, so "Go to album" is pointless there
function openAlbumMenu(x, y, a, onPage) {
  if (!a) return;
  const ids = a.trackIds.filter(id => S.byId.has(id));
  const has = ids.length > 0;
  showMenu(x, y, [
    { head: a.title, sub: [a.artist, TYPE_LABEL[a.type]].filter(Boolean).join(' · '), cover: a.cover, headIcon: 'disc' },
    has ? { label: 'Play', icon: 'play', act: () => playAlbum(a, false) } : null,
    has ? { label: 'Shuffle', icon: 'shuffle', act: () => playAlbum(a, true) } : null,
    has ? { label: 'Play next', icon: 'playNext', act: () => queueNextMany(ids, a.title) } : null,
    has ? { label: 'Add to queue', icon: 'listPlus', act: () => queueAddMany(ids, a.title) } : null,
    has ? { label: 'Start album radio', icon: 'radio', act: () => startRadio(ids, a.title) } : null,
    { sep: true },
    has ? { label: 'Add to playlist…', icon: 'plus', act: () => addToPlaylistModal(ids) } : null,
    onPage ? null : { label: 'Go to album', icon: 'disc', act: () => navigate('#/album/' + a.id) },
    { label: 'Go to artist', icon: 'user', act: () => goArtist(a.artist) },
    { label: 'Discography', icon: 'grid', act: () => navigate('#/discography/' + encodeURIComponent(a.artist)) },
    ...nasAlbumMenuItems(a),
    { sep: true },
    { label: 'Edit album', icon: 'edit', act: () => albumEditorModal(a) },
    { label: 'Add songs to album', icon: 'listPlus', act: () => a.custom ? addSongsModal('album', a.id) : toast('Only manual albums can take extra songs. Create one via New album.') },
    a.source === 'navidrome' ? null : { label: 'Import songs…', icon: 'plus', act: () => importSongsInto({ artist: a.artist, album: a.title }) },
    a.source === 'navidrome' ? null : { label: 'Fix tags…', icon: 'tag', act: () => albumFixTagsModal(a) },
    a.custom ? { sep: true } : null,
    a.custom ? { label: 'Delete album (keeps files)', icon: 'trash', danger: true, act: () => deleteCustomAlbum(a) } : null
  ]);
}

function openArtistMenu(x, y, name, onPage) {
  const ar = S.artistByName.get(name);
  const ids = S.tracks.filter(t => t.artistKey === name).map(t => t.id);
  showMenu(x, y, [
    { head: name, sub: ar ? `${ar.trackCount} song${ar.trackCount === 1 ? '' : 's'}` : '', cover: ar && artistImage(ar), round: true, headIcon: 'user' },
    ids.length ? { label: 'Play', icon: 'play', act: () => playArtist(name, false) } : null,
    ids.length ? { label: 'Shuffle', icon: 'shuffle', act: () => playArtist(name, true) } : null,
    ids.length ? { label: 'Start artist radio', icon: 'radio', act: () => startRadio(ids, name) } : null,
    { sep: true },
    onPage ? null : { label: 'Go to artist', icon: 'user', act: () => goArtist(name) },
    { label: 'Discography', icon: 'grid', act: () => navigate('#/discography/' + encodeURIComponent(name)) },
    { sep: true },
    { label: 'New album…', icon: 'plus', act: () => albumEditorModal(null, { artist: name }) },
    { label: 'Import songs…', icon: 'listPlus', act: () => importSongsForArtist(name) },
    { label: 'Edit artist photo', icon: 'image', act: () => artistEditorModal(name) }
  ]);
}

/* ---------- modals ---------- */

let modalSave = null;
function openModal(html, wide) {
  const m = $('#modal');
  clearTimeout(m._closeT); // a close still animating out must not wipe this one
  m.innerHTML = `<div class="modal-backdrop" data-action="modal-close"></div><div class="modal-card ${wide ? 'wide' : ''}">${html}</div>`;
  m.classList.remove('hidden');
  requestAnimationFrame(() => m.classList.add('open'));
  const inp = m.querySelector('input[type="text"],input:not([type]),textarea');
  if (inp) { inp.focus(); if (inp.select) inp.select(); }
}
function closeModal() {
  const m = $('#modal');
  m.classList.remove('open');
  modalSave = null;
  clearTimeout(m._closeT);
  m._closeT = setTimeout(() => { m.classList.add('hidden'); m.innerHTML = ''; }, 180);
  if (['playlist', 'album', 'artist', 'spplaylist'].includes(S.route.name)) route();
}
function promptModal(title, value, cb, placeholder) {
  modalSave = cb;
  openModal(`<h3>${esc(title)}</h3>
    <input id="modalInput" type="text" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}" />
    <div class="modal-actions"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn primary" data-action="modal-save">Save</button></div>`);
  $('#modalInput').addEventListener('keydown', e => { if (e.key === 'Enter') doModalSave(); });
}
function doModalSave() {
  const cb = modalSave;
  const v = $('#modalInput') ? $('#modalInput').value.trim() : null;
  closeModal();
  if (cb) cb(v);
}

/* A destructive action that can't just be an "Undo" toast on its own (the
   confirm step stops a stray click; the caller is still expected to offer
   an undo toast afterward wherever the delete is actually recoverable). */
function confirmModal(title, message, confirmLabel, onConfirm) {
  modalSave = null;
  openModal(`<h3>${esc(title)}</h3>
    <div class="muted pad-b">${esc(message)}</div>
    <div class="modal-actions"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn ghost danger" id="modalConfirm">${esc(confirmLabel || 'Delete')}</button></div>`);
  $('#modalConfirm').addEventListener('click', () => { closeModal(); onConfirm(); });
}

let pendingAdd = null;
function addToPlaylistModal(ids) {
  pendingAdd = ids;
  // a NAS playlist can only hold NAS songs
  const list = S.playlists.filter(p => p.source !== 'navidrome' || ids.some(id => String(id).startsWith('nd:')))
    .map(p => `<button class="menu-item" data-action="atp" data-pl="${p.id}">${esc(p.name)}${p.source === 'navidrome' ? ' <span class="muted">(NAS)</span>' : ''}</button>`).join('');
  openModal(`<h3>Add to playlist</h3>
    <div class="modal-list">${list || '<div class="muted pad">No playlists yet</div>'}</div>
    <div class="modal-actions"><button class="btn ghost" data-action="modal-close">Cancel</button>${nasNewPlaylistBtnHTML(ids)}<button class="btn primary" data-action="atp-new">${icon('plus')}New playlist</button></div>`);
}

function addSongsModal(target, id) {
  openModal(`<h3>Add songs</h3>
    <input id="addSearch" type="text" placeholder="Search your library" />
    <div class="modal-list tall" id="addResults"></div>
    <div class="modal-actions"><button class="btn primary" data-action="modal-close">Done</button></div>`, true);
  const res = $('#addResults'), inp = $('#addSearch');
  const has = () => {
    if (target === 'playlist') { const pl = S.playlists.find(p => p.id === id); return new Set(pl ? pl.items.map(i => i.trackId) : []); }
    const a = S.albumById.get(id); return new Set(a ? a.trackIds : []);
  };
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    const inSet = has();
    const matches = (q ? S.tracks.filter(t => (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q))
      : [...S.tracks].sort((a, b) => b.dateAdded - a.dateAdded)).slice(0, 40);
    res.innerHTML = matches.map(t => `<div class="add-row">
      <span class="q-art">${t.cover ? `<img loading="lazy" decoding="async" src="${artUrl(t.cover, ART_SM)}" alt="">` : icon('music')}</span>
      <span class="q-meta"><span class="q-title">${esc(t.title)}</span><span class="q-sub">${esc(t.artist)} · ${esc(t.album)}</span></span>
      <button class="btn small ${inSet.has(t.id) ? 'ghost' : ''}" data-action="add-track" data-target="${target}" data-id="${id}" data-track="${t.id}" ${inSet.has(t.id) ? 'disabled' : ''}>${inSet.has(t.id) ? 'Added' : '+ Add'}</button>
    </div>`).join('') || '<div class="muted pad">No matches.</div>';
  };
  inp.addEventListener('input', debounce(draw, 140));
  draw();
  wireSpotifyIntoAddSongsModal(target, id);
}

function coverZoneHTML(url) {
  return `<div class="cover-zone drop-cover" id="coverZone" title="Click, drop, or paste an image">
    ${url ? `<img src="${url}" alt="">` : `<span class="art-ph">${icon('image')}</span><span class="cz-hint">Cover</span>`}
  </div><input type="file" id="coverFile" accept="image/*" hidden />`;
}
function wireCoverZone(onData) {
  const zone = $('#coverZone'), file = $('#coverFile');
  const use = dataUrl => { zone.innerHTML = `<img src="${dataUrl}" alt="">`; onData(dataUrl); };
  zone.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { const f = file.files[0]; if (f) readImg(f, use); });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readImg(f, use); });
}
function readImg(f, cb) {
  if (!/^image\//.test(f.type)) { toast('Not an image'); return; }
  const r = new FileReader();
  r.onload = () => cb(r.result);
  r.readAsDataURL(f);
}

function albumEditorModal(album, prefill = {}) {
  const a = album || { title: '', artist: prefill.artist || '', releaseDate: '', type: 'album', unreleased: false, cover: null };
  let coverData = null;
  openModal(`<h3>${album ? 'Edit album' : 'New album'}</h3>
    <div class="editor-grid">
      ${coverZoneHTML(a.cover)}
      <div class="editor-fields">
        <label>Title<input id="fTitle" type="text" value="${esc(a.title)}" placeholder="Album title" /></label>
        <label>Artist<input id="fArtist" type="text" value="${esc(a.artist)}" list="artistList" placeholder="Artist" />
          <datalist id="artistList">${S.artists.map(x => `<option value="${esc(x.name)}">`).join('')}</datalist></label>
        <label>Release date<input id="fDate" type="date" value="${esc(a.releaseDate || '')}" /></label>
        <div class="field-row">
          <label>Type<select id="fType" class="select">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${a.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="check"><input id="fUnrel" type="checkbox" ${a.unreleased ? 'checked' : ''} /> Unreleased</label>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      ${album && album.custom ? '<button class="btn ghost danger" data-action="album-del" data-id="' + album.id + '">Delete album</button><span class="spacer"></span>' : ''}
      <button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn primary" id="albumSave">${album ? 'Save' : 'Create'}</button>
    </div>`, true);
  wireCoverZone(d => coverData = d);
  $('#albumSave').addEventListener('click', async () => {
    const patch = {
      title: $('#fTitle').value.trim() || 'Untitled',
      artist: $('#fArtist').value.trim() || 'Unknown Artist',
      releaseDate: $('#fDate').value || null,
      type: $('#fType').value,
      unreleased: $('#fUnrel').checked
    };
    if (coverData) {
      const name = await window.aura.setCover(coverData);
      if (name) patch.coverFile = name;
    }
    window.aura.ensureAlbumFolder(patch.artist, patch.title).catch(() => {});
    if (album && !album.custom) {
      await refreshLibrary(await window.aura.albumOverride(album.id, patch));
      closeModal(); route(); toast('Album updated');
    } else {
      const res = await window.aura.albumUpsert(album ? { id: album.id, ...patch } : patch);
      await refreshLibrary(res.library);
      closeModal();
      if (!album) { location.hash = '#/album/' + res.album.id; toast('Album created. Now import songs into it.'); }
      else { route(); toast('Album updated'); }
    }
  });
}

function artistEditorModal(name) {
  const ar = name ? S.artistByName.get(name) : null;
  let coverData = null;
  openModal(`<h3>${ar ? 'Edit artist' : 'New artist'}</h3>
    <div class="editor-grid">
      ${coverZoneHTML(ar ? artistImage(ar) : null)}
      <div class="editor-fields">
        <label>Name<input id="fName" type="text" value="${esc(name || '')}" ${ar && !ar.custom && ar.trackCount ? 'readonly title="Rename tracks via Edit tags"' : ''} placeholder="Artist name" /></label>
        <div class="muted">The photo shows on the artist page and cards. Albums attach to artists by name.</div>
      </div>
    </div>
    <div class="modal-actions"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn primary" id="artistSave">${ar ? 'Save' : 'Create'}</button></div>`, true);
  wireCoverZone(d => coverData = d);
  $('#artistSave').addEventListener('click', async () => {
    const newName = $('#fName').value.trim();
    if (!newName) { toast('Give the artist a name'); return; }
    window.aura.ensureArtistFolder(newName).catch(() => {});
    const data = { name: newName };
    if (ar && ar.customId) data.id = ar.customId;
    if (coverData) {
      const file = await window.aura.setCover(coverData);
      if (file) data.imageFile = file;
    }
    const res = await window.aura.artistUpsert(data);
    await refreshLibrary(res.library);
    closeModal();
    location.hash = '#/artist/' + encodeURIComponent(newName);
    toast(ar ? 'Artist updated' : 'Artist created');
  });
}

function tagEditorModal(t) {
  const split = splitArtistCredit(t.artist);
  openModal(`<h3>Edit tags</h3>
    <div class="muted pad-b">${esc(t.fileName || '')} · edits are saved in Aura and never touch the file unless you write them.</div>
    <div class="editor-fields two">
      <label>Title<input id="gTitle" type="text" value="${esc(t.title)}" /></label>
      <label>Main artist<input id="gArtist" type="text" value="${esc(split.main)}" /></label>
      <label class="span-2">Featured artists<input id="gFeatured" type="text" value="${esc(split.featured.join(', '))}" placeholder="Comma-separated, e.g. Kid Cudi, Pusha T" /></label>
      <label>Album<input id="gAlbum" type="text" value="${esc(t.album)}" /></label>
      <label>Track #<input id="gNo" type="number" min="0" value="${t.trackNo || ''}" /></label>
      <label>Year<input id="gYear" type="number" min="0" value="${t.year || ''}" /></label>
      <label>Genre<input id="gGenre" type="text" value="${esc(t.genre || '')}" /></label>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" id="tagWrite" title="Writes ID3 tags into the MP3 itself">Write tags to MP3</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-action="modal-close">Cancel</button>
      <button class="btn primary" id="tagSave">Save</button>
    </div>`, true);
  const fields = () => ({
    title: $('#gTitle').value.trim(),
    // Main + Featured are edited as two fields but stored as one credit
    // string ("<main> feat. <a, b>"), same as every other local tag - that's
    // what artistName.js's splitter reads back on next scan, and what keeps
    // this compatible with tracks whose credit was typed as one string
    // elsewhere (the raw Artist field still works, just as one name).
    artist: joinArtistCredit($('#gArtist').value, $('#gFeatured').value.split(',')),
    trackNo: +$('#gNo').value || 0,
    year: +$('#gYear').value || null,
    genre: $('#gGenre').value.trim() || null
  });
  $('#tagSave').addEventListener('click', async () => {
    const newAlbum = $('#gAlbum').value.trim();
    let lib = await window.aura.overrideTrack(t.id, fields());
    // Album is an album-level attribute everywhere else in Aura (see the
    // standalone album editor); route the fix through the same override so
    // renaming from here can never diverge from renaming from the album page.
    if (t.albumId && newAlbum && newAlbum !== t.album) {
      const alb = S.albumById.get(t.albumId);
      lib = alb && alb.custom
        ? (await window.aura.albumUpsert({ id: t.albumId, title: newAlbum })).library
        : await window.aura.albumOverride(t.albumId, { title: newAlbum });
    }
    await refreshLibrary(lib);
    closeModal(); route(); markPlayingRows(); toast('Saved');
  });
  $('#tagWrite').addEventListener('click', async () => {
    const r = await window.aura.writeTags(t.id, fields());
    toast(r.ok ? 'Tags written to file' : r.error || 'Could not write tags');
  });
}

/* Album-wide tag cleanup: one canonical artist, one album name, one release
   date and genre across every track, plus a chance to hand-edit any title
   Aura's automatic cleanup (see normalize.js) didn't quite get right.
   Reachable only from the album "…" menu, mirroring how "Edit tags" sits
   behind a track's right-click menu rather than being a visible button. */
function albumFixTagsModal(a) {
  const trackRows = a.trackIds.map(id => S.byId.get(id)).filter(Boolean);
  const counts = new Map();
  for (const t of trackRows) if (t.genre) counts.set(t.genre, (counts.get(t.genre) || 0) + 1);
  const commonGenre = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];

  openModal(`<h3>Fix tags · ${esc(a.title)}</h3>
    <div class="muted pad-b">Sets one artist, album, release date and genre across every track here, and cleans up titles the same way Aura already does automatically on scan. Saved in Aura only unless you click Write tags to files.</div>
    <div class="editor-fields two">
      <label>Artist<input id="fxArtist" type="text" value="${esc(a.artist)}" /></label>
      <label>Album<input id="fxAlbum" type="text" value="${esc(a.title)}" /></label>
      <div class="field-row">
        <label>Release date<input id="fxDate" type="date" value="${esc(a.releaseDate || '')}" /></label>
        <button class="btn ghost small" id="fxLookup" type="button" title="Look up on MusicBrainz">Look up</button>
      </div>
      <label>Genre<input id="fxGenre" type="text" value="${esc((commonGenre && commonGenre[0]) || '')}" /></label>
    </div>
    <div class="muted pad-b">Track titles</div>
    <div class="modal-list tall" id="fxTracks">
      ${trackRows.map(t => `<div class="add-row">
        <span class="q-sub">${t.trackNo || '-'}</span>
        <input type="text" class="fx-title" data-id="${t.id}" value="${esc(t.title)}" />
      </div>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn ghost" id="fxWrite" title="Writes these tags into every file in this album">Write tags to files</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-action="modal-close">Cancel</button>
      <button class="btn primary" id="fxSave">Save</button>
    </div>`, true);

  $('#fxLookup').addEventListener('click', async () => {
    const artist = $('#fxArtist').value.trim(), album = $('#fxAlbum').value.trim();
    if (!artist || !album) { toast('Artist and album are needed to look up a date'); return; }
    const btn = $('#fxLookup');
    btn.disabled = true; btn.textContent = '…';
    const date = await window.aura.lookupReleaseDate(artist, album);
    btn.disabled = false; btn.textContent = 'Look up';
    if (date) $('#fxDate').value = date.length === 4 ? date + '-01-01' : date.slice(0, 10);
    else toast('No confident match on MusicBrainz');
  });

  const readForm = () => ({
    artist: $('#fxArtist').value.trim(),
    album: $('#fxAlbum').value.trim(),
    date: $('#fxDate').value || null,
    genre: $('#fxGenre').value.trim() || null,
    titles: new Map($$('.fx-title').map(el => [el.dataset.id, el.value.trim()]))
  });

  async function applyOverrides(form) {
    let lib = null;
    const albumPatch = {};
    if (form.album && form.album !== a.title) albumPatch.title = form.album;
    if (form.date !== (a.releaseDate || null)) albumPatch.releaseDate = form.date;
    if (Object.keys(albumPatch).length) {
      lib = a.custom
        ? (await window.aura.albumUpsert({ id: a.id, ...albumPatch })).library
        : await window.aura.albumOverride(a.id, albumPatch);
    }
    for (const t of trackRows) {
      const title = form.titles.get(t.id);
      const patch = {};
      // Replace just the MAIN artist, keep each track's own featured
      // collaborators intact - a blind overwrite here used to erase every
      // "feat. X" credit across the whole album the moment you fixed the
      // album's own artist name.
      if (form.artist) {
        const rebuilt = joinArtistCredit(form.artist, splitArtistCredit(t.artist).featured);
        if (rebuilt !== t.artist) patch.artist = rebuilt;
      }
      if (form.genre !== (t.genre || null)) patch.genre = form.genre;
      if (title && title !== t.title) patch.title = title;
      if (Object.keys(patch).length) lib = await window.aura.overrideTrack(t.id, patch);
    }
    return lib || await window.aura.library();
  }

  $('#fxSave').addEventListener('click', async () => {
    const lib = await applyOverrides(readForm());
    await refreshLibrary(lib);
    closeModal(); route(); toast('Tags fixed');
  });

  $('#fxWrite').addEventListener('click', async () => {
    const form = readForm();
    const lib = await applyOverrides(form);
    await refreshLibrary(lib);
    const items = trackRows.map(t => ({
      trackId: t.id,
      fields: {
        title: form.titles.get(t.id) || t.title,
        artist: form.artist ? joinArtistCredit(form.artist, splitArtistCredit(t.artist).featured) : t.artist,
        album: form.album || t.album,
        trackNo: t.trackNo || 0,
        year: form.date ? +String(form.date).slice(0, 4) : (t.year || null),
        genre: form.genre || t.genre || null
      }
    }));
    const results = await window.aura.writeTagsBatch(items);
    const failed = results.filter(r => !r.ok);
    closeModal(); route();
    toast(failed.length ? `Wrote ${results.length - failed.length}/${results.length} files, ${failed.length} failed` : `Wrote tags to ${results.length} file(s)`);
  });
}

function lyricsEditModal(t) {
  const cached = S.lyricsCache.get(t.id);
  const existing = cached && cached !== 'loading'
    // keep the hundredths: rounding every line down to the whole second made
    // an unchanged re-save drift the sync by up to a second
    ? (cached.synced ? cached.synced.map(([s, l]) => { const cs = Math.round(s * 100); return `[${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}] ${l}`; }).join('\n') : (cached.plain || ''))
    : '';
  openModal(`<h3>Lyrics · ${esc(t.title)}</h3>
    <div class="muted pad-b">Paste plain lyrics or LRC with [mm:ss.xx] timestamps for Apple-style sync.</div>
    <textarea id="lyrText" rows="12" placeholder="[00:12.40] First line...">${esc(existing)}</textarea>
    <div class="modal-actions"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn primary" id="lyrSave">Save</button></div>`, true);
  $('#lyrSave').addEventListener('click', async () => {
    const data = await window.aura.lyricsSave(t.id, $('#lyrText').value);
    S.lyricsCache.set(t.id, data);
    closeModal();
    renderLyricsPanel();
    toast('Lyrics saved');
  });
}

/* ---------- lyrics panel ---------- */

// Builds the lyrics markup once and drops it into every lyrics surface that
// exists (the full-screen Now Playing tab and the docked side panel) rather
// than tracking which one is currently visible - both are cheap, tiny DOM
// trees, and keeping both in sync means whichever one you open next is
// already scrolled to the right line instead of jumping on open.
function lyricsHTML(t, data) {
  if (data === 'loading') return '<div class="lyr-empty">Loading…</div>';
  if (!data) {
    return `<div class="lyr-empty">No lyrics yet.
      <div class="lyr-actions"><button class="btn small" data-action="lyr-fetch">Search LRCLIB</button>
      <button class="btn small ghost" data-action="lyr-edit">Paste lyrics</button></div></div>`;
  }
  if (data.synced) {
    return `<div class="lyr-scroll">${data.synced.map(([s, line], i) =>
      `<div class="lyr-line" data-i="${i}" data-action="lyr-seek" data-t="${s}">${line ? esc(line) : '♪'}</div>`).join('')}
      <div class="lyr-src muted">${data.source === 'lrclib' ? 'Lyrics via LRCLIB' : ''}</div></div>`;
  }
  return `<div class="lyr-scroll plain">${esc(data.plain).split('\n').map(l => `<div class="lyr-line static">${l || '&nbsp;'}</div>`).join('')}</div>`;
}

function renderLyricsPanel() {
  lastLyrIdx = -1;
  const t = cur();
  const html = t ? lyricsHTML(t, S.lyricsCache.get(t.id)) : '<div class="lyr-empty">Play a song to see its lyrics.</div>';
  for (const id of ['npLyrics', 'dockLyrics']) { const el = $('#' + id); if (el) el.innerHTML = html; }
}
