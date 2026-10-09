// Plan limits and what reels cost, told only when it matters: a quiet note at 80%
// of a window, a loud one at 95%, one line after a reel is accepted, and /usage.
// Claude reports its windows in the stream (rate_limit_event); Codex writes them into
// its session file. Each finished turn is logged to data/usage.jsonl and attributed to
// the reel whose folder the agent touched during it.
import {appendFileSync, existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DATA, STUDIO} from './config.mjs';

const LOG = join(DATA, 'usage.jsonl');

// ---------- Codex: windows from its session file ----------

function findCodexSession(id, dir = join(homedir(), '.codex', 'sessions'), depth = 0) {
  if (!id || !existsSync(dir) || depth > 4) return null;
  // Newest first: today's folder is where the session usually is.
  for (const name of readdirSync(dir).sort().reverse()) {
    const full = join(dir, name);
    if (name.endsWith('.jsonl') && name.includes(id)) return full;
    if (statSync(full).isDirectory()) {
      const found = findCodexSession(id, full, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Latest plan windows Codex recorded for a session, or null. */
export function codexLimits(sessionId) {
  const file = findCodexSession(sessionId);
  if (!file) return null;
  const lines = readFileSync(file, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const rl = JSON.parse(line).payload?.rate_limits;
      if (!rl) continue;
      const out = {};
      for (const w of [rl.primary, rl.secondary].filter(Boolean)) {
        const key = w.window_minutes <= 300 ? 'fiveHour' : 'week';
        out[key] = {pct: Math.round(w.used_percent), resetsAt: w.resets_at * 1000};
      }
      return out;
    } catch {}
  }
  return null;
}

// ---------- which reel a turn worked on ----------

/** The reel folder the agent changed since `since` (ms), or null. */
export function touchedReel(since) {
  const dir = join(STUDIO, 'reels');
  if (!existsSync(dir)) return null;
  let best = null;
  for (const name of readdirSync(dir).filter((d) => /^\d{2}-/.test(d))) {
    const spots = ['', 'README.md', 'versions', 'project/src', 'sources'].map((p) => join(dir, name, p)).filter(existsSync);
    const t = Math.max(...spots.map((p) => statSync(p).mtimeMs));
    if (t > since && (!best || t > best.t)) best = {name, t};
  }
  return best?.name ?? null;
}

const reelTitle = (name) => {
  const readme = join(STUDIO, 'reels', name, 'README.md');
  return (existsSync(readme) && readFileSync(readme, 'utf8').match(/^#\s+(.+)$/m)?.[1]?.trim()) || name;
};

// ---------- log ----------

const entries = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/**
 * Records a finished turn. `before` is the last known windows, `after` the new ones;
 * the share of the weekly window it used is their difference within the same window.
 */
export function recordTurn({startedAt, reel, before, after, cost, tokens}) {
  const delta = (k) => (before?.[k] && after?.[k] && before[k].resetsAt === after[k].resetsAt ? Math.max(0, after[k].pct - before[k].pct) : null);
  const entry = {at: Date.now(), startedAt, reel, week: delta('week'), fiveHour: delta('fiveHour'), cost, tokens};
  appendFileSync(LOG, JSON.stringify(entry) + '\n');
  return entry;
}

/** {turns, week, cost} spent on one reel so far. */
export function reelSpend(reel) {
  const mine = entries().filter((e) => e.reel === reel);
  return {
    turns: mine.length,
    week: mine.reduce((s, e) => s + (e.week ?? 0), 0),
    cost: mine.reduce((s, e) => s + (e.cost ?? 0), 0),
  };
}

// Average weekly share per reel, over reels other than `except` with at least 2 turns.
function averageWeek(except) {
  const byReel = {};
  for (const e of entries()) if (e.reel && e.reel !== except && e.week !== null) byReel[e.reel] = (byReel[e.reel] ?? 0) + e.week;
  const vals = Object.values(byReel).filter((v) => v > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// ---------- texts ----------

const L = {
  ru: {
    title: '📊 Лимиты агента',
    five: '5 часов',
    week: 'Неделя',
    resets: (t) => `сброс ${t}`,
    perReel: (p, left) => `Рилс в среднем ≈ ${p}% недели${left !== null ? ` · хватит ещё примерно на ${left}` : ''}`,
    last: (t, p) => `Последний: ${t} ≈ ${p}%`,
    none: 'Данных о лимитах пока нет: они появятся после первой задачи агента.',
    noWindows: (cost) => `Окна лимитов этот агент не сообщает. Потрачено по ценам API ≈ $${cost.toFixed(2)} за всё время.`,
    accepted: (t, p, n) => `📊 На ${t} ушло ≈ ${p}% недельного лимита · ${n} ${n === 1 ? 'ход' : n < 5 ? 'хода' : 'ходов'} агента`,
    acceptedCost: (t, c, n) => `📊 На ${t} ушло ≈ $${c.toFixed(2)} по ценам API · ${n} ходов агента`,
    warn: (key, pct, reset, left) => `⚠️ Использовано ${pct}% ${key === 'week' ? 'недельного' : '5-часового'} лимита агента (сброс ${reset}).${left === null ? '' : left > 0 ? ` Рилсов хватит ещё примерно на ${left}.` : ' На новый рилс может не хватить.'}`,
    in: (ms) => {
      const mins = Math.max(1, Math.round(ms / 60_000));
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h >= 24 ? `через ${Math.floor(h / 24)} д ${h % 24} ч` : h ? `через ${h} ч ${m} мин` : `через ${m} мин`;
    },
  },
  en: {
    title: '📊 Agent limits',
    five: '5 hours',
    week: 'Week',
    resets: (t) => `resets ${t}`,
    perReel: (p, left) => `A reel takes ≈ ${p}% of the week${left !== null ? ` · enough for about ${left} more` : ''}`,
    last: (t, p) => `Last: ${t} ≈ ${p}%`,
    none: 'No limit data yet: it appears after the agent\'s first task.',
    noWindows: (cost) => `This agent does not report plan windows. Spent at API prices ≈ $${cost.toFixed(2)} in total.`,
    accepted: (t, p, n) => `📊 ${t} took ≈ ${p}% of the weekly limit · ${n} agent turns`,
    acceptedCost: (t, c, n) => `📊 ${t} took ≈ $${c.toFixed(2)} at API prices · ${n} agent turns`,
    warn: (key, pct, reset, left) => `⚠️ ${pct}% of the agent's ${key === 'week' ? 'weekly' : '5-hour'} limit is used (resets ${reset}).${left === null ? '' : left > 0 ? ` Enough for about ${left} more reels.` : ' A new reel may not fit.'}`,
    in: (ms) => {
      const mins = Math.max(1, Math.round(ms / 60_000));
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : h ? `in ${h}h ${m}m` : `in ${m}m`;
    },
  },
};

const bar = (pct) => '▰'.repeat(Math.round(pct / 10)) + '▱'.repeat(10 - Math.round(pct / 10));
const reelsLeft = (limits, avg) => (avg && limits?.week ? Math.max(0, Math.floor((100 - limits.week.pct) / avg)) : null);

/** The /usage message. */
export function usageText(limits, lang) {
  const t = L[lang];
  if (!limits?.week && !limits?.fiveHour) {
    const cost = entries().reduce((s, e) => s + (e.cost ?? 0), 0);
    return cost ? t.noWindows(cost) : t.none;
  }
  const line = (name, w) => w && `${name.padEnd(8)} ${bar(w.pct)} ${w.pct}% · ${t.resets(t.in(w.resetsAt - Date.now()))}`;
  const avg = averageWeek(null);
  const last = entries().filter((e) => e.reel).at(-1)?.reel;
  const lastSpend = last && reelSpend(last);
  return [
    `**${t.title}**`,
    '```',
    line(t.five, limits.fiveHour),
    line(t.week, limits.week),
    '```',
    avg ? t.perReel(Math.round(avg), reelsLeft(limits, avg)) : null,
    lastSpend?.week ? t.last(reelTitle(last), lastSpend.week) : null,
  ].filter(Boolean).join('\n');
}

/** One line for an accepted reel, or null if nothing was recorded. */
export function acceptedText(reel, lang) {
  const t = L[lang];
  const s = reelSpend(reel);
  if (!s.turns) return null;
  if (s.week) return t.accepted(reelTitle(reel), s.week, s.turns);
  return s.cost ? t.acceptedCost(reelTitle(reel), s.cost, s.turns) : null;
}

/**
 * Warnings for windows that crossed 80% or 95% since last time. `warned` (persisted
 * by the caller) remembers what was sent per window. Returns [{text, loud}].
 */
export function limitWarnings(limits, warned, lang) {
  const t = L[lang];
  const out = [];
  for (const key of ['fiveHour', 'week']) {
    const w = limits?.[key];
    if (!w) continue;
    const id = `${key}:${w.resetsAt}`;
    for (const level of [95, 80]) {
      if (w.pct >= level && (warned[id] ?? 0) < level) {
        warned[id] = level;
        out.push({text: t.warn(key, w.pct, t.in(w.resetsAt - Date.now()), key === 'week' ? reelsLeft(limits, averageWeek(null)) : null), loud: level >= 95});
        break;
      }
    }
  }
  return out;
}
