// Web version of the reels bot: the same agent, REELS.md workflow and project folders,
// with a browser page instead of Telegram. Every reel has its own chat (its own Claude
// session); the project has a general chat and a design-system chat. The agent talks
// through web/send.mjs, which appends events here; this server streams them, the render
// progress and the final reply to the page. No dependencies.
//
// Unlike the Telegram bot, the agent here never gets unrestricted permissions: only the
// tools in ALLOWED run, and DENIED keeps it away from this server's own files.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {isEditor, normalize} from '../bot/roles.mjs';
import {transcribe} from '../bot/stt.mjs';
import {changeEdits, readEdits} from './edits.mjs';
import {changeItem, createItems, loadItems, followPlan, needOf, syncItems} from './items.mjs';
import {accountOf, addToken, igDir, listAccounts, match, readProfile, refreshSafe, refreshTokens, setTokenFile, shortcodeTime, tokenAccounts, tokenFor, typical, writeProfile} from './instagram.mjs';
import {listPosts, newPost, postDir, postFiles, processPhoto, readPost, renderSlides, savePost, TEMPLATES} from './posts.mjs';
import {appendFileSync, closeSync, copyFileSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeApp} from './app.mjs';
import {access as planAccess} from '../bot/plans.mjs';
import {createSandbox, listSandboxes, removeSandbox} from '../bot/sandbox.mjs';
import {telegramDigest} from '../bot/tgexport.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT = process.env.REELS_BOT_ROOT || join(HERE, '..');
// The bot's .env carries WEB_KEY, AGENT_BIN and REELS_MEMBERS; on a server it may be
// unreadable for this user, and the values then come from the service's environment.
try { process.loadEnvFile(join(BOT, '.env')); } catch {}
const PROJECTS = join(BOT, 'projects');
const DATA = join(HERE, 'data');
const CHATS = join(DATA, 'chats');
// Every running turn gets its own folder for events.jsonl and status.txt (REELS_CHANNEL).
const CHANNELS = join(DATA, 'channels');
// Chats run side by side; one chat runs one turn at a time. Each turn is a Claude process,
// so the cap keeps the subscription and the machine in check.
const MAX_JOBS = Number(process.env.REELS_MAX_JOBS || 3);
const SEND = join(HERE, 'send.mjs');
const PORT = Number(process.env.PORT || 8080);
const KEY = process.env.WEB_KEY;
const PAGE = readFileSync(join(HERE, 'index.html'), 'utf8');
const TYPES = {'.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
const ALLOWED = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  ...['new-reel', 'render', 'ffmpeg', 'beats', 'loudnorm'].map((s) => `Bash(node scripts/${s}.mjs:*)`),
  `Bash(node ${SEND}:*)`,
  // The agent runs in BOT and often calls it by the short path.
  `Bash(node ${relative(BOT, SEND)}:*)`,
  'Bash(npx tsc:*)',
];
// People, invites and the log are shared with the Telegram bot (bot/members.mjs).
const SHARED = process.env.REELS_MEMBERS ? dirname(process.env.REELS_MEMBERS) : join(BOT, 'data', 'shared');
// Scheduled publishing packages; the bot sends them (bot/outbox.mjs).
const OUTBOX = join(SHARED, 'outbox.json');
const DENIED = [`Edit(/${HERE}/**)`, `Read(/${join(HERE, 'data')}/**)`, `Edit(/${SHARED}/**)`, `Read(/${SHARED}/**)`];
const SECTION_STATUS = {'In work': 'work', 'In review': 'review', Done: 'done', Published: 'published'};

if (!KEY || KEY.length < 16) throw new Error('WEB_KEY is not set');
mkdirSync(CHATS, {recursive: true});
// Channels of turns cut short by a restart are left over; no turn survives a restart.
rmSync(CHANNELS, {recursive: true, force: true});
mkdirSync(SHARED, {recursive: true});
// The web turns have their own state: no Telegram chat, so a stray bot/send.mjs call fails.
if (!existsSync(join(DATA, 'state.json'))) writeFileSync(join(DATA, 'state.json'), JSON.stringify({project: 'main'}));
const emptyMcp = join(DATA, 'mcp-none.json');
writeFileSync(emptyMcp, '{"mcpServers":{}}');

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f); };
const safe = (s) => typeof s === 'string' && /^[\w-]{1,80}$/.test(s);
const id = () => randomBytes(18).toString('base64url');

// People of a project: real people work in every real project; a test account's people
// (test: true, project: <slug>) only in it. The owner sees every project.
const isTestProject = (p) => !!readJson(join(PROJECTS, p, 'settings.json'), {}).test;
const peopleOf = (a, p) => a.people.filter((x) => x.isOwner || (isTestProject(p) ? x.project === p : !x.project));
const projectSettings = (p) => readJson(join(PROJECTS, p, 'settings.json'), {});

// ---------- projects, reels, ideas ----------

