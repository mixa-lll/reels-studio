// Button menus the agent describes once and the bot walks locally, so taps are
// instant and cost no agent turns. Two modes:
//   steps — a setup wizard: one question after another, «do the rest yourself» on every step.
//           Each step is a blocking question, so it is a new message with a reply keyboard:
//           the tap stays in the chat as the owner's answer and nothing is edited away.
//   menu  — a settings menu (an optional action): one message with inline buttons, sections
//           listed with current values, changes applied together.
//
// Menu file (written by the agent, passed to `send.mjs --menu`):
// {
//   "mode": "steps" | "menu",
//   "title": "🎛 «Где это было» · v1",
//   "sections": [{
//     "title": "🎵 Музыка", "prompt": "Какой трек?",
//     "current": "funk",                                  // menu mode: value now in the reel
//     "options": [{"label": "🎵 Фанк, 110 BPM", "value": "funk", "note": "бодрый", "file": "studio/…/funk.mp3"}]
//   }]
// }
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {isAbsolute, join} from 'node:path';
import {DATA, ROOT} from './config.mjs';
import {toHtml} from './format.mjs';
import {forgetKeys, replyKeyboard} from './keys.mjs';

const DIR = join(DATA, 'menus');
const ACTIVE = join(DIR, 'active');
const PENDING = join(DIR, 'pending');
mkdirSync(DIR, {recursive: true});

const L = {
  ru: {
    step: (i, n) => `Шаг ${i}/${n}`,
    custom: '✍️ Или напиши / надиктуй свой вариант',
    auto: '🚀 Дальше сам — делай рилс',
    back: '⬅️ Назад',
    apply: '🚀 Применить и пересобрать',
    close: '✖️ Закрыть',
    tune: '🎛 Настроить подробнее',
    pickWhat: 'Выбери, что поменять. Изменения применятся разом.',
    changes: 'Изменения:',
    closed: 'Настройки закрыты без изменений.',
    chosen: 'Выбрано:',
    rest: 'остальное — на твой вкус',
    making: 'Собираю рилс.',
  },
  en: {
    step: (i, n) => `Step ${i}/${n}`,
    custom: '✍️ Or type / dictate your own',
    auto: '🚀 Do the rest yourself',
    back: '⬅️ Back',
    apply: '🚀 Apply and rebuild',
    close: '✖️ Close',
    tune: '🎛 Fine-tune in detail',
    pickWhat: 'Pick what to change. Changes are applied together.',
    changes: 'Changes:',
    closed: 'Settings closed without changes.',
    chosen: 'Chosen:',
    rest: 'the rest is up to you',
    making: 'Making the reel.',
  },
};
const lang = () => (process.env.BOT_LANG === 'en' ? 'en' : 'ru');
const t = () => L[lang()];

export const tuneLabel = () => t().tune;
export const customHint = () => t().custom;

const file = (id) => join(DIR, `${id}.json`);
export const loadMenu = (id) => (existsSync(file(id)) ? JSON.parse(readFileSync(file(id), 'utf8')) : null);
const saveMenu = (m) => writeFileSync(file(m.id), JSON.stringify(m, null, 2));

/** The menu currently waiting for a typed answer, if any. */
export function activeMenu() {
  const id = existsSync(ACTIVE) ? readFileSync(ACTIVE, 'utf8').trim() : '';
  const m = id && loadMenu(id);
  return m && !m.closed && m.view >= 0 ? m : null;
}
const setActive = (m) => writeFileSync(ACTIVE, m.id);

/** Stores a menu spec from the agent; returns its id. */
export function createMenu(spec) {
  if (!['steps', 'menu'].includes(spec.mode) || !spec.sections?.length) {
    throw new Error('menu needs "mode": "steps" | "menu" and a non-empty "sections" array');
  }
  const id = randomBytes(4).toString('hex');
  saveMenu({...spec, id, view: spec.mode === 'steps' ? 0 : -1, picks: {}, previewed: []});
  return id;
}

/**
 * Holds a menu the agent opened mid-turn until its final reply is out, so the owner reads
 * the status first and the question last, right above the keyboard.
 */
export const deferMenu = (id) => writeFileSync(PENDING, id);

/** Posts the menu held by deferMenu, if any; `drop` discards it (the turn failed). */
export async function postPending(tg, chatId, {drop = false} = {}) {
  const id = existsSync(PENDING) ? readFileSync(PENDING, 'utf8').trim() : '';
  rmSync(PENDING, {force: true});
  const m = id && !drop && loadMenu(id);
  if (m) await post(tg, chatId, m);
  return Boolean(m);
}

