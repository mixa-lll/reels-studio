// Telegram mini app «Съёмка» for hosts (ведущие): weekly filming tasks, the text to read
// with a teleprompter, recording in the browser camera and sending the take to the editor.
// The page is web/app.html; it signs every request with Telegram's initData, which is
// checked here against the bot token, so no key or cookie is needed inside Telegram.
//
// Data per project: projects/<p>/host/tasks.json (tasks), host/profiles.json (per person),
// takes go to the project's inbox like anything else sent to the bot. Until the editor
// side exists, a project without tasks.json gets demo tasks (seeded: true).
import {execFileSync, spawn} from 'node:child_process';
import {createHmac, randomBytes} from 'node:crypto';
import {appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, extname, join, relative} from 'node:path';
import {ffCommand} from '../bot/media.mjs';
import {transcribe} from '../bot/stt.mjs';
import {isEditor} from '../bot/roles.mjs';
import {buildRequest, changeEdits, readEdits} from './edits.mjs';

const MAX_TAKE = 300 * 1024 * 1024;
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f); };
const id = () => randomBytes(9).toString('base64url');
const LAT = {а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya'};
const slugOf = (t) => String(t || '').toLowerCase().replace(/[а-яё]/g, (c) => LAT[c] ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 5).join('-') || 'reel';
const MEDIA = /\.(jpe?g|png|webp|mp4|mov|webm|m4v)$/i;

// The take is shot as clips (one per phrase, or one for the whole text, cut where the
// host restarted a phrase); the server trims, joins and evens them out into one
// vertical 1080×1920 mp4 and then checks the speech against the text.
export const phrasesOf = (text) => String(text || '').split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean);
const norm = (w) => w.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/gi, '');

