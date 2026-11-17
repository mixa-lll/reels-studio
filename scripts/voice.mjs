#!/usr/bin/env node
// The voice of a take, as PLAYBOOK wants it: mono, one linear gain to the peak, no loudnorm,
// no limiter, no filters; optional lead-in of silence.
//   node scripts/voice.mjs <take> <out.wav> [--from s] [--to s] [--peak -1] [--lead 0.6]
// Mono BEFORE the delay: adelay on stereo delays only the left channel and a later -ac 1
// folds the voice with its own copy (the «every phrase twice» echo of reel 11 v1–v2).
// Remotion plays a mono voice ~3 dB lower; scripts/qc.mjs on the render shows the peak.
import {spawnSync} from 'node:child_process';
import {ffCommand} from '../bot/media.mjs';

const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv.splice(i, 2)[1]) : d;
};
const from = opt('from', 0), to = opt('to', undefined), peak = opt('peak', -1), lead = opt('lead', 0);
const [take, out] = argv;
if (!take || !out) {
  console.error('Usage: node scripts/voice.mjs <take> <out.wav> [--from s] [--to s] [--peak -1] [--lead 0.6]');
  process.exit(1);
}
const ffm = (args) => {
  const [c, a] = ffCommand('ffmpeg', args);
  return spawnSync(c, a, {encoding: 'utf8', maxBuffer: 64 << 20});
};
const range = ['-ss', String(from), ...(to !== undefined ? ['-t', String(to - from)] : [])];
const mono = 'aformat=channel_layouts=mono';
const m = ffm(['-hide_banner', '-nostats', ...range, '-i', take, '-vn', '-af', `${mono},volumedetect`, '-f', 'null', '-']);
const max = Number((/max_volume: (-?[\d.]+) dB/.exec(m.stderr) || [])[1]);
if (!Number.isFinite(max)) {
  console.error('no audio in', take, m.stderr.slice(-800));
  process.exit(1);
}
const gain = Math.round((peak - max) * 100) / 100;
const chain = [mono, `volume=${gain}dB`, ...(lead > 0 ? [`adelay=${Math.round(lead * 1000)}`] : [])].join(',');
const r = ffm(['-v', 'error', '-y', ...range, '-i', take, '-vn', '-af', chain, '-ar', '48000', '-c:a', 'pcm_s16le', out]);
if (r.status !== 0) {
  console.error(r.stderr.slice(-1500));
  process.exit(1);
}
console.log(`→ ${out}: mono, peak ${max} → ${peak} dBFS (gain ${gain >= 0 ? '+' : ''}${gain} dB)${lead ? `, lead-in ${lead} s` : ''}`);
