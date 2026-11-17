#!/usr/bin/env node
// Where the face is in footage (Apple Vision, macOS only), for keeping graphics off it:
//   node scripts/faces.mjs <video> [--every 0.5] [--pad 0.15]
// Prints JSON {w, h, every, box, track: [{t, x, y, w, h}]}: the face of the biggest person
// every --every seconds, widened by --pad of its size (hair, ears; Vision's box is tight),
// and `box` — one rectangle that holds them all, ready for a FaceShot-style guard
// ({top, bottom, left, right}). Graphics go above the head, to the side or under the chin.
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {ff, probe, visionTool} from './vision.mjs';

const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv.splice(i, 2)[1]) : d;
};
const every = opt('every', 0.5), pad = opt('pad', 0.15);
const video = argv[0];
if (!video) {
  console.error('Usage: node scripts/faces.mjs <video> [--every 0.5] [--pad 0.15]');
  process.exit(1);
}
try {
  const bin = visionTool();
  const {w, h} = probe(resolve(video));
  const [dc, da] = ff('ffmpeg', ['-v', 'error', '-i', resolve(video), '-vf', `fps=1/${every}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const dec = spawn(dc, da, {stdio: ['ignore', 'pipe', 'inherit']});
  const vis = spawn(bin, ['faces', String(w), String(h)], {stdio: ['pipe', 'pipe', 'ignore']});
  dec.stdout.pipe(vis.stdin);
  let text = '';
  vis.stdout.on('data', (d) => { text += d; });
  await new Promise((ok) => vis.on('close', ok));
  const track = [];
  text.trim().split('\n').forEach((line, i) => {
    const faces = JSON.parse(line || '[]');
    if (!faces.length) return;
    const f = faces.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const px = Math.round(f.w * pad), py = Math.round(f.h * pad);
    track.push({t: Math.round(i * every * 100) / 100, x: Math.max(0, f.x - px), y: Math.max(0, f.y - py), w: f.w + 2 * px, h: f.h + 2 * py});
  });
  const box = track.length ? {
    top: Math.min(...track.map((f) => f.y)), bottom: Math.max(...track.map((f) => f.y + f.h)),
    left: Math.min(...track.map((f) => f.x)), right: Math.max(...track.map((f) => f.x + f.w)),
  } : null;
  console.log(JSON.stringify({w, h, every, box, track}));
} catch (e) {
  console.error('faces failed:', e.message);
  process.exit(1);
}
