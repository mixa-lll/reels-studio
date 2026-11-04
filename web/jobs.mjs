// Задачи Claude (handbook/LEAN.md, кусок 16): one list of Claude's long work, wherever it was
// started — the web page, the Plan, the mini app on a phone or the Telegram bot. The server is the
// source of truth: its own `claude -p` turns (each with its folder web/data/turns/<id>), the turns
// waiting in its queue, the render jobs of scripts/render.mjs (in those folders and in the bot's
// data/renders) and the bot's data/state.json + status.txt, which are only read here.
// Finished tasks stay green a minute, then go to «Недавние»; a turn that ended on a question waits
// (yellow) until someone writes in that chat again; a turn a server restart cut off is «прервано»
// until someone restarts or dismisses it. The state lives in web/data/jobs.json.
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export const KINDS = {
  build: 'Сборка выпуска', render: 'Рендер', plan: 'Расписать идеи', material: 'Разобрать материал',
  memory: 'Первая память', facts: 'Обновить факты', design: 'Дизайн-система', bot: 'Работа в боте',
};
// How long a kind usually takes, in minutes, until the studio has its own history.
const USUAL = {build: 6, render: 4, plan: 3, material: 3, memory: 5, facts: 3, design: 6, bot: 5};
const SOURCES = ['web', 'bot', 'phone', 'plan'];
const DONE_SHOWN = 60_000;

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const clean = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function makeJobs({BOT, DATA}) {
  const FILE = join(DATA, 'jobs.json');
  const BOT_DATA = join(BOT, 'data');
  const state = readJson(FILE, {});
  state.recent ||= []; state.asks ||= {}; state.took ||= {}; state.live ||= {};
  const save = () => { try { writeFileSync(FILE, JSON.stringify(state, null, 2)); } catch {} };
  const remember = (rec) => { state.recent = [rec, ...state.recent.filter((x) => x.id !== rec.id)].slice(0, 40); };
  let botSeen = null;

  // The server started again: turns that were running or queued did not finish. Their processes
  // (own process groups) are stopped, and each task waits as «прервано, перезапустить?».
  for (const [id, x] of Object.entries(state.live)) {
    if (x.pid && alive(x.pid)) try { process.kill(-x.pid, 'SIGTERM'); } catch {}
    if (x.task) remember({...x.task, id, text: x.text, finishedAt: Date.now(), state: 'interrupted', open: true, note: x.queued ? 'ждала в очереди, сервер перезапускался' : 'сервер перезапускался'});
  }
  state.live = {};
  save();

  const taskOf = (item) => (item.meta?.kind ? {id: item.id, p: item.p, key: item.key, kind: item.meta.kind, title: clean(item.meta.title || KINDS[item.meta.kind], 90),
    source: SOURCES.includes(item.meta.source) ? item.meta.source : 'web', ref: item.meta.ref || null, startedAt: Date.now()} : null);
  // A turn starts (t is the running turn, item what was asked). Short chat answers are not tasks.
  function begin(t, item) {
    t.task = taskOf(item);
    state.live[item.id] = {task: t.task, text: String(item.text || '').slice(0, 20000), pid: t.child.pid};
    if (state.asks[`${item.p}:${item.key}`]) delete state.asks[`${item.p}:${item.key}`];
    save();
  }
  function queued(item) {
    const task = taskOf(item);
    item.task = task;
    state.live[item.id] = {task, text: String(item.text || '').slice(0, 20000), queued: true};
    save();
  }
  // Taken out of the queue before it started.
  function dropped(item, note) {
    delete state.live[item.id];
    if (item.task) remember({...item.task, finishedAt: Date.now(), took: 0, state: 'error', note});
    save();
  }
  // The turn ended: done, a question back, or an error with its reason.
  function end(t, {ok, reply = '', keys = [], error = ''}) {
    delete state.live[t.id];
    const task = t.task;
    if (!task) return save();
    if (t.stopped) ok = false;
    const took = Date.now() - task.startedAt;
    if (ok) state.took[task.kind] = Math.round(((state.took[task.kind] || USUAL[task.kind] * 60e3) * 2 + took) / 3);
    const text = clean(reply, 400);
    const asks = ok && (keys.length > 0 || /\?\s*$/.test(text));
    const rec = {...task, finishedAt: Date.now(), took, state: !ok ? 'error' : asks ? 'ask' : 'done', note: !ok ? (t.stopped ? 'остановлено вручную' : clean(error, 300)) : asks ? text : clean(reply.split('\n').find((l) => l.trim()) || '', 140)};
    if (asks) state.asks[`${task.p}:${task.key}`] = rec;
    remember(rec);
    save();
  }
  // «Прервано»: restart takes the saved request back; dismiss just closes it.
  const openOne = (id, p) => state.recent.find((x) => x.id === id && x.p === p && x.state === 'interrupted' && x.open);
  function revive(id, p) { const x = openOne(id, p); if (!x) return null; x.open = false; x.note = 'перезапущено'; save(); return {...x}; }
  function dismiss(id, p) { const x = openOne(id, p); if (!x) return false; x.open = false; save(); return true; }

  const usual = (kind) => state.took[kind] || (USUAL[kind] || 5) * 60e3;
  const left = (ms) => (ms < 60e3 ? '<1 мин' : `~${Math.round(ms / 60e3)} мин`);
  // «Сборка · 62 % · осталось ~3 мин» from scripts/render.mjs, else an estimate from the usual time.
  function progress(kind, startedAt, status, render) {
    const m = /(\d{1,3})\s*%(?:.*?осталось\s*([^·]+))?/.exec(status || '');
    if (render) return {pct: render.pct || 0, left: render.left || '', exact: true};
    if (m) return {pct: Math.min(100, Number(m[1])), left: (m[2] || '').trim(), exact: true};
    const el = Date.now() - startedAt, u = usual(kind);
    return {pct: Math.min(95, Math.round((el / u) * 100)), left: el < u ? left(u - el) : 'ещё немного', exact: false};
  }
  // Running (or queued for a render slot) render jobs in one data folder.
  const rendersIn = (dir, who = 'web') => {
    const d = join(dir, 'renders');
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => ({...readJson(join(d, f), {}), who, dir}))
      .filter((r) => (r.status === 'running' || r.status === 'queued') && r.pid && alive(r.pid));
  };
  const turnsRoot = join(DATA, 'turns');
  const allRenders = () => [
    ...(existsSync(turnsRoot) ? readdirSync(turnsRoot).flatMap((id) => rendersIn(join(turnsRoot, id)).map((r) => ({...r, turn: id}))) : []),
    ...rendersIn(BOT_DATA, 'bot'),
  ];
  const reelOf = (out) => /\/reels\/([^/]+)\//.exec(out || '')?.[1] || null;
  const projectOf = (out) => /\/projects\/([^/]+)\//.exec(out || '')?.[1] || null;
  const renderNow = (r) => (r.status === 'queued' ? 'ждёт очереди на рендер' : `рендер · ${r.pct || 0} %`);

  // Everything running or waiting for project p, then the recent ones.
  function list(p, {turns, queue, turnDir, titleOf}) {
    const active = [];
    const renders = allRenders();
    const inTurn = new Set(turns.map((t) => t.id));
    for (const t of turns) {
      if (!t.task || t.task.p !== p) continue;
      const r = renders.filter((x) => x.turn === t.id).at(-1);
      const status = read(join(turnDir(t.id), 'status.txt')).trim();
      active.push({...t.task, state: 'run', now: clean(r?.status === 'queued' ? renderNow(r) : status, 120) || 'думает', ...progress(t.task.kind, t.task.startedAt, status, r?.status === 'running' ? r : null), canStop: true});
    }
    queue.forEach((q, i) => { if (q.task && q.p === p) active.push({...q.task, state: 'queue', now: `в очереди · ${i + 1}`, pct: 0, left: '', canStop: true}); });
    // The bot's turn: state.json says whom it works for; its status line says what it does.
    const bot = readJson(join(BOT_DATA, 'state.json'), {});
    if (bot.pending && (bot.project || 'main') === p) {
      const first = String(bot.pending).split('\n').map((l) => l.trim()).filter((l) => l && !/^\(from /.test(l));
      const key = clean(first.join(' '), 400);
      if (!botSeen || botSeen.key !== key) botSeen = {key, at: Date.now()};
      const r = renders.filter((x) => x.who === 'bot').at(-1), st = read(join(BOT_DATA, 'status.txt')).trim();
      const ref = (r && reelOf(r.out)) || null, kind = ref || r ? 'build' : 'bot';
      active.push({id: 'bot', p, kind, source: 'bot', title: clean((ref && titleOf(ref)) || first.find((l) => !/^https?:/.test(l)) || 'Задача в боте', 90),
        who: bot.holder || bot.ownerName || '', state: 'run', now: clean(r?.status === 'queued' ? renderNow(r) : st, 120) || 'думает', ref: ref ? {kind: 'reel', id: ref} : null, startedAt: botSeen.at,
        ...progress(kind, botSeen.at, st, r?.status === 'running' ? r : null), canStop: false});
    } else botSeen = null;
    // A render whose turn has ended (it runs in the background) is a task of its own.
    for (const r of renders) {
      if ((r.turn && inTurn.has(r.turn)) || (r.who === 'bot' && bot.pending)) continue;
      if ((projectOf(r.out) || p) !== p) continue;
      const ref = reelOf(r.out);
      active.push({id: 'r-' + r.id, p, kind: 'render', source: r.who, title: clean((ref && titleOf(ref)) || 'Рендер', 90), state: r.status === 'queued' ? 'queue' : 'run', now: renderNow(r),
        ref: ref ? {kind: 'reel', id: ref} : null, startedAt: r.startedAt, pct: r.pct || 0, left: r.left || '', exact: true, canStop: true});
    }
    const now = Date.now();
    const mine = state.recent.filter((x) => x.p === p).map(({text, ...x}) => x);
    for (const x of mine) {
      if (x.state === 'interrupted' && x.open) active.push({...x, canStop: false});
      else if (x.state === 'ask' && state.asks[`${p}:${x.key}`]?.id === x.id) active.push({...x, canStop: false});
      else if (x.state !== 'interrupted' && now - x.finishedAt < DONE_SHOWN) active.push({...x, fresh: true, canStop: false});
    }
    const shown = new Set(active.map((x) => x.id));
    return {active, recent: mine.filter((x) => !shown.has(x.id)).slice(0, 12)};
  }
  // A render to stop: its own job file says which data folder it belongs to.
  const renderJob = (id) => allRenders().find((r) => r.id === id) || null;
  return {begin, queued, dropped, end, revive, dismiss, list, renderJob, rendersIn};
}
