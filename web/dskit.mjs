// The reels style page (design-system/index.html, built outside the studio) laid out inside
// «Память › Дизайн»: its live 9:16 frames per technique, its CSS for them, and the rules from
// design-system/STYLE.md. The studio draws its own headings and puts each frame grid in a
// shadow root, so the page's CSS stays inside. Pictures embedded in the page are written next to
// it (design-system/img/) once, so the frames load them as plain files.
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

// Techniques shown in the studio, in order. The page's research (refs, scope), its base table
// (the studio shows colours and type itself), the old per-rubric table and open questions
// (taken from STYLE.md instead) stay on the full page.
export const KIT_SECTIONS = ['frame', 'titles', 'cards', 'map', 'grade', 'motion'];
const cache = new Map();
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function section(md, title) {
  const m = new RegExp(`^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(md);
  return m ? m[1].trim() : '';
}
const items = (s) => s.split('\n').map((l) => l.replace(/^\s*(\d+\.|-)\s+/, '').trim()).filter((l) => l && !l.startsWith('|'));
function table(s) {
  const rows = s.split('\n').filter((l) => l.trim().startsWith('|') && !/^\|\s*-/.test(l.trim())).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  return rows.length ? {head: rows[0], rows: rows.slice(1)} : null;
}

/** {sections:[{id, title, lead, html}], css, rules, rubrics, open, updated} or null. */
export function readKit(dsDir, base) {
  const page = join(dsDir, 'index.html');
  if (!existsSync(page)) return null;
  const at = statSync(page).mtimeMs + (existsSync(join(dsDir, 'STYLE.md')) ? statSync(join(dsDir, 'STYLE.md')).mtimeMs : 0);
  const hit = cache.get(dsDir);
  if (hit?.at === at) return hit.kit;
  const html = readFileSync(page, 'utf8');
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0] || '';
  const imgs = /const IMG=(\{[\s\S]*?\});/.exec(html);
  const IMG = imgs ? JSON.parse(imgs[1]) : {};
  const sections = [];
  for (const id of KIT_SECTIONS) {
    const m = new RegExp(`<section id="${id}">([\\s\\S]*?)</section>`).exec(html);
    if (!m) continue;
    let body = m[1];
    const head = /<header>([\s\S]*?)<\/header>/.exec(body);
    const title = head ? strip(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(head[1])?.[1] || '') : id;
    const lead = head ? strip(/<p[^>]*>([\s\S]*?)<\/p>/.exec(head[1])?.[1] || '') : '';
    if (head) body = body.replace(head[0], '');
    body = body.replace(/data-s="([\w.-]+)"/g, (_, n) => {
      const f = join(dsDir, 'img', n);
      if (!existsSync(f) && /^data:[\w/+-]+;base64,/.test(IMG[n] || '')) {
        mkdirSync(join(dsDir, 'img'), {recursive: true});
        writeFileSync(f, Buffer.from(IMG[n].split(',')[1], 'base64'));
      }
      return `src="${base}img/${n}"`;
    }).replace(/<script[\s\S]*?<\/script>/g, '');
    sections.push({id, title, lead, html: body});
  }
  // The page's own CSS, made to work inside a shadow root next to the studio: no page body,
  // no bar, light only; «zones» switch on a wrapper instead of <body>.
  const kitCss = css
    .replace(/@media \(prefers-color-scheme:dark\)\{[^{}]*\{[^{}]*\}\}/g, '')
    .replace(/:root\[data-theme="dark"\]\{[^}]*\}/g, '')
    .replace(/:root\{/g, ':host{')
    .replace(/(^|\})body\{[^}]*\}/g, '$1')
    .replace(/body\.zones \.z/g, '.kit.zones .z');
  const md = existsSync(join(dsDir, 'STYLE.md')) ? readFileSync(join(dsDir, 'STYLE.md'), 'utf8') : '';
  // The mark and the lock-up drawn inline (the files have no xmlns, so <img> shows nothing).
  const svg = (f) => {
    const t = existsSync(join(dsDir, 'assets', f)) ? readFileSync(join(dsDir, 'assets', f), 'utf8') : '';
    return t.replace(/<script[\s\S]*?<\/script>/g, '').replace(/\son\w+="[^"]*"/g, '').replace(/^<svg([^>]*?)\swidth="[^"]*"/, '<svg$1').replace(/^<svg([^>]*?)\sstyle="[^"]*"/, '<svg$1');
  };
  const kit = {sections, marks: {mark: svg('mark.svg'), lock: svg('lock_left.svg')}, css: kitCss, rules: items(section(md, 'Сводка правил')), rubrics: table(section(md, 'По рубрикам')), open: items(section(md, 'Ещё не решено')), updated: statSync(page).mtimeMs};
  cache.set(dsDir, {at, kit});
  return kit;
}
