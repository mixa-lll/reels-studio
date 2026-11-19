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
// A file ffmpeg could not read (a render cut short by a full disk): not retried until it changes.
const failed = new Map();
let busy = false;

const dirOf = (video) => join(dirname(video), '.preview');
const name = (video) => basename(video).replace(/\.[^.]+$/, '');

/** {video, sprite, every, cols, w, h, n} for a ready preview of this file, or null (and queues it). */
export function previewOf(video, {rotate = 0} = {}) {
  const d = dirOf(video), n = name(video);
  const mp4 = join(d, `${n}.mp4`), meta = join(d, `${n}.json`);
  try {
    if (existsSync(meta) && statSync(meta).mtimeMs >= statSync(video).mtimeMs) {
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      if ((m.rotate || 0) !== rotate) throw new Error('turned');
      return {video: mp4, sprite: existsSync(join(d, `${n}.jpg`)) ? join(d, `${n}.jpg`) : null, ...m};
    }
  } catch {}
  // A video still being written (a render, a copy) gets its preview once it has settled.
  try { if (Date.now() - statSync(video).mtimeMs < 15000) return null; } catch { return null; }
  try { if (failed.get(video) === statSync(video).mtimeMs) return null; } catch {}
  if (!queued.has(video)) { queued.add(video); queue.push({video, rotate}); next(); }
  return null;
}

/** The voice for the studio player: {audio, peaks} — a small mono m4a (24 kHz, the whole recording
 *  decoded once into WebAudio) and its loudness, 100 points a second (peaks.json: {rate, n, p} with p
 *  base64 bytes 0–255), for the waveform. Made from the lavalier or the camera's sound; null while queued. */
export function voiceOf(file) {
  const d = dirOf(file), n = name(file);
  const audio = join(d, `${n}.voice.m4a`), peaks = join(d, `${n}.peaks.json`);
  try { if (existsSync(peaks) && statSync(peaks).mtimeMs >= statSync(file).mtimeMs && existsSync(audio)) return {audio, peaks}; } catch {}
  try { if (Date.now() - statSync(file).mtimeMs < 15000) return null; } catch { return null; }
  const key = file + '#voice';
  try { if (failed.get(key) === statSync(file).mtimeMs) return null; } catch {}
  if (!queued.has(key)) { queued.add(key); queue.unshift({video: file, voice: true, key}); next(); }
  return null;
}

/** For scrubbing the cut's source (hover, dragging a clip's edge): {video, sheets, fps, per, cols, w, h, n}
 *  — a 360p copy with a key frame every 5 frames (an exact frame in a few ms) and the strip at 4 frames
 *  a second in sheets of 100 (one JPEG per 25 s, so only the sheets near the cursor are loaded).
 *  Made from the light copy (already turned) next to it; null while queued. */
export function scrubOf(light) {
  const d = dirname(light), n = name(light), meta = join(d, `${n}.scrub.json`);
  try {
    if (existsSync(meta) && statSync(meta).mtimeMs >= statSync(light).mtimeMs) {
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      return {...m, video: join(d, `${n}.scrub.mp4`), sheets: Array.from({length: m.count}, (_, i) => join(d, `${n}.s${String(i).padStart(3, '0')}.jpg`))};
    }
  } catch {}
  const key = light + '#scrub';
  try { if (failed.get(key) === statSync(light).mtimeMs) return null; } catch { return null; }
  if (!queued.has(key)) { queued.add(key); queue.push({video: light, scrub: true, key}); next(); }
  return null;
}

