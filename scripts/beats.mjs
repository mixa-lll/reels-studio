#!/usr/bin/env node
// Tempo, beats and bar starts of a track, in plain Node (no Python):
//   node scripts/beats.mjs <audio>   → JSON {bpm, barSeconds, firstBeat, beats, bars}
// Onset envelope from frame energy; the tempo whose beat grid lines up best with the
// hits over the whole track; then the bar phase where the strongest hits land.
// Check the tempo against the kicks by ear: trap often comes out at half tempo.
import {spawnSync} from 'node:child_process';
import {ffCommand} from '../bot/media.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/beats.mjs <audio>');
  process.exit(1);
}

const RATE = 22050;
const HOP = 512;
const FPS = RATE / HOP;

// Decode to 16-bit mono WAV on stdout: every ffmpeg build (including Remotion's) has it.
const [cmd, args] = ffCommand('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', '-f', 'wav', '-']);
const r = spawnSync(cmd, args, {maxBuffer: 1 << 30, windowsHide: true});
if (r.status !== 0) {
  console.error(String(r.stderr));
  process.exit(1);
}
const wav = r.stdout;
const dataAt = wav.indexOf('data', 12) + 8;
const pcm = new Float32Array(Math.floor((wav.length - dataAt) / 2));
for (let i = 0; i < pcm.length; i++) pcm[i] = wav.readInt16LE(dataAt + i * 2) / 32768;

// Onset strength: rise of log energy per hop.
const frames = Math.floor(pcm.length / HOP);
const energy = new Float64Array(frames);
for (let i = 0; i < frames; i++) {
  let e = 0;
  for (let j = i * HOP; j < (i + 1) * HOP; j++) e += pcm[j] * pcm[j];
  energy[i] = Math.log1p(1000 * e);
}
const onset = new Float64Array(frames);
for (let i = 1; i < frames; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
const mean = onset.reduce((a, b) => a + b, 0) / frames;

// How well a beat grid of `period` frames lines up with the hits: mean onset strength
// at its best phase (±1 frame), relative to the track's mean. Returns [score, phase].
function grid(period) {
  let best = [0, 0];
  for (let o = 0; o < period; o += 0.5) {
    let s = 0;
    let k = 0;
    for (let f = o; f < frames; f += period, k++) {
      const i = Math.round(f);
      s += Math.max(onset[i] ?? 0, onset[i - 1] ?? 0, onset[i + 1] ?? 0);
    }
    if (s / k > best[0]) best = [s / k, o];
  }
  return [best[0] / mean, best[1]];
}

// Tempo: the grid that fits best over the whole track, 70–180 BPM in 0.1 steps (a wrong
// tempo drifts off the beat within bars), mildly preferring the usual 90–140, then refined.
const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 115) / 1.2) ** 2);
let bpm = 120;
let top = -Infinity;
for (let b = 70; b <= 180; b += 0.1) {
  const s = grid((60 * FPS) / b)[0] * prior(b);
  if (s > top) [top, bpm] = [s, b];
}
for (let b = bpm - 0.1; b <= bpm + 0.1; b += 0.01) {
  const s = grid((60 * FPS) / b)[0] * prior(b);
  if (s > top) [top, bpm] = [s, b];
}
const period = (60 * FPS) / bpm;
const phase = grid(period)[1];

// Bars: of the 4 beats, the one where the strongest hits (kicks) land starts the bar.
const phaseScore = (offset, step) => {
  let s = 0;
  for (let f = offset; f < frames; f += step) s += onset[Math.round(f)] ?? 0;
  return s;
};
let barPhase = phase;
for (let b = 0, best = -1; b < 4; b++) {
  const s = phaseScore(phase + b * period, period * 4);
  if (s > best) [best, barPhase] = [s, phase + b * period];
}

const t = (frame) => Math.round((frame / FPS) * 1000) / 1000;
const beats = [];
for (let f = phase; f < frames; f += period) beats.push(t(f));
const bars = [];
for (let f = barPhase; f < frames; f += period * 4) bars.push(t(f));
console.log(JSON.stringify({bpm: Math.round(bpm * 10) / 10, barSeconds: Math.round((240 / bpm) * 1000) / 1000, firstBeat: beats[0] ?? 0, beats, bars}, null, 1));