const projectDir = (p) => (safe(p) && existsSync(join(PROJECTS, p)) ? join(PROJECTS, p) : null);
function projects() {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS).filter((p) => safe(p) && statSync(join(PROJECTS, p)).isDirectory())
    .map((p) => { const st = readJson(join(PROJECTS, p, 'settings.json'), {}); return {slug: p, name: st.test ? `🧪 Тест · ${st.name || 'новый клиент'}` : st.name || (p === 'main' ? 'My Gudauri' : p), test: !!st.test}; });
}
// ideas.md: «## Section» then «### Title» entries with Format:/Hook: lines.
function parseIdeas(p) {
  const out = [];
  let section = '';
  let cur = null;
  for (const line of read(join(PROJECTS, p, 'ideas.md')).split('\n')) {
    const h2 = /^## (.+)/.exec(line);
    if (h2) { section = h2[1].trim(); cur = null; continue; }
    const h3 = /^### (.+)/.exec(line);
    if (h3) { cur = {section, title: h3[1].trim(), lines: []}; out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return out;
}
const reelNumber = (s) => /^(\d{1,3})\b/.exec(s)?.[1]?.padStart(2, '0');
function dirSize(p) {
  let n = 0;
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    for (const f of readdirSync(p)) n += dirSize(join(p, f));
  } catch {}
  return n;
}
const versionDirs = (reelDir) => {
  const d = join(reelDir, 'versions');
  return existsSync(d) ? readdirSync(d).filter((v) => /^v\d+$/.test(v)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) : [];
};
// The rubric templates' catalog: scene kinds and the templates built from them.
// What a reference can lend a rubric (кусок 15).
const REF_TAKES = ['hook', 'edit', 'plates', 'delivery', 'sound', 'cover'];
const templates = () => readJson(join(BOT, 'template', 'src', 'templates', 'catalog.json'), {kinds: {}, templates: []});

function reels(p) {
  const root = join(PROJECTS, p, 'reels');
  const status = {};
  for (const idea of parseIdeas(p)) {
    const n = reelNumber(idea.title);
    if (n && SECTION_STATUS[idea.section]) status[n] = SECTION_STATUS[idea.section];
  }
  return (existsSync(root) ? readdirSync(root) : []).filter((r) => safe(r) && statSync(join(root, r)).isDirectory()).map((r) => {
    const dir = join(root, r);
    const title = (/^#\s*(.+)/m.exec(read(join(dir, 'README.md')))?.[1] || r).replace(/^\d+\s*/, '').replace(/[«»]/g, '').replace(/\s*\(.*\)\s*$/, '').trim();
    const vs = versionDirs(dir);
    const last = vs.at(-1);
    const thumb = last && readdirSync(join(dir, 'versions', last)).find((f) => /\.(thumb\.jpg|png|jpg)$/i.test(f));
    return {id: r, num: reelNumber(r), title, status: status[reelNumber(r)] || 'none', version: last || null, versions: vs.length,
      thumb: thumb ? mediaUrl(join(dir, 'versions', last, thumb)) : null, updated: statSync(dir).mtimeMs};
  }).sort((a, b) => Number(b.num) - Number(a.num));
}
// The whole server disk, as the sidebar meter shows it.
function disk() {
  const s = statfsSync(PROJECTS);
  return {total: s.blocks * s.bsize, free: s.bavail * s.bsize};
}
const reelDir = (p, r) => (projectDir(p) && safe(r) && existsSync(join(PROJECTS, p, 'reels', r)) ? join(PROJECTS, p, 'reels', r) : null);

function versions(p, r) {
  const dir = reelDir(p, r);
  if (!dir) return [];
  const vs = versionDirs(dir);
  return vs.map((v, i) => {
    const vdir = join(dir, 'versions', v);
    const files = readdirSync(vdir).filter((f) => statSync(join(vdir, f)).isFile()).map((f) => {
      const full = join(vdir, f);
      const kind = /^raw/i.test(f) ? 'other' : /\.(mp4|mov|webm)$/i.test(f) ? (/1080p|1440p|master/i.test(f) ? 'master' : 'copy') : /cover\.png$/i.test(f) ? 'cover' : /thumb\.jpg$/i.test(f) ? 'thumb' : 'other';
      return {name: f, kind, size: statSync(full).size, url: mediaUrl(full)};
    });
    const archived = readJson(join(vdir, 'ARCHIVED.json'), null);
    // A variant (RU, EN, short cut…) is a finished parallel version, not a draft: versions/vN/variant.json.
    const variant = readJson(join(vdir, 'variant.json'), null)?.label || null;
    return {v, state: i === vs.length - 1 ? 'current' : archived?.state || (i === vs.length - 2 ? 'previous' : 'old'), files, archived, variant, at: statSync(vdir).mtimeMs};
  }).reverse();
}

// Every file of a reel: materials the owner brought (sources/) and what was made (versions/).
function fileInfo(full, base) {
  const st = statSync(full);
  const ext = extname(full).toLowerCase();
  const kind = /\.(mp4|mov|webm|m4v)$/.test(ext) ? 'video' : /\.(png|jpe?g|webp|gif|heic)$/.test(ext) ? 'image' : /\.(mp3|m4a|wav|ogg|aac)$/.test(ext) ? 'audio' : 'file';
  return {name: relative(base, full), size: st.size, at: st.mtimeMs, kind, url: mediaUrl(full)};
}
function listFiles(dir, base = dir, depth = 0) {
  if (!existsSync(dir) || depth > 3) return [];
  return readdirSync(dir).flatMap((f) => {
    if (f.startsWith('.') || f === 'project-snapshot' || f === 'node_modules') return [];
    const full = join(dir, f);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return [];
    return st.isDirectory() ? listFiles(full, base, depth + 1) : /\.json$/.test(f) ? [] : [fileInfo(full, base)];
  }).sort((a, b) => b.at - a.at);
}
const cleanName = (n) => basename(n || 'file').replace(/[^\w.\-а-яё ]/gi, '_').replace(/^\.+/, '') || 'file';
function uniquePath(dir, name) {
  let path = join(dir, name);
  for (let i = 2; existsSync(path); i++) path = join(dir, name.replace(/(\.[^.]*)?$/, ` (${i})$1`));
  return path;
}

// ---------- storage policy ----------

const POLICY = join(DATA, 'policy.json');
const policy = () => ({keepPrevious: true, archiveOlder: true, finalOnly: true, ...readJson(POLICY, {})});
// Copies the reel's code (not its media) next to a version, so an archived one can be rebuilt.
function snapshot(dir, v) {
  const target = join(dir, 'versions', v, 'project-snapshot');
  const project = join(dir, 'project');
  if (existsSync(target) || !existsSync(project)) return;
  mkdirSync(target, {recursive: true});
  for (const f of readdirSync(project)) {
    const full = join(project, f);
    if (f === 'node_modules' || f === 'public' || lstatSync(full).isSymbolicLink()) continue;
    if (lstatSync(full).isDirectory() ? f === 'src' : /\.(mjs|js|ts|tsx|json|md)$/.test(f) && f !== 'package-lock.json') cpSync(full, join(target, f), {recursive: true});
  }
}
function retain(p, r) {
  const dir = reelDir(p, r);
  if (!dir) return 0;
  const pol = policy();
  const vs = versionDirs(dir);
  if (!vs.length) return 0;
  snapshot(dir, vs.at(-1));
  const accepted = ['done', 'published'].includes(reels(p).find((x) => x.id === r)?.status);
  let freed = 0;
  vs.slice(0, -1).forEach((v, i, older) => {
    const vdir = join(dir, 'versions', v);
    // A master is a deliverable, not a draft: a reel can have several finished variants
    // (RU v1, EN v2), so masters are never archived — only review copies are.
    const keep = readdirSync(vdir).some((f) => /1440p|1080p|master/i.test(f)) || existsSync(join(vdir, 'variant.json'));
    const videos = readdirSync(vdir).filter((f) => /\.(mp4|mov|webm)$/i.test(f) && !/1440p|1080p|master/i.test(f)).map((f) => ({f, size: statSync(join(vdir, f)).size})).sort((a, b) => a.size - b.size);
    if (!videos.length) return;
    // With its master kept, a version stays fully usable: its light copy stays too, for watching.
    if (keep) return;
    const previous = i === older.length - 1;
    let drop = [];
    if (accepted && pol.finalOnly) drop = videos;
    else if (previous && pol.keepPrevious) drop = videos.slice(1);
    else if (!previous && pol.archiveOlder) drop = videos;
    else if (previous && !pol.keepPrevious && pol.archiveOlder) drop = videos;
    if (!drop.length) return;
    for (const {f, size} of drop) { rmSync(join(vdir, f), {force: true}); freed += size; }
    const prev = readJson(join(vdir, 'ARCHIVED.json'), {freed: 0});
    const left = videos.length - drop.length;
    writeJson(join(vdir, 'ARCHIVED.json'), {state: left ? 'previous' : 'old', at: Date.now(), freed: prev.freed + drop.reduce((s, x) => s + x.size, 0)});
  });
  return freed;
}

// ---------- chats ----------
// One chat per reel, plus «_project» (general) and «_ds» (design system); a new reel
// starts as «new-<time>» and is renamed to its reel folder once the agent creates it.

const chatKey = (k) => typeof k === 'string' && /^(_project|_ds|new-\d+|[\w-]{1,80})$/.test(k);
const chatFile = (p, k, ext) => join(CHATS, p, `${k}.${ext}`);
const record = (p, k, msg) => { mkdirSync(join(CHATS, p), {recursive: true}); appendFileSync(chatFile(p, k, 'jsonl'), JSON.stringify({...msg, at: Date.now()}) + '\n'); };
const history = (p, k) => read(chatFile(p, k, 'jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chatMeta = (p, k) => readJson(chatFile(p, k, 'json'), {});
const setChatMeta = (p, k, v) => { mkdirSync(join(CHATS, p), {recursive: true}); writeJson(chatFile(p, k, 'json'), {...chatMeta(p, k), ...v}); };

const onboardingDue = (studio) => {
  const settings = readJson(join(studio, 'settings.json'), {});
  return read(join(studio, 'brief.md')) === read(join(BOT, 'starter', 'brief.md')) || (settings.test && !settings.mode);
};

function preamble(p, k) {
  const studio = join(PROJECTS, p);
  const lines = [
    `You are running as the WEB version of the reels bot: the owner talks to you in a browser page, not in Telegram. Follow AGENTS.md and REELS.md with these differences:`,
    `- Wherever REELS.md says \`node bot/send.mjs\`, run \`node ${SEND}\` instead, with the same options (--status, --text, --keyboard, --ideas, --buttons, --file, --caption, --menu). Never run bot/send.mjs.`,
    `- Only these tools are allowed here: file tools (Read, Write, Edit, Glob, Grep), WebSearch, WebFetch, and Bash limited to \`node scripts/<new-reel|render|ffmpeg|beats|loudnorm>.mjs …\` and \`node ${SEND} …\` run from the bot folder. Do everything through them (write files with Write, not shell commands). If a step needs something else (e.g. downloading a track), say so in one line and suggest the owner attach the file on the page.`,
    `- Always answer the owner in Russian, whatever language the files, logs or tools use; keep paths, commands and code as they are.`,
    `- The page shows videos inline, has no file size limit and keeps every version in a side panel, so you do not need to resend old versions. There are no voice messages.`,
    `- Files the owner attaches arrive as \`(attached file → <path>)\`; button taps as in REELS.md.`,
    `- Old versions are archived by the page to save disk: older ones keep only a frame, \`ARCHIVED.json\` and \`project-snapshot/\` (the reel's code at that version). To rebuild one, copy its snapshot back into the reel's \`project/\` with Read/Write and render.`,
    `The active project is \`${relative(BOT, studio)}/\` (\`<project>/\` in REELS.md). The Telegram bot works on the same project, so re-read ideas.md and PLAYBOOK.md before changing them.`,
  ];
  if (k === '_ds') lines.push(`THIS CHAT develops the project's design system for its reels. The result is ONE self-contained HTML page, \`${relative(BOT, studio)}/design-system/index.html\` (inline CSS/JS, Google Fonts allowed, images as relative files next to it): a small landing page with the system's name and idea, color and type tokens, spacing and motion rules, and a library of the components (plates, price receipts, titles, subtitles, phone mockup…) drawn in HTML/CSS as they look in the reels, each with its name, when to use it and its Remotion component name if there is one. Read the brief, PLAYBOOK.md, \`template/src\` and the reels' code to stay true to what is really used. After each change, rewrite the page and tell the owner in one or two lines what changed; the page reloads by itself. Keep \`design-system/tokens.json\` in sync with the tokens on the page.`);
  else if (k === '_project') lines.push('THIS CHAT is the project\'s general chat: ideas, brief, rules, settings, strategy and plan. Reels and posts themselves are made in their own chats; if the owner asks to make one here, say that «+ Новый выпуск» starts it in its own chat.',
    `Strategy and plan follow STRATEGY.md: \`${relative(BOT, studio)}/strategy.json\` (platforms, rubrics, weekly rhythm, events) and \`${relative(BOT, studio)}/plan.json\` (dates and rubrics of reels and posts); the page draws Strategy and the Calendar from them.`,
    `Units of content live in \`${relative(BOT, studio)}/items.json\` (handbook/LEAN.md): one item per format with stage, rubric, at and idea {about, hook, flow}. When the owner asks about an item by its id, edit only that item's idea, format, rubric or at there. Never add or remove items yourself: new ideas go to ideas.md («My ideas», Format:/Hook:/Plot: plus «Date: YYYY-MM-DDTHH:MM», «Rubric: <rubric id>» and «Why: <one phrase: why this idea on this day>»), and the page turns them into proposals.`,
    `A rubric in strategy.json may carry template (an id from template/src/templates/catalog.json), look (what its releases share visually), rules [{text, lock}] (lock = never break) and refs [{id, url, name, file, takes: hook|edit|plates|delivery|sound|cover, note — how it will look in our releases, skip — what we do not copy}] plus refsSummary (your short summary over all refs). When you make or pitch a release of a rubric, follow its template, rules and the refs' takes and notes; never copy music, faces, someone else's text or logo from a ref. When asked to study the refs, open each url or file, fill takes, note and skip, and write refsSummary in 2–4 lines.`,
    `Facts and prices live in \`${relative(BOT, studio)}/facts.json\`: {"facts":[{"id":"f-…","text":"what","value":"how much or when","source":"сайт|прайс|сказал <name>|…","kind":"price|date|people|other","at":"YYYY-MM-DD"}]}. When the owner tells you a new price or date, update or add the fact there with today's date and the source; check every caption and slide against these facts and say when one is older than 30 days.`);
  lines.push(`Memory also has \`${relative(BOT, studio)}/memory.json\`: {"answers":[{"q","question","text"}] — the owner's spoken answers to the guiding questions, "questions":[{"id":"q-<random>","text","source","at":"YYYY-MM-DD"}] — what clients ask (add the ones you find in chats, screenshots and comments; they are material for ideas), "sources":[…]}. brief.md is one page in «## » sections: Кто мы, Для кого, Что продаём, Чем отличаемся, Сезон, Площадки, Что работает, Цели на сезон, Чего не обещаем, Чьи аккаунты нравятся — keep these headings when you write it. A design taken from the site goes to design-system/tokens.json: {"site","colors":[{"name","hex","role","use":true}],"fonts":[{"family","weight","role"}],"radii":[px],"logo","photo"}.`);
  // A new project (the starter brief, or a test account not set up yet) is a first visit: the
  // whole onboarding, as the bot runs it, not just an answer to the first message.
  // The web's first launch (handbook/LEAN.md, кусок 11): an organisation, not a questionnaire.
  if (k === '_project' && onboardingDue(studio) && readJson(join(studio, 'settings.json'), {}).started) lines.push(`THIS PROJECT IS NEW and the owner started it from the web's first launch: the organisation's name and links are in settings.json (name, links). Do NOT ask REELS.md section 0's guiding questions. Read the links (WebFetch) and any files in the project, then write in one go: brief.md (what they do, for whom, how they speak); facts.json — prices, dates, places, people, each {"id":"f-<random>","text","value","source","kind":"price|date|people|other","at":"<today>"}; strategy.json by STRATEGY.md — platforms from the links with formats and perWeek, 3–5 rubrics each with name, a stable color, about (one-line formula), format (reel|post|carousel|telegram) and day (1–7), a weekly rhythm, and the voice {about, never, styles}; settings.json mode "solo", plan "video", team null — the owner turns modules on later; and 6–10 ideas for the next two weeks in ideas.md «My ideas» with Format:/Hook:/Plot: plus «Date: YYYY-MM-DDTHH:MM» and «Rubric: <id>». Then reply in 4–6 short lines: what you understood, what you could not find (mark it [нужно уточнить]). Mark a fact you are not sure of with source «проверьте».`);
  else if (k === '_project' && onboardingDue(studio)) lines.push(`THIS PROJECT IS NEW: run REELS.md section 0 (Onboarding) from where it stands, whatever the owner's message is about (a greeting too): start with the guiding questions, material and the Telegram archive link come last (step 1). Ask ONE question per turn with \`--keyboard\` buttons and stop until they answer; the next turn goes on with the next question. You are not done until \`brief.md\` is filled, \`strategy.json\` is written and \`settings.json\` has \`mode\`, \`plan\` and \`team\` (step 5), and the summary (step 6) is shown.`);
  else if (k.startsWith('new-')) lines.push('THIS CHAT starts a NEW reel. Create its folder with `node scripts/new-reel.mjs <latin-slug>` as soon as the idea is clear, before anything else; the page then moves this chat to that reel. One reel per chat.');
  else if (k.startsWith('post-')) {
    const dir = join(studio, 'posts', k.slice(5));
    const post = readPost(dir);
    lines.push(`THIS CHAT is about post \`${relative(BOT, dir)}/\` only (a ${post.kind === 'carousel' ? 'carousel' : post.kind === 'photo' ? 'post with a photo' : 'text post'}); follow POSTS.md. Everything the page shows lives in its \`post.json\` — edit that file (keep its other fields) and the page redraws. Photos people brought are in \`sources/\`; the page crops them and draws the slides itself.`);
  }
  else lines.push(`THIS CHAT is about reel \`${relative(BOT, join(studio, 'reels', k))}/\` only; read its README.md first. Other reels have their own chats: if the owner asks about another one, tell them to open it on the page.`,
    'The page shows the reel in four stages (Сценарий, Материалы, Монтаж, Выкладка) from two optional files in the reel folder; keep them current when the script, materials or captions change. ' +
    '`scenes.json`: [{"t":"0:00","name":"Хук","screen":"what is on screen","text":"text on screen","sound":"…","need":"what material it needs","have":"what file covers it","status":"готово|нужно|переснять"}]. ' +
    '`publish.json`: {"captions":[{"platform":"Instagram RU","account":"@…","text":"caption"}],"checks":[{"ok":true,"text":"…"}]}. ' +
    'Messages starting with a timecode like «0:11 —» are notes about that moment of the current version. ' +
    'Comments for the next version live in `edits.json` (format in web/edits.mjs): [{"id","stage":"script|scenes|video","t":seconds,"text","quote"?,"scene"?,"shape"?:{"kind":"rect|brush|point|frame",…fractions of the frame},"hint"?:"blur|replace|trim|remove","state":"open|sent|done|note","forV":"v4","by"}]; they come from the page and from the mini app\'s editor. When you have built that version, set each sent comment to "done" and add "result": what you changed, in a few words — the page shows it as «что поменялось». Your own pre-build findings (faces, subtitles, consents) go there as "state":"note" with "by":"Claude".');
  return lines.join('\n');
}

const jobs = new Set();
const jobOf = (p, k) => [...jobs].find((j) => j.p === p && j.key === k);
const full = () => jobs.size >= MAX_JOBS;
let channelSeq = 0;

function startTurn(p, k, text, send) {
  const meta = chatMeta(p, k);
  const studio = join(PROJECTS, p);
  const reelsBefore = new Set(existsSync(join(studio, 'reels')) ? readdirSync(join(studio, 'reels')) : []);
  const args = ['-p', `${preamble(p, k)}\n\n${text}`, '--output-format', 'stream-json', '--verbose',
    '--allowedTools', ALLOWED.join(','), '--disallowedTools', DENIED.join(','),
    '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', emptyMcp,
    // A project may be a link to a folder outside the studio (My Gudauri → Рилсы/студия): Claude
    // resolves links, so that real folder must be allowed too or every write there is refused.
    ...(realProject(studio) ? ['--add-dir', realProject(studio)] : []),
    ...(/^[\w-]{8,}$/.test(meta.session || '') ? ['--resume', meta.session] : [])];
  const channel = join(CHANNELS, `${Date.now()}-${++channelSeq}`);
  mkdirSync(channel, {recursive: true});
  const EVENTS = join(channel, 'events.jsonl'), STATUS = join(channel, 'status.txt');
  let offset = 0;
  let lastStatus = '';
  let key = k;
  const child = spawn(process.env.AGENT_BIN || 'claude', args, {
    cwd: BOT,
    env: {...process.env, REELS_BOT: '1', REELS_DATA: DATA, REELS_CHANNEL: channel, REELS_PROJECTS: PROJECTS, REELS_STUDIO: studio},
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // A new-reel chat becomes that reel's chat as soon as its folder appears.
  const rebind = () => {
    if (!key.startsWith('new-') || !existsSync(join(studio, 'reels'))) return;
    const created = readdirSync(join(studio, 'reels')).find((r) => !reelsBefore.has(r) && safe(r));
    if (!created || existsSync(chatFile(p, created, 'jsonl'))) return;
    for (const ext of ['jsonl', 'json']) if (existsSync(chatFile(p, key, ext))) renameSync(chatFile(p, key, ext), chatFile(p, created, ext));
    key = created;
    send({rebind: created});
  };
  const poll = () => {
    const size = existsSync(EVENTS) ? statSync(EVENTS).size : 0;
    if (size > offset) {
      const fd = openSync(EVENTS, 'r');
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        const msg = toMessage(JSON.parse(line));
        if (msg) { record(p, key, msg); send({msg}); }
      }
    }
    const status = read(STATUS).trim();
    if (status && status !== lastStatus) { lastStatus = status; setChatMeta(p, key, {status}); send({status}); }
    rebind();
  };
  const timer = setInterval(poll, 700);
  let buf = '', result = null, err = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'system' && ev.subtype === 'init') setChatMeta(p, key, {session: ev.session_id});
      if (ev.type === 'result') result = ev;
    }
  });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => {
    clearInterval(timer);
    poll();
    let reply = (result?.result ?? '').trim();
    if (result?.is_error || (code && !result)) {
      const msg = {from: 'bot', kind: 'error', text: reply || err.trim().split('\n').pop() || `агент завершился с кодом ${code}`};
      record(p, key, msg); send({msg});
    } else if (reply && reply !== 'NO_REPLY') {
      // «⌨️ A | B | C» on the last line is the keyboard, as in the bot.
      let keys = [];
      reply = reply.replace(/\n?\s*⌨️\s*(.+)\s*$/u, (_, k2) => { keys = k2.split('|').map((x) => x.trim()).filter(Boolean); return ''; }).trim();
      const msg = {from: 'bot', kind: 'text', text: reply.replace(/\s*NO_REPLY\s*$/, ''), keys, buttons: []};
      record(p, key, msg); send({msg});
    }
    setChatMeta(p, key, {status: '', updated: Date.now()});
    if (!key.startsWith('_') && !key.startsWith('new-') && !key.startsWith('post-')) {
      const freed = retain(p, key);
      if (freed) send({freed});
    }
    send({done: true, ms: result?.duration_ms});
    jobs.delete(job);
    rmSync(channel, {recursive: true, force: true});
  });
  const job = {child, p, get key() { return key; }};
  jobs.add(job);
  return job;
}

