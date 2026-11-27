// The cover generator (issue #152): frame → text → design, in «Готово» and «Сборка» and in Telegram.
//
// Per version of a reel, in `versions/<vN>/cover/`:
//   cover.json   the state the page keeps: {frame: {t, by, file, person}, rubric, text, designs: [{id, name, note, file}], chosen}
//   texts.json   written by CLAUDE (the chat agent): {"texts": [{"t1", "t2", "zone", "zoneAlt", "items", "right", "caption", "place", "why"}]}
//                — four proposals by the meaning of the video; the fields each rubric needs are in TEXT_FIELDS below
//   frame-*.jpg, person-*.png, d1.png … d4.png   the picked frame, the host cut out of it, the designs
// The chosen design becomes `versions/<vN>/cover.png` (1080×1920) and `cover-3x4.png` (the feed crop), which
// every other place already reads as «the cover» (file kind «cover»).
//
// The look is the brand's cover system («Правила: обложки, метки, формы»): template/src/cover/CoverDS.tsx.
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {ffCommand, videoInfo} from '../bot/media.mjs';
import {bestVideo} from './dllink.mjs';

const TEMPLATE = join(import.meta.dirname, '..', 'template');
/** The fixed places and sizes (template/src/cover/geometry.json): a headline line longer than title.maxChars is refused, not shrunk. */
export const GEOMETRY = JSON.parse(readFileSync(join(TEMPLATE, 'src', 'cover', 'geometry.json'), 'utf8'));
const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2));
const sec = (t) => Math.max(0, Math.round(Number(t) * 100) / 100);
const tag = (t) => String(sec(t)).replace('.', '_');

/** What the agent writes per rubric (the page shows exactly these). */
export const TEXT_FIELDS = {
  useful: 't1 + t2 (headline, 2 lines of at most 18 characters each, thin, no emoji), zone (ONE short word, ≤7 letters, for behind the host), zoneAlt (a sign or number: ×2, 20.11, 0 ₾; optional), items (up to 4 short words of a list; optional), right (a few words for the mono line at the top right, e.g. the series or topic)',
  news: 't1 + t2 (headline, 2 lines of at most 18 characters each; t2 is the highlighted half), zone (a word), zoneAlt (the number or date to put big behind the host), right',
  memes: 'caption (the meme line, ≤90 characters, as a person would say it)',
  beauty: 'place (one mono line like «Гудаури · 2196 м»)',
};
export const RUBRIC_NAMES = {useful: 'Полезное', news: 'Новость', memes: 'Мемы', beauty: 'Красивое'};

const dirOf = (reel, v) => join(reel, 'versions', v, 'cover');
export const read = (reel, v) => readJson(join(dirOf(reel, v), 'cover.json'), {v});
export const save = (reel, v, st) => { mkdirSync(dirOf(reel, v), {recursive: true}); writeJson(join(dirOf(reel, v), 'cover.json'), st); return st; };
export const texts = (reel, v) => readJson(join(dirOf(reel, v), 'texts.json'), {texts: []}).texts?.filter((x) => x && typeof x === 'object') || [];

function ff(bin, args, opts = {}) {
  const [cmd, full] = ffCommand(bin, args);
  return spawnSync(cmd, full, {encoding: 'utf8', maxBuffer: 64 << 20, ...opts});
}

/**
 * The video a cover frame is taken from: the reel's clean cut without graphics (project/public/cut-graded.mov, else
 * cut.mov) — the cover lays its own text, the reel's plates must not show through. The generator scrubs this very file,
 * so the frame on screen is the frame cut. Without a clean cut: the version's master, else its best copy.
 */
export function sourceOf(reel, v) {
  const pub = join(reel, 'project', 'public');
  for (const f of ['cut-graded.mov', 'cut-graded.mp4', 'cut.mov', 'cut.mp4']) if (existsSync(join(pub, f))) return join(pub, f);
  return bestVideo(join(reel, 'versions', v));
}
export const isClean = (reel, v) => sourceOf(reel, v)?.startsWith(join(reel, 'project', 'public')) || false;

/**
 * The host's cut-out (a webm with alpha the reel's project made) — only when it runs as long as the
 * version's video, so its time is the video's time. Otherwise a cutout of another moment would be laid
 * over the frame; without a mask the designs «слово за ведущим» are not offered.
 */
