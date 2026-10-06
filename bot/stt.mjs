// Local speech-to-text for voice notes: no API keys, the model downloads on first use.
import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

// Domain words steer Whisper away from near-misses like «хуб» for «хук».
const HINT = {
  ru: 'Правки к рилсу: хук, сцена, музыка, трек, обложка, монтаж, переход, титры.',
  en: 'Reel feedback: hook, scene, music, track, cover, cut, transition, captions.',
};

/** Transcribes an audio file; resolves to the text or null when STT is unavailable. */
export async function transcribe(file, lang = 'ru') {
  const model = process.env.STT_MODEL || 'small';
  const out = mkdtempSync(join(tmpdir(), 'reels-stt-'));
  try {
    await run('uvx', [
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
