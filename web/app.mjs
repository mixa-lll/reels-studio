// Telegram mini app «Съёмка» for hosts (ведущие): weekly filming tasks, the text to read
// with a teleprompter, recording in the browser camera and sending the take to the editor.
// The page is web/app.html; it signs every request with Telegram's initData, which is
// checked here against the bot token, so no key or cookie is needed inside Telegram.
//
// Data per project: projects/<p>/host/tasks.json (tasks), host/profiles.json (per person),
// takes go to the project's inbox like anything else sent to the bot. Until the editor
// side exists, a project without tasks.json gets demo tasks (seeded: true).
import {createHmac, randomBytes} from 'node:crypto';
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const MAX_TAKE = 300 * 1024 * 1024;
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f); };
const id = () => randomBytes(9).toString('base64url');

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

// Rewrites until the editor side drives them through Claude: plain rules, marked stub.
const REWRITES = {
  shorter: (t) => t.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '),
  simpler: (t) => t.replace(/,\s*(который|которая|которые)[^,.]*[,.]/g, '.').replace(/\s+/g, ' '),
  warmer: (t) => (/^(Здравствуйте|Привет)/.test(t) ? t : `Здравствуйте! ${t}`),
  other: (t) => { const s = t.split(/(?<=[.!?])\s+/); return s.length > 1 ? [s.at(-1), ...s.slice(0, -1)].join(' ') : t; },
};

export function makeApp({BOT, PROJECTS, PAGE, access, reels, log}) {
  const token = () => process.env.TELEGRAM_BOT_TOKEN;
  const botState = () => readJson(join(BOT, 'data', 'state.json'), {});
  const project = () => (botState().project && existsSync(join(PROJECTS, botState().project)) ? botState().project : 'main');
  const hostDir = (p) => { const d = join(PROJECTS, p, 'host'); mkdirSync(d, {recursive: true}); return d; };

  function person(user) {
    const st = botState();
    if (user.id === st.ownerId) return {key: 'owner', name: st.ownerName || user.first_name, role: 'owner'};
    const x = access().people.find((y) => y.telegram?.id === user.id);
    return x ? {key: x.id, name: x.name, role: x.role} : null;
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
    if (!st.chatId || !token()) return;
    const api = `${process.env.REELS_TELEGRAM_API || 'https://api.telegram.org'}/bot${token()}`;
    try {
      if (file) {
        const form = new FormData();
        form.append('chat_id', String(st.chatId));
        form.append('caption', text);
        form.append('video', new Blob([readFileSync(file)]), file.split('/').pop());
        await fetch(`${api}/sendVideo`, {method: 'POST', body: form, signal: AbortSignal.timeout(120_000)});
      } else {
        await fetch(`${api}/sendMessage`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({chat_id: st.chatId, text}), signal: AbortSignal.timeout(30_000)});
      }
    } catch (e) { console.error('mini app notify:', e.message); }
  }

  return async function app(req, res, url) {
    const json = (code, b) => { res.writeHead(code, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && url.pathname === '/app') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
      return res.end(PAGE());
    }
    const user = verifyInitData(req.headers['x-tg-init'], token());
    if (!user) return json(401, {error: 'Откройте приложение из Телеграм-бота'});
    const me = person(user);
    if (!me) return json(403, {error: 'Вас ещё не добавили в команду. Попросите у редактора приглашение.'});
    const p = project();
    const t = tasks(p);
    const task = (tid) => t.tasks.find((x) => x.id === tid);

    if (req.method === 'GET' && url.pathname === '/api/app/state') {
      const prof = profiles(p)[me.key] || {};
      const mine = reels(p).map((r) => ({id: r.id, title: r.title, status: r.status, version: r.version, updated: r.updated}));
      return json(200, {me: {name: me.name, role: me.role}, project: p, week: t.week, due: t.due, demo: !!t.seeded, tasks: t.tasks, reels: mine,
        profile: {langs: 'русский, английский', when: 'вт и чт после 15:00', where: 'кабинет 204, у окна', speed: 1, size: 'large', consent: true, ...prof}});
    }
    let b = {};
    if (req.method === 'POST' && url.pathname !== '/api/app/take') {
      let s = '';
      for await (const chunk of req) s += chunk;
      try { b = JSON.parse(s || '{}'); } catch {}
    }
    if (req.method === 'POST' && url.pathname === '/api/app/rewrite') {
      const x = task(b.id);
      const f = REWRITES[b.mode];
      if (!x || !f) return json(400, {});
      return json(200, {text: f(x.edit?.text || x.text), stub: true});
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
      x.take = file.slice(PROJECTS.length + 1);
      delete x.note;
      saveTasks(p, t);
      log?.(me.name, `прислал запись «${x.title}»`);
      notify(`🎬 ${me.name} прислал(а) запись: «${x.title}»${x.edit?.status === 'pending' ? '\n✏️ Со своим текстом — он ждёт вашего согласования.' : ''}`, size < 48 * 1024 * 1024 ? file : null);
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
    return json(404, {});
  };
}
