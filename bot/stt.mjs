// Local speech-to-text for voice notes: no API keys. It needs `uv`, which is not a
// setup requirement: on the first voice note the bot downloads uv's official release
// binary into data/tools/ (no installer scripts, no sudo, nothing outside the folder);
// the speech model downloads on first use too.
import {execFile, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {DATA} from './config.mjs';

const run = promisify(execFile);
const win = process.platform === 'win32';

// Domain words steer Whisper away from near-misses like «хуб» for «хук».
const HINT = {
  ru: 'Правки к рилсу: хук, сцена, музыка, трек, обложка, монтаж, переход, титры.',
  en: 'Reel feedback: hook, scene, music, track, cover, cut, transition, captions.',
};

const TOOLS = join(DATA, 'tools');
const UVX = join(TOOLS, win ? 'uvx.exe' : 'uvx');

function findUvx() {
  if (spawnSync('uvx', ['--version'], {stdio: 'ignore', windowsHide: true}).status === 0) return 'uvx';
  return existsSync(UVX) ? UVX : null;
}

// uv's release archive for this OS and CPU.
function uvAsset() {
  const cpu = {x64: 'x86_64', arm64: 'aarch64'}[process.arch];
  const os = {darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc'}[process.platform];
  if (!cpu || !os) throw new Error(`no uv build for ${process.platform}/${process.arch}`);
  return `uv-${cpu}-${os}.${win ? 'zip' : 'tar.gz'}`;
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === name) return full;
    if (statSync(full).isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

async function installUv() {
  const asset = uvAsset();
  const res = await fetch(`https://github.com/astral-sh/uv/releases/latest/download/${asset}`, {signal: AbortSignal.timeout(300_000)});
  if (!res.ok) throw new Error(`download ${asset}: HTTP ${res.status}`);
  const tmp = mkdtempSync(join(tmpdir(), 'reels-uv-'));
  try {
    const archive = join(tmp, asset);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    // tar ships with macOS, Linux and Windows 10+ (where it also opens .zip).
    await run('tar', ['-xf', archive, '-C', tmp], {windowsHide: true});
    mkdirSync(TOOLS, {recursive: true});
    for (const exe of win ? ['uv.exe', 'uvx.exe'] : ['uv', 'uvx']) {
      const src = findFile(tmp, exe);
      if (!src) throw new Error(`${exe} not found in ${asset}`);
      copyFileSync(src, join(TOOLS, exe));
      if (!win) chmodSync(join(TOOLS, exe), 0o755);
    }
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
}

async function ensureUvx(onInstall) {
  let uvx = findUvx();
  if (uvx) return uvx;
  await onInstall?.();
  try {
    await installUv();
  } catch (e) {
    console.error('stt install failed:', e.message);
  }
  return findUvx();
}

// One whisper-ctranslate2 run into a temporary folder; resolves to the output file's text.
async function whisper(uvx, file, extra, format) {
  const out = mkdtempSync(join(tmpdir(), 'reels-stt-'));
  // int8 + skipping silence: ~25x faster on a CPU with the same text.
  const args = (offline) => [...(offline ? ['--offline'] : []), 'whisper-ctranslate2', file,
    '--compute_type', 'int8', '--vad_filter', 'True', ...extra,
    '--output_format', format, '--output_dir', out];
  const opts = {timeout: 60 * 60_000, maxBuffer: 64 << 20, windowsHide: true};
  try {
    // Offline first: no index check once the package is cached; online the first time.
    await run(uvx, args(true), opts).catch(() => run(uvx, args(false), opts));
    const f = readdirSync(out).find((x) => x.endsWith(`.${format}`));
    return f ? readFileSync(join(out, f), 'utf8') : null;
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
}

/**
 * Transcribes an audio file; resolves to the text or null on failure. `onInstall` is
 * called once before the one-time setup, so the owner knows why the first one is slow.
 */
export async function transcribe(file, lang = 'ru', {onInstall} = {}) {
  const uvx = await ensureUvx(onInstall);
  if (!uvx) return null;
  try {
    const txt = await whisper(uvx, file, ['--model', process.env.STT_MODEL || 'small', '--beam_size', '1',
      '--initial_prompt', HINT[lang] ?? HINT.en], 'txt');
    return txt ? txt.trim() : null;
  } catch (e) {
    console.error('stt failed:', e.message.slice(0, 2000));
    return null;
  }
}

// Apple Silicon: MLX Whisper large-v3-turbo on the GPU, ~10x faster than CPU «medium» and
// more accurate (a 4:43 take in about a minute). It decodes audio with the system ffmpeg.
const MLX = process.platform === 'darwin' && process.arch === 'arm64' && spawnSync('ffmpeg', ['-version'], {stdio: 'ignore'}).status === 0;
const MLX_MODELS = {turbo: 'mlx-community/whisper-large-v3-turbo', 'large-v3': 'mlx-community/whisper-large-v3-mlx', medium: 'mlx-community/whisper-medium-mlx', small: 'mlx-community/whisper-small-mlx'};

async function mlx(uvx, wav, extra) {
  const out = mkdtempSync(join(tmpdir(), 'reels-stt-'));
  try {
    await run(uvx, ['--from', 'mlx-whisper', 'mlx_whisper', wav, '--output-format', 'json', '--output-dir', out, '--verbose', 'False', ...extra],
      {timeout: 60 * 60_000, maxBuffer: 64 << 20});
    const f = readdirSync(out).find((x) => x.endsWith('.json'));
    if (!f) throw new Error('mlx_whisper wrote no output');
    return JSON.parse(readFileSync(join(out, f), 'utf8'));
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
}

/**
 * Speech of footage with the time of every word, for picking takes and word-by-word
 * captions: Whisper's JSON {text, language, segments: [{start, end, text, words: [{word,
 * start, end, probability}]}]}. `lang` 'auto' detects it from 30 s in the MIDDLE of the
 * file: takes often open with chatter in another language, and Whisper detecting from the
 * start then translates the whole take (an English take came out in Russian). Throws.
 */
export async function transcribeWords(file, {lang = 'auto', model, prompt} = {}) {
  const uvx = await ensureUvx();
  if (!uvx) throw new Error('uv is not available');
  if (!MLX) {
    const extra = ['--model', model || process.env.STT_FOOTAGE_MODEL || 'medium', '--beam_size', '5', '--word_timestamps', 'True'];
    if (lang === 'auto') lang = await detectLanguage(file, (clip) => whisper(uvx, clip, ['--model', 'small', '--beam_size', '1'], 'json').then((j) => JSON.parse(j).language));
    if (lang) extra.push('--language', lang);
    if (prompt) extra.push('--initial_prompt', prompt);
    const json = await whisper(uvx, file, extra, 'json');
    if (!json) throw new Error('whisper wrote no output');
    return JSON.parse(json);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'reels-stt-'));
  try {
    const wav = join(tmp, 'audio.wav');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav]);
    const name = MLX_MODELS[model || 'turbo'] || model;
    if (lang === 'auto') lang = await detectLanguage(wav, (clip) => mlx(uvx, clip, ['--model', name]).then((j) => j.language));
    const extra = ['--model', name, '--word-timestamps', 'True', '--condition-on-previous-text', 'False'];
    if (lang) extra.push('--language', lang);
    if (prompt) extra.push('--initial-prompt', prompt);
    return await mlx(uvx, wav, extra);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
}

// Language of the middle 30 s (of the longest file part that has speech); null = let Whisper decide.
async function detectLanguage(file, detect) {
  const tmp = mkdtempSync(join(tmpdir(), 'reels-lang-'));
  try {
    const {stdout} = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).catch(() => ({stdout: ''}));
    const dur = Number(stdout) || 0;
    const clip = join(tmp, 'mid.wav');
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, dur / 2 - 15)), '-t', '30', '-i', file, '-vn', '-ac', '1', '-ar', '16000', clip]);
    return (await detect(clip)) || null;
  } catch {
    return null;
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
}
