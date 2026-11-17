#!/usr/bin/env node
// Where speech is in footage, by audio energy (Whisper's word times drift by up to 0.7 s,
// energy does not): node scripts/speech.mjs <media> [--db -35] [--gap 0.35] [--pad 0.05]
// Prints JSON [{start, end}] in seconds: stretches louder than --db (dBFS), joined across
// pauses shorter than --gap, widened by --pad. Trim each take to the stretch its words fall
// in, with ~0.1 s between lines. Too much cut: lower --db (-40); room noise kept: raise it.
import {spawnSync} from 'node:child_process';
import {ffCommand} from '../bot/media.mjs';

const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv.splice(i, 2)[1]) : d;
};
const db = opt('db', -35), gap = opt('gap', 0.35), pad = opt('pad', 0.05);
const file = argv[0];
if (!file) {
  console.error('Usage: node scripts/speech.mjs <media> [--db -35] [--gap 0.35] [--pad 0.05]');
  process.exit(1);
}
const [cmd, args] = ffCommand('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-ac', '1',
  '-af', `highpass=f=80,silencedetect=noise=${db}dB:d=${gap}`, '-f', 'null', '-']);
const r = spawnSync(cmd, args, {encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true});
if (r.status !== 0) {
  console.error(r.stderr.slice(-2000));
  process.exit(1);
}
const dur = (/Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr) || []).slice(1).map(Number);
const total = dur.length ? dur[0] * 3600 + dur[1] * 60 + dur[2] : Infinity;
const silences = [];
for (const m of r.stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
  if (m[1] === 'start') silences.push([Math.max(0, Number(m[2])), total]);
  else if (silences.length) silences[silences.length - 1][1] = Number(m[2]);
}
const out = [];
let at = 0;
for (const [s, e] of silences) {
  if (s > at) out.push({start: at, end: s});
  at = e;
}
if (at < total && total !== Infinity) out.push({start: at, end: total});
const r3 = (x) => Math.round(x * 1000) / 1000;
const speech = out.filter((x) => x.end - x.start > 0.15)
  .map((x) => ({start: r3(Math.max(0, x.start - pad)), end: r3(Math.min(total, x.end + pad))}));
console.log(JSON.stringify(speech));
