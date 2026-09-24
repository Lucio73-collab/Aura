/* dj.js — the talking DJ.
   Builds an endless mix from your library + play history and talks between
   songs like a radio host: the voice comes FIRST, then the song.

   How a break works:
   1. When a song starts, the DJ decides whether it will talk before the NEXT
      one, and if so writes the line (local Ollama) and renders the voice
      (Kokoro) right away, while this song plays, so nothing waits at the
      boundary.
   2. At the end of the song the audio engine offers the DJ the transition
      (AudioEngine.setGate). The outro fades, the DJ speaks, and the next song
      starts under the last half-second of the voice.
   3. Skipping, pausing or queueing something else cancels a pending break
      cleanly; a stale prepared line is simply thrown away.
   Starting the DJ works the same way: it writes and voices the intro before
   any music plays. */

const DJ_MIN_TALK_TRACK_SEC = 45; // don't talk into skits/interludes
const djSleep = ms => new Promise(r => setTimeout(r, ms));

const DJ = {
  active: false,
  count: 0,
  sinceTalk: 0,
  speaking: false,
  prepared: null,      // { trackId, line, speech, clip, kind }
  preparingFor: null,  // trackId a segment is currently being written for
  breakToken: 0,
  lines: [],           // recent lines, so the model doesn't repeat itself
  kinds: [],           // recent segment kinds, so the show varies
  history: [],         // tracks played this DJ session
  startedAt: 0,

  async start() {
    if (!S.tracks.length) { toast('Your library is empty'); return; }
    if (DJ.active) DJ.stop(true);
    const topIds = Object.entries(S.counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => S.byId.get(id)).filter(Boolean);
    const seeds = topIds.length >= 3 ? shuffled(topIds.map(t => t.id)).slice(0, 8).map(id => S.byId.get(id)) : trackList(shuffled(S.tracks.map(t => t.id)).slice(0, 8));
    const picks = djSequence(recommend(seeds, new Set(S.taste.recentIds || []), 12).filter(t => t.source !== 'spotify'));
    if (!picks.length) { toast('Not enough music to mix yet'); return; }

    Object.assign(DJ, { active: true, count: 0, sinceTalk: 0, prepared: null, preparingFor: null, lines: [], kinds: [], history: [], startedAt: Date.now() });
    AudioEngine.setGate(nextId => DJ.takeBreak(nextId));
    P.shuffle = false; P.smart = false; P.dj = true;
    syncControls();
    const ids = picks.map(t => t.id);

    if (S.settings.djVoiceEnabled === false) {
      playFrom(ids, 0, { name: 'DJ', sourceType: 'dj' });
      toast('DJ is on (voice off in Settings)');
      return;
    }

    setDjStatus('warming');
    setDjLine('Warming up the booth…', true);
    window.aura.djWarm().catch(() => {}); // the model isn't preloaded at launch any more
    toast('DJ is warming up…');
    const token = ++DJ.breakToken;
    // never keep the listener waiting forever on a cold model
    const seg = await Promise.race([DJ.buildSegment(null, picks[0], 'opener'), djSleep(22000).then(() => null)]);
    if (!DJ.active || token !== DJ.breakToken) return;

    if (Playback.hasTrack() && !Playback.isPaused()) { AudioEngine.fadeActive(1.2); await djSleep(1000); }
    if (!DJ.active || token !== DJ.breakToken) return;
    if (!seg) {
      setDjStatus('');
      setDjLine('');
      playFrom(ids, 0, { name: 'DJ', sourceType: 'dj' });
      toast('DJ is on');
      return;
    }
    DJ.remember(seg);
    setDjStatus('talking');
    setDjLine(seg.line);
    const ok = await AudioEngine.voiceThen(seg.clip, seg.speech, {
      tail: 0.5,
      onTail: () => {
        if (!DJ.active || token !== DJ.breakToken) return;
        AudioEngine.setMusicLevel(0.3, 0.05);
        playFrom(ids, 0, { name: 'DJ', sourceType: 'dj' });
      }
    });
    AudioEngine.setMusicLevel(1, 1.4);
    setDjStatus('');
    if (!ok && DJ.active && !P.currentId) playFrom(ids, 0, { name: 'DJ', sourceType: 'dj' });
    DJ.clearLineSoon(seg.line);
  },

  stop(silent) {
    if (!DJ.active) return;
    DJ.active = false;
    DJ.breakToken++;
    DJ.prepared = null; DJ.preparingFor = null;
    P.dj = false;
    AudioEngine.setGate(null);
    AudioEngine.stopVoice();
    AudioEngine.setMusicLevel(1, 0.3);
    syncControls();
    setDjStatus('');
    setDjLine('');
    window.aura.djRelease().catch(() => {}); // frees the model a minute later unless the DJ restarts
    if (!silent) toast('DJ stopped');
  },

  onTrackStart(track) {
    if (!DJ.active) return;
    DJ.count++;
    DJ.sinceTalk++;
    DJ.history.push(track.id);
    if (DJ.history.length > 60) DJ.history.shift();
    DJ.planAhead();
  },

  /* Decide whether to talk before the next song and start writing it now.
     Also called whenever the queue changes (scheduleUpcoming), so an edited
     queue gets a fresh line instead of a wrong one. */
  planAhead() {
    if (!DJ.active || S.settings.djVoiceEnabled === false) return;
    const nextId = P.manual[0] || P.ctx.ids[P.ctx.pos + 1];
    const next = nextId && S.byId.get(nextId);
    if (!next || next.source === 'spotify') return;
    const every = Math.max(1, S.settings.djEvery || 4);
    const cur = S.byId.get(P.currentId);
    const talk = DJ.sinceTalk >= every && next.duration >= DJ_MIN_TALK_TRACK_SEC;
    if (!talk) { if (DJ.prepared && DJ.prepared.trackId !== nextId) DJ.prepared = null; return; }
    if ((DJ.prepared && DJ.prepared.trackId === nextId) || DJ.preparingFor === nextId) return;
    DJ.prepared = null;
    DJ.preparingFor = nextId;
    DJ.buildSegment(cur, next, pickKind(cur, next)).then(seg => {
      if (DJ.preparingFor !== nextId) return;
      DJ.preparingFor = null;
      if (seg && DJ.active) DJ.prepared = seg;
    });
  },

  // Everything the model is allowed to talk about, pulled from the library.
  // It is told to use only these, so it can't invent trivia.
  async buildSegment(prev, next, kind) {
    try {
      const facts = {
        kind,
        next: trackFacts(next),
        prev: prev ? trackFacts(prev) : null,
        after: (() => { const i = P.ctx.ids.indexOf(next.id); const a = i > -1 && S.byId.get(P.ctx.ids[i + 1]); return a ? { title: a.title, artist: creditName(a) } : null; })(),
        listener: {
          timeOfDay: timeOfDay(),
          weekday: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
          songsThisSession: DJ.history.length,
          minutesThisSession: DJ.startedAt ? Math.round((Date.now() - DJ.startedAt) / 60000) : 0,
          topArtists: topPlayedArtists(3).map(a => a.name)
        },
        recentLines: DJ.lines.slice(-4)
      };
      const line = await window.aura.djLines(facts);
      if (!line) return null;
      const speech = speakable(line);
      const wav = await window.aura.djSpeak(speech);
      const clip = await AudioEngine.decodeVoice(wav);
      return { trackId: next.id, line, speech, clip, kind };
    } catch (e) {
      console.warn('DJ segment failed', e);
      return null;
    }
  },

  remember(seg) {
    DJ.lines.push(seg.line); if (DJ.lines.length > 8) DJ.lines.shift();
    DJ.kinds.push(seg.kind); if (DJ.kinds.length > 4) DJ.kinds.shift();
    DJ.sinceTalk = 0;
  },

  // Called by the audio engine at the end of a song. true = the DJ owns this boundary.
  takeBreak(nextId) {
    if (!DJ.active || S.settings.djVoiceEnabled === false || DJ.speaking) return false;
    const seg = DJ.prepared;
    const next = S.byId.get(nextId);
    if (!seg || seg.trackId !== nextId || !next || Playback.activeSource() !== 'local') return false;
    DJ.prepared = null;
    DJ.runBreak(next, seg);
    return true;
  },

  async runBreak(next, seg) {
    const token = ++DJ.breakToken;
    DJ.speaking = true;
    DJ.remember(seg);
    AudioEngine.fadeActive(1.5);
    await djSleep(700);
    if (token !== DJ.breakToken || !AudioEngine.inBreak()) { DJ.speaking = false; return; }
    setDjStatus('talking');
    setDjLine(seg.line);
    await AudioEngine.voiceThen(seg.clip, seg.speech, {
      tail: 0.5,
      onTail: () => {
        if (token !== DJ.breakToken || !AudioEngine.inBreak()) return;
        AudioEngine.setMusicLevel(0.3, 0.05);
        AudioEngine.endBreak();
        Playback.playNow(next);
      }
    });
    if (token === DJ.breakToken) {
      AudioEngine.setMusicLevel(1, 1.4);
      // the voice ended without starting the song (e.g. a cancelled tail): make sure music continues
      if (AudioEngine.inBreak()) { AudioEngine.endBreak(); Playback.playNow(next); }
    }
    DJ.speaking = false;
    setDjStatus('');
    DJ.clearLineSoon(seg.line);
  },

  clearLineSoon(line) {
    setTimeout(() => { if ($('#npDjLine').textContent === line) setDjLine(''); }, 7000);
  }
};

