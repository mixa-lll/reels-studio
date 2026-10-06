#!/usr/bin/env node
// Two-pass loudness normalisation to -15 LUFS with a limiter; video is copied as is.
// Uses system ffmpeg when present, otherwise the one bundled with Remotion.
// Usage: node scripts/loudnorm.mjs <in.mp4> <out.mp4>
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node scripts/loudnorm.mjs <in.mp4> <out.mp4>');
  process.exit(1);
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], {stdio: 'ignore'}).status === 0;
const remotion = join(ROOT, 'template', 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
function ff(args) {
  const ffArgs = ['-hide_banner', ...args];
  const [cmd, full] = hasFfmpeg ? ['ffmpeg', ffArgs] : [process.execPath, [remotion, 'ffmpeg', ...ffArgs]];
  const r = spawnSync(cmd, full, {encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20});
  if (r.status !== 0) throw new Error(r.stderr.split('\n').slice(-5).join('\n'));
  return r.stderr + r.stdout;
}

const target = 'I=-15:TP=-1.5:LRA=11';
const measured = JSON.parse(ff(['-i', input, '-vn', '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']).match(/\{[\s\S]*\}/)[0]);
const m = `measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
// Remotion's trimmed ffmpeg has no alimiter; loudnorm's own true-peak limit then has to do.
const limiter = /\balimiter\b/.test(ff(['-filters'])) ? ',alimiter=limit=0.89' : '';
ff(['-loglevel', 'error', '-y', '-i', input, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-af', `loudnorm=${target}:${m}${limiter}`, output]);

// Report the result so the agent can check it, not guess it.
const check = JSON.parse(ff(['-i', output, '-vn', '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']).match(/\{[\s\S]*\}/)[0]);
console.log(`Integrated: ${check.input_i} LUFS, true peak: ${check.input_tp} dBTP`);