export function maskOf(reel, v) {
  const src = sourceOf(reel, v);
  const pub = join(reel, 'project', 'public');
  if (!src || !existsSync(pub)) return null;
  const dur = Number(ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).stdout.trim());
  if (!dur) return null;
  const ms = readdirSync(pub).filter((f) => /^person.*\.(webm|mov)$/i.test(f) && !/^person-\d/.test(f));
  for (const f of ms) {
    const d = Number(ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(pub, f)]).stdout.trim());
    if (Math.abs(d - dur) <= 0.3) return join(pub, f);
  }
  return null;
}

/** Cuts the frame at `t` seconds (1080×1920, JPEG) and, when there is a mask, the host at the same moment. */
export function takeFrame(reel, v, t, by = 'user') {
  const src = sourceOf(reel, v);
  if (!src) throw new Error('нет видео этой версии');
  t = sec(t);
  const dir = dirOf(reel, v); mkdirSync(dir, {recursive: true});
  const file = `frame-${tag(t)}.jpg`;
  const r = ff('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', src, '-frames:v', '1', '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920', '-q:v', '2', join(dir, file)]);
  if (r.status !== 0 || !existsSync(join(dir, file))) throw new Error('не вышло вырезать кадр');
  const mask = maskOf(reel, v);
  let person = null;
  if (mask) {
    const pf = `person-${tag(t)}.png`;
    const p = ff('ffmpeg', ['-y', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-ss', String(t), '-i', mask, '-frames:v', '1', '-vf', 'scale=1080:1920,format=rgba', join(dir, pf)]);
    if (p.status === 0 && existsSync(join(dir, pf))) person = pf;
  }
  const st = read(reel, v);
  return save(reel, v, {...st, v, frame: {t, by, file, person}, designs: [], chosen: null});
}

/**
 * Sharp, well-lit frames to start from: the first seconds of the video, sampled three times a second,
 * ranked by edge strength and kept away from too dark and too bright ones. Honest about what it knows: no faces.
 */
export function suggest(reel, v, {from = 0.2, to = 8, n = 3} = {}) {
  const cache = join(dirOf(reel, v), 'suggest.json');
  const src = sourceOf(reel, v);
  if (!src) return [];
  const stamp = Math.round(statSync(src).mtimeMs);
  const c = readJson(cache, null);
  if (c?.stamp === stamp) return c.times;
  const run = (vf) => {
    const r = ff('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(to - from), '-i', src, '-vf', `fps=3,scale=270:480,${vf},metadata=mode=print:key=lavfi.signalstats.YAVG`, '-an', '-f', 'null', '-']);
    return [...(r.stderr || '').matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  };
  const edge = run('edgedetect,signalstats'), luma = run('signalstats');
  const pick = [];
  const ranked = edge.map((e, i) => ({t: sec(from + i / 3), e, l: luma[i] ?? 100})).filter((x) => x.l > 35 && x.l < 215).sort((a, b) => b.e - a.e);
  for (const x of ranked) if (pick.length < n && pick.every((y) => Math.abs(y.t - x.t) >= 0.7)) pick.push(x);
  const times = pick.map((x) => x.t).sort((a, b) => a - b).map((t) => ({t, file: `sug-${tag(t)}.jpg`}));
  mkdirSync(dirOf(reel, v), {recursive: true});
  for (const x of times) ff('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(x.t), '-i', src, '-frames:v', '1', '-vf', 'scale=180:-2', '-q:v', '4', join(dirOf(reel, v), x.file)]);
  writeJson(cache, {stamp, times});
  return times;
}

// ---------- designs ----------

/** The four (at most) designs a rubric offers, from the brand's cover system. `person` = the host is cut out. */
export function designsFor(rubric, text, person) {
  const z = (zone, zoneText, extra = {}) => ({zone, zoneText, ...extra});
  if (rubric === 'memes') return [
    {id: 'meme-top', name: 'Плашка сверху', note: 'Улыбка в углу, плашка повёрнута на 3°.', props: {memeLayout: 'top'}},
    {id: 'meme-bottom', name: 'Плашка снизу', note: 'Подпись над зоной счётчика, поворот в другую сторону.', props: {memeLayout: 'bottom'}},
    {id: 'meme-cut', name: 'Текст сверху, срез 12°', note: 'Белое поле срезано под наш угол, наклона нет.', props: {memeLayout: 'cut'}},
  ];
  if (rubric === 'beauty') return [
    {id: 'beauty-line', name: 'Фото и строка места', note: 'Ничего, кроме строки моноширинным.', props: {}},
  ];
  const out = [];
  if (person) {
    if (text.zone) out.push({id: 'word', name: rubric === 'news' ? 'Б · слово за ведущим' : 'А · слово за ведущим', note: 'Основной для полезного: слово за головой.', props: z('word', text.zone)});
    if (text.zoneAlt) out.push({id: 'sign', name: rubric === 'news' ? 'Б · число за ведущим' : 'А · знак вместо слова', note: 'Короче и крупнее — читается и в сетке.', props: z(rubric === 'news' ? 'number' : 'word', text.zoneAlt)});
    if (text.items?.length > 1) out.push({id: 'list', name: 'В · список за ведущим', note: 'Когда в ролике перечень.', props: z('list', '', {items: text.items.slice(0, 4)})});
  }
  out.push({id: 'photo', name: 'Г · кадр целиком', note: person ? 'Чище: без слова, держится на заголовке.' : 'Нет выреза ведущего — кадр целиком.', props: z('none', '')});
  return out.slice(0, 4);
}

function dataUri(file, mime) { return `data:${mime};base64,${readFileSync(file).toString('base64')}`; }

/**
 * Renders the designs of the picked frame with the chosen text (one browser, the bundle is cached).
 * Resolves with the new state; the stills are `d1.png`…
 */
export function build(reel, v, {text, rubric, plate, date}, {cache}) {
  const st = read(reel, v);
  if (!st.frame) throw new Error('сначала выбери кадр');
  const max = GEOMETRY.title.maxChars;
  for (const line of [text.t1, text.t2]) if (line && line.length > max) throw new Error(`строка «${line}» длиннее ${max} знаков — сократи: заголовок не уменьшается`);
  const dir = dirOf(reel, v);
  const person = st.frame.person && existsSync(join(dir, st.frame.person)) ? st.frame.person : null;
  const label = rubric === 'news' ? `Новость${date ? ' · ' + date : ''}` : plate || RUBRIC_NAMES[rubric] || '';
  const list = designsFor(rubric, text, person);
  const jobs = list.map((d, i) => ({
    out: join(dir, `d${i + 1}.png`),
    props: {rubric, label, right: text.right, t1: text.t1 || '', t2: text.t2, caption: text.caption, place: text.place, series: text.series, zone: 'none', ...d.props,
      frame: dataUri(join(dir, st.frame.file), 'image/jpeg'), person: person && d.props.zone && d.props.zone !== 'none' ? dataUri(join(dir, person), 'image/png') : undefined},
  }));
  mkdirSync(cache, {recursive: true});
  const jobFile = join(dir, 'job.json');
  writeJson(jobFile, {bundle: join(cache, 'cover-bundle'), jobs});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(TEMPLATE, 'cover-render.mjs'), jobFile], {cwd: TEMPLATE, stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`обложка не собралась: ${err.trim().split('\n').slice(-2).join(' ')}`));
      resolve(save(reel, v, {...st, rubric, text, designs: list.map((d, i) => ({id: d.id, name: d.name, note: d.note, file: `d${i + 1}.png`, at: Date.now()})), chosen: null}));
    });
  });
}

