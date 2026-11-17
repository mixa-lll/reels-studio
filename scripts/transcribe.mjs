#!/usr/bin/env node
// Speech of a video or audio file with the time of every word (local Whisper, no keys):
//   node scripts/transcribe.mjs <media> [--out words.json] [--lang ru|en|ka|auto] [--model turbo|large-v3|medium] [--prompt "names, places"]
// Writes Whisper's JSON {text, language, segments: [{start, end, text, words: [{word, start,
// end, probability}]}]} (default: words.json next to the media) and prints the text with
// times, one segment per line. Word times drift by up to ~0.7 s: trim takes by audio energy.
// On an M-series Mac (MLX, large-v3-turbo) about a minute for 5 minutes of speech; elsewhere
// faster-whisper «medium» on the CPU, ~3x real time. Language: detected from the middle of
// the file; pass --lang when you know it. Georgian needs --model large-v3 (turbo garbles it).
import {writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {transcribeWords} from '../bot/stt.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const out = opt('out');
const lang = opt('lang') || 'auto';
const model = opt('model');
const prompt = opt('prompt');
const file = argv[0];
if (!file) {
  console.error('Usage: node scripts/transcribe.mjs <media> [--out words.json] [--lang ru|en|auto] [--model medium] [--prompt "…"]');
  process.exit(1);
}

const t0 = Date.now();
try {
  const res = await transcribeWords(resolve(file), {lang, model, prompt});
  const dest = resolve(out || join(dirname(resolve(file)), 'words.json'));
  writeFileSync(dest, JSON.stringify(res));
  const ts = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  for (const s of res.segments) console.log(`[${ts(s.start)}–${ts(s.end)}] ${s.text.trim()}`);
  const words = res.segments.reduce((n, s) => n + (s.words?.length || 0), 0);
  console.log(`\n→ ${dest}: ${res.segments.length} segments, ${words} words, language ${res.language}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} catch (e) {
  console.error('transcribe failed:', e.message.slice(0, 3000));
  process.exit(1);
}
