/* gen-test-audio.js — generates a handful of short, tagged WAV files so playback,
   seeking, and crossfade can be verified without needing a real music library,
   and so library.js's scan + merge logic has something real to test against.
   Tags are embedded as a RIFF LIST/INFO chunk (INAM/IART/IPRD/IPRT/ICRD/IGNR),
   which music-metadata reads natively for WAV files.
   Run with: node scripts/gen-test-audio.js [outDir] */
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '.test-music');
fs.mkdirSync(OUT, { recursive: true });

function pcmSine(seconds, freq, sampleRate = 44100) {
  const n = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 800, (n - i) / 800); // tiny fade in/out, avoids clicks
    const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.28 * fade;
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

function chunk(id, data) {
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const size = Buffer.alloc(4); size.writeUInt32LE(data.length, 0);
  return Buffer.concat([Buffer.from(id, 'ascii'), size, data, pad]);
}

function infoList(fields) {
  const subs = Object.entries(fields).map(([id, val]) => chunk(id, Buffer.from(String(val) + '\0', 'ascii')));
  return chunk('LIST', Buffer.concat([Buffer.from('INFO', 'ascii'), ...subs]));
}

function buildWav({ seconds, freq, tags }) {
  const sampleRate = 44100, channels = 1, bitsPerSample = 16;
  const pcm = pcmSine(seconds, freq, sampleRate);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 8);
  fmt.writeUInt16LE(channels * bitsPerSample / 8, 12); fmt.writeUInt16LE(bitsPerSample, 14);
  const parts = [chunk('fmt ', fmt), infoList(tags), chunk('data', pcm)];
  const body = Buffer.concat(parts);
  const riff = Buffer.concat([Buffer.from('WAVE', 'ascii'), body]);
  return chunk('RIFF', riff);
}

const TRACKS = [
  { file: 'aura-test-01.wav', seconds: 8, freq: 440, tags: { INAM: 'Aura Test One', IART: 'Aura Test Artist', IPRD: 'Aura Test Album', IPRT: '1', ICRD: '2024', IGNR: 'Test' } },
  { file: 'aura-test-02.wav', seconds: 6, freq: 523.25, tags: { INAM: 'Aura Test Two', IART: 'Aura Test Artist', IPRD: 'Aura Test Album', IPRT: '2', ICRD: '2024', IGNR: 'Test' } },
  { file: 'aura-test-03.wav', seconds: 5, freq: 659.25, tags: { INAM: 'Aura Test Three', IART: 'Aura Test Artist Two', IPRD: 'Aura Test Album Two', IPRT: '1', ICRD: '2025', IGNR: 'Test' } }
];

for (const t of TRACKS) {
  fs.writeFileSync(path.join(OUT, t.file), buildWav(t));
  console.log('wrote', t.file, t.seconds + 's', t.freq + 'Hz');
}
console.log('\nTest music folder:', OUT);
console.log('Add it as a music folder in Aura (Settings > Add folder) to verify playback.');
