// The editor's side of the bot (canvas «Черновик 8»: E7, E8, E11–E13; handbook/LAUNCH.md):
// scenarios with buttons instead of a free chat with the agent. Free text and voice still
// go to Claude; everything that has a clear next step is a card here.
//
//   Сегодня   — one card: what waits for a decision, the week, who is quiet
//   Входящие  — what members sent (inbox/authors.jsonl): «Сделать варианты» → 3 texts in the
//               project's styles (a short Claude call) → «В очередь» on the next free slot
//   Неделя    — plan.json by days with the rhythm's empty slots
//   Люди      — tasks by person and who has not sent anything for a week
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {askJson} from './llm.mjs';
import {FILE as MEMBERS} from './members.mjs';

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f); };
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const when = (s) => { const d = new Date(s); return `${DAYS[(d.getDay() + 6) % 7]} ${d.getDate()} ${d.toLocaleDateString('ru-RU', {month: 'short'}).replace('.', '')}, ${s.slice(11, 16)}`; };
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);

export const KEYS = {keyboard: [[{text: '📥 Входящие'}, {text: '📅 Неделя'}], [{text: '👥 Люди'}, {text: '☰ Ещё'}]], resize_keyboard: true, is_persistent: true};
export const LABELS = {'📥 Входящие': 'inbox', '📅 Неделя': 'week', '👥 Люди': 'people', '☰ Ещё': 'more'};

