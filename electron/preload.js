/* preload.js — the only bridge between renderer and main */
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = ch => (...args) => ipcRenderer.invoke(ch, ...args);

// Spotify IPC results never throw (see main.js HS()) - a failure comes back
// as { __spotifyError, code, message } and is passed through as-is. It must
// NOT be turned into a thrown Error here: contextBridge strips custom
// properties off errors crossing into the page, so .code would never arrive.
// renderer/js/core.js (spApi) does the throwing on the page side instead.
const spCall = call;

contextBridge.exposeInMainWorld('aura', {
  status: call('lib:status'),
  library: call('lib:get'),
  rescan: call('lib:rescan'),
  reloadAll: call('app:reloadAll'),
  deleteTrackFile: call('lib:deleteTrackFile'),
  addFolder: call('lib:addFolder'),
  removeFolder: call('lib:removeFolder'),
  defaultFolder: call('lib:defaultFolder'),
  useDefaultFolder: call('lib:useDefaultFolder'),
  importFiles: call('lib:importFiles'),
  ensureArtistFolder: call('lib:ensureArtistFolder'),
  ensureAlbumFolder: call('lib:ensureAlbumFolder'),

  playlists: call('pl:list'),
  plCreate: call('pl:create'),
  plUpdate: call('pl:update'),
  plDelete: call('pl:delete'),
  plAdd: call('pl:add'),
  plRemove: call('pl:remove'),
  plExportM3U: call('pl:exportM3U'),
  likedList: call('liked:list'),
  likedToggle: call('liked:toggle'),

  overrideTrack: call('meta:track'),
  writeTags: call('meta:write'),
  writeTagsBatch: call('tags:writeBatch'),
  lookupReleaseDate: call('meta:lookupReleaseDate'),
  albumUpsert: call('album:upsert'),
  albumOverride: call('album:override'),
  albumFetchArt: call('album:fetchArt'),
  albumDelete: call('album:delete'),
  albumSetTracks: call('album:tracks'),
  artistUpsert: call('artist:upsert'),
  artistDelete: call('artist:delete'),
  setCover: call('cover:set'),

  lyricsGet: call('lyrics:get'),
  lyricsSave: call('lyrics:save'),
  lyricsFetch: call('lyrics:fetch'),
  statsLog: call('stats:log'),
  statsGet: call('stats:get'),
  statsEvents: call('stats:events'),
  statsTaste: call('stats:taste'),

  djLines: call('dj:lines'),
  djWarm: call('dj:warm'),
  djRelease: call('dj:release'),
  djSpeak: call('dj:speak'),
  ttsStatus: call('tts:status'),
  ttsDownload: call('tts:download'),
  ollamaStatus: call('ollama:status'),
  ollamaModels: call('ollama:models'),
  ollamaLaunch: call('ollama:launch'),

  settingsGet: call('set:get'),
  settingsSet: call('set:set'),
  loudnessAll: call('loudness:get'),
  loudnessSet: call('loudness:set'),
  sessionGet: call('session:get'),
  sessionSave: call('session:save'),
  settingsReset: call('set:reset'),
  backupData: call('data:backup'),
  openDataFolder: call('data:openFolder'),
  clearFetchedLyrics: call('data:clearFetchedLyrics'),
  clearLoudness: call('data:clearLoudness'),
  statsReset: call('stats:reset'),
  openMini: call('win:mini'),
  showWindow: call('win:show'),
  quitApp: call('app:quit'),

  // NAS results may be { __nasError, code, message }; renderer/js/nas.js (nasApi) throws them on the page side
  nasStatus: call('nas:status'),
  nasGetConfig: call('nas:getConfig'),
  nasSetConfig: call('nas:setConfig'),
  nasSetCredential: call('nas:setCredential'),
  nasForget: call('nas:forget'),
  nasTest: call('nas:test'),
  nasRefresh: call('nas:refresh'),
  nasSearch: call('nas:search'),
  nasScrobble: call('nas:scrobble'),
  nasCreatePlaylist: call('nas:createPlaylist'),
  nasDownload: call('nas:download'),
  nasCancelDownload: call('nas:cancelDownload'),
  nasRemoveDownload: call('nas:removeDownload'),

  spStatus: spCall('sp:status'),
  spSetClientId: spCall('sp:setClientId'),
  spRedirectUri: spCall('sp:redirectUri'),
  spLogin: spCall('sp:login'),
  spLogout: spCall('sp:logout'),
  onSpotifyStatus: fn => ipcRenderer.on('spotify-status', (e, st) => fn(st)),

  spSearch: spCall('sp:search'),
  spArtist: spCall('sp:artist'),
  spArtistAlbums: spCall('sp:artistAlbums'),
  spAlbum: spCall('sp:album'),
  spAlbumTracks: spCall('sp:albumTracks'),
  spTrack: spCall('sp:track'),

  spPlaybackState: spCall('sp:playbackState'),
  spDevices: spCall('sp:devices'),
  spTransfer: spCall('sp:transfer'),
  spPlayUris: spCall('sp:playUris'),
  spPlayContext: spCall('sp:playContext'),
  spPause: spCall('sp:pause'),
  spResume: spCall('sp:resume'),
  spSeek: spCall('sp:seek'),
  spNext: spCall('sp:next'),
  spPrevious: spCall('sp:previous'),
  spShuffle: spCall('sp:shuffle'),
  spRepeat: spCall('sp:repeat'),
  spVolume: spCall('sp:volume'),
  spQueueAdd: spCall('sp:queueAdd'),

  spSavedTracks: spCall('sp:savedTracks'),
  spSavedAlbums: spCall('sp:savedAlbums'),
  spLibSave: spCall('sp:libSave'),
  spLibRemove: spCall('sp:libRemove'),
  spLibContains: spCall('sp:libContains'),

  spCreatePlaylist: spCall('sp:createPlaylist'),
  spMyPlaylists: spCall('sp:myPlaylists'),
  spPlaylist: spCall('sp:playlist'),
  spPlaylistItems: spCall('sp:playlistItems'),
  spPlaylistAdd: spCall('sp:playlistAdd'),
  spPlaylistRemove: spCall('sp:playlistRemove'),

  spRecentlyPlayed: spCall('sp:recentlyPlayed'),
  spTopItems: spCall('sp:topItems'),

  sendState: s => ipcRenderer.send('state:update', s),
  sendPos: (t, dur) => ipcRenderer.send('state:pos', t, dur),
  sendCmd: c => ipcRenderer.send('cmd', c),
  miniAction: a => ipcRenderer.send('mini', a), // 'close' | 'show-main'
  on: (ch, fn) => ipcRenderer.on(ch, (e, ...a) => fn(...a)),

  // resolves the real filesystem path of a File the user dragged in from
  // Explorer, so dropped audio files can be imported without a file picker
  getFilePath: file => { try { return webUtils.getPathForFile(file); } catch { return null; } }
});
