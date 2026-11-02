// «🎬 Ролики»: which reel the chat is working on right now.
//
// The owner picks a reel from the list (or replies to its video, or names it: «ролик 12»).
// It becomes the focus: a card is pinned on top of the chat — number, title, status, versions
// with their masters — with quick actions (send a version, render its master, all versions,
// open it in the web studio). Every message to Claude then carries one line saying which reel
// it is about, so the agent no longer has to guess. state.focus[project] keeps the folder,
// state.focusCard the pinned card ({chat, id}) that is edited in place as the reel changes.
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';

const STATUS = [
  [/^(published|опубликовано|выложен)/i, '📤 выложен'],
  [/^(done|готово)/i, '✅ готово'],
  [/^(in review|review|на проверке)/i, '👀 на проверке'],
  [/^(cancelled|отмена)/i, '✖ отменён'],
  [/./, '🛠 в работе'],
];
const statusOf = (s) => (s ? STATUS.find(([re]) => re.test(s))[1] : '🛠 в работе');
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
const vNum = (v) => Number(v.slice(1));

/** All reels of a project folder, newest activity first. */
export function listReels(studioDir) {
  const dir = join(studioDir, 'reels');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => /^\d{2,3}-/.test(d) && statSync(join(dir, d)).isDirectory()).map((folder) => {
    const rdir = join(dir, folder);
    const readme = existsSync(join(rdir, 'README.md')) ? readFileSync(join(rdir, 'README.md'), 'utf8') : '';
    const head = readme.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? folder;
    const num = folder.match(/^(\d+)/)[1];
    const title = head.replace(/^\d+\s*/, '').replace(/[«»]/g, '').trim() || folder;
    const status = readme.match(/^\**Status:?\**:?\s*(.+)$/im)?.[1]?.trim() ?? '';
    const vdir = join(rdir, 'versions');
    const versions = (existsSync(vdir) ? readdirSync(vdir).filter((v) => /^v\d+$/.test(v)) : []).sort((a, b) => vNum(b) - vNum(a)).map((v) => {
      const files = readdirSync(join(vdir, v)).filter((f) => !/^raw/i.test(f));
      const videos = files.filter((f) => /\.(mp4|mov)$/i.test(f));
      const master = videos.filter((f) => /1440p|1080p|master/i.test(f)).sort((a, b) => statSync(join(vdir, v, b)).size - statSync(join(vdir, v, a)).size)[0];
      const copy = videos.filter((f) => f !== master && !/1440p|1080p|master/i.test(f))[0];
      const note = readme.match(new RegExp(`^-\\s*${v}\\b[^:\\n]*:\\s*(.+)$`, 'm'))?.[1]?.trim();
      return {v, master: master && join(vdir, v, master), copy: copy && join(vdir, v, copy), note};
    });
    return {folder, num, title, status: statusOf(status), done: /^(done|published|cancelled|готово|опубликовано|отмена)/i.test(status), versions, at: statSync(rdir).mtimeMs};
  }).sort((a, b) => b.at - a.at);
}

/**
 * `studio()` the active project folder, `project()` its slug, `send(prompt)` hands a task to
 * Claude, `panel(folder)` the web studio's address of a reel (or null).
 */