// ---------- media ----------

// The real folder behind a project that is a link, or null for an ordinary folder.
function realProject(dir) {
  try { const real = realpathSync(dir); return real !== dir ? real : null; } catch { return null; }
}
function mediaPath(p) {
  try {
    const real = realpathSync(p);
    // A project may be a link to a folder elsewhere (My Gudauri → Рилсы/студия).
    const roots = [PROJECTS, ...readdirSync(PROJECTS).map((n) => { try { return realpathSync(join(PROJECTS, n)); } catch { return null; } }).filter(Boolean)];
    return roots.some((r) => real.startsWith(r + '/')) && statSync(real).isFile() ? real : null;
  } catch { return null; }
}
function mediaUrl(p) { return `/media?p=${encodeURIComponent(p)}`; }
function toMessage(ev) {
  if (ev.type === 'file') {
    const real = mediaPath(ev.path);
    return {from: 'bot', kind: 'file', url: real ? mediaUrl(real) : null, name: basename(ev.path), ext: extname(ev.path).toLowerCase(), caption: ev.caption, buttons: ev.buttons, menu: ev.menu, document: ev.document};
  }
  if (ev.type === 'text') return {from: 'bot', kind: 'text', text: ev.text, keys: ev.keys, buttons: ev.buttons, menu: ev.menu};
  if (ev.type === 'menu') return {from: 'bot', kind: 'menu', menu: ev.menu};
}

// ---------- people, sessions, log ----------

const ACCESS = join(SHARED, 'access.json');
const access = () => { const a = {people: [], invites: [], sessions: [], ...readJson(ACCESS, {})}; a.people = a.people.map(normalize); return a; };
const saveAccess = (a) => writeJson(ACCESS, a);
const LOG = join(SHARED, 'log.jsonl');
const botUsername = () => readJson(join(SHARED, 'bot.json'), {}).username || null;
const log = (who, what) => appendFileSync(LOG, JSON.stringify({at: Date.now(), who, what}) + '\n');

// Instagram (web/instagram.mjs): every 3 hours each connected account of each project is read
// from the official API; «Обновить сейчас» runs the same for one account. Errors stay on the card.
const IG_BUSY = new Set(), IG_LAST = new Map();
setTokenFile(join(DATA, 'instagram-tokens.json'));
function igRefresh(p, a) {
  const key = `${p}/${a}`;
  if (IG_BUSY.has(key)) return;
  IG_BUSY.add(key); IG_LAST.set(key, Date.now());
  refreshSafe(join(PROJECTS, p), a).then(() => log('Claude', `Instagram @${a} обновлён`), (e) => log('Claude', `Instagram @${a} не обновился: ${String(e.message || e).slice(0, 120)}`)).finally(() => IG_BUSY.delete(key));
}
async function igTick() {
  await refreshTokens().catch(() => {});
  const accs = tokenAccounts();
  for (const p of projects().map((x) => x.slug || x)) for (const a of listAccounts(join(PROJECTS, p)).map((x) => x.account)) if (accs.includes(a)) igRefresh(p, a);
}
setInterval(igTick, 3 * 3600e3).unref();
setTimeout(igTick, 60e3).unref();
const telegramOwner = () => readJson(join(BOT, 'data', 'state.json'), {}).ownerName || null;
function device(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Устройство';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'браузер';
  return `${os}, ${br}`;
}
function newSession(personId, req) {
  const a = access();
  const s = {id: id(), person: personId, device: device(req.headers['user-agent']), created: Date.now(), seen: Date.now()};
  a.sessions.push(s);
  saveAccess(a);
  return s.id;
}
function ownerPerson() {
  const a = access();
  let owner = a.people.find((x) => x.isOwner);
  if (!owner) {
    owner = {id: 'owner', name: telegramOwner() || 'Владелец', role: 'editor', isOwner: true, web: true, added: Date.now()};
    a.people.push(owner);
    saveAccess(a);
  }
  return owner;
}
// Role and flags of a new person, from an invite or the invite form.
const personFields = (x) => ({role: x.role === 'editor' ? 'editor' : 'member', onCamera: !!x.onCamera, selfBuild: !!x.selfBuild, web: x.role === 'editor' || x.web === true,
  deputyUntil: /^\d{4}-\d{2}-\d{2}$/.test(x.deputyUntil || '') ? x.deputyUntil : null});
// Six digits to type into the bot by hand, unique among live invites.
const newPin = (a) => { for (;;) { const pin = String(100000 + randomBytes(4).readUInt32BE(0) % 900000); if (!a.invites.some((x) => x.pin === pin && x.expires > Date.now())) return pin; } };
// With one bot for several studios (relay dispatcher) a link carries its studio: «<node>--» in front.
const startOf = (payload) => `${process.env.RELAY_NODE && process.env.TG_RELAY ? `${process.env.RELAY_NODE}--` : ''}${payload}`;
const inviteLinks = (inv) => ({web: inv.web ? `/invite/${inv.code}` : null, telegram: inv.telegram && botUsername() ? `https://t.me/${botUsername()}?start=${startOf(`inv_${inv.code}`)}` : null});
function whoIs(req) {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!sid) return null;
  const a = access();
  const s = a.sessions.find((x) => x.id === sid);
  const person = s && a.people.find((x) => x.id === s.person);
  if (!person) return null;
  if (Date.now() - s.seen > 60_000) { s.seen = Date.now(); saveAccess(a); }
  const {pw, ...rest} = person;
  return {...rest, sid, hasPassword: !!pw?.hash};
}
// The bot's chats as sessions: the owner's, and each member's; the bot itself keeps
// the owner's last turn and who it is working for right now.
function telegramSessions(a) {
  const bot = readJson(join(BOT, 'data', 'state.json'), {});
  const busy = bot.pending ? `работает для: ${bot.holder || bot.ownerName || 'владельца'}` : 'свободен';
  const out = [];
  if (bot.ownerId) out.push({kind: 'telegram', id: 'owner', name: bot.ownerName || 'Владелец', device: 'Телеграм-бот', seen: bot.lastTurnAt || 0, note: busy, owner: true});
  for (const x of a.people) if (x.telegram && !x.isOwner) out.push({kind: 'telegram', id: x.id, name: x.name, device: `Телеграм-бот${x.telegram.username ? ' · @' + x.telegram.username : ''}`, seen: x.telegram.seen || x.added || 0, note: bot.holder === x.name && bot.pending ? 'Claude сейчас работает для него' : ''});
  return out;
}
const cookie = (req, sid) => `sid=${sid}; Path=/; HttpOnly;${req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : ''} SameSite=Lax; Max-Age=31536000`;

// ---------- http ----------

