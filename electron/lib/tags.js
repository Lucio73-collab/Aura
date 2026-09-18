/* tags.js — optional "write to file". Aura's own edits live as overrides
   and never touch your files; this runs only when you explicitly click
   "Write tags to file" (single track) or "Write tags to files" (whole
   album, from the Fix tags editor). MP3 via node-id3, everything else
   (Opus/Ogg/FLAC/M4A) via node-taglib-sharp. */
const NodeID3 = require('node-id3');
const { File: TLFile, TagTypes } = require('node-taglib-sharp');
const { JUNK_VORBIS_FIELDS } = require('./normalize');

let library = null;
function init(lib) { library = lib; }

function writeMp3(file, fields) {
  const tags = {};
  if (fields.title) tags.title = fields.title;
  if (fields.artist) tags.artist = fields.artist;
  if (fields.album) tags.album = fields.album;
  if (fields.trackNo) tags.trackNumber = String(fields.trackNo);
  if (fields.year) tags.year = String(fields.year);
  if (fields.genre) tags.genre = fields.genre;
  const ok = NodeID3.update(tags, file);
  return ok === true ? { ok: true } : { ok: false, error: String(ok) };
}

function writeTaglib(file, fields) {
  const f = TLFile.createFromPath(file);
  try {
    if (fields.title) f.tag.title = fields.title;
    if (fields.artist) { f.tag.performers = [fields.artist]; f.tag.albumArtists = [fields.artist]; }
    if (fields.album) f.tag.album = fields.album;
    if (fields.trackNo) f.tag.track = fields.trackNo;
    if (fields.year) f.tag.year = fields.year;
    if (fields.genre) f.tag.genres = [fields.genre];
    // strip yt-dlp/ffmpeg junk fields on the Ogg family (Opus/Ogg/FLAC all
    // share the Xiph comment format); no-op for formats without one
    const xiph = f.getTag(TagTypes.Xiph, false);
    if (xiph) for (const key of JUNK_VORBIS_FIELDS) xiph.removeField(key);
    f.save();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    f.dispose();
  }
}

function writeToFile(trackId, fields) {
  const file = library.filePath(trackId);
  if (!file) return { ok: false, error: 'File not found' };
  try {
    return /\.mp3$/i.test(file) ? writeMp3(file, fields) : writeTaglib(file, fields);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* items: [{ trackId, fields }]. Used by the album "Fix tags" editor to
   write every track in one go; each file gets its own result so a bad
   file (locked, deleted, unsupported) doesn't stop the rest. */
function writeBatch(items) {
  return items.map(({ trackId, fields }) => ({ trackId, ...writeToFile(trackId, fields) }));
}

module.exports = { init, writeToFile, writeBatch };
