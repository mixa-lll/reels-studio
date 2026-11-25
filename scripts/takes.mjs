#!/usr/bin/env node
// Takes of every line of the script, found in the recording by its words — no model, milliseconds.
// The host records line after line, repeating a line until it is clean and often running straight into
// the next one without a pause; so takes are cut by the words of the transcript (scripts/transcribe.mjs),
// not by silence: where the words of a line end, its take ends.
//
//   node scripts/takes.mjs <reel>          → the table: each line, its takes (source seconds, how clean)
//   node scripts/takes.mjs <reel> --cut    → writes <reel>/cut.json when there is none: the last clean
//                                            take of every line (the studio's «Разложить на дубли»)
//
// Lines: the texts of cut.json's clips when it has them, else the sentences of scenes.json.
// A take: {in, out, score (share of the line's words heard), flag: whole | slip | cut}
//   whole — the line said to its end; slip — to its end, with words missing or other words inside;
//   cut — broken off before the end.
import {existsSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ffCommand} from '../bot/media.mjs';
import {snapClips} from './join.mjs';

const norm = (w) => String(w).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '');
export const tokens = (text) => String(text).split(/[\s\-–—.,!?:;«»"()%/]+/).map(norm).filter(Boolean);

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// The same word as Whisper heard it: endings and a letter or two may differ (Гудаури / кудауре); numbers only exactly.
const same = (a, b) => {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  return lev(a, b, 2) <= (n >= 6 ? 2 : 1);
};

// Where the voice is, from its loudness (web/preview.mjs peaks: 100 points a second, sqrt scale 0–255):
// [[start, end]] of stretches louder than ~−35 dBFS, joined across pauses under 0.25 s.
export function stretches(peaks) {
  if (!peaks?.p) return null;
  const b = Buffer.from(peaks.p, 'base64'), r = peaks.rate || 100, out = [];
  let a = -1, quiet = 0;
  for (let i = 0; i <= b.length; i++) {
    const loud = i < b.length && b[i] > 34;
    if (loud) { if (a < 0) a = i; quiet = 0; }
    else if (a >= 0 && (++quiet > r * 0.25 || i === b.length)) { out.push([a / r, (i - quiet + 1) / r]); a = -1; quiet = 0; }
  }
  return out;
}

/** phrases: [text]; words: [{word, start, end}] of the whole recording; speech: stretches() or null
 *  → [{text, takes: [{in, out, score, flag, joined}]}] */
export function findTakes(phrases, words, speech = null) {
  const T = words.map((w) => ({t: norm(w.word), s: w.start, e: w.end})).filter((w) => w.t);
  const cands = [];
  phrases.forEach((text, pi) => {
    const P = tokens(text), m = P.length;
    if (m < 2) return;
    for (let i = 0; i < T.length; i++) {
      // A take starts on one of the line's first three words.
      let p0 = -1;
      for (let q = 0; q < Math.min(3, m); q++) if (same(T[i].t, P[q])) { p0 = q; break; }
      if (p0 < 0) continue;
      let p = p0 + 1, matched = 1, last = i, lastP = p0, miss = 0, extra = 0;
      for (let j = i + 1; j < T.length && p < m; j++) {
        // A pause over 2 s or four foreign words in a row: the take is over.
        if (T[j].s - T[j - 1].e > 2 || miss > 3) break;
        let hit = -1;
        for (let q = p; q < Math.min(m, p + 3); q++) if (same(T[j].t, P[q])) { hit = q; break; }
        if (hit < 0) { miss++; continue; }
        extra += miss; miss = 0; matched++; last = j; lastP = hit; p = hit + 1;
      }
      const score = matched / m;
      if (matched < 2 || score < 0.34) continue;
      // Whisper stretches a word over the silence before it and loops on noise (the same words many times in
      // a tenth of a second): a take whose words are impossibly short is not speech.
      if (T[last].e - Math.max(T[i].s, T[i].e - 0.6) < 0.13 * matched) continue;
      const toEnd = lastP >= m - Math.max(2, Math.ceil(m * 0.2));
      cands.push({pi, w0: i, w1: last, score, flag: !toEnd ? 'cut' : score >= 0.8 && extra === 0 ? 'whole' : 'slip'});
    }
  });
  // One stretch of the recording belongs to one line: the best match wins, the rest that overlap it go.
  cands.sort((a, b) => b.score - a.score || (a.w1 - a.w0) - (b.w1 - b.w0));
  const taken = [], out = phrases.map((text) => ({text, takes: []}));
  for (const c of cands) {
    if (taken.some((x) => Math.min(x.w1, c.w1) - Math.max(x.w0, c.w0) >= 0)) continue;
    taken.push(c);
    // The edges: a little air around the words, never into the neighbours' words (a take may run
    // straight into the next line: then the cut sits between the two words).
    const prev = T[c.w0 - 1], next = T[c.w1 + 1];
    // Whisper's word ends are steadier than its starts (a start may sit seconds early, in the silence).
    const first = Math.max(T[c.w0].s, T[c.w0].e - 0.6), lastE = T[c.w1].e;
    let a = Math.max(first - 0.1, prev && prev !== T[c.w0] ? Math.min(prev.e + 0.02, first) : 0), b = Math.min(lastE + 0.15, next ? Math.max(lastE, next.s - 0.02) : lastE + 0.15);
    // By the voice itself, where a pause is near: the take starts just before the sound and ends just after it.
    if (speech) {
      const st = speech.findLast((x) => x[0] >= first - 0.7 && x[0] <= first + 0.35), en = speech.find((x) => x[1] >= lastE - 0.45 && x[1] <= lastE + 0.7);
      if (st) a = Math.max(0, st[0] - 0.06);
      if (en && en[1] > a + 0.3) b = en[1] + 0.08;
    }
    out[c.pi].takes.push({in: +Math.max(0, a).toFixed(3), out: +b.toFixed(3), score: +c.score.toFixed(2), flag: c.flag, joined: !!next && next.s - T[c.w1].e < 0.15});
  }
  out.forEach((p) => p.takes.sort((x, y) => x.in - y.in));
  return out;
}

/** The take to put into the first cut: the last clean one, else the last said to its end, else the best. */
export const pickTake = (takes) => takes.findLast((t) => t.flag === 'whole') || takes.findLast((t) => t.flag === 'slip') || [...takes].sort((a, b) => b.score - a.score)[0] || null;

const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const sentences = (text) => String(text || '').split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter((s) => tokens(s).length >= 2);

/** The lines of a reel: its cut's clip texts, else the sentences of its scenes. */
export function linesOf(reel, cut = readJson(join(reel, 'cut.json'))) {
  const fromCut = [...new Set((cut?.clips || []).map((c) => c.text).filter(Boolean))];
  if (fromCut.length) return fromCut;
  return (readJson(join(reel, 'scenes.json'), []) || []).flatMap((s) => sentences(s.text));
}

export const wordsOf = (reel, cut = readJson(join(reel, 'cut.json'))) => {
  const j = readJson(join(reel, cut?.words || 'sources/words.json'));
  return j ? j.segments.flatMap((s) => s.words || []) : null;
};

// Takes of a reel, cached by the files they come from.
const CACHE = new Map();
/** peaksFile: the voice's peaks.json (web/preview.mjs voiceOf) when it is made — the edges then follow the sound. */
export function takesOf(reel, peaksFile = null) {
  const cut = readJson(join(reel, 'cut.json')), wf = join(reel, cut?.words || 'sources/words.json');
  if (!existsSync(wf)) return null;
  const pk = peaksFile && existsSync(peaksFile) ? peaksFile : null;
  const lines = linesOf(reel, cut), key = `${statSync(wf).mtimeMs}|${pk ? statSync(pk).mtimeMs : 0}|${lines.join('|')}`;
  const hit = CACHE.get(reel);
  if (hit?.key === key) return hit.value;
  const words = wordsOf(reel, cut), value = {phrases: findTakes(lines, words, pk ? stretches(readJson(pk)) : null), words: words.map((w) => [w.word.trim(), w.start, w.end])};
  CACHE.set(reel, {key, value});
  return value;
}

/** The footage of a reel to cut: the longest video in sources/. */
export function footageOf(reel) {
  const d = join(reel, 'sources');
  if (!existsSync(d)) return null;
  const vids = readdirSync(d).filter((f) => /\.(mp4|mov|m4v|webm)$/i.test(f) && !/^cut\./.test(f)).map((f) => ({f, size: statSync(join(d, f)).size}));
  return vids.sort((a, b) => b.size - a.size)[0]?.f ? `sources/${vids[0].f}` : null;
}

/** Frames a second of a video, rounded (25, 30, 60). */
export function fpsOfFile(file) {
  try {
    const [cmd, full] = ffCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', file]);
    const [a, b] = String(execFileSync(cmd, full)).trim().split('/').map(Number);
    return Math.round(a / (b || 1)) || 30;
  } catch { return 30; }
}

/** The first cut of a new recording: for every line its picked take, in the script's order.
 *  peaksFile: the voice's loudness, when made — the edges then follow the sound. */
export function firstCut(reel, {source = footageOf(reel), fps, peaksFile = null} = {}) {
  if (!source) throw new Error('в «Материалах» нет видео съёмки');
  fps = fps || fpsOfFile(join(reel, source));
  const lines = (readJson(join(reel, 'scenes.json'), []) || []).flatMap((s) => sentences(s.text));
  const words = wordsOf(reel, {words: 'sources/words.json'});
  if (!lines.length) throw new Error('в «Идее» нет текста ролика — по нему ищутся дубли');
  if (!words) throw new Error('нет расшифровки sources/words.json');
  const found = findTakes(lines, words, peaksFile && existsSync(peaksFile) ? stretches(readJson(peaksFile)) : null);
  const clips = found.map((p) => ({p, t: pickTake(p.takes)})).filter((x) => x.t).map((x) => ({in: x.t.in, out: x.t.out, text: x.p.text}));
  if (!clips.length) throw new Error('в записи не нашлось ни одной фразы из текста');
  return {cut: {source, fps, words: 'sources/words.json', clips: snapClips(clips, fps)}, missing: found.filter((p) => !p.takes.length).map((p) => p.text)};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [reelArg, flag] = process.argv.slice(2);
  if (!reelArg) { console.log('node scripts/takes.mjs <reel folder> [--cut]'); process.exit(1); }
  const reel = resolve(reelArg);
  const pkf = join(reel, 'sources/.preview'), pk = existsSync(pkf) ? readdirSync(pkf).filter((f) => f.endsWith('.peaks.json')).sort((a, b) => (a.startsWith('mic') ? -1 : 1))[0] : null;
  const t = takesOf(reel, pk && join(pkf, pk)) || (() => { const w = wordsOf(reel, {}); return w ? {phrases: findTakes(linesOf(reel), w)} : null; })();
  if (!t) { console.log('No transcript: node scripts/transcribe.mjs <source> --out sources/words.json'); process.exit(1); }
  const mm = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  t.phrases.forEach((p, i) => { console.log(`${i + 1}. ${p.text}`); const pk = pickTake(p.takes); p.takes.forEach((k) => console.log(`   ${k === pk ? '→' : ' '} ${mm(k.in)}–${mm(k.out)}  ${k.flag}  ${Math.round(k.score * 100)}%${k.joined ? '  runs into the next words' : ''}`)); if (!p.takes.length) console.log('   — not found'); });
  if (flag === '--cut') {
    if (existsSync(join(reel, 'cut.json'))) { console.log('cut.json is already there: not touched'); process.exit(0); }
    const {cut, missing} = firstCut(reel, {peaksFile: pk && join(pkf, pk)});
    writeFileSync(join(reel, 'cut.json'), JSON.stringify(cut, null, 2));
    console.log(`cut.json · ${cut.clips.length} clips${missing.length ? ` · not found: ${missing.length}` : ''}`);
  }
}
