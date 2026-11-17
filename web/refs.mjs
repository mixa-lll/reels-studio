// Референсы проекта (Идеи › Референсы): someone else's reels the project learns from.
// projects/<p>/refs/refs.json holds the list and Claude's overall summary; each reference has
// its own folder refs/<id>/ with the video, a few frames and the transcript of its speech, so
// Claude can really «watch» it: links are downloaded here (yt-dlp through uvx, as bot/stt.mjs
// runs Whisper), files are copied. Claude fills takes / note / skip when asked to study them.
import {execFile} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {transcribe} from '../bot/stt.mjs';

const run = promisify(execFile);
export const TAKES = ['hook', 'edit', 'plates', 'delivery', 'sound', 'cover', 'humor'];
const FRAMES = 6;

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f); };
const s = (x, n) => String(x ?? '').slice(0, n);

export const refsDir = (studio) => join(studio, 'refs');
const refsFile = (studio) => join(refsDir(studio), 'refs.json');
export const loadRefs = (studio) => ({summary: '', list: [], ...readJson(refsFile(studio), {})});
function saveRefs(studio, data) { mkdirSync(refsDir(studio), {recursive: true}); writeJson(refsFile(studio), data); }

/** A new reference from a link or an uploaded file (its path on disk); prep() fetches it. */
export function addRef(studio, {url, path, name, rubric, by}) {
  const data = loadRefs(studio);
  const ref = {id: 'ref-' + randomBytes(4).toString('hex'), url: url ? s(url, 500) : null, name: s(name || (url ? new URL(url).hostname.replace(/^www\./, '') : 'файл'), 120),
    rubric: rubric ? s(rubric, 60) : null, takes: [], note: '', skip: '', seen: '', status: 'prep', at: new Date().toISOString().slice(0, 10), by: s(by, 60)};
  data.list.unshift(ref);
  data.list = data.list.slice(0, 80);
  saveRefs(studio, data);
  return {ref, path};
}

/** The fields a person changes by hand: rubric, takes, note, skip, name; or removes it. */
export function changeRef(studio, id, b) {
  const data = loadRefs(studio);
  const ref = data.list.find((x) => x.id === id);
  if (!ref) return null;
  if (b.remove) {
    data.list = data.list.filter((x) => x !== ref);
    rmSync(join(refsDir(studio), id), {recursive: true, force: true});
    saveRefs(studio, data);
    return {removed: true};
  }
  if (b.rubric !== undefined) ref.rubric = b.rubric ? s(b.rubric, 60) : null;
  if (Array.isArray(b.takes)) ref.takes = b.takes.filter((t) => TAKES.includes(t));
  for (const [k, n] of [['name', 120], ['note', 500], ['skip', 400]]) if (b[k] !== undefined) ref[k] = s(b[k], n);
  saveRefs(studio, data);
  return ref;
}

function setRef(studio, id, patch) {
  const data = loadRefs(studio);
  const ref = data.list.find((x) => x.id === id);
  if (!ref) return;
  Object.assign(ref, patch);
  saveRefs(studio, data);
}

/** What the page shows: frames and the video as /media links, the transcript's first lines. */
export function refView(studio, ref, mediaUrl) {
  const dir = join(refsDir(studio), ref.id);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const video = files.find((f) => /^video\.(mp4|mov|webm|mkv)$/i.test(f));
  const transcript = files.includes('transcript.txt') ? readFileSync(join(dir, 'transcript.txt'), 'utf8') : '';
  return {...ref, video: video ? mediaUrl(join(dir, video)) : null,
    frames: files.filter((f) => /^frame-\d+\.jpg$/.test(f)).sort().map((f) => mediaUrl(join(dir, f))), transcript: transcript.slice(0, 4000)};
}

/**
 * Gets the reference ready for Claude: the video in refs/<id>/, FRAMES frames and the speech
 * as text. Runs in the background; the status goes prep → ready (or error with the reason).
 */
export async function prepRef(studio, id, {url, path}) {
  const dir = join(refsDir(studio), id);
  mkdirSync(dir, {recursive: true});
  try {
    if (path) copyFileSync(path, join(dir, 'video' + (/\.\w+$/.exec(path)?.[0].toLowerCase() || '.mp4')));
    else await run('uvx', ['yt-dlp', '--no-playlist', '--max-filesize', '300M', '-f', 'mp4/bv*+ba/b', '--merge-output-format', 'mp4', '-o', join(dir, 'video.%(ext)s'), url], {timeout: 5 * 60_000});
    const video = readdirSync(dir).find((f) => /^video\./.test(f));
    if (!video) throw new Error('видео не скачалось');
    const v = join(dir, video);
    const {stdout} = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', v]);
    const len = Number(stdout.trim()) || 0;
    for (let i = 0; i < FRAMES; i++) {
      const t = len ? (len * (i + 0.5)) / FRAMES : i;
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', v, '-frames:v', '1', '-vf', 'scale=480:-2', join(dir, `frame-${i + 1}.jpg`)]).catch(() => {});
    }
    setRef(studio, id, {len: Math.round(len), status: 'ready'});
    // The speech is the slow part (Whisper): the reference is usable before it ends.
    const text = await transcribe(v, 'ru');
    if (text) writeFileSync(join(dir, 'transcript.txt'), text);
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    const why = /login|cookies|private|rate-limit|403/i.test(msg) ? 'сайт не отдал видео без входа — скачайте его и загрузите файлом' : 'не получилось скачать — загрузите видео файлом';
    console.error('ref', id, msg.slice(0, 500));
    setRef(studio, id, {status: 'error', error: why});
  }
}