export function reelsUi({tg, studio, project, state, save, send, panel, root}) {
  const focusOf = () => state.focus?.[project()] || null;
  const reel = (folder) => folder && listReels(studio()).find((r) => r.folder === folder);
  const byNum = (n) => listReels(studio()).find((r) => Number(r.num) === Number(n));
  const label = (r) => `${r.num} «${r.title}»`;

  function cardText(r) {
    const cur = r.versions[0];
    const lines = [`🎬 <b>Сейчас в работе: ${esc(label(r))}</b>`, `${r.status} · ${r.versions.length ? `версий: ${r.versions.length}` : 'версий пока нет'}`];
    for (const v of r.versions.slice(0, 4)) {
      lines.push(`${v === cur ? '▸' : '·'} <b>${v.v}</b>${v === cur ? ' (текущая)' : ''}${v.note ? ` — ${esc(v.note.slice(0, 90))}` : ''} · мастер ${v.master ? '✓' : '—'}`);
    }
    if (r.versions.length > 4) lines.push(`… и ещё ${r.versions.length - 4}`);
    lines.push('', '<i>Всё, что пишешь, относится к этому ролику. Другой — кнопка «🎬 Ролики» или «вернёмся к ролику 12».</i>');
    return lines.join('\n');
  }

  function cardKeys(r) {
    const cur = r.versions[0];
    const rows = [];
    if (cur) rows.push([
      {text: `▶️ Прислать ${cur.v}`, callback_data: `rp:${r.folder}:${cur.v}`.slice(0, 64)},
      cur.master ? {text: `📦 Мастер ${cur.v} готов`, callback_data: `rp:${r.folder}:${cur.v}:m`.slice(0, 64)} : {text: `🎞 В мастер ${cur.v}`, callback_data: `rm:${r.folder}:${cur.v}`.slice(0, 64)},
    ]);
    rows.push([
      ...(r.versions.length > 1 ? [{text: '🗂 Все версии', callback_data: `rv:${r.folder}`.slice(0, 64)}] : []),
      ...(panel(r.folder) ? [{text: '🌐 В панели', url: panel(r.folder)}] : []),
    ]);
    rows.push([{text: '🔄 Другой ролик', callback_data: 'rl'}, {text: '✖ Без ролика', callback_data: 'rx'}]);
    return {inline_keyboard: rows.filter((x) => x.length)};
  }

  const html = (chat, text, markup) => tg.call('sendMessage', {chat_id: chat, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}, disable_notification: true, ...(markup ? {reply_markup: markup} : {})});

  /** The list: recent reels first; `all` shows every one. */
  async function list(chat, all = false, edit = null) {
    const reels = listReels(studio());
    if (!reels.length) return html(chat, 'Роликов пока нет. Напиши, о чём снимаем, — Claude заведёт первый.');
    const focus = focusOf();
    const shown = all ? reels.slice(0, 40) : [...reels.filter((r) => !r.done).slice(0, 6), ...reels.filter((r) => r.done).slice(0, 2)];
    const rows = shown.map((r) => [{text: `${r.folder === focus ? '● ' : ''}${r.num} · ${r.title}${r.versions[0] ? ` · ${r.versions[0].v}` : ''} · ${r.status.split(' ')[0]}`.slice(0, 64), callback_data: `rs:${r.folder}`.slice(0, 64)}]);
    if (!all && reels.length > shown.length) rows.push([{text: `Все ролики (${reels.length})`, callback_data: 'rla'}]);
    rows.push([{text: '➕ Новый ролик', callback_data: 'rn'}, ...(focus ? [{text: '✖ Без ролика', callback_data: 'rx'}] : [])]);
    const text = `🎬 <b>Ролики</b>${focus ? `\nСейчас: ${esc(label(reel(focus) || {num: '', title: focus}))}` : ''}\nВыбери, над каким работаем.`;
    if (edit) return tg.call('editMessageText', {chat_id: chat, message_id: edit, text, parse_mode: 'HTML', reply_markup: {inline_keyboard: rows}}).catch(() => html(chat, text, {inline_keyboard: rows}));
    return html(chat, text, {inline_keyboard: rows});
  }

  async function unpin() {
    const c = state.focusCard;
    if (c) await tg.call('unpinChatMessage', {chat_id: c.chat, message_id: c.id}).catch(() => {});
    delete state.focusCard;
  }

  /** Makes `folder` the focus; a fresh pinned card unless `quiet` (then the old card is edited). */
  async function setFocus(chat, folder, {quiet = false} = {}) {
    const r = reel(folder);
    if (!r) return null;
    state.focus = {...state.focus, [project()]: folder};
    save(state);
    if (quiet && state.focusCard) return refresh();
    await unpin();
    const m = await html(chat, cardText(r), cardKeys(r)).catch(() => null);
    if (m) {
      state.focusCard = {chat, id: m.message_id};
      await tg.call('pinChatMessage', {chat_id: chat, message_id: m.message_id, disable_notification: true}).catch(() => {});
    }
    save(state);
    return r;
  }

  /** Redraws the pinned card after a turn (new versions, a master, a status). */
  async function refresh() {
    const c = state.focusCard, r = reel(focusOf());
    if (!c || !r) return;
    await tg.call('editMessageText', {chat_id: c.chat, message_id: c.id, text: cardText(r), parse_mode: 'HTML', link_preview_options: {is_disabled: true}, reply_markup: cardKeys(r)}).catch(() => {});
  }

  /**
   * Adds the focus line to a message for Claude. A reply to a reel's video (captions start with
   * «NN «Title»») or a message naming a reel («ролик 12») moves the focus there first.
   */
  async function framePrompt(chat, prompt, msg) {
    const quoted = `${msg?.reply_to_message?.caption ?? ''}\n${msg?.reply_to_message?.text ?? ''}`;
    const fromReply = quoted.match(/(?:^|\n|\s)(\d{2,3})\s*(?:«|·)/)?.[1];
    const named = (msg?.text ?? msg?.caption ?? '').match(/(?:ролик|рилс|reel)\S*\s*(?:№\s*)?(\d{1,3})\b/i)?.[1];
    const target = (fromReply && byNum(fromReply)) || (named && byNum(named));
    if (target && target.folder !== focusOf()) await setFocus(chat, target.folder, {quiet: !!state.focusCard});
    const r = reel(focusOf());
    if (!r) return prompt;
    const cur = r.versions[0];
    return `(Focus: the owner is working on reel \`${relative(root, join(studio(), 'reels', r.folder))}/\` ${label(r)}${cur ? `, current version ${cur.v}` : ''}. Unless the message clearly names another reel, it is about this one.)\n\n${prompt}`;
  }

  async function onButton(q) {
    const chat = q.message.chat.id;
    const d = q.data;
    if (d === 'rl' || d === 'rla') return list(chat, d === 'rla', d === 'rla' ? q.message.message_id : null);
    if (d === 'rx') {
      if (state.focus) delete state.focus[project()];
      await unpin();
      save(state);
      return html(chat, 'Ок, без конкретного ролика. Выбрать — «🎬 Ролики».');
    }
    if (d === 'rn') return send('(the owner tapped «➕ Новый ролик»: ask in one or two lines what the new reel is about — or offer the top ideas from ideas.md as buttons — then create it as REELS.md says.)');
    const [kind, folder, v, m] = d.split(':');
    const r = reel(folder);
    if (!r) return html(chat, 'Этого ролика уже нет.');
    if (kind === 'rs') return setFocus(chat, folder);
    if (kind === 'rv') {
      const rows = r.versions.map((x) => [
        {text: `▶️ ${x.v}${x.note ? ` · ${x.note}` : ''}`.slice(0, 48), callback_data: `rp:${folder}:${x.v}`.slice(0, 64)},
        x.master ? {text: '📦 мастер', callback_data: `rp:${folder}:${x.v}:m`.slice(0, 64)} : {text: '🎞 в мастер', callback_data: `rm:${folder}:${x.v}`.slice(0, 64)},
      ]);
      return html(chat, `🗂 <b>${esc(label(r))}</b> — все версии`, {inline_keyboard: rows});
    }
    const ver = r.versions.find((x) => x.v === v);
    if (!ver) return html(chat, `Версии ${v} нет.`);
    if (kind === 'rp') {
      // A master over Telegram's 50 MB goes as a compressed copy (sendFile says so), plus the panel link.
      const file = m ? ver.master : ver.copy || ver.master;
      if (!file) return html(chat, `У ${v} нет видео.`);
      await tg.call('sendChatAction', {chat_id: chat, action: 'upload_video'}).catch(() => {});
      const big = m && statSync(file).size > 49e6;
      await tg.sendFile(chat, file, {caption: `${label(r)} · ${v}${m ? ' · мастер' : ''}`, asDocument: !!m && !big}).catch((e) => html(chat, `Не получилось отправить: ${esc(e.message)}`));
      if (big && panel(folder)) await html(chat, `Полный мастер ${v} (${Math.round(statSync(file).size / 1e6)} МБ) — в панели: «Скачать мастер ${v}».`, {inline_keyboard: [[{text: '🌐 Открыть в панели', url: panel(folder)}]]});
      if (folder !== focusOf()) await setFocus(chat, folder, {quiet: !!state.focusCard});
      return;
    }
    if (kind === 'rm') {
      if (folder !== focusOf()) await setFocus(chat, folder, {quiet: !!state.focusCard});
      const rel = relative(root, join(studio(), 'reels', folder));
      return send(`(the owner tapped «🎞 В мастер ${v}» for reel \`${rel}/\` ${label(r)}: render the master of ${v} as REELS.md says — 1440×2560, CRF 15 (\`-- --scale=1.333333 --crf=15\`), loudnorm, \`versions/${v}/<slug>-${v}-master-1440p.mp4\`; if ${v} is not the project's current state, render it from \`versions/${v}/project-snapshot\`. Do not change the cut. Set the README Status to Done, then send the master and say in one line it is ready.)`);
    }
  }

  return {list, setFocus, refresh, framePrompt, onButton, focusOf};
}
