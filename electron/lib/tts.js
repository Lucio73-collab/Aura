/* tts.js — Kokoro TTS, fully local. Lazy-loads on first use.
   Returns a WAV ArrayBuffer, or null so the renderer falls back to system voices. */
const path = require('path');

let store = null;
let tts = null;
let state = 'idle'; // idle | loading | ready | standby (unloaded after idle) | failed
let loadPromise = null;

// The loaded voice model plus its ONNX runtime hold a few hundred MB in the
// main process. An active DJ talks every few songs, well inside this window,
// so it never pays a reload; once the DJ has been quiet this long (switched
// off, music paused) the memory is handed back and reloads on the next line.
const IDLE_UNLOAD_MS = 20 * 60 * 1000;
let idleTimer = null;
let busy = 0;

function init(s) { store = s; }

function scheduleUnload() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (busy || state !== 'ready' || !tts) return;
    const engine = tts;
    tts = null;
    state = 'standby'; // downloaded, just not held in memory
    try { if (engine.model && engine.model.dispose) await engine.model.dispose(); } catch {}
    console.log('Kokoro TTS unloaded (idle)');
  }, IDLE_UNLOAD_MS);
}

async function load() {
  if (state === 'ready') return tts;
  if (loadPromise) return loadPromise;
  state = 'loading';
  loadPromise = (async () => {
    try {
      // keep the model inside Aura's data folder so it survives updates
      process.env.HF_HOME = process.env.HF_HOME || path.join(store.dir(), 'models');
      try {
        const tf = await import('@huggingface/transformers');
        if (tf && tf.env) tf.env.cacheDir = path.join(store.dir(), 'models');
      } catch {}
      const { KokoroTTS } = await import('kokoro-js');
      tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
      state = 'ready';
      scheduleUnload();
      console.log('Kokoro TTS ready');
      return tts;
    } catch (e) {
      state = 'failed';
      console.warn('Kokoro unavailable, falling back to system voices:', e.message);
      return null;
    } finally { loadPromise = null; }
  })();
  return loadPromise;
}

async function speak(text) {
  if (!text) return null;
  if (state === 'failed') return null;
  busy++;
  try {
    const engine = await load();
    if (!engine) return null;
    const voice = store.settings().djVoice || 'am_onyx';
    const audio = await engine.generate(String(text).slice(0, 400), { voice });
    if (audio && typeof audio.toWav === 'function') {
      const wav = audio.toWav();
      return Buffer.from(wav instanceof ArrayBuffer ? wav : wav.buffer);
    }
  } catch (e) { console.warn('TTS generate failed:', e.message); }
  finally { busy--; scheduleUnload(); }
  return null;
}

const status = () => state;

module.exports = { init, load, speak, status };
