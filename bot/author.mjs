// Authors (teachers and the like) live only in the bot and never talk to the agent: the
// bot answers them itself, with buttons (canvas «Черновик 8», A1–A11). They send raw
// material as is; the bot replies with one «Понял так» card (what, class, rubric, what
// it will make), asks at most one question, and the material goes to the editor.
//
// Per author: data/authors.json (subjects, classes, signature, pause, open dialog).
// Per project: inbox/<day>/ for files, inbox/authors.jsonl for submissions and ideas
// (the studio's «От авторов» list reads it).
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA, studio} from './config.mjs';
import {DOWNLOAD_LIMIT} from './intake.mjs';

const FILE = join(DATA, 'authors.json');
const CONFIRM_AFTER = 10 * 60_000;
const ALBUM_WAIT = 2500;
export const KEYBOARD = {keyboard: [[{text: '📎 Скинуть'}, {text: '💡 Идея'}], [{text: '📋 Что снять'}, {text: '📚 Мои материалы'}]], resize_keyboard: true, is_persistent: true};
const SUBJECTS = ['Химия', 'Биология', 'Физика', 'Математика', 'Русский', 'Литература', 'Английский', 'История', 'Начальная школа', 'Кружок'];
const CLASSES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
const LETTERS = ['А', 'Б', 'В'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = (a) => { writeFileSync(`${FILE}.tmp`, JSON.stringify(a, null, 2)); renameSync(`${FILE}.tmp`, FILE); };
const log = () => join(studio(), 'inbox', 'authors.jsonl');
function entries() {
  if (!existsSync(log())) return [];
  const byId = new Map();
  for (const line of readFileSync(log(), 'utf8').split('\n')) {
    try { const e = JSON.parse(line); byId.set(e.id, {...byId.get(e.id), ...e}); } catch {}
  }
  return [...byId.values()];
}
const record = (e) => { mkdirSync(join(studio(), 'inbox'), {recursive: true}); appendFileSync(log(), JSON.stringify({...e, at: e.at ?? Date.now()}) + '\n'); };
const kb = (rows) => ({inline_keyboard: rows.map((r) => r.map(([text, data]) => ({text, callback_data: `a:${data}`})))});
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));