const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
function invitePage(res, code, inner) {
  res.writeHead(code, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Рилсы · приглашение</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F6F4;color:#141414;font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:380px;padding:32px;background:#fff;border:1px solid #E4E3DF;border-radius:16px;margin:16px}h1{margin:0 0 8px;font-size:22px}p{color:#6B6A66;margin:0 0 20px}
button{width:100%;min-height:48px;border:0;border-radius:12px;background:#D7261A;color:#fff;font:inherit;font-weight:600;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#161615;color:#EDECE8}main{background:#201F1D;border-color:#33312E}p{color:#9A978F}}</style></head><body><main>${inner}</main></body></html>`);
}

async function rawBody(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}
async function body(req) {
  try { return JSON.parse((await rawBody(req)) || '{}'); } catch { return {}; }
}

// ---------- passwords ----------
// Each person has their own password (scrypt, in access.json as pw: {salt, hash}); the owner sets
// them in «Команда», anyone can change their own. Ten wrong tries from one address lock it for 15 min.
const hashPassword = (pw) => { const salt = randomBytes(16).toString('hex'); return {salt, hash: scryptSync(pw, salt, 32).toString('hex')}; };
const checkPassword = (person, pw) => {
  if (!person?.pw?.hash || !pw) return false;
  const want = Buffer.from(person.pw.hash, 'hex');
  const got = scryptSync(pw, person.pw.salt, 32);
  return got.length === want.length && timingSafeEqual(got, want);
};
const tries = new Map();
const tooMany = (ip) => { const t = tries.get(ip); return !!t && t.n >= 10 && Date.now() - t.at < 15 * 60_000; };
const failed = (ip) => { const t = tries.get(ip); tries.set(ip, t && Date.now() - t.at < 15 * 60_000 ? {n: t.n + 1, at: t.at} : {n: 1, at: Date.now()}); };
function loginPage(res, error = '', who = '') {
  const people = access().people.filter((x) => x.pw?.hash && (isEditor(x) || x.web === true));
  invitePage(res, error ? 401 : 200, people.length
    ? `<h1>Вход в студию</h1><p>Выбери себя и введи свой пароль.</p>${error ? `<p style="color:#D7261A">${escHtml(error)}</p>` : ''}
      <form method="post" action="/login" style="display:flex;flex-direction:column;gap:10px">
        <select name="who" required style="min-height:46px;border-radius:12px;border:1px solid #D9D8D3;padding:0 12px;font:inherit;background:transparent;color:inherit">${people.map((x) => `<option value="${escHtml(x.id)}" ${x.id === who ? 'selected' : ''}>${escHtml(x.name)}</option>`).join('')}</select>
        <input type="password" name="password" required autocomplete="current-password" placeholder="Пароль" style="min-height:46px;border-radius:12px;border:1px solid #D9D8D3;padding:0 12px;font:inherit;background:transparent;color:inherit">
        <button type="submit">Войти</button></form>`
    : '<h1>Нужен вход</h1><p>Пароли ещё никому не заданы. Владелец задаёт их в студии: Настройки › Команда.</p>');
}

const APP_PAGE = join(HERE, 'app.html');
// The mini app's editor hands its comments to the reel's chat, as «Собрать vN» on the page does.
const buildFromApp = (p, r, text, shown, who) => {
  if (jobOf(p, r) || full()) return false;
  record(p, r, {from: 'me', kind: 'text', text: shown, by: who});
  log(who, `собрал из мини-приложения: ${shown}`);
  startTurn(p, r, `(from ${who}, mini app)\n${text}`, () => {});
  return true;
};
const miniApp = makeApp({BOT, PROJECTS, PAGE: () => readFileSync(APP_PAGE, 'utf8'), access, saveAccess, logFile: () => LOG, sandboxPaths: {projects: PROJECTS, access: ACCESS, starter: join(BOT, 'starter'), chats: CHATS, outbox: OUTBOX, log: LOG, botState: join(BOT, 'data', 'state.json')}, reels, log, reelDir, build: buildFromApp, chat: {history, meta: chatMeta}, busy: (p, k) => ({self: !!jobOf(p, k), full: full()})});

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, b) => { res.writeHead(code, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(b)); };
  const go = (to, set) => { res.writeHead(302, {location: to, ...(set ? {'set-cookie': set} : {})}); res.end(); };

  // The owner's key link, or the old key cookie, opens an owner session.
  const oldKey = /(?:^|;\s*)k=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (url.searchParams.get('k') === KEY || (oldKey === KEY && !whoIs(req))) {
    const sid = newSession(ownerPerson().id, req);
    log(ownerPerson().name, 'вошёл по ключу владельца');
    return go('/', cookie(req, sid));
  }
  const invite = /^\/invite\/([\w-]{10,})$/.exec(url.pathname)?.[1];
  if (invite) {
    const a = access();
    const inv = a.invites.find((x) => x.code === invite && x.expires > Date.now() && x.web !== false && !x.claimed?.includes('web'));
    // Reopening a used invite in the browser that already signed in with it just opens the studio.
    if (!inv && whoIs(req)) return go('/');
    if (!inv) return invitePage(res, 410, '<h1>Ссылка уже не работает</h1><p>Приглашение использовано или истекло. Если ты уже входил с этого браузера — открой <a href="/">студию</a>. Иначе попроси новое приглашение.</p>');
    // Opening the link only shows a button: link previews in messengers fetch it by
    // themselves, and a GET that signed in would let them use up the invite.
    if (req.method !== 'POST') return invitePage(res, 200, `<h1>Привет, ${escHtml(inv.name)}!</h1><p>Тебя пригласили в студию ${inv.role === 'editor' ? 'редактором' : 'участником'}.</p><form method="post"><button type="submit">Войти</button></form>`);
    let person = a.people.find((x) => x.id === inv.person);
    if (!person) {
      person = {id: id(), name: inv.name, ...personFields(inv), added: Date.now()};
      a.people.push(person);
      inv.person = person.id;
    }
    inv.claimed = [...(inv.claimed ?? []), 'web'];
    // One link per channel: once every channel it was made for is used, it is gone.
    if (!inv.telegram || inv.claimed.includes('telegram')) a.invites = a.invites.filter((x) => x !== inv);
    saveAccess(a);
    log(person.name, 'подключился к веб-версии по приглашению');
    return go('/', cookie(req, newSession(person.id, req)));
  }

  // The Telegram mini app signs its own requests (web/app.mjs), no session needed.
  if (req.method === 'GET' && url.pathname === '/preview.js') { res.writeHead(200, {'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache'}); return res.end(readFileSync(join(HERE, 'preview.js'))); }
  if (url.pathname === '/app' || url.pathname.startsWith('/api/app/') || url.pathname.startsWith('/app/take/') || url.pathname === '/app/v') return miniApp(req, res, url);

  // Sign-in by password: pick yourself from the list, type your own password. Links (key,
  // invites) still work, but a link opened in Telegram's browser does not follow into Safari.
  if (url.pathname === '/login' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (tooMany(ip)) return loginPage(res, 'Слишком много попыток. Подожди 15 минут.');
    const f = new URLSearchParams(await rawBody(req));
    const person = access().people.find((x) => x.id === f.get('who'));
    if (!person || !checkPassword(person, f.get('password') || '')) { failed(ip); return loginPage(res, 'Неверный пароль.', f.get('who')); }
    log(person.name, 'вошёл по паролю');
    return go('/', cookie(req, newSession(person.id, req)));
  }

  const me = whoIs(req);
  if (!me) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/media') { res.writeHead(401, {'content-type': 'text/plain; charset=utf-8'}); return res.end('Нужен вход'); }
    return loginPage(res);
  }
  if (req.method === 'POST' && url.pathname === '/api/password') {
    const b = await body(req);
    const a = access();
    const target = a.people.find((x) => x.id === (b.id || me.id));
    // Your own password, or anyone's for the owner.
    if (!target || (target.id !== me.id && !me.isOwner)) return json(403, {});
    if (typeof b.password !== 'string' || b.password.length < 6) return json(400, {error: 'Пароль — минимум 6 символов'});
    target.pw = hashPassword(b.password);
    saveAccess(a);
    log(me.name, target.id === me.id ? 'сменил свой пароль' : `задал пароль: ${target.name}`);
    return json(200, {ok: true});
  }
  // owner = the flag; editor = editors and deputies; anyone signed in may read their own things.
  const can = (role) => role === 'owner' ? me.isOwner === true : role === 'editor' ? isEditor(me) : true;
  // Members see only their part (D4): their tasks, sending material, what they sent.
  if (!isEditor(me) && !(url.pathname === '/' || url.pathname === '/api/me' || url.pathname.startsWith('/api/member') || url.pathname === '/media')) return json(403, {error: 'только для редакторов'});
  const dsPath = /^\/ds\/([\w-]+)\/(.+)$/.exec(url.pathname);
  const p = dsPath?.[1] || url.searchParams.get('project') || 'main';
  // A test account's person never reaches a real project, and real people never reach a test one.
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/me' && !me.isOwner && projectDir(p) && (me.project ? p !== me.project : isTestProject(p))) return json(403, {error: 'нет доступа к этому проекту'});

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    return res.end(PAGE);
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const a = access();
    // A test account's person sees only that project; real people do not see test accounts.
    const mine = projects().filter((x) => me.isOwner || (me.project ? x.slug === me.project : !x.test));
    const pp = mine.some((x) => x.slug === p) ? p : mine[0]?.slug || 'main';
    return json(200, {me: {name: me.name, role: isEditor(me) ? 'editor' : 'member', isOwner: !!me.isOwner, deputyUntil: me.deputyUntil || null, onCamera: !!me.onCamera, test: !!me.test},
      team: peopleOf(a, pp).length, projects: mine, project: pp, plan: planAccess(projectSettings(pp)), test: isTestProject(pp),
      modules: projectSettings(pp).modules || {}, bot: botUsername()});
  }
  // Первый запуск (handbook/LEAN.md, кусок 11): the organisation's name and links; Claude then reads
  // them in the project chat and writes the first memory and a draft plan.
  if (req.method === 'POST' && url.pathname === '/api/start') {
    if (!can('editor') || !projectDir(p)) return json(400, {});
    const b = await body(req);
    const f = join(PROJECTS, p, 'settings.json');
    const st = readJson(f, {});
    if (String(b.name || '').trim()) st.name = String(b.name).trim().slice(0, 80);
    st.links = (Array.isArray(b.links) ? b.links : []).map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 8);
    st.started = new Date().toISOString();
    writeJson(f, st);
    log(me.name, `первый запуск: ${st.name || p}`);
    return json(200, {settings: st});
  }
  // Модули (handbook/LEAN.md, кусок 12): the base is always on; people, staff, approval and branches
  // are switched on when there is a reason, and only then add their items to the sidebar.
  if (req.method === 'POST' && url.pathname === '/api/modules') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    if (!['camera', 'staff', 'approve', 'branches'].includes(b.key) || !projectDir(p)) return json(400, {});
    const f = join(PROJECTS, p, 'settings.json');
    const st = readJson(f, {});
    st.modules = {...st.modules, [b.key]: !!b.on};
    writeJson(f, st);
    log(me.name, `модуль ${b.key}: ${b.on ? 'включён' : 'выключен'}`);
    return json(200, {modules: st.modules});
  }
  // ---------- test accounts (bot/sandbox.mjs): a whole pretend client to try a scenario ----------
  if (url.pathname === '/api/sandbox') {
    if (!can('owner')) return json(403, {});
    const paths = {projects: PROJECTS, access: ACCESS, starter: join(BOT, 'starter'), chats: CHATS, outbox: OUTBOX, log: LOG, botState: join(BOT, 'data', 'state.json')};
    if (req.method === 'POST') {
      const b = await body(req);
      if (b.action === 'create') {
        // Empty, as a first visit: the onboarding in the chat builds the strategy, mode and team.
        const slug = createSandbox(paths);
        log(me.name, 'создал тестовый аккаунт');
        return json(200, {slug, list: listSandboxes(paths)});
      }
      if (b.action === 'link') {
        // A sign-in link for one of the account's people: open it in a private window to see the studio as them.
        const a = access();
        const x = a.people.find((y) => y.id === b.person && y.test && y.project === b.slug);
        if (!x) return json(404, {});
        const inv = {code: id(), name: x.name, role: x.role, expires: Date.now() + 24 * 3600_000, web: true, telegram: false, claimed: [], person: x.id};
        a.invites.push(inv);
        saveAccess(a);
        return json(200, {link: `/invite/${inv.code}`});
      }
      if (b.action === 'delete') {
        const r = removeSandbox(paths, String(b.slug || ''));
        if (!r) return json(404, {});
        log(me.name, `удалил тестовый аккаунт «${r.name}» со всеми данными`);
        return json(200, {removed: r, list: listSandboxes(paths)});
      }
      return json(400, {});
    }
    return json(200, {list: listSandboxes(paths)});
  }
  // ---------- a member's own part (D4 «Веб глазами участника») ----------
  if (url.pathname.startsWith('/api/member')) {
    if (!projectDir(p)) return json(404, {});
    const studio = join(PROJECTS, p);
    const sent = () => {
      const byId = new Map();
      for (const line of read(join(studio, 'inbox', 'authors.jsonl')).split('\n')) { try { const e = JSON.parse(line); byId.set(e.id, {...byId.get(e.id), ...e}); } catch {} }
      return [...byId.values()];
    };
    if (req.method === 'GET' && url.pathname === '/api/member') {
      const tasks = readJson(join(studio, 'host', 'tasks.json'), {tasks: []}).tasks || [];
      const mine = sent().filter((e) => e.who === me.name).sort((x, y) => y.at - x.at).slice(0, 40)
        .map((e) => ({...e, items: (e.items || []).map((i) => ({kind: i.kind, text: i.text, url: i.path ? mediaUrl(join(studio, i.path)) : null}))}));
      return json(200, {tasks: me.onCamera || isEditor(me) ? tasks.filter((t) => t.status !== 'done').slice(0, 10) : [], sent: mine, bot: botUsername()});
    }
    if (req.method === 'POST' && url.pathname === '/api/member/upload') {
      const day = new Date().toISOString().slice(0, 10);
      const dir = join(studio, 'inbox', day);
      mkdirSync(dir, {recursive: true});
      const path = uniquePath(dir, `web-${Date.now()}-${cleanName(url.searchParams.get('name'))}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      writeFileSync(path, Buffer.concat(chunks));
      const ext = extname(path).toLowerCase();
      const kind = ['.mp4', '.mov', '.webm'].includes(ext) ? 'video' : ['.m4a', '.mp3', '.ogg', '.wav'].includes(ext) ? 'voice' : 'photo';
      appendFileSync(join(studio, 'inbox', 'authors.jsonl'), JSON.stringify({id: `web-${Date.now().toString(36)}`, who: me.name, kind: 'files', via: 'web', status: 'sent', text: String(url.searchParams.get('note') || '').slice(0, 500), items: [{kind, path: relative(studio, path)}], at: Date.now()}) + '\n');
      log(me.name, `прислал ${basename(path)}`);
      return json(200, {ok: true});
    }
    return json(404, {});
  }

  if (!projectDir(p)) return json(404, {});
  const studio = join(PROJECTS, p);

  // Instagram accounts of the project (web/instagram.mjs) with the saved pictures as media links,
  // how each post matches the items (by link, else an offer by date and caption) and the sync state.
  if (req.method === 'GET' && url.pathname === '/api/instagram') {
    const items = loadItems(studio).items;
    const pic = (a, f) => (f ? mediaUrl(join(igDir(studio, a), f)) : null);
    return json(200, {accounts: listAccounts(studio).map((x) => {
      const m = match(x, items);
      return {...x, avatar: pic(x.account, x.avatar), typical: typical(x), connected: !!tokenFor(x.account), refreshing: IG_BUSY.has(`${p}/${x.account}`),
        highlights: (x.highlights || []).map((h) => ({title: h.title, url: pic(x.account, h.image)})),
        media: x.media.map((y) => ({...y, thumb: pic(x.account, y.thumb)})),
        linked: m.linked.map((y) => ({code: y.media.code, item: y.item.id})), offers: m.offers.map((y) => ({code: y.media.code, item: y.item.id, title: y.item.title, score: y.score})), loose: m.loose.map((y) => y.code)};
    })});
  }
  // «Обновить сейчас»: one account from the API, at most once in 5 minutes; the page polls /api/instagram.
  if (req.method === 'POST' && url.pathname === '/api/instagram/refresh') {
    if (!can('editor')) return json(403, {});
    const a = accountOf((await body(req)).account);
    if (!readProfile(studio, a) && !tokenFor(a)) return json(404, {});
    if (!tokenFor(a)) return json(400, {error: 'Instagram не подключён'});
    const key = `${p}/${a}`, last = IG_LAST.get(key) || 0;
    if (IG_BUSY.has(key)) return json(200, {refreshing: true});
    if (Date.now() - last < 5 * 60e3) return json(429, {error: 'Обновляли меньше 5 минут назад', wait: Math.ceil((last + 5 * 60e3 - Date.now()) / 1000)});
    igRefresh(p, a);
    return json(200, {refreshing: true});
  }
  // A key pasted by the owner in Подключения: checked with Instagram, kept in the server's token
  // file, never logged or sent back; the account's folder is made here and filled by a refresh.
  if (req.method === 'POST' && url.pathname === '/api/instagram/token') {
    if (!can('owner')) return json(403, {});
    const t = String((await body(req)).token || '');
    if (t.length < 20 || t.length > 1000) return json(400, {error: 'Это не похоже на ключ'});
    try {
      const a = await addToken(t);
      if (!readProfile(studio, a)) writeProfile(studio, a, {account: a, media: [], source: 'api', fetchedAt: new Date().toISOString()});
      IG_LAST.delete(`${p}/${a}`); igRefresh(p, a);
      log(me.name, `Instagram @${a} подключён`);
      return json(200, {account: a});
    } catch (e) { return json(400, {error: String(e.message || e).replace(/access_token=[^&\s]+/g, '').slice(0, 160)}); }
  }
  // A post found in Instagram → its item («Привязать»), or set aside as not made in the studio.
  if (req.method === 'POST' && url.pathname === '/api/instagram/link') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const a = accountOf(b.account), prof = readProfile(studio, a);
    const m = prof?.media.find((x) => x.code === b.code);
    if (!m) return json(404, {});
    if (b.hide !== undefined) {
      writeProfile(studio, a, {...prof, hidden: b.hide ? [...new Set([...(prof.hidden || []), m.code])] : (prof.hidden || []).filter((c) => c !== m.code)});
      return json(200, {ok: true});
    }
    const item = changeItem(studio, String(b.item || ''), {publish: {account: a, url: m.permalink, at: m.timestamp || shortcodeTime(m.code)}}, {by: me.name});
    if (!item) return json(404, {});
    log(me.name, `выпуск «${item.title}» вышел в Instagram @${a}`);
    return json(200, {item});
  }

  if (req.method === 'GET' && url.pathname === '/api/overview') {
    const list = reels(p);
    const ideas = parseIdeas(p).filter((x) => /Owner's ideas|My ideas/.test(x.section));
    const chats = existsSync(join(CHATS, p)) ? readdirSync(join(CHATS, p)).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)) : [];
    const posts = listPosts(studio, mediaUrl);
    const plan = readJson(join(studio, 'plan.json'), {});
    const rubricOf = (key, own) => plan.rubric?.[key] || own || null;
    const tally = {};
    for (const r of list) { const x = rubricOf('reel:' + r.id); if (x) tally[x] = (tally[x] || 0) + 1; }
    for (const x of posts) { const y = rubricOf('post:' + x.id, x.rubric); if (y) tally[y] = (tally[y] || 0) + 1; }
    const rubrics = (readJson(join(studio, 'strategy.json'), {}).rubrics || []).map((r) => ({id: r.id, name: r.name, color: r.color, n: (tally[r.id] || 0) + (tally[r.name] || 0)}));
    // «Входящие»: what people sent through the bot or the member page in the last week.
    const sentLines = read(join(studio, 'inbox', 'authors.jsonl')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const inboxNew = new Set(sentLines.filter((e) => e.who && e.at > Date.now() - 7 * 864e5 && e.status !== 'private').map((e) => e.id)).size;
    return json(200, {inbox: inboxNew, reels: list, posts, rubrics, ideasCount: ideas.length, chats, busy: [...jobs].filter((j) => j.p === p).map((j) => j.key),
      disk: disk()});
  }
  if (req.method === 'GET' && url.pathname === '/api/ideas') {
    return json(200, {ideas: parseIdeas(p).filter((x) => /Owner's ideas|My ideas/.test(x.section)).map((x) => ({
      title: x.title, section: x.section,
      format: x.lines.find((l) => /^Format:/.test(l))?.replace(/^Format:\s*/, '') || '',
      hook: x.lines.find((l) => /^Hook:/.test(l))?.replace(/^Hook:\s*/, '') || '',
      plot: x.lines.find((l) => /^Plot:/.test(l))?.replace(/^Plot:\s*/, '') || '',
    }))});
  }
  // Strategy and plan (STRATEGY.md): what the Strategy tabs and the Calendar draw.
  if (req.method === 'GET' && url.pathname === '/api/plan') {
    const plan = readJson(join(studio, 'plan.json'), {});
    const at = plan.at || {}, rubric = plan.rubric || {};
    const posts = listPosts(studio, mediaUrl);
    const items = [
      ...reels(p).map((r) => ({key: 'reel:' + r.id, kind: 'reel', id: r.id, title: `${r.num} ${r.title}`, status: r.status, thumb: r.thumb})),
      ...posts.map((x) => ({key: 'post:' + x.id, kind: x.kind, id: x.id, title: x.title, status: x.stage, thumb: x.thumb, at: x.at ? new Date(x.at).toISOString() : null, rubric: x.rubric})),
    ].map((x) => ({...x, at: at[x.key] || x.at || null, rubric: rubric[x.key] || x.rubric || null}));
    return json(200, {strategy: readJson(join(studio, 'strategy.json'), {}), items, events: plan.events || [], templates: templates().templates, kinds: templates().kinds});
  }
  // Рубрика и ритм (handbook/LEAN.md, кусок 8): a rubric is a simple group — name, color,
  // formula (about), usual format and day; platforms carry a weekly count; days off. Fields the
  // old Strategy screens use (share, rules, series…) stay as they are.
  if (req.method === 'POST' && url.pathname === '/api/strategy/edit') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const f = join(studio, 'strategy.json');
    const st = readJson(f, {});
    const str = (v, n) => String(v ?? '').trim().slice(0, n);
    if (b.rubric) {
      st.rubrics ||= [];
      let r = st.rubrics.find((x) => x.id === b.rubric.id);
      if (!r) {
        const name = str(b.rubric.name, 60);
        if (!name) return json(400, {});
        const id = (name.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 30) || 'r') + '-' + Date.now().toString(36).slice(-3);
        r = {id, name, color: '#737373'};
        st.rubrics.push(r);
      }
      if (b.rubric.remove) st.rubrics = st.rubrics.filter((x) => x !== r);
      for (const [k, n] of [['name', 60], ['about', 200], ['format', 20], ['day', 20], ['look', 300]]) if (b.rubric[k] !== undefined) r[k] = str(b.rubric[k], n);
      if (Number.isFinite(b.rubric.share)) r.share = Math.max(0, Math.min(100, Math.round(b.rubric.share)));
      // Правила рубрики (кусок 15): the whole list at once, each {text, lock}.
      if (Array.isArray(b.rubric.rules)) r.rules = b.rubric.rules.map((x) => ({text: str(x?.text, 240), ...(x?.lock ? {lock: true} : {})})).filter((x) => x.text).slice(0, 30);
      // Референсы рубрики: a link or an uploaded file, what we take from it, how it will be ours.
      const ref = b.rubric.ref;
      if (ref) {
        r.refs ||= [];
        if (ref.add) {
          const url = str(ref.add.url, 500);
          if (!/^(https?:\/\/|\/media\?)/.test(url)) return json(400, {});
          r.refs.unshift({id: 'ref-' + Date.now().toString(36), url, name: str(ref.add.name, 120), file: !!ref.add.file, takes: [], at: new Date().toISOString().slice(0, 10)});
        } else {
          const x = r.refs.find((y) => y.id === ref.id);
          if (!x) return json(404, {});
          if (ref.remove) r.refs = r.refs.filter((y) => y !== x);
          if (Array.isArray(ref.takes)) x.takes = ref.takes.filter((t) => REF_TAKES.includes(t));
          for (const [k, n] of [['name', 120], ['note', 400], ['skip', 300]]) if (ref[k] !== undefined) x[k] = str(ref[k], n);
        }
        r.refs = r.refs.slice(0, 40);
      }
      if (/^#[0-9a-f]{6}$/i.test(b.rubric.color || '')) r.color = b.rubric.color;
      writeJson(f, st);
      log(me.name, `рубрика «${r.name}»${b.rubric.remove ? ' удалена' : ''}`);
      return json(200, {rubric: r});
    }
    if (b.platform) {
      const pl = (st.platforms || []).find((x) => x.id === b.platform.id);
      if (!pl) return json(404, {});
      if (Number.isFinite(b.platform.perWeek)) pl.perWeek = Math.max(0, Math.min(21, Math.round(b.platform.perWeek)));
      writeJson(f, st);
      return json(200, {platform: pl});
    }
    if (Array.isArray(b.daysOff)) {
      st.rhythm ||= {};
      st.rhythm.daysOff = b.daysOff.map(Number).filter((d) => d >= 1 && d <= 7);
      writeJson(f, st);
      return json(200, {});
    }
    return json(400, {});
  }
  // Память › Факты и цены (handbook/LEAN.md, кусок 9): facts.json, each fact with its source and
  // the date it was last confirmed; Claude checks releases against them.
  if (req.method === 'GET' && url.pathname === '/api/facts') return json(200, {facts: readJson(join(studio, 'facts.json'), {facts: []}).facts || []});
  if (req.method === 'POST' && url.pathname === '/api/facts/set') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const f = join(studio, 'facts.json');
    const d = readJson(f, {facts: []});
    d.facts ||= [];
    let x = d.facts.find((y) => y.id === b.id);
    if (b.remove) { d.facts = d.facts.filter((y) => y !== x); writeJson(f, d); return json(200, {}); }
    if (!x) { if (!String(b.text || '').trim()) return json(400, {}); x = {id: 'f-' + randomBytes(4).toString('hex')}; d.facts.push(x); }
    for (const [k, n] of [['text', 160], ['value', 120], ['source', 80]]) if (b[k] !== undefined) x[k] = String(b[k]).trim().slice(0, n);
    if (['price', 'date', 'people', 'other'].includes(b.kind)) x.kind = b.kind;
    x.at = new Date().toISOString().slice(0, 10); x.by = me.name;
    writeJson(f, d);
    log(me.name, `факт «${x.text}»: ${x.value || ''}`);
    return json(200, {fact: x});
  }
  // Память (handbook/LEAN.md, кусок 14): memory.json keeps the owner's spoken answers to the guiding
  // questions, the clients' questions and where memory came from; /api/memory is the overview.
  if (req.method === 'GET' && url.pathname === '/api/memory') {
    const m = readJson(join(studio, 'memory.json'), {});
    const st = readJson(join(studio, 'strategy.json'), {});
    const facts = readJson(join(studio, 'facts.json'), {facts: []}).facts || [];
    const old = facts.filter((x) => !x.at || Date.now() - new Date(x.at) > 30 * 864e5).length;
    const rules = (read(join(studio, 'PLAYBOOK.md')).match(/^\s*[-*] /gm) || []).length + (st.rubrics || []).reduce((n, r) => n + (r.rules || []).length, 0);
    return json(200, {answers: m.answers || [], questions: m.questions || [], sources: m.sources || [], brief: read(join(studio, 'brief.md')),
      facts: {n: facts.length, old, prices: facts.filter((x) => x.kind === 'price').slice(0, 4)}, voice: !!(st.voice?.about || (st.voice?.styles || []).length), rules,
      tokens: readJson(join(studio, 'design-system', 'tokens.json'), null), ds: existsSync(join(studio, 'design-system', 'index.html')),
      links: readJson(join(studio, 'settings.json'), {}).links || []});
  }
  if (req.method === 'POST' && url.pathname === '/api/memory/set') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const f = join(studio, 'memory.json');
    const m = readJson(f, {});
    const at = new Date().toISOString();
    const clip = (t, n) => String(t || '').trim().slice(0, n);
    if (b.answer && clip(b.answer.text, 4000)) {
      m.answers = (m.answers || []).filter((x) => x.q !== b.answer.q);
      m.answers.push({q: clip(b.answer.q, 40), question: clip(b.answer.question, 200), text: clip(b.answer.text, 4000), at, by: me.name});
    }
    if (b.question && clip(b.question.text, 300)) (m.questions ||= []).push({id: 'q-' + randomBytes(4).toString('hex'), text: clip(b.question.text, 300), source: clip(b.question.source, 80) || 'сказал ' + me.name, at: at.slice(0, 10)});
    if (b.removeQuestion) m.questions = (m.questions || []).filter((x) => x.id !== b.removeQuestion);
    if (b.source && clip(b.source.name, 200)) (m.sources ||= []).unshift({kind: clip(b.source.kind, 20), name: clip(b.source.name, 200), at});
    m.sources = (m.sources || []).slice(0, 40);
    writeJson(f, m);
    return json(200, m);
  }
  // A rubric's template (TEMPLATES.md): which of template/src/templates its reels are built by.
  if (req.method === 'POST' && url.pathname === '/api/strategy/template') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const f = join(studio, 'strategy.json');
    const st = readJson(f, {});
    const rub = (st.rubrics || []).find((x) => x.id === b.rubric);
    if (!rub || (b.template !== null && !templates().templates.some((x) => x.id === b.template))) return json(400, {});
    if (b.template) rub.template = b.template; else delete rub.template;
    writeJson(f, st);
    log(me.name, `шаблон рубрики «${rub.name}»: ${b.template || 'без шаблона'}`);
    return json(200, {rubric: rub});
  }
  if (req.method === 'POST' && url.pathname === '/api/plan/set') {
    if (!can('editor')) return json(403, {});
    const {key, at, rubric} = await body(req);
    if (!/^(reel|post):[\w-]{1,80}$/.test(key || '')) return json(400, {});
    const f = join(studio, 'plan.json');
    const plan = readJson(f, {});
    plan.at ||= {}; plan.rubric ||= {};
    if (at !== undefined) { if (at) plan.at[key] = String(at).slice(0, 25); else delete plan.at[key]; }
    if (rubric !== undefined) { if (rubric) plan.rubric[key] = String(rubric).slice(0, 60); else delete plan.rubric[key]; }
    writeJson(f, plan);
    followPlan(studio, key, {at, rubric});
    log(me.name, `поставил ${key} на ${at ?? '—'}`);
    return json(200, {});
  }
  // Units of content (web/items.mjs, handbook/LEAN.md): one item per format, by stage.
  if (req.method === 'GET' && url.pathname === '/api/items') {
    const {data, src} = syncItems(studio);
    const thumbs = {};
    for (const r of reels(p)) thumbs['reel:' + r.id] = r.thumb;
    for (const x of listPosts(studio, mediaUrl)) thumbs['post:' + x.id] = x.thumb;
    const items = data.items.map((x) => ({...x, need: needOf(x, src), thumb: x.ref ? thumbs[`${x.ref.kind}:${x.ref.id}`] || null : null}));
    const rubrics = (readJson(join(studio, 'strategy.json'), {}).rubrics || []).map((r) => ({id: r.id, name: r.name, color: r.color, about: r.about || '', format: r.format || '', day: r.day || '', share: r.share || 0, template: r.template || null}));
    return json(200, {items, rubrics});
  }
  if (req.method === 'POST' && url.pathname === '/api/items/set') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const item = changeItem(studio, String(b.id || ''), b, {by: me.name});
    if (!item) return json(404, {});
    log(me.name, `выпуск «${item.title}»: ${Object.keys(b).filter((k) => k !== 'id').join(', ')}`);
    return json(200, {item});
  }
  if (req.method === 'POST' && url.pathname === '/api/items/new') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const made = createItems(studio, {formats: b.formats, title: b.title, rubric: b.rubric || null, at: b.at || null, idea: b.idea || null, by: me.name});
    if (!made.length) return json(400, {});
    log(me.name, `новые выпуски «${made[0].title}»: ${made.map((x) => x.format).join(', ')}`);
    return json(200, {items: made});
  }
  if (req.method === 'GET' && url.pathname === '/api/knowledge') {
    const ds = join(studio, 'design-system', 'index.html');
    return json(200, {brief: read(join(studio, 'brief.md')), playbook: read(join(studio, 'PLAYBOOK.md')),
      ds: existsSync(ds) ? {url: `/ds/${p}/index.html?t=${statSync(ds).mtimeMs}`, updated: statSync(ds).mtimeMs} : null});
  }
  // The design-system page and the files next to it, sandboxed: its scripts run, but
  // never as this site.
  if (req.method === 'GET' && dsPath) {
    const f = join(studio, 'design-system', decodeURIComponent(dsPath[2]));
    const real = mediaPath(f);
    if (!real || !real.startsWith(join(studio, 'design-system') + '/')) return res.writeHead(404).end();
    res.writeHead(200, {'content-type': TYPES[extname(real)] || 'application/octet-stream', 'content-security-policy': 'sandbox allow-scripts', 'cache-control': 'no-store'});
    return createReadStream(real).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/reel') {
    const r = url.searchParams.get('reel');
    const dir = reelDir(p, r);
    if (!dir) return json(404, {});
    return json(200, {reel: reels(p).find((x) => x.id === r), versions: versions(p, r), readme: read(join(dir, 'README.md')),
      ready: readJson(join(dir, 'ready.json'), {}).v || null, scenes: readJson(join(dir, 'scenes.json'), null), publish: readJson(join(dir, 'publish.json'), null), edits: readEdits(dir), template: readJson(join(dir, 'project', 'src', 'reel.json'), null),
      outbox: readJson(OUTBOX, []).filter((o) => o.project === p && o.reel === r && !o.cancelled).slice(-10)});
  }
  // Правки по секундам (Д3): the list of notes for the next version, by voice or text, with a
  // point on the frame; «Собрать vN» hands the open ones to the reel chat (edits.json).
  // Names a version as a variant («RU», «EN», «короткая»), or clears the name.
  if (req.method === 'POST' && url.pathname === '/api/reel/variant') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const dir = reelDir(p, b.reel);
    if (!dir || !/^v\d+$/.test(b.v || '') || !existsSync(join(dir, 'versions', b.v))) return json(404, {});
    const label = String(b.label || '').trim().slice(0, 24);
    const f = join(dir, 'versions', b.v, 'variant.json');
    if (label) writeJson(f, {label, by: me.name, at: Date.now()}); else rmSync(f, {force: true});
    log(me.name, label ? `назвал ${b.v} ролика ${b.reel} вариантом «${label}»` : `снял метку варианта с ${b.v} ролика ${b.reel}`);
    return json(200, {ok: true});
  }
  // Which version goes to «Готово» (кусок 17): one is marked, the newest by default.
  if (req.method === 'POST' && url.pathname === '/api/reel/ready') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const dir = reelDir(p, b.reel);
    if (!dir || !/^v\d+$/.test(b.v || '') || !existsSync(join(dir, 'versions', b.v))) return json(404, {});
    writeJson(join(dir, 'ready.json'), {v: b.v, by: me.name, at: Date.now()});
    log(me.name, `${b.v} ролика ${b.reel} идёт в «Готово»`);
    return json(200, {ready: b.v});
  }
  if (req.method === 'POST' && url.pathname === '/api/reel/edits') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const dir = reelDir(p, b.reel);
    if (!dir) return json(404, {});
    const list = changeEdits(dir, b, me.name);
    if (!list) return json(400, {});
    return json(200, {edits: list});
  }
  // «Как увидят» (NX7): which platform views someone has looked at before publishing (publish.json → seen).
  if (req.method === 'POST' && url.pathname === '/api/reel/seen') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const dir = reelDir(p, b.reel);
    if (!dir || typeof b.key !== 'string') return json(404, {});
    const f = join(dir, 'publish.json');
    const pub = readJson(f, {});
    pub.seen = {...pub.seen, [b.key.slice(0, 80)]: {by: me.name, at: Date.now()}};
    writeJson(f, pub);
    return json(200, {seen: pub.seen});
  }
  // A spoken note: saved next to the reel's materials and turned into text by the bot's local Whisper.
  if (req.method === 'POST' && url.pathname === '/api/reel/voice') {
    if (!can('editor')) return json(403, {});
    const dir = reelDir(p, url.searchParams.get('reel'));
    if (!dir) return json(404, {});
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 20 * 1024 * 1024) return json(413, {}); chunks.push(c); }
    mkdirSync(join(dir, 'sources'), {recursive: true});
    const f = join(dir, 'sources', `voice-${Date.now()}.${/mp4|aac/.test(req.headers['content-type'] || '') ? 'm4a' : 'webm'}`);
    writeFileSync(f, Buffer.concat(chunks));
    const text = await transcribe(f, 'ru').catch(() => null);
    return json(200, {text: text || '', file: basename(f)});
  }
  // ---------- posts (web/posts.mjs) ----------
  if (req.method === 'GET' && url.pathname === '/api/post') {
    const id = url.searchParams.get('post');
    const dir = postDir(studio, id);
    if (!dir) return json(404, {});
    const ls = (d) => (existsSync(d) ? readdirSync(d).filter((f) => statSync(join(d, f)).isFile()).map((f) => ({name: f, url: mediaUrl(join(d, f)), size: statSync(join(d, f)).size})) : []);
    return json(200, {id, post: readPost(dir), sources: ls(join(dir, 'sources')), images: ls(join(dir, 'images')), imagesEn: ls(join(dir, 'images', 'en')),
      base: mediaUrl(dir).replace(/%2F?$/, ''), templates: TEMPLATES, summary: listPosts(studio, mediaUrl).find((x) => x.id === id),
      outbox: readJson(OUTBOX, []).filter((o) => o.project === p && o.post === id && !o.cancelled).slice(-10)});
  }
  if (req.method === 'POST' && url.pathname === '/api/post/new') {
    if (!can('editor')) return json(403, {});
    const {kind, title} = await body(req);
    const id = newPost(studio, {kind, title, by: me.name});
    log(me.name, `начал пост ${id}`);
    return json(200, {id});
  }
  // Fields the page edits by hand: chosen text, slide texts and order, captions, kind.
  if (req.method === 'POST' && url.pathname === '/api/post/save') {
    if (!can('editor')) return json(403, {});
    const {post: id, patch} = await body(req);
    const dir = postDir(studio, id);
    if (!dir || !patch || typeof patch !== 'object') return json(400, {});
    const cur = readPost(dir);
    for (const k of ['kind', 'title', 'chosen', 'texts', 'slides', 'slidesEn', 'slideCount', 'captions', 'after', 'photos', 'published', 'seen']) if (k in patch) cur[k] = patch[k];
    savePost(dir, cur);
    return json(200, {post: cur});
  }
  if (req.method === 'POST' && url.pathname === '/api/post/photo') {
    if (!can('editor')) return json(403, {});
    const {post: id, file, crop, bright} = await body(req);
    const dir = postDir(studio, id);
    const src = dir && mediaPath(join(dir, 'sources', basename(file || '')));
    if (!src) return json(404, {});
    try {
      const out = processPhoto(dir, src, {crop, bright: !!bright});
      const cur = readPost(dir);
      cur.photos = (cur.photos || []).map((x) => ({...x, chosen: false})).filter((x) => x.file !== basename(src));
      cur.photos.unshift({file: basename(src), crop, bright: !!bright, out: relative(dir, out), chosen: true});
      savePost(dir, cur);
      return json(200, {post: cur, url: mediaUrl(out)});
    } catch (e) { return json(500, {error: e.message}); }
  }
  if (req.method === 'POST' && url.pathname === '/api/post/slides') {
    if (!can('editor')) return json(403, {});
    const {post: id, lang} = await body(req);
    const dir = postDir(studio, id);
    if (!dir) return json(404, {});
    try {
      const files = await renderSlides(dir, studio, BOT, lang === 'en' ? 'en' : 'ru');
      log(me.name, `собрал слайды поста ${id}`);
      return json(200, {files: files.map((f) => mediaUrl(f))});
    } catch (e) { return json(500, {error: e.message}); }
  }
  // Publishing = a package (video, cover, caption) the bot sends to Telegram at the chosen time
  // (bot/outbox.mjs); the person then posts it from the phone.
  if (req.method === 'POST' && url.pathname === '/api/publish') {
    if (!can('editor')) return json(403, {});
    const {reel, post, at, caption, platform, lang, version: wantV} = await body(req);
    const when = Date.parse(at);
    if (!Number.isFinite(when)) return json(400, {error: 'нет времени'});
    let files, version = '', what = reel;
    if (post) {
      const pdir = postDir(studio, post);
      files = pdir ? postFiles(pdir, lang) : [];
      what = post;
      if (!pdir) return json(404, {});
    } else {
      const dir = reelDir(p, reel);
      // The version the owner picked (a reel may have RU and EN variants), its master when built.
      const all = dir ? versions(p, reel) : [];
      const cur = all.find((v) => v.v === wantV) || all[0];
      if (!cur) return json(400, {error: 'нет версии'});
      // Telegram takes at most 50 MB from a bot: a bigger master stays on the page («Скачать мастер»).
      const pick = (k) => cur.files.filter((f) => f.kind === k && f.size < 49e6).sort((a, b) => b.size - a.size)[0]?.name;
      files = [pick('master') || pick('copy'), pick('cover')].filter(Boolean).map((f) => join(dir, 'versions', cur.v, f));
      version = cur.v;
    }
    const items = readJson(OUTBOX, []);
    const item = {id: randomBytes(6).toString('hex'), project: p, reel: what, post: post || undefined, version, at: when, platform: String(platform || '').slice(0, 60),
      caption: String(caption || '').slice(0, 4000), files, by: me.name, person: me.id, created: Date.now()};
    items.push(item);
    writeJson(OUTBOX, items.slice(-200));
    log(me.name, `запланировал выкладку ${what} на ${new Date(when).toISOString()}`);
    return json(200, item);
  }
  if (req.method === 'POST' && url.pathname === '/api/publish/cancel') {
    if (!can('editor')) return json(403, {});
    const {id} = await body(req);
    const items = readJson(OUTBOX, []);
    const it = items.find((o) => o.id === id && o.project === p && !o.sent);
    if (!it) return json(404, {});
    it.cancelled = Date.now();
    writeJson(OUTBOX, items);
    log(me.name, `отменил выкладку ${it.reel}`);
    return json(200, {});
  }
  if (req.method === 'GET' && url.pathname === '/api/chat') {
    const k = url.searchParams.get('key');
    if (!chatKey(k)) return json(400, {});
    const busy = !!jobOf(p, k);
    return json(200, {messages: history(p, k), busy, status: busy ? chatMeta(p, k).status || '' : ''});
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (!can('editor')) return json(403, {});
    const {key: k, text, shown} = await body(req);
    if (!chatKey(k) || !text?.trim()) return json(400, {});
    if (jobOf(p, k)) return json(409, {});
    if (full()) return json(429, {max: MAX_JOBS});
    record(p, k, {from: 'me', kind: 'text', text: shown || text, by: me.name});
    log(me.name, `написал в чат «${k}»: ${(shown || text).slice(0, 80)}`);
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'});
    const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    // The turn goes on if the page is closed; the history keeps what it sent.
    const job = startTurn(p, k, `(from ${me.name})\n${text}`, send);
    job.child.on('close', () => setTimeout(() => res.end(), 50));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    if (!can('editor')) return json(403, {});
    const {key: k} = await body(req).catch(() => ({}));
    // A key stops that chat's turn; without one (older pages) every turn in the project stops.
    for (const j of jobs) if (j.p === p && (!k || j.key === k)) try { process.kill(-j.child.pid, 'SIGTERM'); } catch {}
    log(me.name, `остановил задачу${k ? ` в «${k}»` : ''}`);
    return json(200, {});
  }
  if (req.method === 'POST' && url.pathname === '/api/chat/reset') {
    if (!can('editor')) return json(403, {});
    const {key: k} = await body(req);
    if (!chatKey(k) || jobOf(p, k)) return json(400, {});
    for (const ext of ['jsonl', 'json']) rmSync(chatFile(p, k, ext), {force: true});
    return json(200, {});
  }
  // Raw upload: the body is the file, ?name= its name. With ?reel= it goes to that reel's
  // materials (sources/), otherwise to the project's inbox, as in the bot.
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    if (!can('editor')) return json(403, {});
    const reel = url.searchParams.get('reel');
    const pdir = postDir(studio, url.searchParams.get('post'));
    const rdir = (reel && reelDir(p, reel)) || pdir;
    const dir = rdir ? join(rdir, 'sources') : join(studio, 'inbox', new Date().toISOString().slice(0, 10));
    mkdirSync(dir, {recursive: true});
    const path = uniquePath(dir, rdir ? cleanName(url.searchParams.get('name')) : `web-${Date.now()}-${cleanName(url.searchParams.get('name'))}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    writeFileSync(path, buf);
    // A Telegram export (.zip): Claude can't unpack it, so the posts (posts.md) and photos go next to it.
    let digest = null;
    if (/\.zip$/i.test(path)) {
      let d = null;
      try { d = telegramDigest(buf); } catch {}
      if (d) {
        const out = path.replace(/\.zip$/i, '-telegram');
        mkdirSync(join(out, 'photos'), {recursive: true});
        for (const ph of d.photos) { const data = ph.read(); if (data && !ph.path.includes('..')) writeFileSync(join(out, 'photos', basename(ph.path)), data); }
        writeFileSync(join(out, 'posts.md'), d.md);
        digest = {path: join(out, 'posts.md'), name: d.name || '', count: d.count, photos: d.photos.length};
      }
    }
    mkdirSync(join(studio, 'inbox'), {recursive: true});
    appendFileSync(join(studio, 'inbox', 'history.md'), `- ${new Date().toISOString()} (web, ${me.name}${rdir ? `, reel ${reel}` : ''}) ${path}\n`);
    log(me.name, `загрузил ${basename(path)}${rdir ? ` в рилс ${reel}` : ''}`);
    return json(200, {path, url: mediaUrl(path), digest});
  }
  // Inbox → variants (Д2): an author's material becomes a post whose chat writes 2–3 variants.
  if (req.method === 'POST' && url.pathname === '/api/authors/variants') {
    if (!can('editor')) return json(403, {});
    const {id: eid, skip} = await body(req);
    const byId = new Map();
    for (const line of read(join(studio, 'inbox', 'authors.jsonl')).split('\n')) { try { const e = JSON.parse(line); byId.set(e.id, {...byId.get(e.id), ...e}); } catch {} }
    const e = byId.get(eid);
    if (!e) return json(404, {});
    const mark = (fields) => appendFileSync(join(studio, 'inbox', 'authors.jsonl'), JSON.stringify({id: eid, ...fields}) + '\n');
    if (skip) { mark({status: 'skip'}); return json(200, {}); }
    if (e.post && postDir(studio, e.post)) return json(200, {id: e.post, existed: true});
    const photos = (e.items || []).filter((i) => i.kind === 'photo' && i.path && existsSync(join(studio, i.path)));
    const pid = newPost(studio, {kind: photos.length ? 'photo' : 'text', title: (e.note || `От ${e.who || 'участника'}`).slice(0, 80), by: me.name});
    const dir = postDir(studio, pid);
    for (const i of photos) copyFileSync(join(studio, i.path), join(dir, 'sources', basename(i.path)));
    mark({status: 'used', post: pid});
    log(me.name, `сделал пост ${pid} из материала ${e.who || ''}`);
    return json(200, {id: pid, photos: photos.length});
  }
  // Задания людям (Д2): the editor's side of the mini app's tasks (projects/<p>/host/tasks.json).
  if (url.pathname === '/api/tasks') {
    if (!can('editor')) return json(403, {});
    const f = join(studio, 'host', 'tasks.json');
    const t = readJson(f, {tasks: []});
    if (req.method === 'GET') return json(200, {tasks: t.tasks || [], week: t.week, due: t.due, people: access().people.map((x) => ({id: x.id, name: x.name, role: x.role, onCamera: !!x.onCamera}))});
    const b = await body(req);
    const x = (t.tasks || []).find((y) => y.id === b.id);
    if (b.action === 'add' && b.title?.trim() && b.text?.trim()) {
      mkdirSync(join(studio, 'host'), {recursive: true});
      delete t.seeded;
      t.tasks = [...(t.tasks || []), {id: randomBytes(9).toString('base64url'), status: 'todo', title: b.title.trim().slice(0, 120), text: b.text.trim().slice(0, 2000),
        seconds: Math.min(90, Math.max(5, Number(b.seconds) || 20)), place: String(b.place || '').slice(0, 80), lang: b.lang === 'en' ? 'en' : 'ru', to: b.to || null, kind: 'shoot_self', by: me.name, created: Date.now()}];
    } else if (b.action === 'redo' && x) { x.status = 'redo'; x.note = String(b.note || '').slice(0, 300); }
    else if (b.action === 'remove' && x) t.tasks = t.tasks.filter((y) => y !== x);
    else return json(400, {});
    writeJson(f, t);
    log(me.name, `задания людям: ${b.action} ${b.title || x?.title || ''}`);
    return json(200, {tasks: t.tasks});
  }
  // What authors sent through the bot (bot/author.mjs): one line per update, merged by id.
  if (req.method === 'GET' && url.pathname === '/api/authors') {
    const byId = new Map();
    for (const line of read(join(studio, 'inbox', 'authors.jsonl')).split('\n')) {
      try { const e = JSON.parse(line); byId.set(e.id, {...byId.get(e.id), ...e}); } catch {}
    }
    const list = [...byId.values()].sort((x, y) => y.at - x.at).slice(0, 100)
      .map((e) => ({...e, items: (e.items || []).map((i) => ({...i, url: i.path ? mediaUrl(join(studio, i.path)) : null}))}));
    return json(200, {authors: list});
  }
  if (req.method === 'GET' && url.pathname === '/api/files') {
    const reel = url.searchParams.get('reel');
    if (reel) {
      const dir = reelDir(p, reel);
      if (!dir) return json(404, {});
      return json(200, {sources: listFiles(join(dir, 'sources')), results: listFiles(join(dir, 'versions'))});
    }
    return json(200, {inbox: listFiles(join(studio, 'inbox')).filter((f) => f.name !== 'history.md')});
  }
  if (req.method === 'POST' && url.pathname === '/api/files/delete') {
    if (!can('editor')) return json(403, {});
    const {reel, name} = await body(req);
    const dir = reelDir(p, reel);
    const f = dir && mediaPath(join(dir, 'sources', name || ''));
    if (!f || !f.startsWith(join(dir, 'sources') + '/')) return json(404, {});
    rmSync(f);
    log(me.name, `удалил материал ${basename(f)} из рилса ${reel}`);
    return json(200, {});
  }
  if (req.method === 'GET' && url.pathname === '/api/storage') {
    const list = reels(p).map((r) => {
      const dir = join(studio, 'reels', r.id);
      return {id: r.id, title: r.title, num: r.num, versions: dirSize(join(dir, 'versions')), sources: dirSize(join(dir, 'sources')) + dirSize(join(dir, 'project'))};
    }).sort((a, b) => b.versions + b.sources - a.versions - a.sources);
    return json(200, {reels: list, inbox: dirSize(join(studio, 'inbox')), total: dirSize(studio), policy: policy()});
  }
  if (req.method === 'POST' && url.pathname === '/api/policy') {
    if (!can('owner')) return json(403, {});
    const b = await body(req);
    const next = {...policy()};
    for (const k of ['keepPrevious', 'archiveOlder', 'finalOnly']) if (typeof b[k] === 'boolean') next[k] = b[k];
    writeJson(POLICY, next);
    log(me.name, 'поменял правила хранения');
    return json(200, next);
  }
  if (req.method === 'POST' && url.pathname === '/api/free') {
    if (!can('owner')) return json(403, {});
    const {reel} = await body(req);
    const list = reel ? [reel] : reels(p).map((r) => r.id);
    let freed = 0;
    for (const r of list) if (!jobOf(p, r)) freed += retain(p, r);
    log(me.name, `освободил место${reel ? ` в «${reel}»` : ''}: ${Math.round(freed / 1e6)} МБ`);
    return json(200, {freed});
  }
  // ---------- team (D1–D3): editors manage people; owner flag and owners only by an owner ----------
  if (req.method === 'GET' && url.pathname === '/api/access') {
    if (!can('editor')) return json(403, {});
    const a = access();
    const tg = telegramSessions(a);
    return json(200, {
      people: peopleOf(a, p).map(({pw, ...x}) => ({...x, hasPassword: !!pw?.hash, editorNow: isEditor(x),
        devices: a.sessions.filter((s) => s.person === x.id).map((s) => ({id: s.id, device: s.device, created: s.created, seen: s.seen, mine: s.id === me.sid})),
        bot: x.isOwner ? tg.find((t) => t.owner) || null : x.telegram ? {username: x.telegram.username, seen: x.telegram.seen || x.added} : null})),
      invites: a.invites.filter((x) => x.expires > Date.now()).map((x) => ({...x, link: inviteLinks(x)})),
      bot: botUsername(), me: me.id,
      // Only the owner sees the bot's owner link, and only while the bot has no owner yet.
      ownerLink: me.isOwner && botUsername() && process.env.OWNER_CODE && !readJson(join(BOT, 'data', 'state.json'), {}).ownerId ? `https://t.me/${botUsername()}?start=${startOf(process.env.OWNER_CODE)}` : null,
      log: read(LOG).split('\n').filter(Boolean).slice(-40).map((l) => JSON.parse(l)).reverse(),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/access') {
    if (!can('editor')) return json(403, {});
    const b = await body(req);
    const a = access();
    const target = a.people.find((y) => y.id === b.id);
    const mayTouch = (x) => x && x.id !== me.id && (!x.isOwner || me.isOwner);
    if (b.action === 'invite' && b.name?.trim() && ['editor', 'member'].includes(b.role)) {
      const inv = {code: id(), pin: newPin(a), name: b.name.trim().slice(0, 60), note: String(b.note || '').slice(0, 80), ...personFields(b), expires: Date.now() + 7 * 864e5, claimed: []};
      inv.telegram = !!botUsername();
      inv.web = inv.role === 'editor' || b.web === true || !inv.telegram;
      a.invites.push(inv);
      log(me.name, `пригласил ${inv.name} (${inv.role === 'editor' ? 'редактор' : 'участник'}${inv.web ? ', бот + веб' : ', бот'})`);
      saveAccess(a);
      return json(200, {invite: {...inv, link: inviteLinks(inv)}});
    }
    // A fresh sign-in link for someone already in the team (new phone, lost sign-in).
    if (b.action === 'relink' && target && (mayTouch(target) || target.id === me.id)) {
      const inv = {code: id(), pin: newPin(a), name: target.name, person: target.id, role: target.role, expires: Date.now() + 7 * 864e5, claimed: [], telegram: !!botUsername(), web: isEditor(target) || target.web === true};
      a.invites.push(inv);
      saveAccess(a);
      return json(200, {invite: {...inv, link: inviteLinks(inv)}});
    }
    if (b.action === 'cancel') a.invites = a.invites.filter((x) => x.code !== b.code);
    if (b.action === 'update' && target && (mayTouch(target) || (target.id === me.id && !('isOwner' in b)))) {
      if (['editor', 'member'].includes(b.role) && !(target.isOwner && b.role === 'member')) target.role = b.role;
      if ('onCamera' in b) target.onCamera = !!b.onCamera;
      if ('selfBuild' in b) target.selfBuild = !!b.selfBuild;
      if ('web' in b) target.web = !!b.web;
      if ('deputyUntil' in b) target.deputyUntil = /^\d{4}-\d{2}-\d{2}$/.test(b.deputyUntil || '') ? b.deputyUntil : null;
      if (Array.isArray(b.groups)) target.groups = b.groups.map((g) => String(g).slice(0, 40)).filter(Boolean).slice(0, 12);
      if ('isOwner' in b && me.isOwner && target.role === 'editor') target.isOwner = !!b.isOwner;
      if (!target.web && !isEditor(target)) a.sessions = a.sessions.filter((s) => s.person !== target.id);
      log(me.name, `поменял доступ: ${target.name}`);
    }
    if (b.action === 'remove' && mayTouch(target)) {
      a.people = a.people.filter((y) => y !== target); a.sessions = a.sessions.filter((s) => s.person !== target.id); a.invites = a.invites.filter((i) => i.person !== target.id);
      log(me.name, `убрал ${target.name}`);
    }
    if (b.action === 'end-telegram' && mayTouch(target) && target.telegram) { log(me.name, `отключил бот у ${target.name}`); delete target.telegram; }
    if (b.action === 'end') { const s0 = a.sessions.find((s) => s.id === b.session); const owner = s0 && a.people.find((x) => x.id === s0.person); if (s0 && s0.id !== me.sid && (owner?.id === me.id || mayTouch(owner))) a.sessions = a.sessions.filter((s) => s !== s0); }
    if (b.action === 'end-others') a.sessions = a.sessions.filter((s) => s.person !== me.id || s.id === me.sid);
    saveAccess(a);
    return json(200, {});
  }
  if (req.method === 'GET' && url.pathname === '/media') {
    const f = mediaPath(url.searchParams.get('p') || '');
    if (f && !isEditor(me) && !f.includes('/inbox/')) return res.writeHead(403).end();
    if (!f) return res.writeHead(404).end();
    const size = statSync(f).size;
    const headers = {'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'accept-ranges': 'bytes'};
    if (url.searchParams.has('dl')) {
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(f))}`;
      log(me.name, `скачал ${basename(f)}`);
    }
    if (extname(f) === '.html' || extname(f) === '.svg') headers['content-security-policy'] = 'sandbox';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1});
      return createReadStream(f, {start, end}).pipe(res);
    }
    res.writeHead(200, {...headers, 'content-length': size});
    return createReadStream(f).pipe(res);
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`reels web on 127.0.0.1:${PORT}`));
