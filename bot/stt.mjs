// Local speech-to-text for voice notes: no API keys. It needs `uv`, which is not a
// setup requirement: on the first voice note the bot installs it into the user's home
// (official installer, no sudo, PATH untouched); the model downloads on first use too.
import {execFile, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);
const win = process.platform === 'win32';

// Domain words steer Whisper away from near-misses like «хуб» for «хук».
const HINT = {
  ru: 'Правки к рилсу: хук, сцена, музыка, трек, обложка, монтаж, переход, титры.',
  en: 'Reel feedback: hook, scene, music, track, cover, cut, transition, captions.',
};

function findUvx() {
  if (spawnSync('uvx', ['--version'], {stdio: 'ignore', windowsHide: true}).status === 0) return 'uvx';
  const exe = win ? 'uvx.exe' : 'uvx';
  return [join(homedir(), '.local', 'bin', exe), join(homedir(), '.cargo', 'bin', exe)].find(existsSync) ?? null;
}

async function installUv() {
  const env = {...process.env, UV_NO_MODIFY_PATH: '1'};
  if (win) {
    await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'ByPass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'], {env, timeout: 300_000, windowsHide: true});
  } else {
    await run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh || wget -qO- https://astral.sh/uv/install.sh | sh'], {env, timeout: 300_000});
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
      console.error('stt install', e.message.split('\n')[0]);
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
    console.error('stt', e.message.split('\n')[0]);
    return null;
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
}
