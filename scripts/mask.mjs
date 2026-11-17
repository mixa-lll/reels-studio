#!/usr/bin/env node
// Cut-out of the person in footage (Apple Vision, macOS only), as in reels 11 and 15:
//   node scripts/mask.mjs <video> <out.webm> [--from s] [--to s] [--matte mask.mp4]
// Writes the footage with the person kept and the rest transparent (VP9 + alpha, frame n =
// frame n of the source from --from), smoothed in time (3 frames) and at the edge. Lay it
// over the graphics: <OffthreadVideo src={staticFile('person.webm')} transparent muted/>, so
// text or a map stands between the wall and the person. --matte also keeps the grey mask.
// About 6 frames a second on an M-series Mac: a 1-minute 60 fps take takes ~10 min — run it
// in the background and mask only the stretches the reel uses.
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {ff, probe, visionTool} from './vision.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const from = Number(opt('from') || 0);
const toArg = opt('to');
const matteOut = opt('matte');
const [video, out] = argv;
if (!video || !out || !(from >= 0) || (toArg !== undefined && !(Number(toArg) > from))) {
  console.error('Usage: node scripts/mask.mjs <video> <out.webm> [--from s] [--to s] [--matte mask.mp4]');
  process.exit(1);
}

const pipe = (a, b) => new Promise((ok, fail) => {
  a.stdout.pipe(b.stdin);
  let left = 2;
  const done = (name) => (code) => code === 0 ? (--left || ok()) : fail(new Error(`${name} exited ${code}`));
  a.on('close', done('decoder')); b.on('close', done('next step'));
});
const run = ([cmd, args], opts = {}) => spawn(cmd, args, {stdio: ['ignore', 'inherit', 'inherit'], ...opts});

const t0 = Date.now();
const tmp = mkdtempSync(join(tmpdir(), 'reels-mask-'));
try {
  const bin = visionTool();
  const {w, h, fps, duration} = probe(resolve(video));
  const to = toArg !== undefined ? Math.min(Number(toArg), duration) : duration;
  const range = ['-ss', String(from), '-t', String(to - from)];
  console.log(`${w}×${h}, ${fps.toFixed(2)} fps, ${from}–${to.toFixed(1)} s ≈ ${Math.round((to - from) * fps)} frames`);
  const raw = join(tmp, 'raw.mp4');
  // 1. Decode → Vision → grey mask, near-lossless.
  const [dc, da] = ff('ffmpeg', ['-v', 'error', ...range, '-i', resolve(video), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const dec = spawn(dc, da, {stdio: ['ignore', 'pipe', 'inherit']});
  const vis = spawn(bin, ['matte', String(w), String(h)], {stdio: ['pipe', 'pipe', 'ignore']});
  const [ec, ea] = ff('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(fps), '-i', '-',
    '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv420p', raw]);
  const enc = spawn(ec, ea, {stdio: ['pipe', 'inherit', 'inherit']});
  await Promise.all([pipe(dec, vis), pipe(vis, enc)]);
  // 2. Smooth in time and at the edge; 3. the source with that alpha, as VP9 + alpha.
  const smooth = "format=gray,tmix=frames=3:weights='1 2 1',gblur=sigma=1.6,lut=y='clip((val-30)*1.2\\,0\\,255)'";
  const matte = matteOut ? resolve(matteOut) : join(tmp, 'matte.mp4');
  await new Promise((ok, fail) => run(ff('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', smooth, '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv420p', matte]))
    .on('close', (c) => c === 0 ? ok() : fail(new Error('smoothing failed'))));
  await new Promise((ok, fail) => run(ff('ffmpeg', ['-v', 'error', '-y', ...range, '-i', resolve(video), '-i', matte, '-filter_complex',
    '[0:v]format=yuv420p[v];[1:v]format=gray[m];[v][m]alphamerge,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-b:v', '0', '-crf', '10', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '5', '-auto-alt-ref', '0', '-an', resolve(out)]))
    .on('close', (c) => c === 0 ? ok() : fail(new Error('VP9 encode failed'))));
  console.log(`→ ${resolve(out)} (${(statSync(resolve(out)).size / 1e6).toFixed(0)} MB)${matteOut ? ` + ${matte}` : ''}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} catch (e) {
  console.error('mask failed:', e.message);
  process.exitCode = 1;
} finally {
  rmSync(tmp, {recursive: true, force: true});
}
