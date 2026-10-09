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

/**
 * Transcribes an audio file; resolves to the text or null on failure. `onInstall` is
 * called once before the one-time setup, so the owner knows why the first one is slow.
 */
export async function transcribe(file, lang = 'ru', {onInstall} = {}) {
  let uvx = findUvx();
  if (!uvx) {
    await onInstall?.();
    try {
      await installUv();
    } catch (e) {
      console.error('stt install failed:', e.message);
    }
    uvx = findUvx();
    if (!uvx) return null;
  }
  const model = process.env.STT_MODEL || 'small';
  const out = mkdtempSync(join(tmpdir(), 'reels-stt-'));
  try {
    await run(uvx, [
      'whisper-ctranslate2', file,
      '--model', model,
      '--output_format', 'txt',
      '--output_dir', out,
      '--initial_prompt', HINT[lang] ?? HINT.en,
    ], {timeout: 10 * 60_000, windowsHide: true});
    const txt = readdirSync(out).find((f) => f.endsWith('.txt'));
    return txt ? readFileSync(join(out, txt), 'utf8').trim() : null;
  } catch (e) {
    console.error('stt failed:', e.message.slice(0, 2000));
    return null;
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
}