function joinClips(clips, out) {
  const args = ['-y', '-loglevel', 'error'];
  clips.forEach((c) => { if (c.keep) args.push('-t', String(c.keep)); args.push('-i', c.file); });
  const f = clips.map((_, i) => `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[v${i}];[${i}:a]aresample=48000,aformat=channel_layouts=mono[a${i}]`).join(';');
  const cat = clips.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${clips.length}:v=1:a=1[v][a]`;
  args.push('-filter_complex', `${f};${cat}`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
  const [cmd, full] = ffCommand('ffmpeg', args);
  return new Promise((ok, fail) => {
    const p = spawn(cmd, full, {stdio: ['ignore', 'ignore', 'pipe']});
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 && existsSync(out) ? ok(out) : fail(new Error(err.trim().split('\n').slice(-2).join(' ') || 'ffmpeg failed'))));
  });
}

/** Words of each phrase that the transcript does not have (fuzzy: by their first five letters). */
export function missingWords(text, heard) {
  const got = new Set(String(heard || '').split(/\s+/).map(norm).filter(Boolean).map((w) => w.slice(0, 5)));
  return phrasesOf(text).map((ph, i) => ({phrase: i, words: ph.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}-]/gu, '')).filter((w) => norm(w).length > 3 && !got.has(norm(w).slice(0, 5)))}))
    .filter((x) => x.words.length);
}

/** The Telegram user from a valid, fresh initData string, or null. */
export function verifyInitData(initData, token, maxAgeSec = 24 * 3600) {
  if (!initData || !token) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  if (createHmac('sha256', secret).update(check).digest('hex') !== hash) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > maxAgeSec) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

const DEMO = [
  {title: 'День открытых дверей: что спрашивают родители', text: 'Каждый родитель на дне открытых дверей задаёт нам одни и те же три вопроса. Вот ответы. Первый: сколько детей в классе? У нас не больше пятнадцати.', seconds: 20, place: 'кабинет 204, у окна', lang: 'ru', why: 'Серия для родителей, которые выбирают школу. Говорите тепло, как будто встречаете их у входа.'},
  {title: 'Почему у нас маленькие классы', text: 'В нашем классе пятнадцать учеников, а не тридцать. Поэтому учитель успевает услышать каждого.', seconds: 20, place: 'кабинет 204, у окна', lang: 'ru', why: 'Отвечаем на частый вопрос родителей коротко и по делу.'},
  {title: 'Лаборатория робототехники', text: 'This is our robotics lab. Kids build their first robot in week one.', translation: 'Это наша лаборатория робототехники. Первого робота дети собирают в первую же неделю.', seconds: 15, place: 'лаборатория', lang: 'en', why: 'Английская версия для иностранных родителей.'},
  {title: 'Знакомьтесь: повар Нина', text: 'Это Нина, наш повар. Она знает, кто из детей не ест лук, и всё равно делает вкусно.', seconds: 15, place: 'столовая', lang: 'ru', status: 'redo', note: 'Всё хорошо, кроме темпа. Говорите медленнее, а в начале 2 секунды просто улыбнитесь.', why: 'Рубрика «Знакомьтесь».'},
];

// What each rewrite asks Claude for; the plain rules below stand in when it is unavailable.
const ASK = {
  other: 'Напиши другой вариант этого текста: тот же смысл и длина, другие слова и заход.',
  more: 'Напиши ещё один, заметно другой вариант этого текста: тот же смысл и длина.',
  simpler: 'Сделай текст проще: короткие фразы, обычные слова, тот же смысл.',
  shorter: 'Сделай текст короче примерно на треть, сохрани главное.',
  warmer: 'Сделай текст теплее и дружелюбнее, как будто встречаешь человека у входа.',
  mine: 'Это текст ведущего его словами. Сделай на его основе гладкий текст для чтения в камеру: сохрани его мысль, интонацию и ключевые слова, убери лишнее.',
  fix: 'Исправь только орфографию, пунктуацию и опечатки. Ничего не перефразируй и не меняй слова.',
};
function claudeRewrite(mode, text, task) {
  const prompt = `${ASK[mode]}\nТекст читают в камеру за ${task.seconds || 20} секунд, язык — ${task.lang === 'en' ? 'английский' : 'русский'}. Тема ролика: «${task.title}».\nОтветь только новым текстом, без кавычек и пояснений.\n\nТекст:\n${text}`;
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(process.env.AGENT_BIN || 'claude', ['-p', prompt, '--output-format', 'text', '--allowedTools', '', '--max-turns', '1'], {stdio: ['ignore', 'pipe', 'ignore']});
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 45_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); const t = out.trim().replace(/^[«"]|[»"]$/g, ''); resolve(code === 0 && t && t.length < 2000 ? t : null); });
  });
}
const REWRITES = {
  shorter: (t) => t.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '),
  simpler: (t) => t.replace(/,\s*(который|которая|которые)[^,.]*[,.]/g, '.').replace(/\s+/g, ' '),
  warmer: (t) => (/^(Здравствуйте|Привет)/.test(t) ? t : `Здравствуйте! ${t}`),
  other: (t) => { const s = t.split(/(?<=[.!?])\s+/); return s.length > 1 ? [s.at(-1), ...s.slice(0, -1)].join(' ') : t; },
  more: (t) => REWRITES.other(t),
  mine: (t) => t,
  fix: (t) => t.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/(^|[.!?]\s+)([а-яёa-z])/g, (m, a, b) => a + b.toUpperCase()).trim(),
};

// A video with byte ranges, so the phone can seek.
const TYPE = {'.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'};
function streamFile(req, res, f, extra = {}) {
  const type = TYPE[extname(f).toLowerCase()] || 'application/octet-stream';
  const size = statSync(f).size, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const a = range[1] ? Number(range[1]) : 0, z = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {'content-type': type, 'content-range': `bytes ${a}-${z}/${size}`, 'accept-ranges': 'bytes', 'content-length': z - a + 1, 'cache-control': 'no-store', ...extra});
    return createReadStream(f, {start: a, end: z}).pipe(res);
  }
  res.writeHead(200, {'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store', ...extra});
  return createReadStream(f).pipe(res);
}

export function makeApp({BOT, PROJECTS, PAGE, access, saveAccess, logFile, reels, log, reelDir, build, busy, chat}) {
  const token = () => process.env.TELEGRAM_BOT_TOKEN;
  const sign = (rel) => createHmac('sha256', `${token()}:video`).update(rel).digest('base64url').slice(0, 22);
  const botState = () => readJson(join(BOT, 'data', 'state.json'), {});
  const project = () => (botState().project && existsSync(join(PROJECTS, botState().project)) ? botState().project : 'main');
  // Where the studio runs without the bot (the shared stage), MINIAPP_OWNERS lists the
  // Telegram ids treated as the owner; the first one also gets the notifications.
  const owners = () => (process.env.MINIAPP_OWNERS || '').split(',').map((x) => Number(x.trim())).filter(Boolean);
  const hostDir = (p) => { const d = join(PROJECTS, p, 'host'); mkdirSync(d, {recursive: true}); return d; };

  // Test profiles (owner only): people with test: true and no Telegram account. The owner
  // opens the app «as» one of them (header x-as); everything they create is tagged by name
  // and is wiped with the profile (wipeTest below).
  function person(user, as) {
    const st = botState();
    const owner = user.id === st.ownerId || owners().includes(user.id);
    if (owner && as) {
      const x = access().people.find((y) => y.id === as && y.test);
      if (x) return {key: x.id, name: x.name, role: x.role, editor: isEditor(x), deputyUntil: x.deputyUntil || null, onCamera: !!x.onCamera, studio: isEditor(x) || !!x.selfBuild, test: true, realOwner: true};
    }
    if (owner) return {key: 'owner', realOwner: true, name: st.ownerName || user.first_name, role: 'owner', editor: true, onCamera: true, studio: true};
    const x = access().people.find((y) => y.telegram?.id === user.id);
    // «Студия» (SR0): editors of the project and people marked «Сам собирает».
    const deputy = x && x.role !== 'editor' && !x.isOwner && isEditor(x) ? x.deputyUntil : null;
    return x ? {key: x.id, name: x.name, role: x.role, editor: isEditor(x), deputyUntil: deputy, onCamera: !!x.onCamera, studio: isEditor(x) || !!x.selfBuild} : null;
  }
  function tasks(p) {
    const f = join(hostDir(p), 'tasks.json');
    let t = readJson(f, null);
    if (!t) {
      t = {seeded: true, week: 'неделя 3–9 ноября', due: 'пятница', tasks: DEMO.map((x) => ({id: id(), status: 'todo', ...x}))};
      writeJson(f, t);
    }
    return t;
  }
  const saveTasks = (p, t) => writeJson(join(hostDir(p), 'tasks.json'), t);
  const profiles = (p) => readJson(join(hostDir(p), 'profiles.json'), {});

  // Tells the owner in the bot chat; a take goes as a video.
  async function notify(text, file) {
    const st = botState();
    const chat = st.chatId || owners()[0];
    if (!chat || !token()) return;
    const api = `${process.env.REELS_TELEGRAM_API || 'https://api.telegram.org'}/bot${token()}`;
    try {
      if (file) {
        const form = new FormData();
        form.append('chat_id', String(chat));
        form.append('caption', text);
        form.append('video', new Blob([readFileSync(file)]), file.split('/').pop());
        await fetch(`${api}/sendVideo`, {method: 'POST', body: form, signal: AbortSignal.timeout(120_000)});
      } else {
        await fetch(`${api}/sendMessage`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({chat_id: chat, text}), signal: AbortSignal.timeout(30_000)});
      }
    } catch (e) { console.error('mini app notify:', e.message); }
  }


  // «Неделя» (LE1): this week's days with what is planned on them (plan.json) and the rhythm's empty slots.
  function weekOf(p) {
    const plan = readJson(join(PROJECTS, p, 'plan.json'), {});
    const slots = readJson(join(PROJECTS, p, 'strategy.json'), {}).rhythm?.slots || [];
    const now = new Date(), mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const rs = reels(p);
    const titleOf = (key) => key.startsWith('reel:') ? rs.find((x) => x.id === key.slice(5))?.title : readJson(join(PROJECTS, p, 'posts', key.slice(5), 'post.json'), {}).title;
    const statusOf = (key) => key.startsWith('reel:') ? rs.find((x) => x.id === key.slice(5))?.status : null;
    return Array.from({length: 7}, (_, i) => {
      const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const items = Object.entries(plan.at || {}).filter(([, at]) => String(at).startsWith(iso)).map(([key, at]) => ({key, kind: key.startsWith('reel:') ? 'reel' : 'post', title: titleOf(key) || key.slice(5), time: String(at).slice(11, 16), status: statusOf(key)}));
      return {day: i + 1, date: d.getDate(), items, slot: !items.length && slots.some((x) => x.day === i + 1)};
    });
  }
  // «Люди» (LE2): tasks by person and who has not sent anything for a long time.
  function peopleOf(t) {
    const a = access();
    const name = (k) => a.people.find((x) => x.id === k)?.name || (k === 'owner' ? botState().ownerName || 'Владелец' : null);
    const tasks = t.tasks.filter((x) => x.to).map((x) => ({title: x.title, who: name(x.to) || '—', status: x.status, due: t.due}));
    const quiet = a.people.filter((x) => x.telegram && !x.isOwner).map((x) => ({name: x.name, days: Math.floor((Date.now() - (x.telegram.seen || x.added || Date.now())) / 864e5)})).filter((x) => x.days >= 7).sort((x, y) => y.days - x.days);
    return {tasks, quiet};
  }

  const testList = () => access().people.filter((x) => x.test).map((x) => ({id: x.id, name: x.name, role: x.role, onCamera: !!x.onCamera, selfBuild: !!x.selfBuild, deputyUntil: x.deputyUntil || null, added: x.added}));
  // Removes a test profile and everything tagged with it: its own tasks and takes, files it
  // sent (inbox lines «(mini app, <name>, …)»), reels it started, its text edits, its
  // settings and its lines in the shared log. Real people's data is never touched.
  function wipeTest(p, pid) {
    const a = access();
    const x = a.people.find((y) => y.id === pid && y.test);
    if (!x) return null;
    const out = {name: x.name, tasks: 0, files: 0, reels: 0};
    const t = tasks(p);
    const takes = join(hostDir(p), 'takes');
    const rmTake = (tid) => { const d = join(takes, String(tid).replace(/[^\w-]/g, '')); if (existsSync(d)) rmSync(d, {recursive: true, force: true}); };
    t.tasks = t.tasks.filter((k) => {
      if (k.to === pid) { out.tasks++; rmTake(k.id); if (k.take) rmSync(join(PROJECTS, k.take), {force: true}); return false; }
      if (k.sentBy === x.name) { if (k.take) rmSync(join(PROJECTS, k.take), {force: true}); rmTake(k.id); k.status = 'todo'; delete k.take; delete k.sentAt; delete k.sentBy; }
      if (k.edit?.by === x.name) delete k.edit;
      return true;
    });
    saveTasks(p, t);
    const hist = join(PROJECTS, p, 'inbox', 'history.md');
    if (existsSync(hist)) {
      const keep = [];
      for (const line of readFileSync(hist, 'utf8').split('\n')) {
        if (line.includes(`(mini app, ${x.name},`)) { const f = line.split(') ').pop().trim(); if (f && f.startsWith(PROJECTS)) { rmSync(f, {force: true}); out.files++; } }
        else keep.push(line);
      }
      writeFileSync(hist, keep.join('\n'));
    }
    const rdir = join(PROJECTS, p, 'reels');
    if (existsSync(rdir)) for (const r of readdirSync(rdir)) {
      const readme = join(rdir, r, 'README.md');
      if (existsSync(readme) && readFileSync(readme, 'utf8').includes(`Started: mini app, ${x.name},`)) {
        rmSync(join(rdir, r), {recursive: true, force: true}); out.reels++;
        const plan = readJson(join(PROJECTS, p, 'plan.json'), null);
        if (plan) { for (const k of ['at', 'rubric']) if (plan[k]) delete plan[k][`reel:${r}`]; writeJson(join(PROJECTS, p, 'plan.json'), plan); }
      }
    }
    const prof = profiles(p); if (prof[pid]) { delete prof[pid]; writeJson(join(hostDir(p), 'profiles.json'), prof); }
    a.people = a.people.filter((y) => y !== x);
    a.sessions = (a.sessions || []).filter((s) => s.person !== pid);
    a.invites = (a.invites || []).filter((i) => i.person !== pid);
    saveAccess(a);
    const logf = logFile?.();
    if (logf && existsSync(logf)) writeFileSync(logf, readFileSync(logf, 'utf8').split('\n').filter((l) => !l.includes(`"who":${JSON.stringify(x.name)}`)).join('\n'));
    return out;
  }

  return async function app(req, res, url) {
    const json = (code, b) => { res.writeHead(code, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(b)); };
    // The joined take for the page's <video>: an unguessable key from /api/app/join.
    const tk = /^\/app\/take\/([\w-]+)\/([\w-]+)\.mp4$/.exec(url.pathname);
    if (req.method === 'GET' && tk) {
      const d = join(PROJECTS, project(), 'host', 'takes', tk[1]);
      const meta = readJson(join(d, 'meta.json'), {});
      const f = join(d, 'take.mp4');
      if (!meta.key || meta.key !== tk[2] || !existsSync(f)) { res.writeHead(404); return res.end(); }
      return streamFile(req, res, f);
    }
    // A reel's video for the editor's <video>: a link signed with the bot token, no header needed.
    if (req.method === 'GET' && url.pathname === '/app/v') {
      const rel = url.searchParams.get('f') || '';
      const f = join(PROJECTS, rel);
      if (url.searchParams.get('k') !== sign(rel) || relative(PROJECTS, f).startsWith('..') || !/^[\w-]+\/reels\/[\w-]+\/(versions\/v\d+|project\/public|sources)\/[^/]+\.(mp4|mov|webm|jpe?g|png|webp)$/i.test(rel) || !existsSync(f)) { res.writeHead(404); return res.end(); }
      // ?dl=1: «Скачать» saves the file instead of playing it.
      return streamFile(req, res, f, url.searchParams.get('dl') ? {'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(f))}`} : {});
    }
    if (req.method === 'GET' && url.pathname === '/app') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
      return res.end(PAGE());
    }
    const user = verifyInitData(req.headers['x-tg-init'], token());
    if (!user) return json(401, {error: 'Откройте приложение из Телеграм-бота'});
    const me = person(user, req.headers['x-as']);
    if (!me) return json(403, {error: 'Вас ещё не добавили в команду. Попросите у редактора приглашение.'});
    const p = project();
    const t = tasks(p);
    const task = (tid) => t.tasks.find((x) => x.id === tid);

    if (url.pathname === '/api/app/test') {
      if (!me.realOwner) return json(403, {});
      let tb = {};
      if (req.method === 'POST') { let raw = ''; for await (const c of req) raw += c; try { tb = JSON.parse(raw || '{}'); } catch {} }
      if (tb.action === 'create') {
        const roles = {member: 'Участник', camera: 'Участник «в кадре»', builder: 'Участник «сам собирает»', deputy: 'Замещающий', editor: 'Редактор'};
        if (!roles[tb.kind]) return json(400, {});
        const a = access();
        const pid = id();
        const x = {id: pid, name: `Тест · ${roles[tb.kind]} · ${pid.slice(0, 4)}`, role: tb.kind === 'editor' ? 'editor' : 'member', added: Date.now(), test: true,
          onCamera: tb.kind === 'camera', selfBuild: tb.kind === 'builder', ...(tb.kind === 'deputy' ? {deputyUntil: Date.now() + 14 * 864e5} : {})};
        a.people.push(x);
        saveAccess(a);
        // Something to try at once: one task of their own (a filming one for «в кадре»).
        t.tasks.push({...DEMO[x.onCamera ? 0 : 1], id: id(), status: 'todo', to: pid});
        saveTasks(p, t);
        log?.(me.name, `создал тестовый профиль «${x.name}»`);
        return json(200, {tests: testList()});
      }
      if (tb.action === 'delete') {
        const done = wipeTest(p, tb.id);
        if (!done) return json(404, {});
        log?.(me.name, `удалил тестовый профиль «${done.name}» и его данные`);
        return json(200, {tests: testList(), wiped: done});
      }
      return json(200, {tests: testList()});
    }
    if (req.method === 'GET' && url.pathname === '/api/app/state') {
      const prof = profiles(p)[me.key] || {};
      const mine = reels(p).map((r) => ({id: r.id, title: r.title, status: r.status, version: r.version, updated: r.updated}));
      // A task for one person (to) is shown to them only; one without «to» to everyone.
      return json(200, {tests: me.realOwner ? testList() : undefined, me: {test: !!me.test, name: me.name, role: me.role, editor: !!me.editor, deputyUntil: me.deputyUntil || null, onCamera: !!me.onCamera, studio: !!me.studio}, project: p, ...(me.editor ? {plan: weekOf(p), people: peopleOf(t)} : {}), week: t.week, due: t.due, demo: !!t.seeded, tasks: t.tasks.filter((x) => !x.to || x.to === me.key || me.key === 'owner'), reels: mine,
        profile: {langs: 'русский, английский', when: 'вт и чт после 15:00', where: 'кабинет 204, у окна', speed: 1, size: 'large', consent: true, ...prof}});
    }
    let b = {};
    if (req.method === 'POST' && !['/api/app/take', '/api/app/clip', '/api/app/reel/voice', '/api/app/reel/upload', '/api/app/drop'].includes(url.pathname)) {
      let s = '';
      for await (const chunk of req) s += chunk;
      try { b = JSON.parse(s || '{}'); } catch {}
    }
    if (req.method === 'POST' && url.pathname === '/api/app/rewrite') {
      const x = task(b.id);
      const f = REWRITES[b.mode];
      if (!x || !f) return json(400, {});
      // The text on screen (what the host typed or the last variant), else the task's.
      const src = typeof b.text === 'string' && b.text.trim() ? b.text.trim().slice(0, 2000) : x.edit?.text || x.text;
      const out = await claudeRewrite(b.mode, src, x);
      return json(200, out ? {text: out} : {text: f(src), stub: true});
    }
    if (req.method === 'POST' && url.pathname === '/api/app/text') {
      const x = task(b.id);
      if (!x || typeof b.text !== 'string' || !b.text.trim()) return json(400, {});
      if (b.text.trim() === x.text) delete x.edit;
      else x.edit = {text: b.text.trim().slice(0, 2000), by: me.name, at: Date.now(), status: 'pending'};
      saveTasks(p, t);
      if (x.edit) {
        log?.(me.name, `предложил свой текст для «${x.title}»`);
        notify(`✏️ ${me.name} предлагает другой текст для «${x.title}»:\n\n${x.edit.text}\n\nБыло:\n${x.text}`);
      }
      return json(200, {task: x});
    }
    if (req.method === 'POST' && url.pathname === '/api/app/take') {
      const x = task(url.searchParams.get('id'));
      if (!x) return json(400, {});
      const ext = /mp4/.test(req.headers['content-type'] || '') ? 'mp4' : 'webm';
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_TAKE) return json(413, {error: 'Видео слишком большое'}); chunks.push(chunk); }
      const day = new Date().toISOString().slice(0, 10);
      const dir = join(PROJECTS, p, 'inbox', day);
      mkdirSync(dir, {recursive: true});
      const file = join(dir, `host-${Date.now()}-${x.id}.${ext}`);
      writeFileSync(file, Buffer.concat(chunks));
      appendFileSync(join(PROJECTS, p, 'inbox', 'history.md'), `- ${new Date().toISOString()} (mini app, ${me.name}, задание «${x.title}») ${file}\n`);
      x.status = 'sent';
      x.sentAt = Date.now();
      x.sentBy = me.name;
      x.take = file.slice(PROJECTS.length + 1);
      delete x.note;
      saveTasks(p, t);
      log?.(me.name, `прислал запись «${x.title}»`);
      notify(`🎬 ${me.name} прислал(а) запись: «${x.title}»${x.edit?.status === 'pending' ? '\n✏️ Со своим текстом — он ждёт вашего согласования.' : ''}`, size < 48 * 1024 * 1024 ? file : null);
      return json(200, {task: x});
    }
    // ---------- prompter takes: clips → join → speech check → send ----------
    const takeDir = (tid) => { const d = join(hostDir(p), 'takes', tid.replace(/[^\w-]/g, '')); mkdirSync(d, {recursive: true}); return d; };
    if (req.method === 'POST' && url.pathname === '/api/app/clip') {
      const x = task(url.searchParams.get('id'));
      const n = Number(url.searchParams.get('n'));
      if (!x || !Number.isInteger(n) || n < 0 || n > 40) return json(400, {});
      const d = takeDir(x.id);
      if (n === 0) for (const f of readdirSync(d)) rmSync(join(d, f), {force: true});
      const ext = /mp4/.test(req.headers['content-type'] || '') ? 'mp4' : 'webm';
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_TAKE) return json(413, {error: 'Видео слишком большое'}); chunks.push(chunk); }
      writeFileSync(join(d, `clip-${String(n).padStart(2, '0')}.${ext}`), Buffer.concat(chunks));
      const meta = readJson(join(d, 'meta.json'), {clips: {}});
      const keep = Number(url.searchParams.get('keep'));
      meta.clips[n] = {ext, keep: keep > 0 ? keep : null};
      writeJson(join(d, 'meta.json'), meta);
      return json(200, {n});
    }
    if (req.method === 'POST' && url.pathname === '/api/app/join') {
      const x = task(b.id);
      if (!x) return json(400, {});
      const d = takeDir(x.id);
      const meta = readJson(join(d, 'meta.json'), {clips: {}});
      const clips = Object.keys(meta.clips).map(Number).sort((a, c) => a - c).slice(0, Number(b.count) || 40)
        .map((n) => ({file: join(d, `clip-${String(n).padStart(2, '0')}.${meta.clips[n].ext}`), keep: meta.clips[n].keep}));
      if (!clips.length) return json(400, {error: 'Нет записи'});
      try { await joinClips(clips, join(d, 'take.mp4')); } catch (e) { return json(500, {error: 'Не получилось склеить: ' + e.message}); }
      meta.key = randomBytes(9).toString('base64url');
      meta.check = {state: 'running'};
      writeJson(join(d, 'meta.json'), meta);
      // The speech check runs on in the background; the page asks for it.
      transcribe(join(d, 'take.mp4'), x.lang === 'en' ? 'en' : 'ru').then((heard) => {
        const m = readJson(join(d, 'meta.json'), {});
        m.check = heard == null ? {state: 'none'} : {state: 'done', missing: missingWords(x.edit?.text || x.text, heard)};
        writeJson(join(d, 'meta.json'), m);
      }).catch(() => {});
      return json(200, {url: `/app/take/${encodeURIComponent(x.id)}/${meta.key}.mp4`, size: statSync(join(d, 'take.mp4')).size});
    }
    if (req.method === 'GET' && url.pathname === '/api/app/check') {
      const x = task(url.searchParams.get('id'));
      if (!x) return json(400, {});
      return json(200, readJson(join(takeDir(x.id), 'meta.json'), {}).check || {state: 'none'});
    }
    if (req.method === 'POST' && url.pathname === '/api/app/send') {
      const x = task(b.id);
      const src = x && join(takeDir(x.id), 'take.mp4');
      if (!src || !existsSync(src)) return json(400, {error: 'Сначала нужна запись'});
      const dir = join(PROJECTS, p, 'inbox', new Date().toISOString().slice(0, 10));
      mkdirSync(dir, {recursive: true});
      const file = join(dir, `host-${Date.now()}-${x.id}.mp4`);
      copyFileSync(src, file);
      appendFileSync(join(PROJECTS, p, 'inbox', 'history.md'), `- ${new Date().toISOString()} (mini app, ${me.name}, задание «${x.title}») ${file}\n`);
      x.status = 'sent';
      x.sentAt = Date.now();
      x.take = file.slice(PROJECTS.length + 1);
      delete x.note;
      saveTasks(p, t);
      log?.(me.name, `прислал запись «${x.title}»`);
      const miss = readJson(join(takeDir(x.id), 'meta.json'), {}).check?.missing || [];
      notify(`🎬 ${me.name} прислал(а) запись: «${x.title}»${miss.length ? `\n◐ Не прозвучало: ${miss.flatMap((m) => m.words).join(', ')}` : ''}${x.edit?.status === 'pending' ? '\n✏️ Со своим текстом — он ждёт вашего согласования.' : ''}`, statSync(file).size < 48 * 1024 * 1024 ? file : null);
      return json(200, {task: x});
    }
    if (req.method === 'POST' && url.pathname === '/api/app/profile') {
      const all = profiles(p);
      const cur = all[me.key] || {};
      for (const k of ['langs', 'when', 'where', 'size']) if (typeof b[k] === 'string') cur[k] = b[k].slice(0, 120);
      if ([0.5, 0.75, 1, 1.25, 1.5].includes(b.speed)) cur.speed = b.speed;
      if (b.consent === false && cur.consent !== false) {
        cur.consent = false;
        notify(`⚠️ ${me.name} отозвал(а) разрешение на лицо в кадре. Новые ролики с ним/ней не собираем.`);
      }
      if (b.consent === true) cur.consent = true;
      all[me.key] = cur;
      writeJson(join(hostDir(p), 'profiles.json'), all);
      return json(200, {profile: cur});
    }
    // «Скинуть» (M1, M5): a photo or video into the project's inbox, as when sent to the bot.
    if (req.method === 'POST' && url.pathname === '/api/app/drop') {
      const name = basename(String(url.searchParams.get('name') || 'file')).replace(/[^\w.\-а-яё ]/gi, '_').replace(/^\.+/, '') || 'file';
      if (!MEDIA.test(name) && !/\.(heic|heif)$/i.test(name)) return json(400, {error: 'Нужны фото или видео'});
      const dir = join(PROJECTS, p, 'inbox', new Date().toISOString().slice(0, 10));
      mkdirSync(dir, {recursive: true});
      const f = join(dir, `app-${Date.now()}-${name}`);
      let size = 0;
      const out = [];
      for await (const c of req) { size += c.length; if (size > MAX_TAKE) return json(413, {error: 'Файл больше 300 МБ'}); out.push(c); }
      writeFileSync(f, Buffer.concat(out));
      appendFileSync(join(PROJECTS, p, 'inbox', 'history.md'), `- ${new Date().toISOString()} (mini app, ${me.name}, «Скинуть») ${f}\n`);
      log?.(me.name, `скинул материал: ${name}`);
      return json(200, {file: basename(f)});
    }
    // ---------- Т2: a new reel by the rubric's template (SR2, SR3; TEMPLATES.md) ----------
    const catalog = () => readJson(join(BOT, 'template', 'src', 'templates', 'catalog.json'), {kinds: {}, templates: []});
    if (req.method === 'GET' && url.pathname === '/api/app/rubrics') {
      if (!me.studio) return json(403, {});
      const cat = catalog();
      const rubs = readJson(join(PROJECTS, p, 'strategy.json'), {}).rubrics || [];
      return json(200, {rubrics: rubs.map((x) => ({id: x.id, name: x.name, color: x.color, about: x.about, template: x.template || null})), templates: cat.templates, kinds: cat.kinds});
    }
    if (req.method === 'POST' && url.pathname === '/api/app/new') {
      if (!me.studio) return json(403, {});
      const cat = catalog();
      const st = readJson(join(PROJECTS, p, 'strategy.json'), {});
      const rub = (st.rubrics || []).find((x) => x.id === b.rubric) || null;
      const tpl = cat.templates.find((x) => x.id === (b.template || rub?.template));
      if (!tpl) return json(400, {error: 'Выберите шаблон'});
      const title = String(b.title || '').trim().slice(0, 120) || `${tpl.name}${rub ? ' · ' + rub.name : ''}`;
      let dir;
      try {
        dir = execFileSync(process.execPath, [join(BOT, 'scripts', 'new-reel.mjs'), slugOf(title)], {cwd: BOT, env: {...process.env, REELS_STUDIO: join(PROJECTS, p)}, encoding: 'utf8', timeout: 60_000}).trim().split('\n').pop();
      } catch (e) { return json(500, {error: 'Не получилось создать выпуск'}); }
      const rid = basename(dir);
      writeFileSync(join(dir, 'README.md'), `# ${rid.slice(0, 2)} «${title}»\n\nStatus: in work\nRubric: ${rub ? rub.name : '—'}\nTemplate: ${tpl.name} (${tpl.id}), TEMPLATES.md\nStarted: mini app, ${me.name}, ${new Date().toISOString().slice(0, 10)}\n${b.about ? `\n## Idea\n\n${String(b.about).slice(0, 1000)}\n` : ''}`);
      writeJson(join(dir, 'project', 'src', 'reel.json'), {template: tpl.id, scenes: []});
      if (rub) {
        const plan = readJson(join(PROJECTS, p, 'plan.json'), {});
        plan.rubric = {...plan.rubric, [`reel:${rid}`]: rub.id};
        writeJson(join(PROJECTS, p, 'plan.json'), plan);
      }
      log?.(me.name, `начал ролик «${title}» по шаблону «${tpl.name}» в мини-приложении`);
      return json(200, {id: rid});
    }
    // ---------- «Студия»: the reel editor (SE1–SE5) — comments at every stage → «Собрать vN» ----------
    if (url.pathname.startsWith('/api/app/reel')) {
      if (!me.studio) return json(403, {error: 'Студия открыта редакторам и тем, у кого отметка «Сам собирает»'});
      const rid = url.searchParams.get('id') || b.reel;
      const dir = reelDir(p, rid);
      if (!dir) return json(404, {error: 'Нет такого выпуска'});
      const vdirs = existsSync(join(dir, 'versions')) ? readdirSync(join(dir, 'versions')).filter((v) => /^v\d+$/.test(v)).sort((a, z) => Number(a.slice(1)) - Number(z.slice(1))) : [];
      const cur = vdirs.at(-1) || null;
      const nextV = cur ? `v${Number(cur.slice(1)) + 1}` : 'v1';
      const scenes = readJson(join(dir, 'scenes.json'), []);
      const signed = (rel) => `/app/v?f=${encodeURIComponent(rel)}&k=${sign(rel)}`;
      const pub = join(dir, 'project', 'public');
      // The template's layout (reel.json): each scene with its material and what is still missing.
      const layout = () => {
        const d = readJson(join(dir, 'project', 'src', 'reel.json'), null);
        if (!d?.template) return null;
        const cat = catalog();
        const tpl = cat.templates.find((x) => x.id === d.template);
        const thumb = (m) => m?.file && existsSync(join(pub, m.file)) ? signed(relative(PROJECTS, join(pub, m.file))) : null;
        return {template: d.template, name: tpl?.name || d.template, scenes: (d.scenes || []).map((x) => ({kind: x.kind, label: cat.kinds[x.kind]?.label || x.kind, text: x.text || x.a?.label || '', amount: x.amount,
          media: thumb(x.media) || thumb(x.a?.media), video: MEDIA.test(x.media?.file || '') && /\.(mp4|mov|webm|m4v)$/i.test(x.media.file), need: x.media || x.a || ['total', 'cta'].includes(x.kind) ? null : x.need || cat.kinds[x.kind]?.need || null,
          lock: ['total', 'cta'].includes(x.kind), skip: !!x.skip, dur: x.dur ?? null}))};
      };
      const sources = () => existsSync(join(dir, 'sources')) ? readdirSync(join(dir, 'sources')).filter((f) => MEDIA.test(f) && !f.startsWith('voice-')) : [];
      if (req.method === 'GET' && url.pathname === '/api/app/reel') {
        // The smallest video of the current version: the draft plays faster on a phone.
        const vids = cur ? readdirSync(join(dir, 'versions', cur)).filter((f) => /\.mp4$/i.test(f)).map((f) => ({f, size: statSync(join(dir, 'versions', cur, f)).size})).sort((a, z) => a.size - z.size) : [];
        const rel = vids[0] && relative(PROJECTS, join(dir, 'versions', cur, vids[0].f));
        return json(200, {reel: reels(p).find((x) => x.id === rid), version: cur, nextV, video: rel ? `/app/v?f=${encodeURIComponent(rel)}&k=${sign(rel)}` : null,
          scenes: Array.isArray(scenes) ? scenes : [], edits: readEdits(dir), busy: !!busy(), working: busy()?.key === rid, layout: layout(),
          // Every version for «v1 ↔ v2» and the downloads: the review copy and, once accepted, the 1080p master.
          versions: vdirs.map((v) => {
            const vd = join(dir, 'versions', v);
            const mp4 = readdirSync(vd).filter((f) => /\.mp4$/i.test(f)).map((f) => ({f, size: statSync(join(vd, f)).size})).sort((a, z) => a.size - z.size);
            const url = (f) => f && signed(relative(PROJECTS, join(vd, f)));
            const master = mp4.find((x) => /1080p|master/i.test(x.f));
            return {v, video: url(mp4[0]?.f), download: mp4.length ? url(mp4.at(-1).f) + '&dl=1' : null, master: master ? url(master.f) + '&dl=1' : null, size: mp4.at(-1)?.size || 0};
          })});
      }
      if (req.method === 'POST' && url.pathname === '/api/app/reel/edits') {
        if (b.action === 'send') return json(400, {});
        const list = changeEdits(dir, b, me.name);
        return list ? json(200, {edits: list}) : json(400, {});
      }
      // A spoken comment: kept with the reel's materials and written out by the local Whisper.
      if (req.method === 'POST' && url.pathname === '/api/app/reel/voice') {
        const chunks = [];
        let size = 0;
        for await (const c of req) { size += c.length; if (size > 20 * 1024 * 1024) return json(413, {}); chunks.push(c); }
        mkdirSync(join(dir, 'sources'), {recursive: true});
        const f = join(dir, 'sources', `voice-${Date.now()}.${/mp4|aac/.test(req.headers['content-type'] || '') ? 'm4a' : 'webm'}`);
        writeFileSync(f, Buffer.concat(chunks));
        return json(200, {text: (await transcribe(f, 'ru').catch(() => null)) || ''});
      }
      // ---------- Т3: the reel's chat in the mini app (SR4) — the same chat as on the web page ----------
      if (req.method === 'GET' && url.pathname === '/api/app/reel/chat') {
        const fileUrl = (u) => {
          const abs = /^\/media\?p=(.+)$/.exec(u || '')?.[1];
          const rel = abs && relative(PROJECTS, decodeURIComponent(abs));
          return rel && !rel.startsWith('..') && /^[\w-]+\/reels\/[\w-]+\/(versions\/v\d+|project\/public|sources)\/[^/]+\.(mp4|mov|webm|jpe?g|png|webp)$/i.test(rel) ? signed(rel) : null;
        };
        const working = busy()?.key === rid;
        const msgs = chat.history(p, rid).slice(-60).map((m) => ({from: m.from, kind: m.kind, text: m.text || m.caption || '', by: m.by, at: m.at,
          ...(m.kind === 'file' ? {url: fileUrl(m.url), name: m.name, ext: m.ext} : {})}));
        return json(200, {messages: msgs, working, status: working ? chat.meta(p, rid).status || '' : '', busy: !!busy()});
      }
      // «Правка словами»: a message to the reel's chat; Claude answers there and on the web page.
      if (req.method === 'POST' && url.pathname === '/api/app/reel/say') {
        const text = String(b.text || '').trim().slice(0, 2000);
        if (!text) return json(400, {});
        if (busy()) return json(429, {error: busy().key === rid ? 'Claude ещё работает над этим выпуском — дождитесь ответа.' : 'Claude сейчас занят другим выпуском. Попробуйте через пару минут.'});
        if (!build(p, rid, text, text, me.name)) return json(429, {error: 'Claude сейчас занят.'});
        return json(200, {started: true});
      }
      // «Отправить на согласование»: the current version goes to the owner in the bot chat.
      if (req.method === 'POST' && url.pathname === '/api/app/reel/approve') {
        if (!cur) return json(400, {error: 'Версии ещё нет'});
        const vd = join(dir, 'versions', cur);
        const f = readdirSync(vd).filter((x) => /\.mp4$/i.test(x)).map((x) => join(vd, x)).sort((a, z) => statSync(a).size - statSync(z).size)[0];
        notify(`🟡 ${me.name} просит согласовать ${cur} «${reels(p).find((x) => x.id === rid)?.title || rid}»${b.note ? `\n${String(b.note).slice(0, 300)}` : ''}`, f && statSync(f).size < 48 * 1024 * 1024 ? f : null);
        log?.(me.name, `отправил ${cur} «${rid}» на согласование`);
        return json(200, {sent: true});
      }
      // Material in bulk: each file goes to the reel's sources/ as it is.
      if (req.method === 'POST' && url.pathname === '/api/app/reel/upload') {
        const name = basename(String(url.searchParams.get('name') || 'file')).replace(/[^\w.\-а-яё ]/gi, '_').replace(/^\.+/, '') || 'file';
        if (!MEDIA.test(name) && !/\.(heic|heif)$/i.test(name)) return json(400, {error: 'Нужны фото или видео'});
        mkdirSync(join(dir, 'sources'), {recursive: true});
        let f = join(dir, 'sources', name);
        for (let i = 2; existsSync(f); i++) f = join(dir, 'sources', name.replace(/(\.[^.]*)?$/, `-${i}$1`));
        let size = 0;
        const out = [];
        for await (const c of req) { size += c.length; if (size > MAX_TAKE) return json(413, {error: 'Файл больше 300 МБ'}); out.push(c); }
        writeFileSync(f, Buffer.concat(out));
        return json(200, {file: basename(f), count: sources().length});
      }
      // Claude lays the material out by the template's scenes (reel.json), without rendering yet.
      if (req.method === 'POST' && url.pathname === '/api/app/reel/layout') {
        const d = readJson(join(dir, 'project', 'src', 'reel.json'), null);
        if (!d?.template) return json(400, {error: 'У выпуска нет шаблона'});
        const files = sources();
        if (!files.length) return json(400, {error: 'Сначала добавьте материал'});
        if (busy()) return json(429, {error: 'Claude сейчас занят. Попробуйте через пару минут.'});
        mkdirSync(pub, {recursive: true});
        for (const f of files) if (!existsSync(join(pub, f))) copyFileSync(join(dir, 'sources', f), join(pub, f));
        const tpl = catalog().templates.find((x) => x.id === d.template);
        const text = `Новый ролик по шаблону «${tpl?.name || d.template}» (TEMPLATES.md). Материал уже скопирован в project/public/: ${files.join(', ')}.${b.note ? ` Что сказал человек: ${String(b.note).slice(0, 500)}` : ''}\n` +
          'Посмотри каждый файл, разложи материал по сценам шаблона в project/src/reel.json (тексты плашек и суммы — из идеи в README и того, что видно на материале). Сцене без материала оставь "need": что нужно, без media. ' +
          'НЕ рендери: человек посмотрит раскладку и нажмёт «Собрать v1». Ответь одной-двумя строками: что куда легло и чего не хватает.';
        if (!build(p, rid, text, `Разложить материал по шаблону · файлов: ${files.length}`, me.name)) return json(429, {error: 'Claude сейчас занят.'});
        return json(200, {started: true});
      }
      if (req.method === 'POST' && url.pathname === '/api/app/reel/render') {
        const f = join(dir, 'project', 'src', 'reel.json');
        const d = readJson(f, null);
        if (!d?.template || !d.scenes?.length) return json(400, {error: 'Сначала разложите материал'});
        if (busy()) return json(429, {error: 'Claude сейчас занят. Попробуйте через пару минут.'});
        // «Собрать без сцены N»: scenes still waiting for material are left out of this version.
        if (b.skipMissing) { d.scenes = d.scenes.map((x) => (!x.media && !x.a && !['total', 'cta'].includes(x.kind) ? {...x, skip: true} : x)); writeJson(f, d); }
        if (!build(p, rid, `Собери ${nextV} черновиком по project/src/reel.json (TEMPLATES.md, REELS.md шаги 5–7). Сцены со "skip": true рендер пропустит сам.`, `Собрать ${nextV}${b.skipMissing ? ' без недостающих сцен' : ''}`, me.name)) return json(429, {error: 'Claude сейчас занят.'});
        notify(`🎬 ${me.name} собирает ${nextV} «${reels(p).find((x) => x.id === rid)?.title || rid}» по шаблону из мини-приложения.`);
        return json(200, {started: true});
      }
      if (req.method === 'POST' && url.pathname === '/api/app/reel/build') {
        const open = readEdits(dir).filter((x) => x.state === 'open');
        if (!open.length) return json(400, {error: 'Нет комментариев'});
        if (busy()) return json(429, {error: 'Claude сейчас занят другим выпуском. Попробуйте через пару минут.'});
        if (!build(p, rid, buildRequest(open, scenes, nextV), `Собрать ${nextV} · комментариев: ${open.length}`, me.name)) return json(429, {error: 'Claude сейчас занят. Попробуйте через пару минут.'});
        changeEdits(dir, {action: 'send', forV: nextV}, me.name);
        notify(`🛠 ${me.name} собирает ${nextV} «${reels(p).find((x) => x.id === rid)?.title || rid}» из мини-приложения: комментариев ${open.length}.`);
        return json(200, {edits: readEdits(dir), nextV});
      }
      return json(404, {});
    }
    return json(404, {});
  };
}
