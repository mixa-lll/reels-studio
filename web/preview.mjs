// A light copy of each version's video for the studio player, and a strip of its frames.
// The review video can be 24 Mbit/s with a key frame every 8 s: each seek pulls ~25 MB.
// The copy is 720p, a key frame every half second and the index first, so the player jumps at
// once; the strip (one JPEG, a frame every 0.5 s) shows the frame under the mouse on the timeline.
// Both live in versions/vN/.preview/ (a hidden folder, so the version's file list stays as it was)
// and are made in the background, one at a time, at low priority. Downloads still give the full file.
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {ffCommand, videoInfo} from '../bot/media.mjs';

const COLS = 10, W = 90, H = 160;
const queue = [], queued = new Set();
let busy = false;

const dirOf = (video) => join(dirname(video), '.preview');
const name = (video) => basename(video).replace(/\.[^.]+$/, '');

/** {video, sprite, every, cols, w, h, n} for a ready preview of this file, or null (and queues it). */
export function previewOf(video) {
  const d = dirOf(video), n = name(video);
  const mp4 = join(d, `${n}.mp4`), meta = join(d, `${n}.json`);
  try {
    if (existsSync(meta) && statSync(meta).mtimeMs >= statSync(video).mtimeMs) {
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      return {video: mp4, sprite: existsSync(join(d, `${n}.jpg`)) ? join(d, `${n}.jpg`) : null, ...m};
    }
  } catch {}
  // A video still being written (a render, a copy) gets its preview once it has settled.
  try { if (Date.now() - statSync(video).mtimeMs < 15000) return null; } catch { return null; }
  if (!queued.has(video)) { queued.add(video); queue.push(video); next(); }
  return null;
}

/** Previews whose video is gone (the version was cleaned): removed, they would only take space. */
export function dropOrphans(vdir) {
  const d = join(vdir, '.preview');
  if (!existsSync(d)) return;
  const have = new Set(readdirSync(vdir).map((f) => f.replace(/\.[^.]+$/, '')));
  for (const f of readdirSync(d)) if (!have.has(f.replace(/\.[^.]+$/, '').replace(/\.tmp$/, ''))) rmSync(join(d, f), {force: true});
}

function run(args) {
  const [cmd, full] = ffCommand('ffmpeg', args);
  return new Promise((ok) => {
    const c = spawn('nice', ['-n', '15', cmd, ...full], {stdio: 'ignore'});
    c.on('close', (code) => ok(code === 0));
    c.on('error', () => ok(false));
  });
}

async function next() {
  if (busy || !queue.length) return;
  busy = true;
  const video = queue.shift();
  try { await make(video); } catch {}
  queued.delete(video);
  busy = false;
  next();
}

async function make(video) {
  if (!existsSync(video)) return;
  const d = dirOf(video), n = name(video);
  mkdirSync(d, {recursive: true});
  const info = videoInfo(video);
  if (!info) return;
  const tmp = join(d, `${n}.tmp.mp4`);
  const ok = await run(['-y', '-v', 'error', '-i', video, '-vf', "scale='min(720,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]);
  if (!ok) { rmSync(tmp, {force: true}); return; }
  renameSync(tmp, join(d, `${n}.mp4`));
  // The strip: a frame every 0.5 s (every 1 s for long videos), COLS per row.
  const every = info.duration > 240 ? 1 : 0.5, count = Math.ceil(info.duration / every), rows = Math.ceil(count / COLS);
  const jtmp = join(d, `${n}.tmp.jpg`);
  const sprite = await run(['-y', '-v', 'error', '-i', join(d, `${n}.mp4`), '-vf', `fps=${1 / every},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,tile=${COLS}x${rows}`, '-frames:v', '1', '-q:v', '5', jtmp]);
  if (sprite) renameSync(jtmp, join(d, `${n}.jpg`)); else rmSync(jtmp, {force: true});
  writeFileSync(join(d, `${n}.json`), JSON.stringify({every, cols: COLS, w: W, h: H, n: count}));
}