const optionValue = (o) => o.value ?? o.label;
const labelOf = (s, value) => s.options?.find((o) => optionValue(o) === value)?.label ?? value;
const cb = (m, action) => ({callback_data: `m:${m.id}:${action}`});

/** Text and keyboard for the menu's current view. */
export function render(m) {
  const tx = t();
  const rows = [];
  let text;
  if (m.view >= 0) {
    const i = m.view;
    const s = m.sections[i];
    const chosen = m.picks[i]?.value ?? s.current;
    const notes = s.options.filter((o) => o.note).map((o) => `• ${o.label} — ${o.note}`);
    const head = m.mode === 'steps' ? `${tx.step(i + 1, m.sections.length)} · ${s.title}` : s.title;
    text = [`**${m.title}**`, '', `**${head}**`, s.prompt, notes.join('\n'), '', tx.custom].filter((x) => x !== undefined).join('\n');
    if (m.mode === 'steps') {
      const labels = [...s.options.map((o) => `${optionValue(o) === chosen ? '✅ ' : ''}${o.label}`), ...(i > 0 ? [tx.back] : []), tx.auto];
      return {text: toHtml(text), parse_mode: 'HTML', reply_markup: replyKeyboard(labels, {placeholder: tx.custom.replace(/^✍️\s*/, '')})};
    }
    s.options.forEach((o, j) => rows.push([{text: `${optionValue(o) === chosen ? '✅ ' : ''}${o.label}`, ...cb(m, `o${i}.${j}`)}]));
    const nav = [];
    if (m.mode === 'menu' || i > 0) nav.push({text: tx.back, ...cb(m, 'back')});
    rows.push(nav);
  } else {
    const changed = Object.keys(m.picks);
    const summary = changed.map((i) => `• ${m.sections[i].title}: ${m.picks[i].label}`);
    text = [`**${m.title}**`, '', tx.pickWhat, ...(summary.length ? ['', tx.changes, ...summary] : [])].join('\n');
    m.sections.forEach((s, i) => {
      const value = m.picks[i] ? m.picks[i].label : labelOf(s, s.current);
      rows.push([{text: `${m.picks[i] ? '• ' : ''}${s.title}${value ? `: ${value}` : ''}`.slice(0, 60), ...cb(m, `s${i}`)}]);
    });
    if (changed.length) rows.push([{text: tx.apply, ...cb(m, 'apply')}]);
    rows.push([{text: tx.close, ...cb(m, 'close')}]);
  }
  return {text: toHtml(text), parse_mode: 'HTML', reply_markup: {inline_keyboard: rows}};
}

const resolve = (p) => (isAbsolute(p) ? p : join(ROOT, p));

/** Posts the menu as a new message, with previews of the current section first. */
export async function post(tg, chatId, m) {
  // A steps question stays in the chat as asked; only an inline menu is replaced.
  if (m.messageId && m.mode === 'menu') await tg.call('deleteMessage', {chat_id: chatId, message_id: m.messageId}).catch(() => {});
  await sendPreviews(tg, chatId, m);
  // A question waits for the owner: it notifies; an inline menu they opened does not.
  const msg = await tg.call('sendMessage', {chat_id: chatId, disable_notification: m.mode === 'menu', ...render(m)});
  m.messageId = msg.message_id;
  saveMenu(m);
  setActive(m);
}

// Option files (tracks, stills) are sent once, the first time their section opens.
async function sendPreviews(tg, chatId, m) {
  if (m.view < 0 || m.previewed.includes(m.view)) return false;
  const s = m.sections[m.view];
  const files = s.options.filter((o) => o.file && existsSync(resolve(o.file)));
  m.previewed.push(m.view);
  for (const o of files) await tg.sendFile(chatId, resolve(o.file), {caption: o.label, silent: true}).catch(() => {});
  return files.length > 0;
}

async function show(tg, chatId, m) {
  if (m.mode === 'steps') return post(tg, chatId, m);
  // New previews would land below the menu: repost it under them instead of editing.
  if (m.view >= 0 && !m.previewed.includes(m.view) && m.sections[m.view].options.some((o) => o.file)) {
    return post(tg, chatId, m);
  }
  saveMenu(m);
  setActive(m);
  await tg.call('editMessageText', {chat_id: chatId, message_id: m.messageId, ...render(m)}).catch(() => {});
}

