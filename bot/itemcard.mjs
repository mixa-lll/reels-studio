// The item the chat is working on, «Основа» model (handbook/BOT-LEAN.md, piece 2): the old
// «🎬 Ролики» card (bot/reels.mjs) for any format. One pinned card — title, format, rubric,
// date and the stage strip — with buttons that depend on the stage. Every message to Claude
// carries one line naming the item. state.focusItem[project] keeps its id; the pinned
// message is the same state.focusCard the reel card uses, so only one card is ever pinned.
import {readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {STAGES, changeItem, loadItems, needOf, readSources, syncItems} from '../web/items.mjs';
import {listReels} from './reels.mjs';
import {PROJECTS} from './config.mjs';
import {linkButton, reelLink} from '../web/dllink.mjs';

const STAGE = {idea: 'Идея', material: 'Материал', build: 'Сборка', ready: 'Готово', published: 'Вышло'};
const FORMAT = {reel: 'рилс', post: 'пост', carousel: 'карусель', telegram: 'текст в Телеграм', story: 'история'};
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
const day = (at) => (at ? new Date(at).toLocaleDateString('ru-RU', {weekday: 'short', day: 'numeric', month: 'short'}) : '');

/** «Идея ✓ → Материал ✓ → <b>Сборка</b> → Готово → Вышло». */
export function stageStrip(stage) {
  const k = STAGES.indexOf(stage);
  return STAGES.map((s, i) => (i < k ? `${STAGE[s]} ✓` : i === k ? `<b>${STAGE[s]}</b>` : STAGE[s])).join(' → ');
}

/** The card's text for an item; `need` from needOf(), `reel` from listReels() when it has a folder. */
export function itemCardText(item, {need = [], reel = null, rubric = null} = {}) {
  const meta = [FORMAT[item.format] || item.format, rubric || item.rubric, day(item.at)].filter(Boolean).join(' · ');
  const lines = [`🎬 <b>${esc(item.title)}</b>`, `<i>${esc(meta)}</i>`, '', stageStrip(item.stage)];
  if (item.stage === 'idea' && (item.idea?.hook || item.idea?.about)) {
    lines.push('', esc((item.idea.hook ? `Крючок: ${item.idea.hook}` : item.idea.about).slice(0, 200)));
  }
  if (need.length && (item.stage === 'idea' || item.stage === 'material')) {
    const have = need.filter((n) => n.done || n.have).length;
    lines.push('', `Что снять · ${have} из ${need.length}`);
    for (const n of need.slice(0, 6)) lines.push(`${n.done || n.have ? '☑' : '☐'} ${esc(String(n.text).slice(0, 80))}`);
  }
  if (reel?.versions?.length && item.stage !== 'idea') {
    const cur = reel.versions[0];
    lines.push('', `Версия ${cur.v}${cur.note ? ` — ${esc(cur.note.slice(0, 80))}` : ''}${reel.versions.length > 1 ? ` · всего ${reel.versions.length}` : ''}`);
  }
  lines.push('', '<i>Всё, что пишешь, — про этот выпуск. Другой — «/items».</i>');
  return lines.join('\n');
}

/** Buttons by stage: what is the next step for this item. Callback data `it<x>:<id>`. */
export function itemCardKeys(item, {reel = null, panel = null} = {}) {
  const b = (text, x) => ({text, callback_data: `it${x}:${item.id}`});
  const rows = [];
  const cur = reel?.versions?.[0];
  if (item.stage === 'idea') rows.push([b('📋 Что снять?', 'n')]);
  if (item.stage === 'material') rows.push([b('🛠 Собрать так', 'b'), b('⏳ Подожду', 'w')]);
  if (item.stage === 'build') rows.push([...(cur ? [b(`▶️ Прислать ${cur.v}`, 'p')] : []), b('✅ Готово', 'r')]);
  if (item.stage === 'ready') rows.push([b('📤 Вышло', 'd'), b('↩️ В сборку', 'u')]);
  const link = cur && item.stage !== 'idea' && reelLink(cur.master || cur.copy, {projects: PROJECTS});
  if (link) rows.push([linkButton(link)]);
  rows.push([{text: '🔄 Другой выпуск', callback_data: 'itl'}, {text: '✖ Без выпуска', callback_data: 'itx'}, ...(panel ? [{text: '🌐 В студии', url: panel}] : [])]);
  return {inline_keyboard: rows};
}

/**
 * Same shape as reelsUi(): `studio()` the project folder, `project()` its slug, `send(prompt)`
 * hands a task to Claude, `panel(item)` the web studio's address of an item (or null).
 */
export function itemsUi({tg, studio, project, state, save, send, panel, root}) {
  const focusOf = () => state.focusItem?.[project()] || null;
  const find = (id) => id && loadItems(studio()).items.find((x) => x.id === id);
  const reelOf = (item) => (item?.ref?.kind === 'reel' ? listReels(studio()).find((r) => r.folder === item.ref.id) : null);
  const rubricName = (item) => {
    try { return (JSON.parse(readFileSync(join(studio(), 'strategy.json'), 'utf8')).rubrics || []).find((r) => r.id === item.rubric)?.name || null; } catch { return null; }
  };
  const view = (item) => {
    const reel = reelOf(item);
    return {text: itemCardText(item, {need: needOf(item, readSources(studio())), reel, rubric: rubricName(item)}), keys: itemCardKeys(item, {reel, panel: panel(item)})};
  };
  const html = (chat, text, markup) => tg.call('sendMessage', {chat_id: chat, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}, disable_notification: true, ...(markup ? {reply_markup: markup} : {})});

  /** The list: items in work by date, then the latest published. */
  async function list(chat, edit = null) {
    const all = syncItems(studio()).data.items.filter((x) => !x.missing && !x.proposed);
    if (!all.length) return html(chat, 'Выпусков пока нет. Напиши идею или кинь материал — заведу первый.');
    const open = all.filter((x) => x.stage !== 'published').sort((a, b) => String(a.at || '9').localeCompare(String(b.at || '9')));
    const shown = [...open.slice(0, 8), ...all.filter((x) => x.stage === 'published').slice(-2)];
    const focus = focusOf();
    const rows = shown.map((x) => [{text: `${x.id === focus ? '● ' : ''}${x.title} · ${FORMAT[x.format] || x.format} · ${STAGE[x.stage]}`.slice(0, 64), callback_data: `its:${x.id}`}]);
    const text = `🎬 <b>Выпуски</b>${open.length > 8 ? ` · в работе ${open.length}` : ''}\nВыбери, над каким работаем.`;
    if (edit) return tg.call('editMessageText', {chat_id: chat, message_id: edit, text, parse_mode: 'HTML', reply_markup: {inline_keyboard: rows}}).catch(() => html(chat, text, {inline_keyboard: rows}));
    return html(chat, text, {inline_keyboard: rows});
  }

  async function unpin() {
    const c = state.focusCard;
    if (c) await tg.call('unpinChatMessage', {chat_id: c.chat, message_id: c.id}).catch(() => {});
    delete state.focusCard;
  }

  /** Makes `id` the focus: a fresh pinned card, or the old one edited when `quiet`. */
  async function setFocus(chat, id, {quiet = false} = {}) {
    const item = find(id);
    if (!item) return null;
    state.focusItem = {...state.focusItem, [project()]: id};
    // The reel card follows, so a reply to the reel's video keeps working as before.
    if (item.ref?.kind === 'reel') state.focus = {...state.focus, [project()]: item.ref.id};
    save(state);
    if (quiet && state.focusCard) return refresh();
    await unpin();
    const v = view(item);
    const m = await html(chat, v.text, v.keys).catch(() => null);
    if (m) {
      state.focusCard = {chat, id: m.message_id};
      await tg.call('pinChatMessage', {chat_id: chat, message_id: m.message_id, disable_notification: true}).catch(() => {});
    }
    save(state);
    return item;
  }

  /** Redraws the pinned card after a turn: a new version, a closed item of the list, a stage. */
  async function refresh() {
    syncItems(studio());
    const c = state.focusCard, item = find(focusOf());
    if (!c || !item) return;
    const v = view(item);
    await tg.call('editMessageText', {chat_id: c.chat, message_id: c.id, text: v.text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}, reply_markup: v.keys}).catch(() => {});
  }

  /** The line that tells Claude which item a message is about. */
  function focusLine(item) {
    const where = item.ref?.kind === 'reel' || item.ref?.kind === 'post'
      ? `, folder \`${relative(root, join(studio(), item.ref.kind === 'reel' ? 'reels' : 'posts', item.ref.id))}/\``
      : ' (no folder yet)';
    const cur = reelOf(item)?.versions?.[0];
    return `(Focus: the owner is working on item ${item.id} «${item.title}» in items.json — ${item.format}, stage ${item.stage}${where}${cur ? `, current version ${cur.v}` : ''}. Unless the message clearly names another one, it is about this item.)`;
  }

  /** Adds the focus line; a reply to a reel's video moves the focus to that reel's item first. */
  async function framePrompt(chat, prompt, msg) {
    const quoted = `${msg?.reply_to_message?.caption ?? ''}\n${msg?.reply_to_message?.text ?? ''}`;
    const num = quoted.match(/(?:^|\n|\s)(\d{2,3})\s*(?:«|·)/)?.[1];
    if (num) {
      const reel = listReels(studio()).find((r) => Number(r.num) === Number(num));
      const target = reel && loadItems(studio()).items.find((x) => x.ref?.kind === 'reel' && x.ref.id === reel.folder);
      if (target && target.id !== focusOf()) await setFocus(chat, target.id, {quiet: !!state.focusCard});
    }
    const item = find(focusOf());
    return item ? `${focusLine(item)}\n\n${prompt}` : prompt;
  }

  async function move(chat, item, stage, note) {
    changeItem(studio(), item.id, {stage}, {by: state.ownerName || 'owner'});
    await refresh();
    return note ? html(chat, note) : null;
  }

  async function onButton(q) {
    const chat = q.message.chat.id;
    if (q.data === 'itl') return list(chat, q.message.message_id);
    if (q.data === 'itx') {
      if (state.focusItem) delete state.focusItem[project()];
      if (state.focus) delete state.focus[project()];
      await unpin();
      save(state);
      return html(chat, 'Ок, без выпуска. Выбрать — /items.');
    }
    const [kind, id] = q.data.split(':');
    const item = find(id);
    if (!item) return html(chat, 'Этого выпуска уже нет.');
    if (kind === 'its') return setFocus(chat, id);
    if (id !== focusOf()) await setFocus(chat, id, {quiet: !!state.focusCard});
    const line = focusLine(item);
    if (kind === 'itn') return send(`${line}\n\n(the owner tapped «📋 Что снять?»: write the shot list for this item — 2–5 concrete shots or photos with length — as its \`need\` in items.json ([{"text": "…"}]); for a reel make its folder and scenes.json as REELS.md says instead. Set the item's stage to "material", then send the list in one short message.)`);
    if (kind === 'itb') return send(`${line}\n\n(the owner tapped «🛠 Собрать так»: build this item from the material there is now, as REELS.md / POSTS.md say for its format; say in one line what was missing. Send the result.)`);
    if (kind === 'itw') return html(chat, 'Жду материал — кидай сюда, когда снимешь.');
    if (kind === 'itp') {
      const cur = reelOf(item)?.versions?.[0];
      const file = cur && (cur.copy || cur.master);
      if (!file) return html(chat, 'Видео пока нет.');
      await tg.call('sendChatAction', {chat_id: chat, action: 'upload_video'}).catch(() => {});
      const link = reelLink(file, {projects: PROJECTS});
      return tg.sendFile(chat, file, {caption: `${reelOf(item).num} «${item.title}» · ${cur.v}`, markup: link ? {inline_keyboard: [[linkButton(link)]]} : undefined}).catch((e) => html(chat, `Не получилось отправить: ${esc(e.message)}`));
    }
    if (kind === 'itr') return move(chat, item, 'ready', `✅ «${esc(item.title)}» готов${item.at ? ` — выйдет ${day(item.at)}` : '.'}`);
    if (kind === 'itu') return move(chat, item, 'build', `↩️ «${esc(item.title)}» вернул в сборку — пиши правки.`);
    if (kind === 'itd') return move(chat, item, 'published', `📤 «${esc(item.title)}» отмечен как вышедший.`);
  }

  return {list, setFocus, refresh, framePrompt, onButton, focusOf};
}