AudioEngine.on('breakcancel', () => {
  DJ.breakToken++;
  DJ.speaking = false;
  setDjStatus('');
  setDjLine('');
});

/* ---------- facts + show format ---------- */

function creditName(t) {
  const names = t.artists && t.artists.length ? t.artists : [t.artist];
  if (names.length === 1) return names[0];
  return names[0] + ' featuring ' + names.slice(1).join(' and ');
}

function trackFacts(t) {
  const a = t.albumId && S.albumById.get(t.albumId);
  const year = a && a.releaseDate ? +String(a.releaseDate).slice(0, 4) : (t.year || null);
  return {
    title: t.title,
    artist: creditName(t),
    album: a ? a.title : (t.album || null),
    albumType: a ? (TYPE_LABEL[a.type] || 'Album').toLowerCase() : null,
    year,
    unreleased: !!(a && a.unreleased),
    trackNo: t.trackNo || null,
    albumTracks: a ? a.trackIds.length : null,
    plays: S.counts[t.id] || 0,
    liked: S.liked.has(t.id),
    minutes: Math.round((t.duration || 0) / 60 * 10) / 10,
    genre: t.genre || null,
    bpm: t.bpm || null // only NAS songs carry it (OpenSubsonic), local files don't
  };
}

function timeOfDay() {
  const h = new Date().getHours();
  return h < 5 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
}

