/* localSource.js - LocalSource: the existing behavior (files in the music
   folders, scanned by library.js) exposed through the source contract.
   Scanning, overrides and the curated merge stay in library.js; this only
   answers "how do I get bytes for this track id". */
function create(library) {
  return {
    id: 'local', idPrefix: '', label: 'This PC', playback: 'stream',
    status: () => ({ available: true }),
    async openStream(trackId) {
      const file = library.filePath(trackId);
      return file ? { kind: 'file', path: file } : null;
    }
  };
}
module.exports = { create };
