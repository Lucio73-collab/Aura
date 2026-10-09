/* ollama.js — auto-launch + DJ line generation. Pure Node. */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

let store = null;
let launched = false;
function init(s) { store = s; }

const base = () => (store.settings().ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');

async function ping(timeout = 1500) {
  try {
    const r = await fetch(base() + '/api/tags', { signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch { return false; }
}

function trySpawn(cmd, args) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

/* Check 11434; if down and auto-launch is on, start `ollama serve` and wait for it. */
async function ensureRunning() {
  if (await ping()) return { running: true, launched: false };
  if (!store.settings().autoLaunchOllama || launched) return { running: false, launched };

  launched = true;
  let started = trySpawn('ollama', ['serve']);
  if (os.platform() === 'win32') {
    const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
    if (fs.existsSync(exe)) started = trySpawn(exe, ['serve']) || started;
  }
  if (!started) return { running: false, launched: false };

  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await ping(1200)) return { running: true, launched: true };
  }
  return { running: false, launched: true };
}

// Only ever returns real chat-capable models: an installed embedding-only
// model (e.g. "nomic-embed-text", pulled for something else entirely - RAG,
// search, whatever) can't generate text at all, and used to be just as
// eligible as any other installed model for both the DJ dropdown and the
// auto-pick below, silently producing garbage or empty lines if it ever got
// selected.
async function listModels() {
  try {
    const r = await fetch(base() + '/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || [])
      .filter(m => !m.capabilities || !m.capabilities.length || m.capabilities.includes('completion'))
      .map(m => ({ name: m.name, parameterSize: (m.details && m.details.parameter_size) || null }));
  } catch { return []; }
}

function paramCount(sizeStr) {
  const m = sizeStr && /([\d.]+)\s*([BM])/i.exec(sizeStr);
  if (!m) return Infinity;
  const n = parseFloat(m[1]);
  return m[2].toUpperCase() === 'M' ? n / 1000 : n;
}

// Prefer the smallest real chat model so it loads fast next to games and
// responds inside the DJ's own timeout, using Ollama's own reported
// parameter count instead of guessing from the model name - a regex on the
// name missed anything without a size baked into its tag (a plain
// "llama3:latest") and had no way to avoid a large model that just happens
// to be the only one installed (an 8-30B general/coding model takes many
// seconds to even load into memory, let alone respond, which is why the DJ
// used to fall back to its 6 canned lines almost every time).
function pickDefaultModel(models) {
  if (!models.length) return null;
  // Lines are written a whole song ahead of time now, so the DJ can afford
  // a model that actually writes well. Prefer the biggest general chat model
  // up to ~15B (fits a typical GPU, ~1s per line once loaded); coding and
  // embedding models write poor radio copy, so they're a last resort.
  const general = models.filter(m => !/coder|code|embed|vision|llava/i.test(m.name));
  const fits = general.filter(m => paramCount(m.parameterSize) <= 15);
  if (fits.length) return [...fits].sort((a, b) => paramCount(b.parameterSize) - paramCount(a.parameterSize))[0].name;
  return [...(general.length ? general : models)].sort((a, b) => paramCount(a.parameterSize) - paramCount(b.parameterSize))[0].name;
}

// Settles which model the DJ uses without loading it into memory.
async function pickModel() {
  const models = await listModels();
  if (!models.length) return null;
  let model = store.settings().djModel;
  // re-pick unless the listener chose a model themselves in Settings
  if (!model || !models.some(m => m.name === model) || !store.settings().djModelChosen) {
    model = pickDefaultModel(models);
    store.setSettings({ djModel: model });
  }
  return model;
}

let releaseTimer = null;
const loadRequest = (model, keepAlive) => fetch(base() + '/api/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: keepAlive })
}).catch(() => {});

// Loads the DJ model into memory ahead of its first line (called when the DJ starts).
async function warm() {
  clearTimeout(releaseTimer);
  const model = store.settings().djModel || await pickModel();
  if (model) loadRequest(model, '30m');
  return model;
}

// DJ switched off: give the model's memory (GBs of VRAM) back a minute later,
// unless the DJ is started again in the meantime.
function release() {
  clearTimeout(releaseTimer);
  const model = store.settings().djModel;
  if (!model) return false;
  releaseTimer = setTimeout(() => loadRequest(model, 0), 60000);
  return true;
}

/* ---------- the DJ's writing ----------
   The renderer sends facts pulled from the library (see dj.js trackFacts)
   plus a segment kind. The model is told to use only those facts, gets a
   couple of worked examples (small local models follow examples far better
   than rules), and its output is cleaned and checked: it has to actually
   name the next song, fit a spoken length, and not echo a recent line.
   One retry, then a template that uses the same facts. */

const SYSTEM = `You are the host of Aura Radio, a private radio show playing to one listener from their own music library.
You talk between songs like a real radio DJ: warm, quick, confident, a little witty, never cheesy.

Rules:
- Say 1 or 2 short sentences, 12 to 35 words in total.
- Use ONLY the facts you are given. Never invent trivia, chart positions, quotes, stories, samples, release plans or how long the show runs. Only say a song is liked or often played if the facts say so for that exact song.
- Name two songs at most: the one that just played and the next one. End by naming the next song.
- Name the next song and its artist naturally, each once.
- Only greet the listener (good evening, welcome, thanks for tuning in) in the opener segment.
- Talk to the listener as "you". Never mention being an AI, a prompt, facts or rules.
- No emojis, hashtags, quotation marks, asterisks, sound effects or stage directions.
- Don't open with "Alright", "Okay", "Hey there", "Welcome back", "Get ready" or "Up next", and don't reuse the openings of your recent lines.
- Reply with only the words you say on air.`;

const KIND_GUIDE = {
  opener: 'Open the show: a quick greeting that fits the time of day, then bring in the first song.',
  frontsell: 'Build a little anticipation for the next song, then name it.',
  backsell: 'Give the song that just played a one-phrase nod, then bring in the next one.',
  era: 'Point out the jump in time from the previous song\'s year to the next song\'s year, then bring in the next song.',
  favorite: 'Mention that this next one is a favorite of the listener (use the play count or that they liked it), then bring it in.',
  firstlisten: 'Mention the listener has never played the next song in Aura before, then bring it in.',
  deepcut: 'Tease that the next one is an unreleased cut from their collection, then bring it in.',
  samealbum: 'Note you are staying on the same album for another one, then bring in the next song.',
  checkin: 'Check in on the session (how many songs or minutes in), then bring in the next song.'
};

const EXAMPLES = [
  {
    user: 'Segment: backsell\nJust played: "Midnight Static" by Luna Park (2019, from the album Glass Hours).\nNext song: "Paper Suns" by Velvet Motel (2012, from the album Coastline). You have played it 9 times.\nIt is Tuesday night right now.',
    assistant: 'That was Luna Park keeping it moody. Now we rewind to 2012 for one you clearly love, nine plays deep: Velvet Motel, Paper Suns.'
  },
  {
    user: 'Segment: opener\nNext song: "Northern Lights" by Aria Vale featuring Theo Crane (2021, from the album Low Orbit).\nIt is Saturday morning right now.',
    assistant: 'Good morning and happy Saturday, you\'re locked in to Aura Radio. Easing into the weekend with Aria Vale and Theo Crane, this is Northern Lights.'
  }
];

function describeTrack(label, t) {
  if (!t) return '';
  const bits = [`${label}: "${t.title}" by ${t.artist}`];
  const where = [t.year, t.album ? `from the ${t.albumType || 'album'} ${t.album}` : null].filter(Boolean).join(', ');
  if (where) bits[0] += ` (${where})`;
  bits[0] += '.';
  if (t.year) { const age = new Date().getFullYear() - t.year; bits.push(age <= 0 ? 'It came out this year.' : age === 1 ? 'It came out last year.' : `It is ${age} years old.`); }
  if (t.bpm) bits.push(`Tempo: about ${Math.round(t.bpm)} BPM.`);
  if (t.unreleased) bits.push('It is unreleased.');
  if (t.plays) bits.push(`You have played it ${t.plays} time${t.plays === 1 ? '' : 's'}.`);
  else if (label === 'Next song') bits.push('You have never played it in Aura.');
  if (t.liked) bits.push('It is in your Liked Songs.');
  return bits.join(' ');
}

function buildUserPrompt(f) {
  const l = f.listener || {};
  return [
    `Segment: ${f.kind}. ${KIND_GUIDE[f.kind] || KIND_GUIDE.frontsell}`,
    describeTrack('Just played', f.prev),
    describeTrack('Next song', f.next),
    f.after ? `After that: "${f.after.title}" by ${f.after.artist}.` : '',
    l.timeOfDay ? `It is ${l.weekday ? l.weekday + ' ' : ''}${l.timeOfDay} right now, in ${new Date().getFullYear()}.` : '',
    l.songsThisSession ? `Session so far: ${l.songsThisSession} songs, ${l.minutesThisSession} minutes.` : '',
    l.topArtists && l.topArtists.length ? `Listener's most played artists: ${l.topArtists.join(', ')}.` : '',
    f.recentLines && f.recentLines.length ? `Your recent lines (say something different):\n- ${f.recentLines.join('\n- ')}` : ''
  ].filter(Boolean).join('\n');
}

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function cleanLine(raw) {
  let line = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')                 // reasoning models
    .replace(/\*[^*]{0,60}\*|\[[^\]]{0,60}\]|\([^)]*(music|laugh|sfx|pause)[^)]*\)/gi, ' ') // stage directions
    .replace(/^\s*(dj|host|aura radio|aura)\s*:\s*/i, '')
    .replace(/^\s*(here'?s|sure|okay,? here).{0,40}?:\s*/i, '')
    .replace(/["“”*#_]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  // keep at most two sentences
  const sentences = line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [line];
  line = sentences.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
  return line;
}

function acceptable(line, f) {
  const words = line.split(/\s+/).length;
  if (words < 7 || words > 42) return false;
  const n = norm(line);
  // must name the next song: its title, or the first two meaningful words of it
  const title = norm(f.next.title).replace(/\b(feat|featuring|ft|remix|version|live)\b.*$/, '').trim();
  const titleWords = title.split(' ').filter(w => w.length > 2 || /\d/.test(w));
  const namesTitle = title && (n.includes(title) || (titleWords.length && titleWords.slice(0, 2).every(w => n.includes(w))));
  if (!namesTitle) return false;
  // the next song must be the last one brought in (small models sometimes
  // reintroduce the previous song after it)
  if (f.prev) {
    const prevTitle = norm(f.prev.title);
    if (prevTitle && prevTitle !== title && n.lastIndexOf(prevTitle) > n.lastIndexOf(titleWords[0] || title)) return false;
  }
  // contradicting the clock, or inventing release plans
  const tod = norm((f.listener || {}).timeOfDay);
  const okGreeting = { morning: ['morning'], afternoon: ['afternoon'], evening: ['evening', 'night'], night: ['evening', 'night'], 'late night': ['evening', 'night', 'morning'] }[tod] || [];
  for (const w of ['morning', 'afternoon', 'evening', 'night']) if (n.includes('good ' + w) && tod && !okGreeting.includes(w)) return false;
  if (/(upcoming|forthcoming|new single|chart|grammy|billboard)/.test(n)) return false;
  if (/\b(as an ai|language model|the facts|prompt)\b/.test(n)) return false;
  for (const prev of f.recentLines || []) {
    const a = norm(prev).split(' ').slice(0, 4).join(' ');
    if (a && n.startsWith(a)) return false;
  }
  return true;
}

async function ask(model, f, temperature) {
  const messages = [{ role: 'system', content: SYSTEM }];
  for (const ex of EXAMPLES) messages.push({ role: 'user', content: ex.user }, { role: 'assistant', content: ex.assistant });
  messages.push({ role: 'user', content: buildUserPrompt(f) });
  const r = await fetch(base() + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, stream: false, keep_alive: '30m', think: false,
      options: { temperature, top_p: 0.9, repeat_penalty: 1.18, num_predict: 80, stop: ['\n\n', 'Segment:', 'Next song:'] }
    }),
    // lines are written a whole song ahead of time, so there's room to wait
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) {
    // older Ollama builds reject the `think` field: retry without it
    if (r.status === 400) {
      const r2 = await fetch(base() + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, keep_alive: '30m', options: { temperature, top_p: 0.9, repeat_penalty: 1.18, num_predict: 80 } }),
        signal: AbortSignal.timeout(25000)
      });
      if (r2.ok) return cleanLine((await r2.json()).message?.content);
    }
    return null;
  }
  const j = await r.json();
  return cleanLine(j.message && j.message.content);
}

