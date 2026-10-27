// Posts for the web studio: a text with 0–10 pictures — a text post (Telegram), a post
// with a photo, or a carousel of slides drawn from five templates. Each post is a folder
// projects/<p>/posts/<NN-slug>/ with post.json (what the editor shows), sources/ (photos
// people brought) and images/ (cropped photos, slide PNGs). Its chat key is «post-<id>».
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ffCommand} from '../bot/media.mjs';

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f); };

export const KINDS = ['text', 'photo', 'carousel'];
export const TEMPLATES = {cover: 'Обложка', list: 'Список', check: 'Чек', summary: 'Итог', cta: 'Призыв'};

export const postsRoot = (studio) => join(studio, 'posts');
export const postDir = (studio, id) => (typeof id === 'string' && /^[\w-]{1,80}$/.test(id) && existsSync(join(studio, 'posts', id)) ? join(studio, 'posts', id) : null);
export const readPost = (dir) => readJson(join(dir, 'post.json'), {});
export const savePost = (dir, post) => writeJson(join(dir, 'post.json'), post);

/** Where a post stands: text (+ photo) → publish; a carousel goes structure → slides → publish. */
export function stageOf(post, dir) {
  if (post.published) return 'done';
  if (post.kind === 'carousel') return !(post.slides || []).length ? 'struct' : existsSync(join(dir, 'images', 'slide-01.png')) ? 'publish' : 'slides';
  if (!(post.texts || []).length) return 'text';
  if (post.kind === 'photo' && !(post.photos || []).some((x) => x.out)) return 'text';
  return 'publish';
}

export function listPosts(studio, mediaUrl) {
  const root = postsRoot(studio);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) => /^[\w-]{1,80}$/.test(d) && statSync(join(root, d)).isDirectory()).map((id) => {
    const dir = join(root, id);
    const post = readPost(dir);
    const img = (post.kind === 'carousel' ? ['images/slide-01.png'] : (post.photos || []).map((x) => x.out).filter(Boolean)).map((f) => join(dir, f)).find((f) => existsSync(f));
    return {id, num: /^(\d{1,3})/.exec(id)?.[1] || '', title: post.title || id, kind: post.kind || 'text', rubric: post.rubric || '', stage: stageOf(post, dir),
      slides: (post.slides || []).length, at: (post.captions || []).map((c) => Date.parse(c.at)).filter(Number.isFinite).sort()[0] || null,
      thumb: img ? mediaUrl(img) : null, updated: statSync(dir).mtimeMs};
  }).sort((a, b) => b.updated - a.updated);
}