async function makeScrub(light) {
  if (!existsSync(light)) return;
  const d = dirname(light), n = name(light), key = light + '#scrub', FPS = 4, PER = 100;
  const tmp = join(d, `${n}.scrub.tmp.mp4`);
  if (!(await run(['-y', '-v', 'error', '-i', light, '-an', '-vf', 'scale=360:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-tune', 'fastdecode',
    '-g', '5', '-keyint_min', '5', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp]))) { rmSync(tmp, {force: true}); failed.set(key, statSync(light).mtimeMs); return; }
  for (const f of readdirSync(d)) if (new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.s\\d{3}\\.jpg$`).test(f)) rmSync(join(d, f), {force: true});
  const ok = await run(['-y', '-v', 'error', '-i', light, '-vf', `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,tile=${COLS}x${PER / COLS}`, '-q:v', '6', join(d, `${n}.s%03d.jpg`)]);
  const count = readdirSync(d).filter((f) => f.startsWith(`${n}.s`) && /\.s\d{3}\.jpg$/.test(f)).length;
  if (!ok || !count) { rmSync(tmp, {force: true}); failed.set(key, statSync(light).mtimeMs); return; }
  // ffmpeg numbers the sheets from 1: shift to 0.
  for (let i = 1; i <= count; i++) renameSync(join(d, `${n}.s${String(i).padStart(3, '0')}.jpg`), join(d, `${n}.s${String(i - 1).padStart(3, '0')}.x.jpg`));
  for (let i = 0; i < count; i++) renameSync(join(d, `${n}.s${String(i).padStart(3, '0')}.x.jpg`), join(d, `${n}.s${String(i).padStart(3, '0')}.jpg`));
  renameSync(tmp, join(d, `${n}.scrub.mp4`));
  const info = videoInfo(light);
  writeFileSync(join(d, `${n}.scrub.json`), JSON.stringify({fps: FPS, per: PER, cols: COLS, w: W, h: H, n: Math.ceil((info?.duration || count * PER / FPS) * FPS), count}));
}

async function makeVoice(file) {
  if (!existsSync(file)) return;
  const d = dirOf(file), n = name(file), key = file + '#voice';
  mkdirSync(d, {recursive: true});
  const tmp = join(d, `${n}.voice.tmp.m4a`);
  if (!(await run(['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', tmp]))) {
    rmSync(tmp, {force: true}); failed.set(key, statSync(file).mtimeMs); return;
  }
  // Peaks: the loudest sample of every 10 ms, from 8 kHz mono.
  const [cmd, full] = ffCommand('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
  const pcm = await new Promise((ok) => {
    const c = spawn('nice', ['-n', '15', cmd, ...full], {stdio: ['ignore', 'pipe', 'ignore']}), parts = [];
    c.stdout.on('data', (b) => parts.push(b));
    c.on('close', (code) => ok(code === 0 ? Buffer.concat(parts) : null));
    c.on('error', () => ok(null));
  });
  if (!pcm) { rmSync(tmp, {force: true}); failed.set(key, statSync(file).mtimeMs); return; }
  const S = 80, count = Math.ceil(pcm.length / 2 / S), out = Buffer.alloc(count);
  for (let i = 0; i < count; i++) {
    let m = 0;
    for (let j = i * S, e = Math.min(pcm.length / 2, j + S); j < e; j++) { const v = Math.abs(pcm.readInt16LE(j * 2)); if (v > m) m = v; }
    out[i] = Math.min(255, Math.round(Math.sqrt(m / 32768) * 255));
  }
  renameSync(tmp, join(d, `${n}.voice.m4a`));
  writeFileSync(join(d, `${n}.peaks.json`), JSON.stringify({rate: 100, n: count, scale: 'sqrt', p: out.toString('base64')}));
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
  const {video, rotate, voice, scrub, key} = queue.shift();
  try { if (voice) await makeVoice(video); else if (scrub) await makeScrub(video); else await make(video, rotate); } catch {}
  queued.delete(key || video);
  busy = false;
  next();
}

// rotate: a camera clip filmed sideways (cut.json «rotate»: 90 clockwise, -90, 180).
async function make(video, rotate = 0) {
  if (!existsSync(video)) return;
  const d = dirOf(video), n = name(video);
  mkdirSync(d, {recursive: true});
  const info = videoInfo(video);
  if (!info) { failed.set(video, statSync(video).mtimeMs); return; }
  const tmp = join(d, `${n}.tmp.mp4`);
  const ok = await run(['-y', '-v', 'error', '-i', video, '-vf', `${{90: 'transpose=1,', [-90]: 'transpose=2,', 180: 'hflip,vflip,'}[rotate] || ''}scale='min(720,iw)':-2`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]);
  if (!ok) { rmSync(tmp, {force: true}); failed.set(video, statSync(video).mtimeMs); return; }
  renameSync(tmp, join(d, `${n}.mp4`));
  // The strip: a frame every 0.5 s (every 1 s for long videos), COLS per row.
  const every = info.duration > 240 ? 1 : 0.5, count = Math.ceil(info.duration / every), rows = Math.ceil(count / COLS);
  const jtmp = join(d, `${n}.tmp.jpg`);
  const sprite = await run(['-y', '-v', 'error', '-i', join(d, `${n}.mp4`), '-vf', `fps=${1 / every},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,tile=${COLS}x${rows}`, '-frames:v', '1', '-q:v', '5', jtmp]);
  if (sprite) renameSync(jtmp, join(d, `${n}.jpg`)); else rmSync(jtmp, {force: true});
  writeFileSync(join(d, `${n}.json`), JSON.stringify({every, cols: COLS, w: W, h: H, n: count, rotate}));
}