/* Segment kinds, picked from what's actually interesting about this pair of
   songs, weighted, and never the same kind twice in a row. */
function pickKind(prev, next) {
  const n = trackFacts(next), p = prev ? trackFacts(prev) : null;
  const options = [['frontsell', 2]];
  if (p) options.push(['backsell', 3]);
  if (p && p.year && n.year && Math.abs(p.year - n.year) >= 4) options.push(['era', 4]);
  if (n.plays >= 5 || n.liked) options.push(['favorite', 4]);
  if (n.plays === 0) options.push(['firstlisten', 3]);
  if (n.unreleased) options.push(['deepcut', 4]);
  if (p && n.album && p.album === n.album) options.push(['samealbum', 3]);
  if (DJ.history.length >= 8 && DJ.history.length % 8 < every()) options.push(['checkin', 2]);
  const last = DJ.kinds[DJ.kinds.length - 1];
  const pool = options.filter(([k]) => k !== last);
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of pool) { if ((r -= w) <= 0) return k; }
  return 'frontsell';
}
const every = () => Math.max(1, S.settings.djEvery || 4);

/* Kokoro reads text literally: make names and titles sound right. */
function speakable(text) {
  return String(text)
    .replace(/Ty Dolla \$ign/gi, 'Ty Dolla Sign')
    .replace(/¥\$/g, 'Ye and Ty Dolla Sign')
    .replace(/A\$AP/gi, 'A-Sap')
    .replace(/\$/g, 's')
    .replace(/\bfeat\.?\s|\bft\.?\s/gi, 'featuring ')
    .replace(/\bPt\.\s?/g, 'Part ')
    .replace(/\bVol\.\s?/g, 'Volume ')
    .replace(/\bvs\.?\s/gi, 'versus ')
    .replace(/\s&\s/g, ' and ')
    .replace(/\bw\//gi, 'with ')
    .replace(/#(\d)/g, 'number $1')
    .replace(/[()[\]{}_*~|<>"“”]/g, ' ')
    // shouted titles (BULLY, CARNIVAL) get spelled out letter by letter otherwise
    .replace(/\b[A-Z][A-Z'!?]{3,}\b/g, w => w.charAt(0) + w.slice(1).toLowerCase())
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

/* Order picks like a set, not a list: never two songs from the same album
   back to back, and spread artists out when there's a choice. */
function djSequence(tracks) {
  const pool = tracks.slice(), out = [];
  while (pool.length) {
    const last = out[out.length - 1];
    let i = last ? pool.findIndex(t => t.albumId !== last.albumId && t.artist !== last.artist) : 0;
    if (i < 0) i = last ? pool.findIndex(t => t.albumId !== last.albumId) : 0;
    if (i < 0) i = 0;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/* ---------- UI ---------- */

function setDjLine(line, pending) {
  const el = $('#npDjLine');
  el.textContent = line || '';
  el.classList.toggle('show', !!line);
  el.classList.toggle('pending', !!pending);
}

function setDjStatus(state) {
  const chip = $('#pbDj');
  if (!chip) return;
  chip.classList.toggle('talking', state === 'talking');
  chip.classList.toggle('warming', state === 'warming');
  chip.lastChild.textContent = state === 'talking' ? 'On air' : state === 'warming' ? 'DJ…' : 'DJ';
}

/* keeps the DJ context endless: called from peekNext() when near the end */
function djRefill() {
  const recent = trackList(P.ctx.ids.slice(-5));
  const topIds = Object.entries(S.counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => S.byId.get(id)).filter(Boolean);
  const seeds = [...recent, ...topIds].slice(0, 10);
  const exclude = new Set([...P.ctx.ids.slice(-60), ...P.manual]);
  let picks = recommend(seeds, exclude, 8).filter(t => t.source !== 'spotify');
  if (!picks.length) picks = shuffled(S.tracks.filter(t => !exclude.has(t.id)).map(t => t.id)).slice(0, 8).map(id => S.byId.get(id));
  if (!picks.length) return;
  const lastId = P.ctx.ids[P.ctx.ids.length - 1];
  const ordered = djSequence(lastId ? [S.byId.get(lastId), ...picks].filter(Boolean) : picks).filter(t => t.id !== lastId);
  P.ctx.ids.push(...ordered.map(t => t.id));
  P.ctx.originalIds.push(...ordered.map(t => t.id));
}
