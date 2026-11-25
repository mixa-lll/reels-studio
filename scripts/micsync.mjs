#!/usr/bin/env node
// The lavalier synced to the camera by their sound — no clapper, no model, seconds.
//
//   node scripts/micsync.mjs <camera video> <lavalier audio> <out.wav>
//
// Both are read as 8 kHz mono. The offset is found in three passes: the loudness envelopes at 10 points a
// second over every possible lag (the recorder may start minutes before or after the camera), then at 100
// points a second around the best one, then the sound itself (8 kHz) within ±15 ms — to a fraction of a
// millisecond. Then the same is measured in windows along the recording: two devices' clocks drift apart
// (tens of ms over 12 min), so the lavalier is also stretched to the camera's clock. The result is the
// lavalier on the camera's timeline — second t of the camera = second t of out.wav — 48 kHz mono 16-bit.
// Prints JSON {offset (s: camera t ↔ lavalier t + offset), drift (ms over the recording), score (0–1), ms}.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ffCommand} from '../bot/media.mjs';

const RATE = 8000;

function pcm(file) {
  const [cmd, full] = ffCommand('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-']);
  return new Promise((ok, no) => {
    const c = spawn(cmd, full, {stdio: ['ignore', 'pipe', 'pipe']}), parts = [];
    let err = '';
    c.stdout.on('data', (b) => parts.push(b));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => { if (code) return no(new Error(err.trim().split('\n').pop() || `ffmpeg ${code}`)); const b = Buffer.concat(parts); ok(new Int16Array(b.buffer, b.byteOffset, b.length >> 1)); });
    c.on('error', no);
  });
}

// Loudness per window (mean |x|), the mean taken away: speech shapes, not the room's hum.
function envelope(x, per) {
  const n = Math.floor(x.length / per), e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * per, k = j + per; j < k; j++) s += Math.abs(x[j]); e[i] = s / per; }
  let m = 0; for (const v of e) m += v; m /= n || 1;
  for (let i = 0; i < n; i++) e[i] -= m;
  return e;
}

// Normalised correlation of a and b with b shifted by lag (a[i] ↔ b[i + lag]), over their overlap.
function corr(a, b, lag, from = 0, to = a.length) {
  let s = 0, sa = 0, sb = 0;
  const lo = Math.max(from, -lag), hi = Math.min(to, b.length - lag);
  if (hi - lo < 10) return -1;
  for (let i = lo; i < hi; i++) { const x = a[i], y = b[i + lag]; s += x * y; sa += x * x; sb += y * y; }
  return sa && sb ? s / Math.sqrt(sa * sb) : -1;
}

function best(a, b, lags, from, to) {
  let bl = 0, bs = -2;
  for (const l of lags) { const s = corr(a, b, l, from, to); if (s > bs) { bs = s; bl = l; } }
  return {lag: bl, score: bs};
}
const range = (lo, hi) => Array.from({length: hi - lo + 1}, (_, i) => lo + i);

