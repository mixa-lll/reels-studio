#!/usr/bin/env node
// Check a rendered reel before handing it over: node scripts/qc.mjs <video>
// Prints size, resolution, fps, length, bitrate, codecs, loudness (LUFS), true peak and
// warnings: an echoed voice (the track correlates with itself 0.05–1 s later — a stereo
// delay folded to mono), clipping, silence at 0 s (players swallow ~0.2 s), a size over
// Telegram's 50 MB, and frames off the 1080×1920 / 1440×2560 grid.
import {spawnSync} from 'node:child_process';
import {statSync} from 'node:fs';
import {ffCommand} from '../bot/media.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/qc.mjs <video>');
  process.exit(1);
}
const run = (bin, args, opts = {}) => {
  const [c, a] = ffCommand(bin, args);
  return spawnSync(c, a, {maxBuffer: 1 << 30, ...opts});
};
const info = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,channels:format=duration,bit_rate', '-of', 'json', file], {encoding: 'utf8'}).stdout);
const v = info.streams.find((s) => s.codec_type === 'video');
const a = info.streams.find((s) => s.codec_type === 'audio');
const dur = Number(info.format.duration);
const size = statSync(file).size;
const out = {file, sizeMB: +(size / 1e6).toFixed(1), seconds: +dur.toFixed(2), bitrateMbps: +(Number(info.format.bit_rate) / 1e6).toFixed(1)};
const warn = [];
if (v) {
  const [n, d] = v.r_frame_rate.split('/').map(Number);
  Object.assign(out, {video: `${v.codec_name} ${v.width}×${v.height} ${+(n / d).toFixed(2)} fps`});
  if (!['1080x1920', '1440x2560', '720x1280'].includes(`${v.width}x${v.height}`)) warn.push(`frame ${v.width}×${v.height} is not 9:16 1080×1920 / 1440×2560`);
}
if (size > 50 * 1024 * 1024) warn.push('over 50 MB: Telegram takes it only via the page or a link');
if (a) {
  const e = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], {encoding: 'utf8'}).stderr;
  const lufs = Number((/I:\s+(-?[\d.]+) LUFS/.exec(e.slice(e.lastIndexOf('Summary'))) || [])[1]);
  const tp = Number((/Peak:\s+(-?[\d.]+) dBFS/.exec(e.slice(e.lastIndexOf('Summary'))) || [])[1]);
  Object.assign(out, {audio: `${a.codec_name} ${a.channels} ch`, lufs, truePeak: tp});
  if (tp > -0.5) warn.push(`true peak ${tp} dBFS: may clip (aim ≤ −1)`);
  // Mono samples at 4 kHz: the start, and the echo check on up to 30 s from the middle.
  const pcmBuf = run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '4000', '-f', 's16le', '-']).stdout;
  const pcm = new Float32Array(pcmBuf.length / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = pcmBuf.readInt16LE(i * 2) / 32768;
  const first = pcm.findIndex((x) => Math.abs(x) > 0.1);
  if (first >= 0 && first / 4000 < 0.1) warn.push(`sound starts at ${(first / 4000).toFixed(2)} s: players swallow ~0.2 s, add a lead-in`);
  const mid = Math.max(0, Math.floor(pcm.length / 2) - 60000), seg = pcm.subarray(mid, Math.min(pcm.length, mid + 120000));
  let e0 = 0;
  for (const x of seg) e0 += x * x;
  let best = 0, lag = 0;
  for (let L = 200; L <= 4000 && L < seg.length / 2; L += 2) {
    let s = 0;
    for (let i = 0; i + L < seg.length; i++) s += seg[i] * seg[i + L];
    const c = e0 ? s / e0 : 0;
    if (c > best) { best = c; lag = L; }
  }
  out.echo = {correlation: +best.toFixed(2), lagSeconds: +(lag / 4000).toFixed(2)};
  if (best > 0.35) warn.push(`echo: the track repeats itself ${(lag / 4000).toFixed(2)} s later (corr ${best.toFixed(2)}) — a stereo delay folded to mono?`);
} else warn.push('no audio track');
out.warnings = warn;
console.log(JSON.stringify(out, null, 1));