// Closes the menu: the message keeps a plain summary, the agent gets the result.
async function finish(tg, chatId, m, kind) {
  const tx = t();
  m.closed = true;
  saveMenu(m);
  rmSync(ACTIVE, {force: true});
  const picks = Object.entries(m.picks).map(([i, p]) => ({section: m.sections[i].title, ...p}));
  const lines = picks.map((p) => `• ${p.section}: ${p.label}`);
  const summary = kind === 'close' ? tx.closed : [tx.chosen, ...lines, ...(kind === 'auto' ? [`• ${tx.rest}`] : [])].join('\n');
  if (m.mode === 'steps') {
    // A new message, not an edit: the questions and answers above stay as they were,
    // and this one takes the keyboard away for good.
    forgetKeys();
    await tg.call('sendMessage', {chat_id: chatId, disable_notification: true, text: toHtml(`**${m.title}**\n\n${summary}\n\n${tx.making}`), parse_mode: 'HTML', reply_markup: {remove_keyboard: true}}).catch(() => {});
  } else {
    await tg.call('editMessageText', {chat_id: chatId, message_id: m.messageId, text: toHtml(`**${m.title}**\n\n${summary}`), parse_mode: 'HTML'}).catch(() => {});
  }
  if (kind === 'close') return null;

  const desc = picks.map((p) => `- ${p.section}: ${p.custom ? `owner's own words: "${p.value}"` : `"${p.label}" (value: ${p.value})`}`).join('\n') || '- nothing';
  if (m.mode === 'menu') return `(settings menu "${m.title}" applied; change exactly these and make the next version:\n${desc})`;
  const rest = m.sections.map((s, i) => (m.picks[i] ? null : s.title)).filter(Boolean);
  return `(setup "${m.title}" finished${kind === 'auto' ? ' early: the owner said to decide the rest yourself' : ''}. Chosen:\n${desc}${rest.length ? `\nDecide yourself: ${rest.join(', ')}` : ''}\nNow make the reel.)`;
}

async function pick(tg, chatId, m, i, p) {
  m.picks[i] = p;
  if (m.mode === 'menu') {
    m.view = -1;
    return show(tg, chatId, m);
  }
  if (i + 1 < m.sections.length) {
    m.view = i + 1;
    return show(tg, chatId, m);
  }
  return finish(tg, chatId, m, 'done');
}

/**
 * Handles a tap on `m:<id>:<action>`. Resolves to a prompt for the agent when the
 * menu is finished, otherwise null.
 */
export async function onMenuButton(tg, chatId, data) {
  const [, id, action] = data.split(':');
  const m = loadMenu(id);
  if (!m || (m.closed && action !== 'open')) return null;
  if (action === 'open') {
    // A fresh copy each time, so an older version's menu can be reopened.
    const copy = loadMenu(createMenu({mode: m.mode, title: m.title, sections: m.sections}));
    await post(tg, chatId, copy);
    return null;
  }
  if (action === 'back') {
    m.view = m.mode === 'steps' ? Math.max(0, m.view - 1) : -1;
    return show(tg, chatId, m).then(() => null);
  }
  if (action === 'auto' || action === 'apply' || action === 'close') return finish(tg, chatId, m, action);
  if (action[0] === 's') {
    m.view = Number(action.slice(1));
    return show(tg, chatId, m).then(() => null);
  }
  if (action[0] === 'o') {
    const [i, j] = action.slice(1).split('.').map(Number);
    const o = m.sections[i]?.options[j];
    if (!o) return null;
    return pick(tg, chatId, m, i, {label: o.label, value: optionValue(o)});
  }
  return null;
}

/**
 * A message while a section is open: in steps mode a keyboard tap (option, back, «do the
 * rest yourself»), otherwise the owner's own typed or dictated answer. Returns a prompt or null.
 */
export async function onMenuText(tg, chatId, m, text) {
  if (m.mode === 'steps') {
    const tx = t();
    const label = text.replace(/^✅\s*/, '');
    if (label === tx.auto) return finish(tg, chatId, m, 'auto');
    if (label === tx.back && m.view > 0) {
      m.view -= 1;
      return show(tg, chatId, m).then(() => null);
    }
    const o = m.sections[m.view].options.find((x) => x.label === label);
    if (o) return pick(tg, chatId, m, m.view, {label: o.label, value: optionValue(o)});
  }
  return pick(tg, chatId, m, m.view, {label: `✍️ ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`, value: text, custom: true});
}