/** `studio()` — the active project's folder; `app(text, hash)` — a mini app button or null. */
export function editor({tg, studio, app}) {
  const html = (chatId, text, markup) => tg.call('sendMessage', {chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}, ...(markup ? {reply_markup: markup} : {})});
  const edit = (q, text, markup) => tg.call('editMessageText', {chat_id: q.message.chat.id, message_id: q.message.message_id, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}, ...(markup ? {reply_markup: markup} : {reply_markup: {inline_keyboard: []}})}).catch(() => {});
  const kb = (rows) => ({inline_keyboard: rows.filter((r) => r.length).map((r) => r.map((b) => (Array.isArray(b) ? {text: b[0], callback_data: `ed:${b[1]}`} : b)))});

  // ---------- data ----------
  const logFile = () => join(studio(), 'inbox', 'authors.jsonl');
  function entries() {
    if (!existsSync(logFile())) return [];
    const byId = new Map();
    for (const line of readFileSync(logFile(), 'utf8').split('\n')) { try { const e = JSON.parse(line); byId.set(e.id, {...byId.get(e.id), ...e}); } catch {} }
    return [...byId.values()];
  }
  const record = (e) => { mkdirSync(join(studio(), 'inbox'), {recursive: true}); appendFileSync(logFile(), JSON.stringify({...e, at2: Date.now()}) + '\n'); };
  // Material a member confirmed («sent») that nobody has decided on yet.
  const waiting = () => entries().filter((e) => e.status === 'sent' && !e.decided && e.kind !== 'idea');
  const ideas = () => entries().filter((e) => e.kind === 'idea' && !e.decided);
  const strategy = () => readJson(join(studio(), 'strategy.json'), {});
  const plan = () => readJson(join(studio(), 'plan.json'), {});
  const people = () => (MEMBERS ? readJson(MEMBERS, {}).people || [] : []);
  const tasks = () => readJson(join(studio(), 'host', 'tasks.json'), {tasks: []}).tasks || [];
  const titleOf = (key) => {
    const [kind, id] = [key.slice(0, 4), key.slice(5)];
    if (kind === 'post') return readJson(join(studio(), 'posts', id, 'post.json'), {}).title || id;
    return (/^#\s*(.+)/m.exec((() => { try { return readFileSync(join(studio(), 'reels', id, 'README.md'), 'utf8'); } catch { return ''; } })())?.[1] || id).replace(/^\d+\s*/, '').replace(/[«»]/g, '');
  };
  function weekDays() {
    const now = new Date(), mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const at = plan().at || {}, slots = strategy().rhythm?.slots || [];
    return Array.from({length: 7}, (_, i) => {
      const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
      const items = Object.entries(at).filter(([, t]) => String(t).startsWith(iso(d))).map(([k, t]) => ({key: k, title: titleOf(k), time: String(t).slice(11, 16), kind: k.slice(0, 4)}));
      const past = d < new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return {i, d, items, empty: !past && slots.filter((s) => s.day === i + 1).length > items.length};
    });
  }
  // The next rhythm slot from now that nothing fills yet; without a rhythm — tomorrow 12:00.
  function nextSlot() {
    const at = Object.values(plan().at || {}).map(String);
    const slots = strategy().rhythm?.slots || [];
    const now = new Date();
    for (let k = 0; k < 21; k++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k);
      const dow = ((d.getDay() + 6) % 7) + 1;
      for (const s of slots.filter((x) => x.day === dow && x.kind !== 'reel').sort((a, b) => String(a.time).localeCompare(b.time))) {
        const t = `${iso(d)}T${s.time || '12:00'}`;
        if (Date.parse(t) > Date.now() && !at.includes(t)) return {at: t, rubric: s.rubric};
      }
    }
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return {at: `${iso(d)}T12:00`, rubric: null};
  }
  const quiet = () => people().filter((x) => x.role === 'member' && !x.test && x.telegram).map((x) => ({name: x.name, days: Math.floor((Date.now() - (x.telegram.seen || x.added || Date.now())) / 864e5)})).filter((x) => x.days >= 7).sort((a, b) => b.days - a.days);
  const what = (items = []) => {
    const n = (k) => items.filter((x) => x.kind === k).length;
    return [n('photo') && `${n('photo')} фото`, n('video') && `${n('video')} видео`, n('voice') && 'голосовое'].filter(Boolean).join(', ') || 'текст';
  };
  const words = (e) => (e.items || []).map((x) => x.text || x.said).filter(Boolean).join(' ').trim();

  // ---------- Сегодня ----------
  async function today(chatId) {
    const w = waiting(), wk = weekDays(), q = quiet();
    const planned = wk.reduce((n, d) => n + d.items.length, 0), holes = wk.filter((d) => d.empty).length;
    const date = new Date().toLocaleDateString('ru-RU', {weekday: 'long', day: 'numeric', month: 'long'});
    const lines = [`<b>Сегодня · ${date}</b>`, '',
      w.length ? `📥 Ждут решения: <b>${w.length}</b> — ${w.slice(0, 3).map((e) => esc(`${e.who} · ${e.cls || ''}`.trim())).join(', ')}${w.length > 3 ? '…' : ''}` : '📥 Входящих нет',
      `📅 Неделя: ${planned} ${plural(planned, 'публикация', 'публикации', 'публикаций')}${holes ? `, пустых дней в ритме: ${holes}` : ''}`,
      q.length ? `👥 Давно молчат: ${q.slice(0, 3).map((x) => `${esc(x.name)} (${x.days} дн.)`).join(', ')}` : '',
      ideas().length ? `💡 Идей от людей: ${ideas().length}` : ''].filter((x) => x !== '');
    lines.push('', 'Напишите или наговорите, что сделать, — Claude возьмётся.');
    return html(chatId, lines.join('\n'), kb([[w.length ? [`📥 Разобрать · ${w.length}`, 'inbox'] : ['📥 Входящие', 'inbox'], ['📅 Неделя', 'week']], [['👥 Люди', 'people'], ...(app('🎬 Студия') ? [app('🎬 Студия', '#today')] : [])]]));
  }

  // ---------- Входящие ----------
  async function inbox(chatId) {
    const w = waiting();
    if (!w.length) return html(chatId, '📥 <b>Входящих нет.</b>\nКогда участник пришлёт материал и подтвердит «Понял так», он появится здесь.', kb([[['📅 Неделя', 'week'], ['👥 Люди', 'people']]]));
    await html(chatId, `📥 <b>Ждут решения · ${w.length}</b>`);
    for (const e of w.slice(0, 5)) {
      const t = words(e);
      await html(chatId, `<b>${esc(e.cls || 'Материал')}</b> · ${esc(e.who || '')}\n${what(e.items)} · рубрика «${esc(e.rubric || '—')}»${t ? `\n«${esc(t.slice(0, 200))}»` : ''}`,
        kb([[['✍️ Сделать варианты', `mk:${e.id}`]], [['⏸ Отложить', `later:${e.id}`], ['✖ Не берём', `no:${e.id}`]]]));
    }
    if (w.length > 5) await html(chatId, `И ещё ${w.length - 5} — в студии, «Входящие».`);
  }

  // ---------- варианты ----------
  async function makeVariants(q, id) {
    const e = entries().find((x) => x.id === id);
    if (!e) return edit(q, 'Этого материала уже нет.');
    await edit(q, `✍️ Пишу варианты: ${esc(e.cls || '')} · ${esc(e.who || '')}…`);
    const st = strategy();
    const styles = (st.voice?.styles || []).map((s) => s.name).slice(0, 3);
    const brief = (() => { try { return readFileSync(join(studio(), 'brief.md'), 'utf8').slice(0, 2500); } catch { return ''; } })();
    const r = await askJson([
      'Ты пишешь посты для соцсетей проекта. Ответь ТОЛЬКО JSON без пояснений:',
      '{"title":"заголовок в 2–5 слов","variants":[{"style":"…","text":"…"}]}',
      `Три варианта в стилях: ${(styles.length ? styles : ['Тёплый', 'Новость', 'Коротко']).join(', ')}. Каждый 2–5 предложений, без хэштегов, без выдуманных фактов, имён и цифр — только то, что есть в материале.`,
      st.voice?.about ? `Голос проекта: ${st.voice.about}` : '', (st.voice?.never || []).length ? `Никогда: ${st.voice.never.join(', ')}` : '',
      brief ? `О проекте:\n${brief}` : '',
      `Материал: ${e.cls || ''}, рубрика «${e.rubric || ''}», от ${e.who || 'участника'}; ${what(e.items)}.`, words(e) ? `Слова автора: «${words(e)}»` : 'Слов нет — опиши событие по классу и рубрике осторожно, без деталей.',
    ].filter(Boolean).join('\n'));
    const variants = (r?.variants || []).filter((v) => v?.text).slice(0, 3);
    if (!variants.length) return edit(q, `Не получилось написать варианты — Claude не ответил. Попробуйте ещё раз.`, kb([[['✍️ Ещё раз', `mk:${id}`]]]));
    const photos = (e.items || []).filter((x) => x.kind === 'photo').length;
    const {newPost, postDir, readPost, savePost} = await import('../web/posts.mjs');
    const pid = newPost(studio(), {kind: photos >= 3 ? 'carousel' : photos ? 'photo' : 'text', title: r.title || `${e.cls || 'Материал'} · ${e.who || ''}`, by: e.who});
    const dir = postDir(studio(), pid);
    savePost(dir, {...readPost(dir), texts: variants.map((v) => ({style: v.style || '', text: v.text})), chosen: 0, rubric: e.rubric || '', from: {entry: e.id, who: e.who, sources: (e.items || []).map((x) => x.path).filter(Boolean)}});
    record({id, decided: 'variants', post: pid});
    return showVariant(q, pid, 0);
  }
  async function showVariant(q, pid, i) {
    const {postDir, readPost} = await import('../web/posts.mjs');
    const dir = postDir(studio(), pid);
    if (!dir) return edit(q, 'Пост удалён.');
    const p = readPost(dir), n = (p.texts || []).length;
    i = ((i % n) + n) % n;
    const slot = nextSlot();
    return edit(q, `<b>${esc(p.title)}</b> · вариант ${i + 1} из ${n}${p.texts[i].style ? ` · «${esc(p.texts[i].style)}»` : ''}\n\n${esc(p.texts[i].text)}`,
      kb([[[`✓ В очередь · ${when(slot.at)}`, `q:${pid}:${i}`]], [['‹', `v:${pid}:${i - 1}`], ['›', `v:${pid}:${i + 1}`]], [['✖ Не берём', `np:${pid}`]]]));
  }
  async function queue(q, pid, i) {
    const {postDir, readPost, savePost} = await import('../web/posts.mjs');
    const dir = postDir(studio(), pid);
    if (!dir) return edit(q, 'Пост удалён.');
    const p = readPost(dir);
    const slot = nextSlot();
    savePost(dir, {...p, chosen: i});
    const pl = plan();
    pl.at = {...pl.at, [`post:${pid}`]: slot.at};
    if (slot.rubric || p.rubric) pl.rubric = {...pl.rubric, [`post:${pid}`]: slot.rubric || p.rubric};
    writeJson(join(studio(), 'plan.json'), pl);
    if (p.from?.entry) record({id: p.from.entry, decided: 'queued'});
    return edit(q, `<b>${esc(p.title)}</b>\n\n${esc(p.texts[i].text)}\n\n✓ В очереди: <b>${when(slot.at)}</b>. Подпись под площадки и фото — в студии, этап «Выкладка».`, kb([[['📅 Неделя', 'week']]]));
  }
  const REASONS = ['Темно или смазано', 'Не по теме', 'Уже было', 'Без причины'];
  async function decline(q, id, reason) {
    if (reason == null) return edit(q, 'Почему не берём? Автор увидит это одной строкой в «Моих материалах».', kb(REASONS.map((r, k) => [[r, `nr:${id}:${k}`]])));
    record({id, decided: 'declined', status: 'declined', reason: REASONS[reason] === 'Без причины' ? '' : REASONS[reason]});
    return edit(q, `✖ Не берём${REASONS[reason] !== 'Без причины' ? `: ${REASONS[reason].toLowerCase()}` : ''}.`);
  }

  // ---------- Неделя, Люди ----------
  async function week(chatId) {
    const wk = weekDays();
    const lines = ['<b>Неделя</b>', ''];
    for (const d of wk) lines.push(`<b>${DAYS[d.i]} ${d.d.getDate()}</b>  ${d.items.length ? d.items.map((x) => `${x.time} ${x.kind === 'reel' ? '🎬' : '📝'} ${esc(x.title)}`).join(' · ') : d.empty ? '<i>пусто — есть место в ритме</i>' : '—'}`);
    return html(chatId, lines.join('\n'), kb([[...(app('📅 Календарь') ? [app('📅 Календарь', '#week')] : []), ['📥 Входящие', 'inbox']]]));
  }
  async function peopleView(chatId) {
    const t = tasks(), ps = people().filter((x) => !x.test);
    const name = (k) => ps.find((x) => x.id === k)?.name || 'все';
    const open = t.filter((x) => x.to && x.status !== 'sent');
    const q = quiet();
    const lines = ['<b>Люди</b>', '', ps.length ? `В команде: ${ps.length}` : 'В команде пока только вы. Пригласить — в студии, Настройки проекта › Команда.'];
    if (open.length) lines.push('', '<b>Задания</b>', ...open.slice(0, 8).map((x) => `• ${esc(name(x.to))} — ${esc(x.title)}${x.status === 'redo' ? ' (переснять)' : ''}`));
    if (q.length) lines.push('', '<b>Давно молчат</b>', ...q.slice(0, 6).map((x) => `• ${esc(x.name)} — ${x.days} дн.`));
    return html(chatId, lines.join('\n'), app('👥 Люди') ? kb([[app('👥 Люди', '#people')]]) : undefined);
  }

  async function onButton(q) {
    const [, act, a, b] = q.data.split(':');
    tg.call('answerCallbackQuery', {callback_query_id: q.id}).catch(() => {});
    const chatId = q.message.chat.id;
    if (act === 'inbox') return inbox(chatId);
    if (act === 'week') return week(chatId);
    if (act === 'people') return peopleView(chatId);
    if (act === 'mk') return makeVariants(q, a);
    if (act === 'v') return showVariant(q, a, Number(b));
    if (act === 'q') return queue(q, a, Number(b));
    if (act === 'later') { record({id: a, decided: 'later'}); return edit(q, '⏸ Отложено — найдёте в студии, «Входящие».'); }
    if (act === 'no') return decline(q, a);
    if (act === 'nr') return decline(q, a, Number(b));
    if (act === 'np') {
      const {postDir, readPost, savePost} = await import('../web/posts.mjs');
      const dir = postDir(studio(), a);
      if (dir) { const p = readPost(dir); savePost(dir, {...p, dropped: true}); if (p.from?.entry) return decline(q, p.from.entry); }
      return edit(q, '✖ Не берём.');
    }
  }
  return {today, inbox, week, people: peopleView, onButton};
}