/** New post folder «NN-slug»; the number continues the project's posts. */
export function newPost(studio, {kind, title, by}) {
  const root = postsRoot(studio);
  mkdirSync(root, {recursive: true});
  const n = Math.max(0, ...readdirSync(root).map((d) => Number(/^(\d+)/.exec(d)?.[1] || 0))) + 1;
  const lat = {а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya'};
  const slug = String(title || 'post').toLowerCase().replace(/[а-яё]/g, (c) => lat[c] ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'post';
  const id = `${String(n).padStart(2, '0')}-${slug}`;
  const dir = join(root, id);
  mkdirSync(join(dir, 'sources'), {recursive: true});
  mkdirSync(join(dir, 'images'), {recursive: true});
  savePost(dir, {kind: KINDS.includes(kind) ? kind : 'text', title: String(title || '').slice(0, 120) || 'Новый пост', texts: [], chosen: 0, photos: [], slides: [], captions: [], checks: [], created: Date.now(), by});
  return id;
}

// ---------- photos ----------

/** Crops a photo to 4:5 or 1:1 around the centre and optionally lifts it; no AI retouching. */
export function processPhoto(dir, src, {crop = '4:5', bright = false}) {
  const out = join(dir, 'images', `photo-${Date.now().toString(36)}.jpg`);
  const ratio = crop === '1:1' ? 1 : crop === 'orig' ? 0 : 4 / 5;
  const filters = [];
  if (ratio) filters.push(`crop='min(iw,ih*${ratio})':'min(ih,iw/${ratio})'`, `scale=${ratio === 1 ? '1080:1080' : '1080:1350'}`);
  else filters.push("scale='min(1080,iw)':-2");
  if (bright) filters.push('eq=brightness=0.06:contrast=1.04:saturation=1.05');
  const [cmd, args] = ffCommand('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', filters.join(','), '-frames:v', '1', '-q:v', '2', out]);
  const r = spawnSync(cmd, args, {encoding: 'utf8', windowsHide: true});
  if (r.status !== 0) throw new Error((r.stderr || 'ffmpeg failed').trim().split('\n').slice(-2).join(' '));
  return out;
}

// ---------- slides ----------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

/** The project's design tokens if its design system has them, else the studio's neutral ones. */
export function slideTheme(studio) {
  const t = readJson(join(studio, 'design-system', 'tokens.json'), {});
  const pick = (...keys) => keys.map((k) => k.split('.').reduce((o, x) => o?.[x], t)).find((v) => typeof v === 'string');
  return {
    bg: pick('colors.background', 'color.background', 'colors.bg') || '#FFFFFF',
    ink: pick('colors.text', 'color.text', 'colors.ink') || '#171717',
    accent: pick('colors.accent', 'color.accent', 'colors.primary') || '#E5484D',
    soft: pick('colors.muted', 'color.muted') || '#525252',
    font: pick('fonts.heading', 'font.heading', 'typography.heading') || 'Manrope',
  };
}

/** One slide, 1080×1350, from its template; texts only, colours and fonts from the theme. */
export function slideHtml(s, th, i, total) {
  const items = (s.items || []).slice(0, 6);
  const body = {
    cover: `<div class="kick">${esc(s.kicker || '')}</div><h1 class="big">${esc(s.title)}</h1>${s.text ? `<p class="lead">${esc(s.text)}</p>` : ''}<div class="swipe">Листай →</div>`,
    list: `<h1>${esc(s.title)}</h1><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`,
    check: `<h1>${esc(s.title)}</h1><div class="receipt">${items.map((x) => { const [a, b] = String(x).split(/\s+[—–-]\s+|\s*·\s*/); return `<div class="line"><span>${esc(a)}</span><b>${esc(b || '')}</b></div>`; }).join('')}${s.total ? `<div class="line tot"><span>Итого</span><b>${esc(s.total)}</b></div>` : ''}</div>`,
    summary: `<h1>${esc(s.title)}</h1>${s.text ? `<p class="lead">${esc(s.text)}</p>` : ''}${items.length ? `<ol>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}`,
    cta: `<h1 class="big">${esc(s.title || 'Сохрани 📌')}</h1>${s.text ? `<p class="lead">${esc(s.text)}</p>` : ''}<div class="btn">${esc(s.button || 'Ссылка в профиле')}</div>`,
  }[s.template] || `<h1>${esc(s.title)}</h1>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(th.font)}:wght@500;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}html,body{margin:0;width:1080px;height:1350px}