/** The author part of the bot. `notify(text)` writes to the owner's chat. */
export function authors({tg, transcribe, notify}) {
  const albums = new Map();
  const timers = new Map();
  const html = (chatId, text, markup, extra = {}) => tg.call('sendMessage', {chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}, ...(markup ? {reply_markup: markup} : {}), ...extra});
  const edit = (q, text, markup) => tg.call('editMessageText', {chat_id: q.message.chat.id, message_id: q.message.message_id, text, parse_mode: 'HTML', ...(markup ? {reply_markup: markup} : {})}).catch(() => {});
  const me = (id) => load()[id] ?? {subjects: [], classes: [], sign: true};
  const put = (id, patch) => { const a = load(); a[id] = {...me(id), ...patch}; save(a); return a[id]; };

  // ---------- знакомство ----------
  function setupKeyboard(p) {
    const s = new Set(p.subjects), c = new Set(p.classes);
    const rows = [];
    for (let i = 0; i < SUBJECTS.length; i += 3) rows.push(SUBJECTS.slice(i, i + 3).map((x) => [`${s.has(x) ? '✓ ' : ''}${x}`, `sub:${x}`]));
    for (let i = 0; i < CLASSES.length; i += 6) rows.push(CLASSES.slice(i, i + 6).map((x) => [`${c.has(x) ? '✓ ' : ''}${x}`, `cls:${x}`]));
    rows.push([['Готово', 'setup-done']]);
    return kb(rows);
  }
  async function welcome(chatId, from, name, inviter) {
    put(from.id, {name, chatId, step: 'setup'});
    await html(chatId, `<b>${esc(name)}, здравствуйте!</b>\n${esc(inviter || 'Редактор')} пригласил(а) вас присылать материалы для соцсетей.\n\n📎 <b>Скинуть</b> — фото, видео, голосовое с урока. Как есть, без подписей.\n💡 <b>Идея</b> — о чём можно рассказать.\n📋 <b>Что снять</b> — подсказки на неделю.\n\nТексты пишу я, решает редактор.`);
    await html(chatId, 'Какие у вас предметы и классы? Можно выбрать несколько.', setupKeyboard(me(from.id)));
  }

  // ---------- приём материала ----------
  function classesOf(p) {
    const out = [];
    for (const c of p.classes) out.push(...(Number(c) > 4 ? LETTERS.map((l) => c + l) : [c]));
    return out.slice(0, 9);
  }
  async function take(msg, p) {
    const file = msg.photo ? {id: msg.photo.at(-1).file_id, size: msg.photo.at(-1).file_size, ext: 'jpg', kind: 'photo'}
      : msg.video ? {id: msg.video.file_id, size: msg.video.file_size, ext: 'mp4', kind: 'video', dur: msg.video.duration}
      : msg.video_note ? {id: msg.video_note.file_id, size: msg.video_note.file_size, ext: 'mp4', kind: 'video', dur: msg.video_note.duration}
      : msg.voice ? {id: msg.voice.file_id, size: msg.voice.file_size, ext: 'ogg', kind: 'voice', dur: msg.voice.duration}
      : msg.document ? {id: msg.document.file_id, size: msg.document.file_size, ext: (msg.document.file_name?.split('.').pop() || 'bin').slice(0, 5), kind: /^video/.test(msg.document.mime_type) ? 'video' : /^image/.test(msg.document.mime_type) ? 'photo' : 'file'}
      : null;
    const item = {kind: file?.kind ?? 'text', text: msg.caption ?? msg.text ?? ''};
    if (!file) return item;
    if (file.size > DOWNLOAD_LIMIT) return {...item, tooBig: true};
    const day = new Date().toLocaleDateString('sv');
    const dir = join(studio(), 'inbox', day);
    mkdirSync(dir, {recursive: true});
    const dest = join(dir, `author-${msg.from.id}-${msg.message_id}.${file.ext}`);
    try {
      await tg.download(file.id, dest);
      item.path = dest.slice(studio().length + 1);
      if (file.kind === 'voice') item.said = await transcribe(dest, 'ru', {}).catch(() => null);
    } catch { item.failed = true; }
    return item;
  }
  function summary(items) {
    const n = (k) => items.filter((x) => x.kind === k).length;
    const parts = [];
    if (n('photo')) parts.push(`${n('photo')} фото`);
    if (n('video')) parts.push(`${n('video')} видео`);
    if (n('voice')) parts.push(`${n('voice') > 1 ? n('voice') + ' голосовых' : 'голосовое'}`);
    if (n('file')) parts.push(`${n('file')} файл.`);
    return parts.join(', ') || 'текст';
  }
  function plan(items) {
    const out = [];
    const ph = items.filter((x) => x.kind === 'photo').length;
    if (ph || items.some((x) => x.text || x.said)) out.push('пост');
    if (ph >= 3) out.push('карусель');
    if (items.some((x) => x.kind === 'video')) out.push('видео — в рилс «Хроника года»');
    return out.join(', ') || 'покажу редактору';
  }
  const rubric = (cls) => (cls === 'Не урок' ? 'Жизнь школы' : cls === 'Кружок' ? 'Кружки' : 'Уроки');
  function card(e, p) {
    const subj = p.subjects.length === 1 ? p.subjects[0] : p.subjects.find((s) => e.text?.toLowerCase().includes(s.toLowerCase())) || p.subjects[0] || 'Урок';
    const words = (e.items.map((x) => x.text || x.said).filter(Boolean).join(' ').trim() || '').slice(0, 300);
    const day = new Date(e.at).toLocaleDateString('ru-RU', {day: 'numeric', month: 'long'});
    return `<b>Понял так:</b>\n${esc(e.cls === 'Не урок' ? 'Не урок' : `${subj} · ${e.cls}`)} · ${day}\nРубрика: ${esc(rubric(e.cls))}${words ? `\n«${esc(words)}»` : ''}\n${summary(e.items)}${e.items.some((x) => x.tooBig) ? '\n⚠️ Одно видео больше 20 МБ — бот его не получил. Пришлите кусок покороче.' : ''}\n\n<b>Сделаю:</b> ${plan(e.items)}.`;
  }
  const cardButtons = (id) => kb([[['✓ Верно', `ok:${id}`], ['Другой класс', `re:${id}`]], [['Не публиковать', `no:${id}`]]]);
  async function askOrCard(chatId, p, e) {
    const opts = [...classesOf(p), 'Кружок', 'Не урок'];
    if (!e.cls && classesOf(p).length !== 1) {
      const rows = [];
      for (let i = 0; i < opts.length; i += 4) rows.push(opts.slice(i, i + 4).map((x) => [x, `cl:${e.id}:${x}`]));
      return html(chatId, 'Это какой класс?', kb(rows));
    }
    e.cls ||= classesOf(p)[0];
    record({id: e.id, cls: e.cls, rubric: rubric(e.cls)});
    const m = await html(chatId, card(e, p), cardButtons(e.id));
    // Silence = «верно»: after 10 minutes the card is confirmed by itself.
    timers.set(e.id, setTimeout(() => confirm(e.id, chatId, m.message_id, true), CONFIRM_AFTER));
  }
  async function confirm(id, chatId, messageId, silent) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const e = entries().find((x) => x.id === id);
    if (!e || e.status !== 'new') return;
    record({id, status: 'sent'});
    const p = me(e.tg);
    await tg.call('editMessageText', {chat_id: chatId, message_id: messageId, text: `${card(e, p)}\n\n✓ Отправлено редактору${silent ? ' (без ответа 10 минут — считаю верным)' : ''}. Напишу, когда выйдет.`, parse_mode: 'HTML'}).catch(() => {});
    notify(`📥 ${e.who} прислал(а) материал: ${e.cls} · ${summary(e.items)} · рубрика «${rubric(e.cls)}». Во входящих студии — «От авторов».`);
  }
  async function flush(key) {
    const a = albums.get(key);
    albums.delete(key);
    const p = me(a.from.id);
    const items = [];
    for (const msg of a.msgs) items.push(await take(msg, p));
    const e = {id: `${a.from.id}-${a.msgs[0].message_id}`, tg: a.from.id, who: p.name || a.from.first_name, kind: 'material', items, status: 'new', at: Date.now()};
    record(e);
    await askOrCard(a.chatId, p, e);
  }

  // ---------- что снять, мои материалы, профиль ----------
  function tasksFor(p) {
    const subj = p.subjects[0] || 'урок';
    const c = classesOf(p)[0] || '';
    return [
      [`Опыт или задание ${c ? 'в ' + c : ''}`, '3–4 фото крупно: до и после. Лица не нужны'],
      [`Кабинет: ${subj.toLowerCase()}`, 'Видео 10 секунд, медленно по кругу'],
      [`Голосовое: зачем нужен ${subj.toLowerCase()}`, '30 секунд своими словами, к дню открытых дверей'],
    ];
  }
  const tasksKeyboard = (taken) => kb([[1, 2, 3].map((i) => [`${taken.includes(i) ? '✓ ' : ''}Беру ${i}`, `tk:${i}`]), [['Готово', 'tk-done']], [['На этой неделе не могу', 'tk-no']]]);
  async function whatToShoot(chatId, p) {
    const list = tasksFor(p).map(([t, d], i) => `<b>${i + 1}. ${esc(t)}</b>\n${esc(d)}`).join('\n\n');
    await html(chatId, `<b>Что снять на этой неделе</b>${p.subjects[0] ? ' · ' + esc(p.subjects[0].toLowerCase()) : ''}\n\n${list}`, tasksKeyboard(p.taken ?? []));
  }
  function materialsText(id, offset = 0) {
    const d = new Date();
    d.setMonth(d.getMonth() - offset);
    const mine = entries().filter((e) => e.tg === id && new Date(e.at).getMonth() === d.getMonth() && new Date(e.at).getFullYear() === d.getFullYear());
    const icon = {sent: '🕓', published: '✅', private: '🔒', declined: '✖️', new: '🕓', idea: '💡'};
    const label = {sent: 'у редактора', published: 'вышло', private: 'не публикуем', declined: 'не взяли', new: 'ждёт подтверждения'};
    const lines = mine.map((e) => e.kind === 'idea' ? `💡 Идея — «${esc((e.text || '').slice(0, 60))}»` : `${icon[e.status] || '🕓'} ${esc(e.cls || '')} · ${summary(e.items || [])} — ${label[e.status] || 'у редактора'}${e.reason ? ': ' + esc(e.reason) : ''}`);
    return `<b>Мои материалы · ${MONTHS[d.getMonth()]}</b>\n\n${lines.join('\n') || 'Пока ничего.'}`;
  }
  const monthKeys = (o) => kb([[['‹ Раньше', `mm:${o + 1}`], ...(o > 0 ? [['Позже ›', `mm:${o - 1}`]] : [])]]);
  function profileText(p) {
    const cls = classesOf(p).join(', ') || 'не выбраны';
    return `<b>${esc(p.name || 'Автор')} · автор</b>\n\nПредметы: ${esc(p.subjects.join(', ') || 'не выбраны')}\nКлассы: ${esc(cls)}\nПодпись в постах: ${p.sign ? `«${esc(p.name)}»` : 'без имени'}\n«Что снять» — по понедельникам в 8:00\nНе больше 3 сообщений в день, вечером тихо\nПауза: ${p.pauseUntil && p.pauseUntil > Date.now() ? 'до ' + new Date(p.pauseUntil).toLocaleDateString('ru-RU', {day: 'numeric', month: 'long'}) : 'нет'}`;
  }
  const profileKeys = () => kb([[['Подпись', 'pf:sign'], ['Предметы и классы', 'pf:setup']], [['⏸ Пауза', 'pf:pause']]]);

  // ---------- входящие сообщения ----------
  async function onMessage(msg, who) {
    const id = msg.from.id, chatId = msg.chat.id;
    const p = put(id, {name: me(id).name || who.name, chatId});
    const text = msg.text?.trim();
    if (text === '/start') return html(chatId, 'Присылайте фото, видео и голосовые с уроков — как есть. Остальное — кнопками внизу.', KEYBOARD);
    if (text === '/me') return html(chatId, profileText(p), profileKeys());
    if (text === '📎 Скинуть') return html(chatId, 'Пришлите фото, видео или голосовое — как есть, без подписей. Можно несколько сразу.', KEYBOARD);
    if (text === '💡 Идея') { put(id, {step: 'idea'}); return html(chatId, 'Напишите или наговорите идею одним сообщением: о чём можно рассказать.'); }
    if (text === '📋 Что снять') return whatToShoot(chatId, p);
    if (text === '📚 Мои материалы') return html(chatId, materialsText(id), monthKeys(0));
    if (p.step === 'idea' && (text || msg.voice)) {
      const item = await take(msg, p);
      put(id, {step: null});
      record({id: `${id}-${msg.message_id}`, tg: id, who: p.name, kind: 'idea', text: item.text || item.said || '(голосовое)', items: [item], status: 'idea'});
      notify(`💡 ${p.name} предлагает идею: ${item.text || item.said || 'голосовое во входящих'}`);
      return html(chatId, 'Записал идею ✓ Редактор увидит её в корзине идей.', KEYBOARD);
    }
    if (p.step === 'setup' && text) return html(chatId, 'Выберите кнопками выше и нажмите «Готово».');
    // Material: an album comes as several messages with one media_group_id.
    const key = msg.media_group_id ? `g${msg.media_group_id}` : `m${id}-${msg.message_id}`;
    const a = albums.get(key) ?? {from: msg.from, chatId, msgs: []};
    a.msgs.push(msg);
    clearTimeout(a.timer);
    a.timer = setTimeout(() => flush(key).catch((e) => console.error('author intake', e)), msg.media_group_id ? ALBUM_WAIT : 300);
    albums.set(key, a);
    if (a.msgs.length === 1) tg.call('setMessageReaction', {chat_id: chatId, message_id: msg.message_id, reaction: [{type: 'emoji', emoji: '👀'}]}).catch(() => {});
  }

  // ---------- кнопки ----------
  async function onButton(q) {
    const id = q.from.id, chatId = q.message.chat.id;
    const [cmd, ...rest] = q.data.slice(2).split(':');
    const arg = rest.join(':');
    let p = me(id);
    if (cmd === 'sub' || cmd === 'cls') {
      const field = cmd === 'sub' ? 'subjects' : 'classes';
      const set = new Set(p[field]);
      set.has(arg) ? set.delete(arg) : set.add(arg);
      p = put(id, {[field]: [...set]});
      return tg.call('editMessageReplyMarkup', {chat_id: chatId, message_id: q.message.message_id, reply_markup: setupKeyboard(p)}).catch(() => {});
    }
    if (cmd === 'setup-done') {
      if (!p.subjects.length || !p.classes.length) return html(chatId, 'Выберите хотя бы один предмет и один класс.');
      const first = !p.done;
      put(id, {step: null, done: true});
      await edit(q, `Предметы: ${esc(p.subjects.join(', '))}\nКлассы: ${esc(classesOf(p).join(', '))} ✓`);
      if (first) return html(chatId, 'Указывать ваше имя в постах?', kb([[[`Да, «${p.name}»`, 'sign:yes']], [['Без имени', 'sign:no']]]));
      return html(chatId, 'Сохранил ✓', KEYBOARD);
    }
    if (cmd === 'sign') {
      put(id, {sign: arg === 'yes'});
      await edit(q, `Имя в постах: ${arg === 'yes' ? `«${esc(p.name)}»` : 'без имени'} ✓`);
      return html(chatId, 'Готово! Присылайте фото, видео и голосовые с уроков — как есть. Остальное — кнопками внизу.', KEYBOARD);
    }
    if (cmd === 'cl' || cmd === 'ok' || cmd === 're' || cmd === 'no') {
      const [eid, cls] = cmd === 'cl' ? [rest.slice(0, -1).join(':'), rest.at(-1)] : [arg];
      const e = entries().find((x) => x.id === eid && x.tg === id);
      if (!e) return;
      if (cmd === 'cl') {
        e.cls = cls;
        await edit(q, `Это какой класс?\n<i>${esc(cls)} ✓</i>`);
        return askOrCard(chatId, p, e);
      }
      if (cmd === 'ok') return confirm(eid, chatId, q.message.message_id, false);
      if (cmd === 'no') {
        clearTimeout(timers.get(eid));
        record({id: eid, status: 'private'});
        return edit(q, `${card(e, p)}\n\n🔒 Сохранил, публиковать не будем.`);
      }
      clearTimeout(timers.get(eid));
      const opts = [...classesOf(p), 'Кружок', 'Не урок'];
      const rows = [];
      for (let i = 0; i < opts.length; i += 4) rows.push(opts.slice(i, i + 4).map((x) => [x, `cl:${eid}:${x}`]));
      return edit(q, 'Это какой класс?', kb(rows));
    }
    if (cmd === 'tk') {
      const t = new Set(p.taken ?? []);
      const n = Number(arg);
      t.has(n) ? t.delete(n) : t.add(n);
      p = put(id, {taken: [...t].sort()});
      return tg.call('editMessageReplyMarkup', {chat_id: chatId, message_id: q.message.message_id, reply_markup: tasksKeyboard(p.taken)}).catch(() => {});
    }
    if (cmd === 'tk-done') {
      await tg.call('editMessageReplyMarkup', {chat_id: chatId, message_id: q.message.message_id, reply_markup: {inline_keyboard: []}}).catch(() => {});
      return html(chatId, p.taken?.length ? `Записал: ${p.taken.map((n) => n).join(' и ')}. Присылайте, когда снимете.` : 'Ничего не выбрано — ничего страшного.', KEYBOARD);
    }
    if (cmd === 'tk-no') {
      put(id, {taken: []});
      await tg.call('editMessageReplyMarkup', {chat_id: chatId, message_id: q.message.message_id, reply_markup: {inline_keyboard: []}}).catch(() => {});
      return html(chatId, 'Понял, на этой неделе без заданий. Если что-то будет — просто пришлите.', KEYBOARD);
    }
    if (cmd === 'mm') return edit(q, materialsText(id, Number(arg)), monthKeys(Number(arg)));
    if (cmd === 'pf') {
      if (arg === 'sign') { p = put(id, {sign: !p.sign}); return edit(q, profileText(p), profileKeys()); }
      if (arg === 'setup') { put(id, {step: 'setup'}); return html(chatId, 'Предметы и классы:', setupKeyboard(p)); }
      if (arg === 'pause') return html(chatId, 'На сколько пауза? Пока пауза — не пришлю «Что снять» и напоминания. Скидывать можно как обычно.', kb([[['Неделя', 'ps:7'], ['Две недели', 'ps:14']], [['Месяц', 'ps:30'], ['Снять паузу', 'ps:0']]]));
    }
    if (cmd === 'ps') {
      const days = Number(arg);
      p = put(id, {pauseUntil: days ? Date.now() + days * 86_400_000 : 0});
      return edit(q, days ? `⏸ Пауза до ${new Date(p.pauseUntil).toLocaleDateString('ru-RU', {day: 'numeric', month: 'long'})} ✓` : 'Пауза снята ✓');
    }
  }

  return {welcome, onMessage, onButton};
}
