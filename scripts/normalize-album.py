#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""normalize-album.py -- one command to make a ripped/downloaded album's tags
consistent: correct artist/albumartist, correct album name on every track
(files from single-video downloads often have no album tag at all), correct
release date (typed or auto-looked-up on MusicBrainz), sequential track
numbers, and titles with the "<Artist> - Title ft. X (Official Video)" junk
that yt-dlp and friends leave in the tag stripped back to just the song name.

This is the generalized version of the manual College Dropout cleanup --
run this instead, by hand, each time a new album folder is added.

Supports .opus/.ogg/.flac (Vorbis comments) and .mp3 (ID3) and .m4a (MP4
atoms). Requires: pip install mutagen

Usage:
  python scripts/normalize-album.py "<album folder>" --artist "Kanye West" [options]

Options:
  --album TEXT         Album name. Default: the folder's own name. Pass
                        --album "" to explicitly leave the album tag alone
                        (clears it if present) -- for a bonus/loosie file
                        mixed into an album folder that doesn't actually
                        belong on the tracklist.
  --date YYYY-MM-DD    Release date to stamp on every track.
  --auto-date          Look the release date up on MusicBrainz instead of
                        passing --date (needs internet; falls back to
                        leaving dates untouched if no confident match).
  --genre TEXT         Genre to stamp on every track. Omit to leave genre
                        tags exactly as found.
  --exclude SUBSTR     Skip any filename containing this text (repeatable).
                        Use this to leave a bonus/unreleased track alone in
                        one pass, then run again with --only on just that
                        file and different --album/--date/--genre.
  --only SUBSTR        Process ONLY filenames containing this text
                        (repeatable). The inverse of --exclude, for a
                        second, special-cased pass over one or two files.
  --dry-run            Print what would change without writing anything.

Example (a normal album):
  python scripts/normalize-album.py "C:\\Music\\Kanye Discography\\Graduation" \\
      --artist "Kanye West" --auto-date --genre "Hip-Hop"