/** camera, mic: Int16Array at RATE → {offset (s), drift (ms over the camera), score, at: [[t, offset]]} */
export function findOffset(cam, mic) {
  // 1. Envelopes at 10 / s over every lag that leaves ≥ 20 s of overlap.
  const c10 = envelope(cam, RATE / 10), m10 = envelope(mic, RATE / 10);
  const coarse = best(c10, m10, range(-(c10.length - 200), m10.length - 200));
  // 2. At 100 / s, ±0.3 s around it.
  const c100 = envelope(cam, RATE / 100), m100 = envelope(mic, RATE / 100), l100 = coarse.lag * 10;
  const mid = best(c100, m100, range(l100 - 30, l100 + 30));
  // 3. Envelopes at 1000 / s (1 ms — the two microphones differ in phase, not in loudness), ±40 ms around
  //    it, over 20 s windows: the loudest one the two share for the offset, then one a minute for the drift.
  const c1k = envelope(cam, RATE / 1000), m1k = envelope(mic, RATE / 1000), lag0 = mid.lag * 10;
  const fine = (centre, l0, span = 40, half = 10000) => best(c1k, m1k, range(l0 - span, l0 + span), Math.max(0, centre - half), Math.min(c1k.length, centre + half));
  let loud = 0, lv = -1e9;
  for (let i = 0; i + 200 <= c10.length; i += 20) { if (i + coarse.lag < 0 || i + 200 + coarse.lag > m10.length) continue; let sum = 0; for (let q = i; q < i + 200; q++) sum += Math.abs(c10[q]); if (sum > lv) { lv = sum; loud = i + 100; } }
  const main = fine(loud * 100, lag0);
  const at = [];
  for (let t = 20000; t < c1k.length - 20000; t += 30000) {
    if (t - 20000 + main.lag < 0 || t + 20000 + main.lag >= m1k.length) continue;
    const w = fine(t, main.lag, 120, 20000);
    if (w.score > 0.5) at.push([t / 1000, w.lag / 1000]);
  }
  // Drift: the median of the slopes between every two windows (one noisy window does not tilt it), the
  // line through the median point; kept when it is over 8 ms across the recording and the windows follow it.
  let k = 0, b0 = main.lag / 1000;
  if (at.length >= 4) {
    const med = (v) => { const x = [...v].sort((p, q) => p - q); return x.length % 2 ? x[x.length >> 1] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2; };
    const sl = [];
    for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) if (at[j][0] - at[i][0] > 60) sl.push((at[j][1] - at[i][1]) / (at[j][0] - at[i][0]));
    const kk = sl.length ? med(sl) : 0, bb = med(at.map((x) => x[1] - kk * x[0]));
    const dev = med(at.map((x) => Math.abs(x[1] - (bb + kk * x[0]))));
    if (dev < 0.012 && Math.abs(kk * (cam.length / RATE)) > 0.008) { k = kk; b0 = bb; }
  }
  return {offset: b0, k, drift: Math.round(k * (cam.length / RATE) * 1000), score: +main.score.toFixed(3), at};
}

/** ffmpeg arguments: the lavalier on the camera's timeline, from its offset and drift (mic t = cam t·(1+k) + offset). */
export function syncedArgs(micFile, out, {offset, k = 0}) {
  const af = ['aresample=48000', 'aformat=sample_fmts=s16:channel_layouts=mono'];
  // A recorder that started late (offset < 0): silence first, so the camera's second t stays second t.
  if (offset < 0) af.unshift(`adelay=${Math.round(-offset * 1000)}:all=1`);
  // Its clock a little fast or slow: played that much slower or faster, onto the camera's clock.
  if (k) af.push(`atempo=${(1 + k).toFixed(7)}`);
  return ['-v', 'error', '-y', ...(offset > 0 ? ['-ss', offset.toFixed(5)] : []), '-i', micFile, '-vn', '-af', af.join(','), '-c:a', 'pcm_s16le', out];
}

export async function micSync(camFile, micFile, out, {nudge = 0} = {}) {
  const t = Date.now();
  const [cam, mic] = await Promise.all([pcm(camFile), pcm(micFile)]);
  const r = findOffset(cam, mic);
  r.offset += nudge;
  const [cmd, full] = ffCommand('ffmpeg', syncedArgs(micFile, out, r));
  await new Promise((ok, no) => { const c = spawn(cmd, full, {stdio: ['ignore', 'ignore', 'pipe']}); let err = ''; c.stderr.on('data', (d) => (err += d)); c.on('close', (code) => (code ? no(new Error(err.trim().split('\n').pop() || `ffmpeg ${code}`)) : ok())); });
  return {offset: +r.offset.toFixed(4), drift: r.drift, k: r.k, score: r.score, windows: r.at.length, ms: Date.now() - t};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cam, mic, out, nudge] = process.argv.slice(2);
  if (!out) { console.log('node scripts/micsync.mjs <camera video> <lavalier audio> <out.wav> [nudge s]'); process.exit(1); }
  console.log(JSON.stringify(await micSync(cam, mic, out, {nudge: Number(nudge) || 0})));
}
