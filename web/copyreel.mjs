// «Сделать по образцу»: a new reel made from an existing one. It takes the reel's script,
// scenes, code (timings, plates, style) and sound, but not its versions; what else it takes
// depends on what changes:
//   material — new footage, same story: video and photos stay behind, scenes wait for new ones;
//   lang     — the same footage in another language (RU ↔ EN): media come along;
//   theme    — only the style and rhythm: new text and new footage.
// The new reel gets based-on.json with the task for Claude, sent when the owner presses «Собрать».

import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export const MODES = ['material', 'lang', 'theme'];
const VIDEO = /\.(mp4|mov|webm|m4v|mkv)$/i;
const PHOTO = /\.(jpe?g|heic|webp|tiff?)$/i;
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + '\n');

// Footage stays behind for a new material or theme; music, voice-free sound, fonts, logos come.
const keepMedia = (mode) => (src) => {
  if (/node_modules|[\\/]\.remotion|[\\/]out[\\/]?$/.test(src)) return false;
  if (mode === 'lang' || !/[\\/]public[\\/]/.test(src)) return true;
  try { if (statSync(src).isDirectory()) return true; } catch { return false; }
  if (VIDEO.test(src) || PHOTO.test(src)) return false;
  // Frame sequences (masks, cut-outs: p0001.png…) were made from the old footage.
  if (/\d{3,}\.(png|jpe?g|webp)$/i.test(src)) return false;
  // A big PNG is a photo, a small one a logo or a plate.
  if (/\.png$/i.test(src) && statSync(src).size > 1.5e6) return false;
  // A voice-over belongs to the old story.
  if (/voice|vo[-_.]|narration|озвуч/i.test(src)) return false;
  return true;
};

export function nextNumber(reelsDir) {
  const taken = existsSync(reelsDir) ? readdirSync(reelsDir).map((d) => Number(d.slice(0, 2))).filter(Number.isFinite) : [];
  return String(Math.max(0, ...taken) + 1).padStart(2, '0');
}

const isEn = (id) => /(^|-)en(-\d+)?$/.test(id.replace(/^\d+-/, ''));
const baseSlug = (id) => id.replace(/^\d+-+/, '').replace(/-(en|ru)(-\d+)?$/, '').replace(/-po-obraztsu-\d+$/, '') || 'reel';

/** Makes the new reel; returns {id, title, mode, prompt}. */
export function copyReel(studio, from, {mode, root, by = '', now = Date.now()}) {
  if (!MODES.includes(mode)) throw new Error('mode');
  const reels = join(studio, 'reels');
  const src = join(reels, from);
  if (!existsSync(src)) throw new Error('no reel');
  const nn = nextNumber(reels);
  const toLang = mode === 'lang' ? (isEn(from) ? 'ru' : 'en') : null;
  const id = `${nn}-${baseSlug(from)}${toLang === 'en' ? '-en' : mode === 'lang' ? '-ru' : `-po-obraztsu-${from.slice(0, 2)}`}`;
  const dir = join(reels, id);
  for (const d of ['sources', 'versions']) mkdirSync(join(dir, d), {recursive: true});

  // The code: timings, plates, style. node_modules is shared, as in scripts/new-reel.mjs.
  if (existsSync(join(src, 'project'))) cpSync(join(src, 'project'), join(dir, 'project'), {recursive: true, filter: keepMedia(mode)});
  else cpSync(join(root, 'template'), join(dir, 'project'), {recursive: true, filter: (s) => !s.includes('node_modules')});
  const modules = join(root, 'template', 'node_modules');
  if (existsSync(modules) && !existsSync(join(dir, 'project', 'node_modules'))) symlinkSync(modules, join(dir, 'project', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Another language works from the same footage the reel was cut from.
  if (mode === 'lang' && existsSync(join(src, 'sources'))) cpSync(join(src, 'sources'), join(dir, 'sources'), {recursive: true});

  const scenes = readJson(join(src, 'scenes.json'), null);
  if (Array.isArray(scenes)) {
    const next = scenes.map((x) => mode === 'lang' ? {...x}
      : mode === 'material' ? {...x, have: '', status: 'нужно'}
      : {t: x.t, name: '', screen: '', text: '', sound: x.sound || '', need: '', have: '', status: 'нужно'});
    writeJson(join(dir, 'scenes.json'), next);
  }
  if (mode !== 'theme' && existsSync(join(src, 'publish.json'))) cpSync(join(src, 'publish.json'), join(dir, 'publish.json'));

  const srcReadme = read(join(src, 'README.md'));
  const srcTitle = (/^#\s*(.+)/m.exec(srcReadme)?.[1] || from).replace(/^\d+[\s—–-]*/, '').trim();
  const title = mode === 'lang' ? `${srcTitle.replace(/\s*\((EN|RU)\)\s*$/i, '')} (${toLang.toUpperCase()})` : mode === 'material' ? `${srcTitle} — новый материал` : `По образцу ${from.slice(0, 2)}`;
  const what = {
    material: 'Same story, structure, timing, plates, style and music; new footage. The old video and photos were left behind on purpose: put the new material from sources/ into the same scenes (scenes.json says what each scene needs), and adapt the on-screen texts and the caption to what the new footage shows. Keep the language.',
    lang: `Same footage and edit, another language: ${toLang === 'en' ? 'Russian → English' : 'English → Russian'}. Translate the on-screen texts, plates and the caption (publish.json) naturally, not word for word; re-time plates if the text got longer. If the original has a Russian voice-over, say so and ask before replacing it.`,
    theme: 'Only the style and rhythm come from the original: plates, fonts, transitions, pacing, music. The topic, text and footage are new: ask what it is about if the chat does not say, then write the script and fill scenes.json.',
  }[mode];
  writeFileSync(join(dir, 'README.md'), `# ${nn} ${title}\n\n## По образцу\n\nСделан по образцу «${from}» (${{material: 'новый материал', lang: 'другой язык', theme: 'новая тема'}[mode]}), ${new Date(now).toLocaleDateString('ru-RU')}${by ? `, ${by}` : ''}.\nОбразец: \`../${from}/\` — его версии, код и сценарий можно открыть.\n\n${what}\n\n## Сценарий образца\n\n${srcReadme.replace(/^#\s*.+\n?/m, '').trim()}\n`);

  const prompt = `This reel was made from «${from}» with «Сделать по образцу» (${mode}). ${what} Read README.md and scenes.json of this reel and of ../${from}/ first, then build v1.`;
  writeJson(join(dir, 'based-on.json'), {from, mode, lang: toLang, at: now, by, prompt});
  return {id, title, mode, prompt};
}

export const copyLabel = {material: 'новый материал', lang: 'другой язык', theme: 'новая тема'};
