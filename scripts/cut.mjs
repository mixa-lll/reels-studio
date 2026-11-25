#!/usr/bin/env node
// The rough cut of the owner's footage: <reel>/cut.json — the clips the studio's «Нарезка» screen
// shows and the owner trims, moves, splits and deletes. One format for the agent and the page:
//   {"source": "sources/IMG_0656.MOV", "fps": 30, "words": "sources/words-host.json",
//    "clips": [{"in": 17.8, "out": 21.95, "text": "Don't know where to stay…"}, …]}
// Optional: "rotate": 90 | -90 | 180 (a camera clip filmed sideways), "gainDb": voice gain, linear,
// "voice": the lavalier file (default sources/mic-synced.wav when it exists), "rev": the studio's revision.
// A clip's "jt": the sound joint after it moved off the picture joint, seconds — + its voice runs on under
// the next picture (L-cut), − the next voice starts under this one (J-cut); the owner sets it in the studio.
// in/out are seconds of the source on its frame grid; the clips play one after another with hard cuts.
// The join itself is scripts/join.mjs — the same recipe as the studio's «Собрать монтаж».
//
//   node scripts/cut.mjs <reel> cut    → sources/cut.mov (the clips joined: frames, lavalier voice, fades) + cut.applied.json
//   node scripts/cut.mjs <reel> words  → sources/words-cut.json (the source transcript in cut time)
//   node scripts/cut.mjs <reel> map    → how the cut changed since cut.applied.json: for each old clip
//                                         its old start in the cut → new start (or «removed»), and the
//                                         new clips; shift every cut-time in Reel.jsx by that table.
//   node scripts/cut.mjs <reel> map <t> → one old cut time → new cut time
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {joinArgs, lengthOf} from './join.mjs';

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
  execFileSync('node', [join(BOT, 'scripts/ffmpeg.mjs'), ...joinArgs({reel, cut, video: join(reel, cut.source), out: join(reel, 'sources/cut.mov'), draft: false})], {stdio: 'inherit'});
  copyFileSync(join(reel, 'cut.json'), join(reel, 'cut.applied.json'));
  console.log(`sources/cut.mov · ${clips.length} clips · ${lengthOf(cut).toFixed(2)} s`);
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
