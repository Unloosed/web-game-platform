// Generates the built-in game SFX as small WAV files and stores them via
// the platform storage adapter (local disk by default, S3 when env is set
// — mirroring the API's adapter choice). Run: pnpm assets:seed
// No audio dependencies: clips are synthesized PCM.

import { LocalDiskStorage } from "../packages/storage/src/index.js";

const RATE = 22_050;

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  samples.forEach((s, i) =>
    buf.writeInt16LE(
      Math.max(-32767, Math.min(32767, Math.round(s * 32767))),
      44 + i * 2,
    ),
  );
  return buf;
}

/** Sequence of {f: freq Hz, d: duration s} notes with a plucked envelope. */
function melody(notes) {
  const out = [];
  for (const { f, d } of notes) {
    const n = Math.round(d * RATE);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const env = Math.min(1, i / 64) * (1 - i / n) ** 1.5;
      out.push(Math.sin(2 * Math.PI * f * t) * 0.5 * env);
    }
  }
  return out;
}

const clips = [
  // Short rising blip: a player scored (tag or orb).
  ["sfx-score.wav", melody([{ f: 660, d: 0.07 }, { f: 990, d: 0.09 }])],
  // Little fanfare: the match completed.
  [
    "sfx-match-end.wav",
    melody([
      { f: 523, d: 0.12 },
      { f: 659, d: 0.12 },
      { f: 784, d: 0.12 },
      { f: 1046, d: 0.28 },
    ]),
  ],
];

const storage = new LocalDiskStorage(process.env.STORAGE_DIR ?? "data/assets");
for (const [key, samples] of clips) {
  const { etag } = await storage.put(wav(samples), key);
  console.log(`seeded ${key} (${samples.length * 2} bytes, etag ${etag})`);
}