Example (that same folder, but track 15 is a bonus/unreleased cut that
doesn't belong on the official tracklist):
  python scripts/normalize-album.py "...\\Graduation" --artist "Kanye West" \\
      --date 2007-09-11 --genre "Hip-Hop" --exclude "Bittersweet"
  python scripts/normalize-album.py "...\\Graduation" --artist "Kanye West" \\
      --album "" --date 2007 --genre "Hip-Hop" --only "Bittersweet"
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis
from mutagen.flac import FLAC
from mutagen.easyid3 import EasyID3
from mutagen.id3 import ID3NoHeaderError
from mutagen.mp4 import MP4

AUDIO_EXTS = {'.opus', '.ogg', '.flac', '.mp3', '.m4a'}

# yt-dlp / ffmpeg leave these behind on the Ogg family; they don't belong on
# a music file and clutter every tag viewer.
JUNK_VORBIS_KEYS = ['purl', 'synopsis', 'description', 'language', 'encoder', 'comment']

FEAT_RE = re.compile(r'\s*[\(\[]?\s*\b(feat\.?|ft\.?|featuring)\b.*$', re.IGNORECASE)
JUNK_PAREN_RE = re.compile(
    r'\s*[\(\[]\s*(official\s*(video|audio|music\s*video)?|lyrics?(\s*video)?|'
    r'hq|hd|explicit|clean|audio|video|short\s*version|version\s*\d*|'
    r'extended(\s*version)?|full\s*song|visualizer)\s*[\)\]]\s*$',
    re.IGNORECASE)
# A trailing "[WHxRd_va950]"-style yt-dlp video-id suffix - requires at
# least one digit inside the brackets, so a legitimate title suffix that
# happens to be 6-15 letters (like "(Interlude)") is never mistaken for one.
TRAILING_ID_RE = re.compile(r'\s*[\[\(](?=[A-Za-z0-9_-]{6,15}[\]\)]\s*$)(?=[^\]\)]*\d)[A-Za-z0-9_-]+[\]\)]\s*$')
LEADING_NUM_RE = re.compile(r'^\s*(\d{1,3})[\s._\-)]+')


def clean_title(raw_title, artist):
    t = raw_title.strip()
    # strip a leading "<Artist> - " (or "<Artist>: ") the ripper glued on
    lead = re.compile(r'^\s*' + re.escape(artist) + r'\s*[-:]\s*', re.IGNORECASE)
    t = lead.sub('', t)
    # iteratively strip trailing "feat. X", "(Official Video)", "[abc123xyz]"
    # style junk -- order matters since these often stack up
    changed = True
    while changed:
        changed = False
        for pat in (FEAT_RE, JUNK_PAREN_RE, TRAILING_ID_RE):
            new_t = pat.sub('', t).strip()
            if new_t != t:
                t = new_t
                changed = True
    return t.strip() or raw_title.strip()


def title_from_filename(filename, artist):
    base = os.path.splitext(filename)[0]
    base = LEADING_NUM_RE.sub('', base)
    return clean_title(base, artist)


def track_number_from_filename(filename, fallback):
    m = LEADING_NUM_RE.match(os.path.splitext(filename)[0])
    return int(m.group(1)) if m else fallback


def lookup_release_date(artist, album):
    """Best-effort MusicBrainz lookup of the earliest official release date
    for this artist+release-group. Returns 'YYYY-MM-DD'/'YYYY' or None.
    Retries once on a 503 (MusicBrainz throttles anonymous callers to
    ~1 req/sec and hiccups under load)."""
    q = f'artist:"{artist}" AND releasegroup:"{album}"'
    url = 'https://musicbrainz.org/ws/2/release-group/?' + urllib.parse.urlencode({'query': q, 'fmt': 'json', 'limit': 5})
    req = urllib.request.Request(url, headers={'User-Agent': 'AuraLibraryNormalizer/1.0 ( local personal use )'})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.load(resp)
            groups = data.get('release-groups', [])
            if not groups:
                return None
            # prefer an exact (case-insensitive) title match, then whichever MB ranked first
            exact = [g for g in groups if g.get('title', '').lower() == album.lower()]
            best = (exact or groups)[0]
            return best.get('first-release-date') or None
        except Exception as e:
            if attempt == 1 and '503' in str(e):
                time.sleep(1.5)
                continue
            print(f'  ! MusicBrainz lookup failed ({e}); leaving date untouched', file=sys.stderr)
            return None


def load_tags(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.opus':
        return OggOpus(path), 'vorbis'
    if ext == '.ogg':
        return OggVorbis(path), 'vorbis'
    if ext == '.flac':
        return FLAC(path), 'vorbis'
    if ext == '.mp3':
        try:
            return EasyID3(path), 'id3'
        except ID3NoHeaderError:
            audio = EasyID3()
            audio.filename = path
            return audio, 'id3'
    if ext == '.m4a':
        return MP4(path), 'mp4'
    raise ValueError(f'unsupported extension: {ext}')


def apply_vorbis(tags, title, artist, album, date, tracknum, genre):
    for k in JUNK_VORBIS_KEYS:
        if k in tags:
            del tags[k]
    tags['title'] = [title]
    tags['artist'] = [artist]
    tags['albumartist'] = [artist]
    if album is not None:
        tags['album'] = [album]
    elif 'album' in tags:
        del tags['album']
    if date:
        tags['date'] = [date]
    tags['tracknumber'] = [str(tracknum)]
    if genre:
        tags['genre'] = [genre]


def apply_id3(tags, title, artist, album, date, tracknum, genre):
    tags['title'] = title
    tags['artist'] = artist
    tags['albumartist'] = artist
    if album is not None:
        tags['album'] = album
    elif 'album' in tags:
        del tags['album']
    if date:
        tags['date'] = date[:4]  # EasyID3 date frame wants a bare year reliably
    tags['tracknumber'] = str(tracknum)
    if genre:
        tags['genre'] = genre


def apply_mp4(tags, title, artist, album, date, tracknum, genre):
    tags['\xa9nam'] = [title]
    tags['\xa9ART'] = [artist]
    tags['aART'] = [artist]
    if album is not None:
        tags['\xa9alb'] = [album]
    elif '\xa9alb' in tags:
        del tags['\xa9alb']
    if date:
        tags['\xa9day'] = [date]
    existing_trkn = tags.get('trkn', [(0, 0)])
    total = existing_trkn[0][1] if existing_trkn else 0
    tags['trkn'] = [(tracknum, total)]
    if genre:
        tags['\xa9gen'] = [genre]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('folder')
    ap.add_argument('--artist', required=True, help='Canonical artist/albumartist to stamp on every track')
    ap.add_argument('--album', help='Album name (default: the folder name)')
    ap.add_argument('--date', help='Release date, e.g. 2004-02-10')
    ap.add_argument('--auto-date', action='store_true', help='Look up the release date on MusicBrainz')
    ap.add_argument('--genre', help='Genre to stamp on every track (omit to leave genre alone)')
    ap.add_argument('--exclude', action='append', default=[], help='Skip filenames containing this text (repeatable)')
    ap.add_argument('--only', action='append', default=[], help='Process only filenames containing this text (repeatable)')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    folder = args.folder
    # --album omitted -> default to the folder name (normal case).
    # --album "" (explicitly passed empty) -> leave/clear the album tag,
    # for a bonus/loosie file that doesn't belong on the tracklist.
    if args.album is None:
        album = os.path.basename(os.path.normpath(folder))
    elif args.album == '':
        album = None
    else:
        album = args.album
    date = args.date
    if not date and args.auto_date:
        lookup_album = album if album is not None else os.path.basename(os.path.normpath(folder))
        print(f'Looking up release date for "{args.artist}" - "{lookup_album}" on MusicBrainz...')
        date = lookup_release_date(args.artist, lookup_album)
        print(f'  -> {date}' if date else '  -> no confident match, dates left untouched')

    files = sorted(f for f in os.listdir(folder) if os.path.splitext(f)[1].lower() in AUDIO_EXTS)
    if args.only:
        files = [f for f in files if any(s.lower() in f.lower() for s in args.only)]
    if args.exclude:
        files = [f for f in files if not any(s.lower() in f.lower() for s in args.exclude)]
    if not files:
        print('No matching audio files found in', folder)
        return

    print(f'{len(files)} track(s) in "{album if album is not None else "(no album tag)"}" by {args.artist}' + (f', {date}' if date else ''))
    for i, filename in enumerate(files, start=1):
        path = os.path.join(folder, filename)
        tags, kind = load_tags(path)

        raw_title = None
        if kind == 'vorbis':
            raw_title = tags.get('title', [None])[0]
        elif kind == 'id3':
            raw_title = tags.get('title', [None])[0]
        elif kind == 'mp4':
            raw_title = tags.get('\xa9nam', [None])[0]

        title = clean_title(raw_title, args.artist) if raw_title else title_from_filename(filename, args.artist)
        tracknum = track_number_from_filename(filename, i)

        print(f'  {tracknum:>2}. {title}' + ('' if raw_title == title else f'   (was: {raw_title!r})'))

        if args.dry_run:
            continue

        if kind == 'vorbis':
            apply_vorbis(tags, title, args.artist, album, date, tracknum, args.genre)
        elif kind == 'id3':
            apply_id3(tags, title, args.artist, album, date, tracknum, args.genre)
        elif kind == 'mp4':
            apply_mp4(tags, title, args.artist, album, date, tracknum, args.genre)
        tags.save()

    print('\nDRY RUN - nothing written.' if args.dry_run else '\nDone.')


if __name__ == '__main__':
    main()
