// Задачи Claude (handbook/LEAN.md, кусок 16): one list of Claude's long work, wherever it was
// started — the web page, the Plan, the mini app on a phone or the Telegram bot. The server is the
// source of truth: its own `claude -p` turn, the render jobs of scripts/render.mjs (web/data/renders
// and the bot's data/renders) and the bot's data/state.json + status.txt, which are only read here.
// Finished tasks stay green a minute, then go to «Недавние»; a turn that ended on a question waits
// (yellow) until someone writes in that chat again.
import {existsSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
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
  state.recent ||= []; state.asks ||= {}; state.took ||= {};
  const save = () => { try { writeFileSync(FILE, JSON.stringify(state, null, 2)); } catch {} };
  let botSeen = null;

  // A turn's meta: what kind of task it is. Short chat answers are not tasks (kind null).
  function begin(job, {p, key, kind, title, source, ref}) {
    job.task = kind ? {id: 'w' + Date.now().toString(36), p, key, kind, title: clean(title || KINDS[kind], 90), source: SOURCES.includes(source) ? source : 'web', ref: ref || null, startedAt: Date.now()} : null;
    if (state.asks[`${p}:${key}`]) { delete state.asks[`${p}:${key}`]; save(); }
  }
  // The turn ended: done, a question back, or an error with its reason.
  function end(job, {ok, reply = '', keys = [], error = ''}) {
    const t = job.task;
    if (!t) return;
    if (job.stopped) ok = false;
    const took = Date.now() - t.startedAt;
    if (ok) state.took[t.kind] = Math.round(((state.took[t.kind] || USUAL[t.kind] * 60e3) * 2 + took) / 3);
    const text = clean(reply, 400);
    const asks = ok && (keys.length > 0 || /\?\s*$/.test(text));
    const rec = {...t, finishedAt: Date.now(), took, state: !ok ? 'error' : asks ? 'ask' : 'done', note: !ok ? (job.stopped ? 'остановлено вручную' : clean(error, 300)) : asks ? text : clean(reply.split('\n').find((l) => l.trim()) || '', 140)};
    if (asks) state.asks[`${t.p}:${t.key}`] = rec;
    state.recent = [rec, ...state.recent.filter((x) => x.id !== rec.id)].slice(0, 40);
    save();
  }
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
  const renders = (dir, who) => {
    const d = join(dir, 'renders');
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => ({...readJson(join(d, f), {}), who, dir}))
      .filter((r) => r.status === 'running' && r.pid && alive(r.pid));
  };
  const reelOf = (out) => /\/reels\/([^/]+)\//.exec(out || '')?.[1] || null;
  const projectOf = (out) => /\/projects\/([^/]+)\//.exec(out || '')?.[1] || null;

  // Everything running for project p, then the recent ones.
  function list(p, {job, status, titleOf}) {
    const active = [];
    const webRenders = renders(DATA, 'web'), botRenders = renders(BOT_DATA, 'bot');
    const t = job?.task;
    if (t && t.p === p) {
      const r = webRenders.at(-1);
      const pr = progress(t.kind, t.startedAt, status, r);
      active.push({...t, state: 'run', now: clean(status, 120) || 'думает', ...pr, canStop: true});
    }
    // The bot's turn: state.json says whom it works for; its status line says what it does.
    const bot = readJson(join(BOT_DATA, 'state.json'), {});
    if (bot.pending && (bot.project || 'main') === p) {
      const first = String(bot.pending).split('\n').map((l) => l.trim()).filter((l) => l && !/^\(from /.test(l));
      const key = clean(first.join(' '), 400);
      if (!botSeen || botSeen.key !== key) botSeen = {key, at: Date.now()};
      const r = botRenders.at(-1), st = read(join(BOT_DATA, 'status.txt')).trim();
      const ref = (r && reelOf(r.out)) || null;
      active.push({id: 'bot', p, kind: ref || r ? 'build' : 'bot', source: 'bot', title: clean((ref && titleOf(ref)) || first.find((l) => !/^https?:/.test(l)) || 'Задача в боте', 90),
        who: bot.holder || bot.ownerName || '', state: 'run', now: clean(st, 120) || 'думает', ref: ref ? {kind: 'reel', id: ref} : null, startedAt: botSeen.at,
        ...progress(ref || r ? 'build' : 'bot', botSeen.at, st, r), canStop: false});
    } else botSeen = null;
    // A render whose turn has ended (it runs in the background) is a task of its own.
    for (const r of [...webRenders, ...botRenders]) {
      if ((r.who === 'web' && t) || (r.who === 'bot' && bot.pending)) continue;
      if ((projectOf(r.out) || p) !== p) continue;
      const ref = reelOf(r.out);
      active.push({id: 'r-' + r.id, p, kind: 'render', source: r.who, title: clean((ref && titleOf(ref)) || 'Рендер', 90), state: 'run', now: `рендер · ${r.pct || 0} %`,
        ref: ref ? {kind: 'reel', id: ref} : null, startedAt: r.startedAt, pct: r.pct || 0, left: r.left || '', exact: true, canStop: true, render: {id: r.id, who: r.who}});
    }
    const mine = state.recent.filter((x) => x.p === p);
    const now = Date.now();
    for (const x of mine) {
      if (x.state === 'ask' && state.asks[`${p}:${x.key}`]?.id === x.id) active.push({...x, canStop: false});
      else if (now - x.finishedAt < DONE_SHOWN) active.push({...x, fresh: true, canStop: false});
    }
    const shown = new Set(active.map((x) => x.id));
    return {active, recent: mine.filter((x) => !shown.has(x.id)).slice(0, 12)};
  }
  // A render to stop: its own job file says which data folder it belongs to.
  const renderJob = (id) => [...renders(DATA, 'web'), ...renders(BOT_DATA, 'bot')].find((r) => r.id === id) || null;
  return {begin, end, list, renderJob};
}