body{background:${th.bg};color:${th.ink};font-family:'${th.font}',Manrope,system-ui,sans-serif;padding:110px 96px;display:flex;flex-direction:column;gap:44px;position:relative}
h1{margin:0;font-size:84px;line-height:1.05;letter-spacing:-.03em;font-weight:800}h1.big{font-size:112px}
.kick{font-size:34px;font-weight:700;color:${th.accent};text-transform:uppercase;letter-spacing:.06em}
.lead{margin:0;font-size:46px;line-height:1.3;color:${th.soft};font-weight:500}
ul,ol{margin:0;padding-left:56px;font-size:50px;line-height:1.35;font-weight:500;display:flex;flex-direction:column;gap:22px}
li::marker{color:${th.accent};font-weight:800}
.receipt{border:4px dashed ${th.ink}33;border-radius:28px;padding:40px 44px;display:flex;flex-direction:column;gap:26px;font-size:46px}
.line{display:flex;justify-content:space-between;gap:30px}.line b{font-weight:800;white-space:nowrap}.tot{border-top:4px solid ${th.ink};padding-top:26px;font-size:54px}
.btn{margin-top:auto;align-self:flex-start;background:${th.accent};color:#fff;border-radius:999px;padding:30px 56px;font-size:44px;font-weight:700}
.swipe{margin-top:auto;font-size:40px;font-weight:700;color:${th.accent}}
.n{position:absolute;right:96px;bottom:70px;font-size:30px;color:${th.soft};font-weight:600}
</style></head><body>${body}<div class="n">${i + 1}/${total}</div></body></html>`;
}

/** Headless Chrome: the one Remotion downloaded for the template, else a system one. */
export function chromeBin(bot) {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const base = join(bot, 'template', 'node_modules', '.remotion', 'chrome-headless-shell');
  if (existsSync(base)) {
    for (const plat of readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory())) {
      for (const sub of readdirSync(join(base, plat)).filter((d) => statSync(join(base, plat, d)).isDirectory())) {
        const f = join(base, plat, sub, 'chrome-headless-shell');
        if (existsSync(f)) return f;
      }
    }
  }
  return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((f) => existsSync(f)) || null;
}

// Screenshots through the DevTools protocol: headless Chrome on the server hangs on
// --screenshot, but drives fine the way Remotion uses it.
async function shoot(chrome, pages) {
  const profile = join(tmpdir(), `slides-chrome-${Date.now().toString(36)}`);
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  try {
    const wsUrl = await new Promise((ok, fail) => {
      let err = '';
      const t = setTimeout(() => fail(new Error('Chrome не запустился')), 20_000);
      proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]); } });
      proc.on('exit', () => fail(new Error('Chrome закрылся: ' + err.trim().split('\n').slice(-1)[0])));
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('нет связи с Chrome')); });
    let n = 0;
    const waiting = new Map(), events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { const [ok, fail] = waiting.get(m.id); waiting.delete(m.id); m.error ? fail(new Error(m.error.message)) : ok(m.result); }
      else if (m.method) events.push(m);
    };
    const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++n; waiting.set(id, [ok, fail]); ws.send(JSON.stringify({id, method, params, sessionId})); });
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {width: 1080, height: 1350, deviceScaleFactor: 1, mobile: false}, sessionId);
    for (const [html, png] of pages) {
      events.length = 0;
      await send('Page.navigate', {url: `file://${html}`}, sessionId);
      for (let i = 0; i < 100 && !events.some((e) => e.method === 'Page.loadEventFired'); i++) await new Promise((r) => setTimeout(r, 100));
      await send('Runtime.evaluate', {expression: 'document.fonts.ready.then(() => true)', awaitPromise: true}, sessionId).catch(() => {});
      const {data} = await send('Page.captureScreenshot', {format: 'png', clip: {x: 0, y: 0, width: 1080, height: 1350, scale: 1}}, sessionId);
      writeFileSync(png, Buffer.from(data, 'base64'));
    }
    ws.close();
  } finally {
    const gone = new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
    proc.kill('SIGKILL');
    await gone;
    try { rmSync(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 200}); } catch { /* a temp profile left behind is harmless */ }
  }
}

/** Renders every slide of a post to images[/en]/slide-NN.png; returns the files. */
export async function renderSlides(dir, studio, bot, lang = 'ru') {
  const post = readPost(dir);
  const slides = lang === 'en' ? (post.slidesEn || []) : (post.slides || []);
  if (!slides.length) throw new Error('нет слайдов');
  const chrome = chromeBin(bot);
  if (!chrome) throw new Error('нет Chrome для слайдов');
  const outDir = join(dir, 'images', ...(lang === 'en' ? ['en'] : []));
  mkdirSync(outDir, {recursive: true});
  for (const f of readdirSync(outDir)) if (/^slide-\d+\.png$/.test(f)) rmSync(join(outDir, f));
  const th = slideTheme(studio);
  const tmp = join(tmpdir(), `slides-${Date.now().toString(36)}`);
  mkdirSync(tmp, {recursive: true});
  const pages = slides.map((s, i) => {
    const html = join(tmp, `s${i}.html`);
    writeFileSync(html, slideHtml(s, th, i, slides.length));
    return [html, join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`)];
  });
  try { await shoot(chrome, pages); } finally { rmSync(tmp, {recursive: true, force: true}); }
  return pages.map(([, png]) => png);
}

/** Files a publishing package carries: the chosen photo or the slides, in order. */
export function postFiles(dir, lang = 'ru') {
  const post = readPost(dir);
  if (post.kind === 'carousel') {
    const d = join(dir, 'images', ...(lang === 'en' && existsSync(join(dir, 'images', 'en')) ? ['en'] : []));
    return existsSync(d) ? readdirSync(d).filter((f) => /^slide-\d+\.png$/.test(f)).sort().map((f) => join(d, f)) : [];
  }
  const ph = (post.photos || []).find((x) => x.chosen && x.out) || (post.photos || []).find((x) => x.out);
  return ph && existsSync(join(dir, ph.out)) ? [join(dir, ph.out)] : [];
}
