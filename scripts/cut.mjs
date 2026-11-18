#!/usr/bin/env node
// The rough cut of the owner's footage: <reel>/cut.json — the clips the studio's «Нарезка» screen
// shows and the owner trims, moves, splits and deletes. One format for the agent and the page:
//   {"source": "sources/IMG_0656.MOV", "fps": 30, "words": "sources/words-host.json",
//    "clips": [{"in": 17.8, "out": 21.95, "text": "Don't know where to stay…"}, …]}
// in/out are seconds of the source; the clips play one after another with hard cuts.
//
//   node scripts/cut.mjs <reel> cut    → sources/cut.mov (the clips joined, mono, fps) + cut.applied.json
//   node scripts/cut.mjs <reel> words  → sources/words-cut.json (the source transcript in cut time)
//   node scripts/cut.mjs <reel> map    → how the cut changed since cut.applied.json: for each old clip
//                                         its old start in the cut → new start (or «removed»), and the
//                                         new clips; shift every cut-time in Reel.jsx by that table.
//   node scripts/cut.mjs <reel> map <t> → one old cut time → new cut time
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const BOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [reelArg, cmd, arg] = process.argv.slice(2);
if (!reelArg || !cmd) { console.log('node scripts/cut.mjs <reel folder> cut|words|map [t]'); process.exit(1); }
const reel = resolve(reelArg);
const read = (f) => JSON.parse(readFileSync(join(reel, f), 'utf8'));
const cut = read('cut.json');
const clips = cut.clips.filter((c) => c.out > c.in);
const starts = (cs) => cs.reduce((a, c, i) => (a.push(i ? a[i - 1] + (cs[i - 1].out - cs[i - 1].in) : 0), a), []);
const len = (cs) => cs.reduce((a, c) => a + c.out - c.in, 0);

if (cmd === 'cut') {
  const fps = cut.fps || 30;
  const parts = clips.map((c, i) => `[0:v]trim=${c.in}:${c.out},setpts=PTS-STARTPTS,fps=${fps}[v${i}];[0:a]atrim=${c.in}:${c.out},asetpts=PTS-STARTPTS,aformat=channel_layouts=mono,afade=t=in:d=0.012,afade=t=out:st=${(c.out - c.in - 0.012).toFixed(3)}:d=0.012[a${i}]`).join(';');
  const cat = clips.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${clips.length}:v=1:a=1[v][a]`;
  execFileSync('node', [join(BOT, 'scripts/ffmpeg.mjs'), '-v', 'error', '-y', '-i', join(reel, cut.source), '-filter_complex', `${parts};${cat}`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '14', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', join(reel, 'sources/cut.mov')], {stdio: 'inherit'});
  copyFileSync(join(reel, 'cut.json'), join(reel, 'cut.applied.json'));
  console.log(`sources/cut.mov · ${clips.length} clips · ${len(clips).toFixed(2)} s`);
} else if (cmd === 'words') {
  const j = read(cut.words || 'sources/words-host.json');
  const st = starts(clips), words = [];
  for (const w of j.segments.flatMap((s) => s.words || [])) {
    // The clip the word overlaps most (Whisper shifts word starts by up to 0.7 s).
    let best = -1, ov = 0.04;
    clips.forEach((c, i) => { const o = Math.min(c.out, w.end) - Math.max(c.in, w.start); if (o > ov) { ov = o; best = i; } });
    if (best < 0) continue;
    const c = clips[best], a = st[best] + Math.max(0, w.start - c.in), b = st[best] + Math.min(c.out, w.end) - c.in;
    words.push({word: w.word, start: +a.toFixed(3), end: +Math.max(a + 0.08, b).toFixed(3), probability: w.probability});
  }
  writeFileSync(join(reel, 'sources/words-cut.json'), JSON.stringify({language: j.language, segments: [{words}]}, null, 1));
  console.log(`sources/words-cut.json · ${words.length} words`);
} else if (cmd === 'map') {
  if (!existsSync(join(reel, 'cut.applied.json'))) { console.log('No cut.applied.json: the cut has not been applied yet.'); process.exit(0); }
  const old = read('cut.applied.json').clips.filter((c) => c.out > c.in), so = starts(old), sn = starts(clips);
  // An old cut time → the source second → where that second is in the new cut (null: cut out).
  const toNew = (t) => {
    const i = so.findLastIndex((s) => t >= s - 1e-6);
    if (i < 0) return null;
    const src = old[i].in + (t - so[i]);
    const j = clips.findIndex((c) => src >= c.in - 0.02 && src <= c.out + 0.02);
    return j < 0 ? null : +(sn[j] + Math.max(0, src - clips[j].in)).toFixed(3);
  };
  if (arg !== undefined) { const r = toNew(Number(arg)); console.log(r === null ? 'removed' : r); process.exit(0); }
  console.log(`old ${len(old).toFixed(2)} s → new ${len(clips).toFixed(2)} s`);
  old.forEach((c, i) => console.log(`old #${i + 1} ${so[i].toFixed(2)}–${(so[i] + c.out - c.in).toFixed(2)} → ${toNew(so[i]) ?? 'removed'}${c.text ? '  ' + c.text : ''}`));
  clips.forEach((c, j) => { if (!old.some((o) => Math.min(o.out, c.out) - Math.max(o.in, c.in) > 0.05)) console.log(`new #${j + 1} at ${sn[j].toFixed(2)} (source ${c.in}–${c.out})${c.text ? '  ' + c.text : ''}`); });
} else { console.log('cut | words | map'); process.exit(1); }
