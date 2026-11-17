#!/usr/bin/env node
// Word-by-word captions from a transcript (scripts/transcribe.mjs):
//   node scripts/captions.mjs <words.json> <captions.json> [--fps 30] [--offset 0] [--from 0] [--to end]
//        [--hl "word,word"] [--fix fixes.json] [--words 3] [--chars 16]
// Groups of 1–3 words, broken at punctuation, at a pause over 0.3 s and at --chars; a
// hyphen-led word joins the previous one («военно / -грузинской»). --from/--to keep the
// words of that stretch of the source; --offset moves them (seconds, e.g. -12.4 when the
// take starts at 12.4 s in the reel). fixes.json: [["регэксп", "замена"], …] for misheard
// names. Output, as reel 05: [{from_, dur, gap, words: [{t, at, hl}]}] in frames.
import {readFileSync, writeFileSync} from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const FPS = Number(opt('fps', 30)), OFFSET = Number(opt('offset', 0));
const FROM = Number(opt('from', 0)), TO = Number(opt('to', Infinity));
const MAXW = Number(opt('words', 3)), MAXC = Number(opt('chars', 16));
const HL = new Set((opt('hl', '') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const fixFile = opt('fix');
const FIX = fixFile ? JSON.parse(readFileSync(fixFile, 'utf8')).map(([a, b]) => [new RegExp(a), b]) : [];
const [src, dest] = argv;
if (!src || !dest) {
  console.error('Usage: node scripts/captions.mjs <words.json> <captions.json> [--fps 30] [--offset s] [--from s] [--to s] [--hl "a,b"] [--fix fixes.json]');
  process.exit(1);
}

let words = JSON.parse(readFileSync(src, 'utf8')).segments.flatMap((s) => s.words || [])
  .map((w) => ({t: w.word.trim(), s: w.start, e: w.end}))
  .filter((w) => w.t && w.s >= FROM && w.e <= TO);
const joined = [];
for (const w of words) {
  const prev = joined[joined.length - 1];
  if (prev && /^-/.test(w.t)) { prev.t += w.t; prev.e = w.e; } else joined.push({...w});
}
words = joined.map((w) => {
  let t = w.t;
  for (const [re, to] of FIX) t = t.replace(re, to);
  return {...w, t, s: w.s + OFFSET, e: w.e + OFFSET};
}).filter((w) => w.t && w.t !== '—' && w.t !== '–');

const groups = [];
let cur = [];
const flush = () => { if (cur.length) groups.push(cur); cur = []; };
for (let i = 0; i < words.length; i++) {
  const w = words[i], next = words[i + 1];
  cur.push(w);
  const chars = cur.reduce((a, x) => a + x.t.length + 1, 0);
  const pause = next ? next.s - w.e : 1;
  if (/[.,?!:;]$/.test(w.t) || cur.length >= MAXW || chars > MAXC || pause > 0.3 || (next && chars + next.t.length > MAXC + 2)) flush();
}
flush();

const bare = (t) => t.replace(/[.,?!:;«»"]+/g, '').toLowerCase();
const caps = groups.map((g, i) => {
  const from_ = Math.round(g[0].s * FPS);
  const next = groups[i + 1];
  const last = g[g.length - 1];
  const gap = !!next && next[0].s - last.e > 0.5;
  const dur = !next ? Math.round(last.e * FPS) + 12 - from_ : gap ? Math.round(last.e * FPS) + 8 - from_ : Math.round(next[0].s * FPS) - from_;
  return {from_, dur: Math.max(1, dur), gap,
    words: g.map((w) => ({t: w.t.replace(/[.,]$/, ''), at: Math.round(w.s * FPS) - from_, hl: HL.has(bare(w.t))}))};
});
writeFileSync(dest, JSON.stringify(caps, null, 1));
console.log(`${caps.length} captions, ${words.length} words → ${dest}`);
