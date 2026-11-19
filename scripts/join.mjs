// One recipe for joining the clips of <reel>/cut.json — used by the studio's «Собрать монтаж»
// (draft: from the source's light copy, seconds) and by `scripts/cut.mjs <reel> cut` (final: from
// the original), so the montage the owner checks and the final render cut the same frames and
// sound the same.
//
// Time is in frames of the source (cut.fps): in/out are stored as seconds on the frame grid
// (snapClips), every clip is exactly round(out·fps) − round(in·fps) frames, and its sound exactly
// as long. The voice is the lavalier when the reel has one (cut.voice, or sources/mic-synced.wav —
// already synced to the camera), else the camera's own sound; 12 ms fades at every edge (no clicks),
// mono, cut.gainDb.
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export const FADE = 0.012;
// After the gain, peaks held at −1.5 dBFS (0.84) without moving the sound in time: a louder voice never clips.
const LIMIT = 'alimiter=limit=0.84:level=false:latency=true';

export const fpsOf = (cut) => Number(cut?.fps) > 0 ? Number(cut.fps) : 30;

// Seconds → the nearest frame, written back as seconds (4 decimals: exact for 25 fps, ≤ 0.05 ms off for 30).
export const snap = (t, fps) => Math.round(Math.round(t * fps) / fps * 10000) / 10000;

// The sound apart from the picture (J- and L-cuts): a clip's `jt` moves the SOUND joint after it from the
// picture joint, in seconds on the frame grid — + later: its voice runs on under the next picture (and the
// next clip's sound starts that much later); − earlier: the next clip's voice starts under this picture.
// The picture and the length of the reel do not change, the sound never overlaps itself; the last clip has
// none. At most the shorter of the two clips minus 0.1 s, so neither loses all its own sound.
const jtOf = (clips, i, fps) => {
  const c = clips[i], n = clips[i + 1];
  if (!n || !Number(c.jt)) return 0;
  const max = Math.min(c.out - c.in, n.out - n.in) - 0.1;
  return max > 0 ? snap(Math.max(-max, Math.min(max, Number(c.jt))), fps) : 0;
};

// The clips with in/out on the frame grid, each at least one frame long; jt on the grid and in its bounds.
export function snapClips(clips, fps) {
  const out = clips.map((c) => {
    const a = Math.max(0, Math.round(Number(c.in) * fps)), b = Math.max(a + 1, Math.round(Number(c.out) * fps));
    const {jt, ...rest} = c;
    return {...rest, in: snap(a / fps, fps), out: snap(b / fps, fps), ...(Number(jt) ? {jt: Number(jt)} : {})};
  });
  return out.map((c, i) => { const j = jtOf(out, i, fps); const {jt, ...rest} = c; return j ? {...rest, jt: j} : rest; });
}

/** The sound of each clip: [{from, dur}] — where in the source it starts and how long it plays, with the
 *  joints moved by jt. The sum of the durations equals the picture's length. */
export function soundOf(cut) {
  const fps = fpsOf(cut), cl = cut.clips.filter((c) => Math.round(c.out * fps) - Math.round(c.in * fps) > 0);
  return cl.map((c, i) => {
    const a = Math.round(c.in * fps) / fps, d = (Math.round(c.out * fps) - Math.round(c.in * fps)) / fps;
    const s = i ? jtOf(cl, i - 1, fps) : 0, e = jtOf(cl, i, fps);
    const from = Math.max(0, a + s);
    return {from, dur: d + e - s - (from - (a + s))};
  });
}

// Frames of each clip: [{a, b, n}] — a, b frame numbers of the source, n = b − a.
export function framesOf(cut) {
  const fps = fpsOf(cut);
  return cut.clips.map((c) => { const a = Math.round(c.in * fps), b = Math.round(c.out * fps); return {a, b, n: b - a}; }).filter((f) => f.n > 0);
}

export function voiceOf(reel, cut) {
  if (cut.voice) return existsSync(join(reel, cut.voice)) ? join(reel, cut.voice) : null;
  const mic = join(reel, 'sources/mic-synced.wav');
  return existsSync(mic) ? mic : null;
}

// ffmpeg arguments (without the binary) for the joined file.
//   reel   — the reel folder;  cut — cut.json;  video — the file to cut the picture from
//   draft  — true: 720p light copy → mp4 h264 ultrafast + aac (seconds);
//            false: the original → mov h264 crf 14 + pcm, turned by cut.rotate
// One input per clip, seeked straight to its start (nothing before it is decoded), the picture
// counted in frames and the sound in seconds of the same length.
export function joinArgs({reel, cut, video, out, draft}) {
  const fps = fpsOf(cut), fr = framesOf(cut), snd = soundOf(cut), voice = voiceOf(reel, cut) || video;
  if (!fr.length) throw new Error('в нарезке нет кусков');
  const ins = [], parts = [];
  fr.forEach((f, i) => {
    const ss = (f.a / fps).toFixed(4), d = f.n / fps;
    // The sound of a clip may start earlier or end later than its picture (jt): its own input and length.
    const as = snd[i].from.toFixed(4), ad = snd[i].dur, ds = ad.toFixed(4);
    ins.push('-ss', ss, '-t', (d + 0.5).toFixed(3), '-i', video);
    ins.push('-ss', as, '-t', (ad + 0.5).toFixed(3), '-i', voice);
    const vi = 2 * i, ai = 2 * i + 1;
    // fps first (a variable-rate phone file becomes the grid), a held last frame if the file ends
    // early, then exactly n frames.
    parts.push(`[${vi}:v]fps=${fps},tpad=stop_mode=clone:stop_duration=0.5,trim=end_frame=${f.n},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[${ai}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,atrim=duration=${ds},apad=whole_dur=${ds},asetpts=PTS-STARTPTS,` +
      `afade=t=in:d=${FADE},afade=t=out:st=${Math.max(0, ad - FADE).toFixed(4)}:d=${FADE}[a${i}]`);
  });
  const turn = draft ? '' : ({90: 'transpose=1,', [-90]: 'transpose=2,', 180: 'hflip,vflip,'}[cut.rotate] || '');
  // Picture and sound joined apart: with jt their pieces differ in length, the sums are equal.
  const cat = fr.map((_, i) => `[v${i}]`).join('') + `concat=n=${fr.length}:v=1:a=0[vc];` + fr.map((_, i) => `[a${i}]`).join('') + `concat=n=${fr.length}:v=0:a=1[ac];[vc]${turn}setsar=1[v];[ac]volume=${Number(cut.gainDb) || 0}dB,${LIMIT}[a]`;
  const enc = draft
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart']
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'pcm_s16le'];
  return ['-v', 'error', '-y', ...ins, '-filter_complex', `${parts.join(';')};${cat}`, '-map', '[v]', '-map', '[a]', ...enc, out];
}

// Length of the joined file in seconds (frames / fps).
export const lengthOf = (cut) => framesOf(cut).reduce((s, f) => s + f.n, 0) / fpsOf(cut);
