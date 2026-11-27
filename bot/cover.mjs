// The cover generator in Telegram (issue #152, canvas «Обложки рилсов» G9): the same path as on the site —
// frame → text → design — with web/cover.mjs doing the work. One picture per step (a contact sheet) with
// numbered buttons; a typed time («0:42») or number picks a frame, the rest of that message goes to Claude
// as the owner's wish. Claude writes the four texts to versions/<vN>/cover/texts.json; the bot watches the
// file and shows them. state.cover = {project, folder, v, step: 'frame'|'text'|'design', times, at}.
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import * as cover from '../web/cover.mjs';
import {DATA} from './config.mjs';

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')},${String(Math.floor((t % 1) * 100)).padStart(2, '0')}`;
// «0:42», «0:42,5», «42 с», «1:05.2» → seconds
const timeOf = (s) => {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,2})(?:[.,](\d{1,2}))?\s*(?:с|сек|s)?\b/i.exec(s);
  if (!m || (!m[1] && !/[сs:]|[.,]/i.test(s.slice(0, m[0].length)))) return null;
  return Number(m[1] || 0) * 60 + Number(m[2]) + Number(`0.${m[3] || 0}`);
};

export function coverUi({tg, state, save, studio, project, enqueue}) {
  const chat = () => state.chatId;
  const reelDir = (c) => join(studio(), 'reels', c.folder);
  const cur = () => (state.cover?.project === project() ? state.cover : null);
  const rubricOf = (c) => {
    const st = cover.read(reelDir(c), c.v);
    if (st.rubric) return st.rubric;
    try { return JSON.parse(readFileSync(join(studio(), 'items.json'), 'utf8')).items.find((x) => x.ref?.kind === 'reel' && x.ref.id === c.folder)?.rubric || 'useful'; } catch { return 'useful'; }
  };
  const btns = (rows) => ({inline_keyboard: rows});
  const nums = (n, kind) => [Array.from({length: n}, (_, i) => ({text: String(i + 1), callback_data: `cv:${kind}:${i}`}))];

  /** Step 1: three sharp frames from the start of the clean cut, or any time the owner types. */
  async function start(folder, v) {
    const c = {project: project(), folder, v, step: 'frame', times: [], at: Date.now()};
    state.cover = c; save();
    const dir = reelDir(c);
    if (!cover.sourceOf(dir, v)) return tg.sendText(chat(), 'У этой версии нет видео — обложку не из чего собрать.');
    await tg.call('sendChatAction', {chat_id: chat(), action: 'upload_photo'}).catch(() => {});
    const sug = cover.suggest(dir, v);
    c.times = sug.map((x) => x.t); save();
    const tmp = join(dir, 'versions', v, 'cover'); mkdirSync(tmp, {recursive: true});
    const pics = sug.map((x, i) => cover.framePreview(dir, v, x.t, join(tmp, `tg-f${i + 1}.jpg`))).filter(Boolean);
    const clean = cover.isClean(dir, v) ? '' : '\nЧистого монтажа нет — кадр будет из готового видео, с его плашками.';
    const text = `🖼 Обложка ${folder.slice(0, 2)} · ${v}\n<b>Шаг 1 · кадр.</b> ${c.times.map((t, i) => `${i + 1} — ${fmt(t)}`).join(', ')}. Или пришли время, например «0:42». Сразу можно дописать, что важно на обложке.${clean}`;
    const sh = pics.length && cover.sheet(pics, join(tmp, 'tg-frames.jpg'));
    if (sh) return tg.sendFile(chat(), sh, {caption: text, markup: btns(nums(pics.length, 'f'))});
    return tg.sendText(chat(), text);
  }

  /** The frame is taken: cut it, hand Claude the note, wait for texts.json. */
  async function takeFrame(t, wish = '') {
    const c = cur(); if (!c) return;
    const dir = reelDir(c);
    let st;
    try { st = cover.takeFrame(dir, c.v, t, 'user'); } catch (e) { return tg.sendText(chat(), `Не вышло вырезать кадр: ${e.message}`); }
    Object.assign(c, {step: 'text', at: Date.now(), shown: false}); save();
    await tg.sendFile(chat(), join(dir, 'versions', c.v, 'cover', st.frame.file), {caption: `Кадр ${fmt(st.frame.t)}${st.frame.person ? '' : ' · без выреза ведущего'}. <b>Шаг 2 · текст</b> — Claude пишет четыре варианта.`, silent: true});
    enqueue(cover.agentNote(dir, c.v, st, rubricOf(c), wish));
  }

  /** Texts are there: four, numbered. */
  async function showTexts() {
    const c = cur(); if (!c || c.step !== 'text' || c.shown) return;
    const list = cover.texts(reelDir(c), c.v).slice(0, 4);
    if (!list.length) return;
    c.shown = true; save();
    const r = rubricOf(c);
    const line = (x, i) => `<b>${i + 1}.</b> ${r === 'memes' ? x.caption : r === 'beauty' ? x.place : `${x.t1} / ${x.t2 || ''}`}${x.zone ? ` · за тобой «${x.zone}»` : ''}`;
    await tg.sendText(chat(), `<b>Шаг 2 · текст.</b> По ролику:\n${list.map(line).join('\n')}\n\nВыбери цифрой или напиши свой: «Первая строка / вторая строка».`,
      {reply_markup: btns([...nums(list.length, 't'), [{text: '← кадр', callback_data: 'cv:b:frame'}]])});
  }

  /** Step 3: the designs of the rubric with this text, one sheet, numbered. */
  async function build(text) {
    const c = cur(); if (!c) return;
    const dir = reelDir(c);
    await tg.sendText(chat(), 'Собираю дизайны — секунд 15.', {silent: true});
    let st;
    try { st = await cover.build(dir, c.v, {text, rubric: rubricOf(c)}, {cache: join(DATA, 'cover-cache')}); } catch (e) { return tg.sendText(chat(), `Не собралось: ${e.message}`); }
    c.step = 'design'; save();
    const cdir = join(dir, 'versions', c.v, 'cover');
    const sh = cover.sheet(st.designs.map((d) => join(cdir, d.file)), join(cdir, 'tg-designs.jpg'));
    const caption = `<b>Шаг 3 · дизайн.</b>\n${st.designs.map((d, i) => `${i + 1} — ${d.name}`).join('\n')}\n\nВыбери цифрой; правки — словами.`;
    const markup = btns([...nums(st.designs.length, 'd'), [{text: '← текст', callback_data: 'cv:b:text'}, {text: '← кадр', callback_data: 'cv:b:frame'}]]);
    return sh ? tg.sendFile(chat(), sh, {caption, markup}) : tg.sendText(chat(), caption, {reply_markup: markup});
  }

  async function pick(i) {
    const c = cur(); if (!c) return;
    const dir = reelDir(c), st = cover.read(dir, c.v), d = st.designs?.[i];
    if (!d) return;
    try { cover.choose(dir, c.v, d.id); } catch (e) { return tg.sendText(chat(), e.message); }
    state.cover = null; save();
    return tg.sendFile(chat(), join(dir, 'versions', c.v, 'cover.png'), {caption: `Обложка готова: ${d.name}. Лежит в ${c.v} (cover.png и cover-3x4.png), в студии уже в «Готово» и в пакете выкладки.`, asDocument: true});
  }

  return {
    start,
    /** cv:o:<folder>:<v> open · cv:f:i frame · cv:t:i text · cv:d:i design · cv:b:frame|text back */
    async onButton(q) {
      const [, act, a, b] = q.data.split(':');
      await tg.call('editMessageReplyMarkup', {chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: {inline_keyboard: []}}).catch(() => {});
      if (act === 'o') return start(a, b);
      const c = cur();
      if (!c) return tg.sendText(chat(), 'Эта обложка уже закрыта — нажми «🖼 Обложка» под видео ещё раз.', {silent: true});
      if (act === 'f') return takeFrame(c.times[Number(a)] ?? 0);
      if (act === 't') return build(cover.texts(reelDir(c), c.v)[Number(a)] || {});
      if (act === 'd') return pick(Number(a));
      if (act === 'b' && a === 'frame') return start(c.folder, c.v);
      if (act === 'b' && a === 'text') { Object.assign(c, {step: 'text', shown: false}); save(); return showTexts(); }
    },
    /** A typed answer to the current step; true when it was one. */
    async onText(text) {
      const c = cur(); if (!c || !text) return false;
      if (c.step === 'frame') {
        const n = /^\s*([1-3])\b[,.:\s]*(.*)$/s.exec(text);
        if (n && c.times[n[1] - 1] !== undefined) { await takeFrame(c.times[n[1] - 1], n[2].trim()); return true; }
        const t = timeOf(text);
        if (t !== null) { await takeFrame(t, text.replace(/^\s*[\d:.,]+\s*(с|сек|s)?\s*[,.]?\s*/i, '').trim()); return true; }
        return false;
      }
      if (c.step === 'text' && c.shown) {
        const n = /^\s*(?:текст\s*)?([1-4])\s*$/i.exec(text);
        if (n) { await build(cover.texts(reelDir(c), c.v)[n[1] - 1] || {}); return true; }
        const own = /^(.{1,18})\s*\/\s*(.{1,18})$/.exec(text.trim());
        if (own) { await build({t1: own[1].trim(), t2: own[2].trim(), caption: text.replace('/', ' '), place: own[1].trim()}); return true; }
        return false;
      }
      if (c.step === 'design') {
        const n = /^\s*([1-4])\s*$/.exec(text);
        if (n) { await pick(n[1] - 1); return true; }
      }
      return false;
    },
    /** Called every few seconds: shows the texts as soon as Claude wrote them; drops a flow left for a day. */
    tick() {
      const c = cur();
      if (!c) return;
      if (Date.now() - c.at > 24 * 3600e3) { state.cover = null; save(); return; }
      if (c.step === 'text' && !c.shown && existsSync(join(reelDir(c), 'versions', c.v, 'cover', 'texts.json'))) showTexts().catch((e) => console.error('cover', e));
    },
  };
}
