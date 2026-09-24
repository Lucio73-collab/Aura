/* sources/index.js - registry + contract for music sources.

   A source is anything Aura can list, search and play tracks from. Two exist:
     LocalSource     (localSource.js)    files in the music folders
     SubsonicSource  (subsonicSource.js) a Navidrome / Subsonic server (the NAS)
   Spotify predates this contract and is still wired directly (spotify.js,
   playback.js SpotifySource); a SpotifySource can implement the same shape
   later with playback: 'remote' (it controls a Connect device instead of
   handing Aura a stream).

   Contract (all methods optional except id/idPrefix/label/playback):
     id            'local' | 'navidrome' | 'spotify'
     idPrefix      track ids of this source start with it ('' = the default source)
     label         short name for the UI ('This PC', 'NAS')
     playback      'stream' (Aura decodes audio, so crossfade/automix apply)
                   | 'remote' (a device outside Aura plays it)
     status()      { available: bool, ... } cheap, synchronous
     listTracks()  Track[] from local state, synchronous (never touches the network)
     listPlaylists() [{ id, name, trackIds, ... }] same rules
     search(q)     Promise<{ added }> asks the source itself and folds new hits into listTracks()
     openStream(trackId, { range, signal })
                   Promise< { kind:'file', path } | { kind:'http', response } | null >
     coverArt(ref, size)  Promise<{ path, type } | null>

   Every track a source returns carries `source` (its id) and an `id` starting
   with its idPrefix, so tracks from different sources can share one queue. */
const sources = [];

function register(src) {
  const i = sources.findIndex(s => s.id === src.id);
  if (i >= 0) sources[i] = src; else sources.push(src);
  // longest prefix first, so 'nd:' is tried before the '' default
  sources.sort((a, b) => b.idPrefix.length - a.idPrefix.length);
  return src;
}
const get = id => sources.find(s => s.id === id) || null;
const all = () => sources.slice();
const forTrackId = trackId => sources.find(s => s.idPrefix && String(trackId).startsWith(s.idPrefix)) || sources.find(s => s.idPrefix === '') || null;
/* Tracks of every source except local (local scanning stays in library.js). */
const remoteTracks = () => sources.filter(s => s.idPrefix && typeof s.listTracks === 'function').flatMap(s => s.listTracks());
const remotePlaylists = () => sources.filter(s => s.idPrefix && typeof s.listPlaylists === 'function').flatMap(s => s.listPlaylists());

function reset() { sources.length = 0; }

module.exports = { register, get, all, forTrackId, remoteTracks, remotePlaylists, reset };