/* ---------- fallback writing (no Ollama, or two bad answers) ---------- */

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function templateLine(f) {
  const n = f.next, p = f.prev, l = f.listener || {};
  const song = `${n.title} by ${n.artist}`;
  const lines = {
    opener: [
      `Good ${l.timeOfDay === 'late night' ? 'evening, night owl' : l.timeOfDay || 'day'}, you're tuned in to Aura Radio. We start things off with ${song}.`,
      `This is Aura Radio, and it's all your music tonight. First up, ${song}.`,
      `Happy ${l.weekday || 'day'}, and thanks for tuning in. Let's open the show with ${n.artist}, this is ${n.title}.`
    ],
    backsell: p ? [
      `That was ${p.title} from ${p.artist}. Keeping the momentum going, here's ${song}.`,
      `${p.title} still ringing out. Next, ${n.artist} with ${n.title}.`
    ] : [],
    era: p && p.year && n.year ? [
      `From ${p.year} we're jumping ${n.year > p.year ? 'forward' : 'back'} to ${n.year}. This is ${song}.`,
      `Time machine moment, ${Math.abs(n.year - p.year)} years ${n.year > p.year ? 'ahead' : 'back'}. ${n.artist}, ${n.title}.`
    ] : [],
    favorite: [
      n.plays ? `You've played this one ${n.plays} times, so I know you're ready. ${song}.` : `Straight from your Liked Songs, here's ${song}.`,
      `One of your favorites coming right up. ${n.artist}, ${n.title}.`
    ],
    firstlisten: [
      `Here's one you haven't played in Aura yet. Give it a fair shot, ${song}.`,
      `Fresh ears on this next one, first time through. ${n.artist} with ${n.title}.`
    ],
    deepcut: [
      `Digging into the vault for an unreleased one. This is ${song}.`,
      `Deep cut time, straight from the unreleased stash. ${n.artist}, ${n.title}.`
    ],
    samealbum: [
      `We're staying on ${n.album || 'this record'} a little longer. Here's ${n.title}.`,
      `Another one from ${n.album || 'the same album'}, because why stop now. ${n.title}.`
    ],
    checkin: [
      `${l.songsThisSession} songs into the session and we're not slowing down. Here's ${song}.`,
      `${l.minutesThisSession} minutes of nonstop music so far. Keep it going with ${song}.`
    ],
    frontsell: [
      `Keeping the vibe right where it should be. This is ${song}.`,
      `No skips in this set. ${n.artist} coming in with ${n.title}.`,
      `Turn this next one up a little. ${song}.`
    ]
  };
  const pool = (lines[f.kind] && lines[f.kind].length ? lines[f.kind] : lines.frontsell);
  return pick(pool.filter(x => !(f.recentLines || []).includes(x))) || pick(lines.frontsell);
}

// kept for any older caller: plain "next up" line from {title, artist}
function fallbackLine(next) {
  return templateLine({ kind: 'frontsell', next: { title: next.title, artist: next.artist } });
}

/* One spoken DJ segment. Accepts the rich facts object from dj.js, and the
   old { next, after, recent, topArtists, opener } shape too. */
async function djLine(input) {
  if (!input || !input.next) return null;
  const f = input.kind ? input : {
    kind: input.opener ? 'opener' : 'frontsell',
    next: input.next, prev: null, after: input.after,
    listener: { topArtists: input.topArtists || [] }, recentLines: []
  };
  const model = store.settings().djModel;
  if (!model || !(await ping(1200))) return templateLine(f);
  for (const temperature of [0.8, 0.65, 0.5]) {
    try {
      const line = await ask(model, f, temperature);
      if (line && acceptable(line, f)) return line;
    } catch { break; }
  }
  return templateLine(f);
}

module.exports = { init, ping, ensureRunning, listModels, pickModel, warm, release, djLine, fallbackLine, _test: { cleanLine, acceptable, buildUserPrompt, templateLine } };