/** Makes a design the version's cover: cover.png (9:16) and cover-3x4.png (the feed crop, y 240–1680). */
export function choose(reel, v, id) {
  const st = read(reel, v);
  const d = st.designs?.find((x) => x.id === id);
  if (!d) throw new Error('нет такого варианта');
  const src = join(dirOf(reel, v), d.file), vdir = join(reel, 'versions', v);
  copyFileSync(src, join(vdir, 'cover.png'));
  ff('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', 'crop=1080:1440:0:240', join(vdir, 'cover-3x4.png')]);
  return save(reel, v, {...st, chosen: id, at: Date.now()});
}

/** The note that goes to the chat with the frame: what Claude must write, and where. */
export function agentNote(reel, v, st, rubric, prompt = '') {
  const rel = `${basename(reel)}/versions/${v}/cover`;
  return `(cover generator, version ${v}) The owner picked the frame at ${sec(st.frame.t)} s for the cover of this reel (rubric: ${RUBRIC_NAMES[rubric] || rubric}; file ${rel}/${st.frame.file} — look at it). Propose FOUR texts for the cover by the meaning of the video (script, README, scenes) and write them to \`${rel}/texts.json\` as {"texts": [{"why": "5–8 words: what this angle says", ${TEXT_FIELDS[rubric] || TEXT_FIELDS.useful}}]} — exactly this file and shape, valid JSON; the page picks them up. Follow the project's design system and facts; numbers only from facts or the script. Four DIFFERENT angles (the main point, the sharpest number, what the viewer should do, a question). Reply in one or two lines; the page shows the texts. ${prompt ? `The owner adds: ${prompt}` : ''}`.trim();
}
