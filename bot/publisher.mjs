// «Выкладывает»: a person who posts what is ready (canvas page botlean, row «5 · Кто
// выкладывает», boards В1–В6). The owner adds them from the bot or the web with their
// platforms (Instagram RU / EN, stories, TikTok — never the Telegram channel, it posts
// itself) and when they want the package (15 minutes / an hour before, or in the morning
// for the whole day). Then, for every item on the stage «Готово» with a time and one of their
// platforms, the bot sends a package by kind — a reel as a document (no recompression) with
// the cover and the caption, a carousel as slides in order, a story as frames and the link —
// with «Выложено» / «Не получается». Fifteen minutes past the time without a mark it asks
// what happened and moves the item to tomorrow or hands it to the owner. The owner only sees
// the outcome: «Вышло» with the link, a move with the reason, «Выложу сам».
//
// Who publishes: people[].publishes = {platforms: [id], lead: '15m'|'1h'|'morning'} in the
// team list (bot/members.mjs). Jobs: publish-jobs.json next to that list, one per
// item × platform × time. Without such a person nothing changes: packages stay the owner's.
import {createHash, randomBytes} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {changeItem, loadItems} from '../web/items.mjs';
import {postDir, postFiles, readPost} from '../web/posts.mjs';
import {listReels} from './reels.mjs';
import {videoInfo} from './media.mjs';
import {FILE as MEMBERS} from './members.mjs';

export const LEADS = {'15m': 'За 15 минут', '1h': 'За час', morning: 'Утром на весь день'};
const LEAD_TEXT = {'15m': 'за 15 минут до выхода', '1h': 'за час до выхода', morning: 'утром, на весь день'};
const KIND = {reel: 'Рилс', carousel: 'Карусель', story: 'Сторис', post: 'Пост', telegram: 'Текст'};
const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const DAY_NAMES = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const REASONS = {access: 'нет доступа к аккаунту', file: 'файл не открывается', time: 'не успеваю сегодня', other: 'другое'};
const LATE_AFTER = 15 * 60e3;
const MORNING = 9;

const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f); };
const hm = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const jobId = (key) => createHash('sha1').update(key).digest('hex').slice(0, 10);
/** «2026-11-06T19:00» one day later, same wall-clock time. */
const nextDay = (at) => { const d = new Date(Date.parse(at) + 864e5); return `${dayKey(d.getTime())}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const isTg = (p) => /^tg$|telegram|телеграм/i.test(`${p.id} ${p.name}`);

/** Platforms a publisher can take: the plan's, minus the Telegram channel, plus stories and TikTok. */
export function platformsFor(studioDir) {
  const plan = (readJson(join(studioDir, 'strategy.json'), {}).platforms || []).filter((p) => p?.id && !isTg(p)).map((p) => ({id: String(p.id), name: String(p.name || p.id), account: p.account || ''}));
  if (!plan.some((p) => p.id === 'story')) plan.push({id: 'story', name: 'Instagram сторис'});
  if (!plan.some((p) => /tiktok/i.test(p.id + p.name))) plan.push({id: 'tiktok', name: 'TikTok'});
  return plan;
}

/** Where an item goes: its own list, else by format and language (an English reel → Instagram EN). */
export function platformsOf(item, studioDir) {
  if (item.platforms?.length) return item.platforms;
  if (item.format === 'telegram') return [];
  if (item.format === 'story') return ['story'];
  const ig = (readJson(join(studioDir, 'strategy.json'), {}).platforms || []).filter((p) => /ig|instagram/i.test(`${p.id} ${p.name}`));
  const en = /-en$/.test(item.ref?.id || '') || !/[а-яё]/i.test(item.title || '');
  const pick = ig.find((p) => (en ? /\ben\b|-en|EN/.test(`${p.id} ${p.name}`) : /\bru\b|-ru|RU/.test(`${p.id} ${p.name}`))) || ig[0];
  return pick ? [String(pick.id)] : [];
}

/** When the package goes out: before the time by the person's choice, or at 9:00 that day. */
export function sendAtFor(at, lead) {
  if (lead === '15m') return at - 15 * 60e3;
  if (lead === 'morning') {
    const d = new Date(at);
    d.setHours(MORNING, 0, 0, 0);
    return Math.min(d.getTime(), at - 60 * 60e3);
  }
  return at - 60 * 60e3;
}

const jobsFile = () => (MEMBERS ? join(dirname(MEMBERS), 'publish-jobs.json') : '');
const team = () => readJson(MEMBERS, {people: [], invites: []});

/** People who publish, with a linked Telegram chat. */
export function publishers() {
  if (!MEMBERS) return [];
  return team().people.filter((p) => p.publishes?.platforms?.length && p.telegram?.chatId);
}

/**
 * The publisher part of the bot. `studio()` the project folder, `projectName()` its title,
 * `owner()` → {chat, name}, `botName()` the bot's @username, `now()` the clock (tests).
 */
export function publisherUi({tg, studio, projectName, owner, botName, now = () => Date.now()}) {
  const wait = new Map(); // chat → {kind: 'link'|'reason'|'question', job?}
  const adding = new Map(); // owner chat → {step, name, role, platforms: [], lead}
  const html = (chat, text, markup, extra = {}) => tg.call('sendMessage', {chat_id: chat, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}, ...(markup ? {reply_markup: markup} : {}), ...extra});
  const kb = (rows) => ({inline_keyboard: rows.map((r) => r.map(([text, data]) => ({text, callback_data: data})))});
  const ownerName = () => owner().name || 'владелец';
  const menu = () => ({keyboard: [[{text: 'Сегодня'}, {text: 'Неделя'}], [{text: 'Выложено'}, {text: `Вопрос ${ownerName()}`}]], resize_keyboard: true, is_persistent: true});
  const loadJobs = () => readJson(jobsFile(), {jobs: {}, digests: {}});
  const saveJobs = (j) => jobsFile() && writeJson(jobsFile(), j);
  const plats = () => platformsFor(studio());
  const platName = (id) => plats().find((p) => p.id === id)?.name || id;
  const person = (chat) => team().people.find((p) => p.telegram?.chatId === chat && p.publishes);

  // ---------- what is on: items × platforms of this person ----------
  function slots(p, from, to) {
    const out = [];
    for (const item of loadItems(studio()).items) {
      if (!item.at || item.proposed || item.missing) continue;
      const at = Date.parse(item.at);
      if (!Number.isFinite(at) || at < from || at >= to) continue;
      for (const platform of platformsOf(item, studio())) if (p.publishes.platforms.includes(platform)) out.push({item, platform, at, key: `${item.id}|${platform}|${item.at}`});
    }
    return out.sort((a, b) => a.at - b.at);
  }
  const dayBounds = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return [d.getTime(), d.getTime() + 864e5]; };
  const row = (s, jobs) => {
    const j = jobs.jobs[jobId(s.key)];
    const mark = j?.done ? ' ✓' : j?.back ? ` · выложит ${esc(ownerName())}` : s.item.stage === 'ready' || s.item.stage === 'published' ? '' : ' · ещё не готово';
    return `<b>${hm(s.at)}</b>  ${KIND[s.item.format] || s.item.format} · ${esc(s.item.title)}${mark}\n      <i>${esc(platName(s.platform))}</i>`;
  };

  async function today(chat) {
    const p = person(chat);
    if (!p) return;
    const [a, b] = dayBounds(now());
    const list = slots(p, a, b), jobs = loadJobs();
    if (!list.length) return html(chat, 'Сегодня выходов нет. Если что-то появится — пришлю пакет заранее.', menu());
    const sends = [...new Set(list.filter((s) => s.item.stage === 'ready' && !jobs.jobs[jobId(s.key)]?.done).map((s) => hm(Math.max(sendAtFor(s.at, p.publishes.lead), a))))];
    return html(chat, `<b>Сегодня ${list.length} ${plural(list.length, 'выход', 'выхода', 'выходов')}</b>\n\n${list.map((s) => row(s, jobs)).join('\n')}${sends.length ? `\n\n<i>Пакеты придут в ${sends.join(', ')}.</i>` : ''}`, menu());
  }
  async function week(chat) {
    const p = person(chat);
    if (!p) return;
    const [a] = dayBounds(now());
    const list = slots(p, a, a + 7 * 864e5), jobs = loadJobs();
    if (!list.length) return html(chat, 'На неделю выходов нет.', menu());
    const by = new Map();
    for (const s of list) { const k = dayKey(s.at); by.set(k, [...(by.get(k) || []), s]); }
    return html(chat, `<b>Неделя</b>\n${[...by.values()].map((l) => `\n<b>${DAY_NAMES[new Date(l[0].at).getDay()]}, ${new Date(l[0].at).getDate()}</b>\n${l.map((s) => row(s, jobs)).join('\n')}`).join('\n')}`, menu());
  }
  async function posted(chat) {
    const p = person(chat);
    if (!p) return;
    const done = Object.values(loadJobs().jobs).filter((j) => j.person === p.id && j.done && now() - j.done < 14 * 864e5).sort((a, b) => b.done - a.done);
    if (!done.length) return html(chat, 'Пока ничего не выложено. Когда нажмёшь «Выложено» в пакете — появится здесь.', menu());
    return html(chat, `<b>Выложено за две недели</b>\n\n${done.map((j) => `✓ ${new Date(j.done).getDate()} ${DAYS[new Date(j.done).getDay()]} · ${esc(j.title)} · ${esc(platName(j.platform))}${j.link ? `\n      ${esc(j.link)}` : ''}`).join('\n')}`, menu());
  }

  // ---------- the package ----------
  /** Files, the caption and the checklist for one item on one platform. */
  function pack(item, platform) {
    const out = {files: [], caption: '', checks: [], link: '', note: ''};
    const pl = plats().find((p) => p.id === platform);
    const en = /en/i.test(platform) || /EN/.test(pl?.name || '');
    const pickCaption = (list) => {
      const caps = (list || []).filter((c) => c?.text);
      return (caps.find((c) => c.platform === pl?.name || (pl?.account && c.account === pl.account)) || caps.find((c) => new RegExp(en ? 'en' : 'ru', 'i').test(`${c.platform} ${c.account}`)) || caps.find((c) => !/телеграм|telegram/i.test(c.platform || '')))?.text || '';
    };
    if (item.ref?.kind === 'reel') {
      const reel = listReels(studio()).find((r) => r.folder === item.ref.id);
      const cur = reel?.versions?.[0];
      const vdir = cur && join(studio(), 'reels', item.ref.id, 'versions', cur.v);
      const video = cur && [cur.master, cur.copy].filter(Boolean).find((f) => statSync(f).size < 49e6);
      if (video) out.files.push({path: video, what: 'video'});
      else if (cur?.master) out.note = `Файл больше 50 МБ — Телеграм его не пропустит. Возьми из студии: ${basename(cur.master)}`;
      const cover = vdir && existsSync(vdir) && readdirSync(vdir).find((f) => /cover\.(png|jpe?g)$/i.test(f));
      if (cover) out.files.push({path: join(vdir, cover), what: 'cover'});
      const pub = readJson(join(studio(), 'reels', item.ref.id, 'publish.json'), {});
      out.caption = pickCaption(pub.captions);
      out.checks = ['звук ролика, музыку не добавлять', 'обложка — из файла обложки', ...(pub.checks || []).filter((c) => c?.text && !c.ok).map((c) => c.text).slice(0, 4)];
    } else if (item.ref?.kind === 'post') {
      const dir = postDir(studio(), item.ref.id);
      const post = dir ? readPost(dir) : {};
      if (dir) for (const f of postFiles(dir, en ? 'en' : 'ru')) out.files.push({path: f, what: 'slide'});
      out.caption = pickCaption(post.captions) || (post.texts || [])[Number(post.chosen) || 0]?.text || '';
      out.link = post.link || post.sticker?.url || '';
      out.checks = item.format === 'carousel' ? ['слайды по порядку, как в файлах', 'подпись — на языке площадки'] : [];
    }
    if (!out.caption) out.caption = '';
    return out;
  }

  async function sendPackage(chat, job, item, {head = ''} = {}) {
    const p = pack(item, job.platform);
    const kind = KIND[item.format] || item.format;
    const nfiles = p.files.length;
    const what = item.format === 'carousel' ? ` · ${nfiles} ${plural(nfiles, 'слайд', 'слайда', 'слайдов')} по порядку` : item.format === 'story' && nfiles ? ` · ${nfiles} ${plural(nfiles, 'кадр', 'кадра', 'кадров')}` : '';
    await html(chat, `${head}<b>${kind}</b> · ${esc(item.title)}\n${esc(platName(job.platform))} · выложить в ${hm(job.at)}${what}`);
    for (const f of p.files) {
      let caption = '';
      if (f.what === 'video') {
        const info = videoInfo(f.path);
        const mb = Math.round(statSync(f.path).size / 1048576);
        caption = `${info ? `${info.width}×${info.height} · ${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, '0')} · ` : ''}${mb} МБ · файлом, без сжатия`;
      } else if (f.what === 'cover') caption = 'обложка';
      await tg.sendFile(chat, f.path, {asDocument: true, caption, silent: true}).catch((e) => html(chat, `Не получилось отправить ${esc(basename(f.path))}: ${esc(e.message)}`));
    }
    if (p.note) await html(chat, esc(p.note));
    if (p.link) await html(chat, `Ссылка для стикера: <code>${esc(p.link)}</code>\n<i>нажми, чтобы скопировать</i>`);
    if (p.caption) await html(chat, `<pre>${esc(p.caption.slice(0, 3800))}</pre>\n<i>подпись · нажми, чтобы скопировать</i>`);
    else await html(chat, `<i>Подписи в студии нет — спроси ${esc(ownerName())}.</i>`);
    if (p.checks.length) await html(chat, `<b>Перед публикацией</b>\n${p.checks.map((c) => `☐ ${esc(c)}`).join('\n')}`);
    return html(chat, 'Как выложишь — отметь.', kb([[['Выложено', `pb:d:${job.id}`], ['Не получается', `pb:n:${job.id}`]]]));
  }

  // ---------- the clock: morning «Сегодня», packages, «Всё в порядке?» ----------
  async function tick() {
    const people = publishers();
    if (!people.length) return;
    const t = now(), jobs = loadJobs();
    for (const p of people) {
      const chat = p.telegram.chatId;
      if (new Date(t).getHours() >= MORNING && jobs.digests[p.id] !== dayKey(t)) {
        jobs.digests[p.id] = dayKey(t);
        saveJobs(jobs);
        if (slots(p, ...dayBounds(t)).length) await today(chat).catch(() => {});
      }
      for (const s of slots(p, t - 864e5, t + 2 * 864e5)) {
        const id = jobId(s.key);
        const j = jobs.jobs[id] || {id, key: s.key, item: s.item.id, title: s.item.title, format: s.item.format, platform: s.platform, at: s.at, person: p.id, name: p.name};
        if (j.done || j.back || j.moved || j.person !== p.id) continue;
        if (!j.sent && s.item.stage === 'ready' && t >= sendAtFor(s.at, p.publishes.lead) && t < s.at + 2 * 3600e3) {
          j.sent = t; jobs.jobs[id] = j;
          saveJobs(jobs);
          await sendPackage(chat, j, s.item).catch((e) => console.error('publisher', e.message));
        } else if (j.sent && !j.asked && t >= s.at + LATE_AFTER) {
          j.asked = t; jobs.jobs[id] = j;
          saveJobs(jobs);
          await html(chat, `${KIND[s.item.format] || 'Выпуск'} «${esc(s.item.title)}» должен был выйти в ${hm(s.at)}. Всё в порядке?`, kb([[['Выкладываю', `pb:y:${id}`], ['Не получается', `pb:n:${id}`]]]));
        }
      }
    }
  }

  // ---------- the publisher's buttons and messages ----------
  const findJob = (id) => loadJobs().jobs[id];
  const putJob = (j) => { const all = loadJobs(); all.jobs[j.id] = {...all.jobs[j.id], ...j}; saveJobs(all); return all.jobs[j.id]; };
  const itemOf = (j) => loadItems(studio()).items.find((x) => x.id === j.item);

  async function done(chat, j, link) {
    j = putJob({id: j.id, done: now(), link: link || ''});
    const item = itemOf(j);
    if (item) {
      // The item is out once every platform it goes to is marked.
      const left = platformsOf(item, studio()).filter((pl) => pl !== j.platform && !loadJobs().jobs[jobId(`${item.id}|${pl}|${item.at}`)]?.done);
      changeItem(studio(), item.id, {...(left.length ? {} : {stage: 'published'}), postedLink: {platform: j.platform, url: link || '', by: j.name, at: now()}}, {by: j.name});
    }
    await html(chat, link ? `Записал ✓ ${esc(ownerName())} увидит.` : `Отметил ✓ ${esc(ownerName())} увидит.`, menu());
    const o = owner();
    if (o.chat) await html(o.chat, `✓ <b>Вышло</b> · ${esc(j.title)} · ${(KIND[j.format] || '').toLowerCase()}\n<i>${esc(platName(j.platform))} · ${hm(now())} · ${esc(j.name)}</i>${link ? `\n<a href="${esc(link)}">открыть пост</a>` : ''}`);
  }

  async function onButton(q) {
    const chat = q.message.chat.id;
    const [, act, id, extra] = q.data.split(':');
    const j = findJob(id);
    tg.call('answerCallbackQuery', {callback_query_id: q.id}).catch(() => {});
    if (!j || j.person !== person(chat)?.id) return html(chat, 'Этот пакет уже не твой.');
    if (j.back) return html(chat, `${esc(ownerName())} выложит это сам — с тебя снято.`);
    if (act === 'd' || act === 'y') {
      wait.set(chat, {kind: 'link', job: id});
      return html(chat, act === 'y' ? 'Хорошо. Как выложишь — пришли ссылку на пост.' : 'Пришли ссылку на пост — запишу в выпуск.', kb([[['Без ссылки', `pb:x:${id}`]]]));
    }
    if (act === 'x') { wait.delete(chat); return done(chat, j, ''); }
    if (act === 'n') return html(chat, 'Что мешает?', kb([[['Нет доступа к аккаунту', `pb:r:${id}:access`]], [['Файл не открывается', `pb:r:${id}:file`]], [['Не успеваю сегодня', `pb:r:${id}:time`]], [['Другое — скажу голосом', `pb:r:${id}:other`]]]));
    if (act === 'r') {
      if (extra === 'other') { wait.set(chat, {kind: 'reason', job: id}); return html(chat, 'Скажи голосом или напиши, что случилось.'); }
      putJob({id, reason: REASONS[extra] || extra});
      return askWhere(chat, id);
    }
    if (act === 't') return moveTomorrow(chat, findJob(id));
    if (act === 'g') return giveBack(chat, findJob(id));
  }
  const askWhere = (chat, id) => { const j = findJob(id); return html(chat, `Перенести на завтра в ${hm(j.at)} или отдать ${esc(ownerName())} сейчас?`, kb([[['На завтра', `pb:t:${id}`], [`Отдать ${ownerName()}`, `pb:g:${id}`]]])); };

  async function moveTomorrow(chat, j) {
    const item = itemOf(j);
    if (!item) return html(chat, 'Этого выпуска уже нет.');
    const at = nextDay(item.at);
    changeItem(studio(), item.id, {at}, {by: j.name});
    putJob({id: j.id, moved: now()});
    const p = person(chat);
    const when = Date.parse(at);
    await html(chat, `Перенёс на ${DAYS[new Date(when).getDay()]}, ${hm(when)}. Пакет пришлю снова в ${hm(sendAtFor(when, p.publishes.lead))}. ${esc(ownerName())} написал.`, menu());
    const o = owner();
    if (o.chat) await html(o.chat, `⏳ <b>${esc(j.title)}</b> перенесена на завтра, ${hm(when)}\n<i>${esc(j.name)}: ${esc(j.reason || 'не получилось')}</i>`, kb([[['Хорошо', `po:ok:${j.id}`], ['Выложу сам', `po:s:${j.id}`]]]));
  }
  async function giveBack(chat, j) {
    putJob({id: j.id, back: now()});
    await html(chat, `Отдал ${esc(ownerName())} ✓ С тебя снято.`, menu());
    const o = owner(), item = itemOf(j);
    if (o.chat && item) await sendPackage(o.chat, j, item, {head: `↩️ ${esc(j.name)} отдал(а) выкладку: ${esc(j.reason || 'не получилось')}\n\n`});
  }

  /** A message from a publisher; false when it is not theirs to handle. */
  async function onMessage(msg) {
    const chat = msg.chat.id, p = person(chat);
    if (!p) return false;
    const text = msg.text?.trim() || '';
    if (text === '/start' || text === 'Сегодня') { wait.delete(chat); return today(chat); }
    if (text === 'Неделя') { wait.delete(chat); return week(chat); }
    if (text === 'Выложено') { wait.delete(chat); return posted(chat); }
    if (text.startsWith('Вопрос')) { wait.set(chat, {kind: 'question'}); return html(chat, `Напиши или скажи голосом — передам ${esc(ownerName())}.`); }
    const w = wait.get(chat);
    if (w?.kind === 'link') {
      const url = text.match(/https?:\/\/\S+|(?:www\.)?(?:instagram\.com|tiktok\.com)\/\S+/i)?.[0];
      if (!url) return html(chat, 'Не вижу ссылки. Пришли ссылку на пост или нажми «Без ссылки».');
      wait.delete(chat);
      return done(chat, findJob(w.job), url);
    }
    if (w?.kind === 'reason') {
      wait.delete(chat);
      putJob({id: w.job, reason: text || 'сказала голосом'});
      const o = owner();
      if (o.chat && !text) await tg.call('copyMessage', {chat_id: o.chat, from_chat_id: chat, message_id: msg.message_id}).catch(() => {});
      return askWhere(chat, w.job);
    }
    // Anything else is a question to the owner; the owner's reply comes back here.
    wait.delete(chat);
    const o = owner();
    if (!o.chat) return html(chat, 'Сейчас некому передать — попробуй позже.');
    const m = await html(o.chat, `❓ <b>${esc(p.name)}</b> (выкладывает)${text ? `:\n${esc(text)}` : ' — голосом, ниже'}\n<i>Ответь на это сообщение — передам.</i>`).catch(() => null);
    if (!text) await tg.call('copyMessage', {chat_id: o.chat, from_chat_id: chat, message_id: msg.message_id}).catch(() => {});
    if (m?.message_id) { const all = loadJobs(); all.asks = {...all.asks, [m.message_id]: chat}; saveJobs(all); }
    return html(chat, `Передал ${esc(ownerName())} — ответ придёт сюда.`);
  }

  async function welcome(chat, name) {
    const p = person(chat);
    if (p) { const all = loadJobs(); all.digests[p.id] = dayKey(now()); saveJobs(all); }
    const pl = (p?.publishes.platforms || []).map(platName).join(', ');
    await html(chat, `Привет, ${esc(name)}! ${esc(ownerName())} добавил тебя в студию ${esc(projectName())}: ты выкладываешь${pl ? ` — ${esc(pl)}` : ''}.\n\nГотовое присылаю ${LEAD_TEXT[p?.publishes.lead] || LEAD_TEXT['1h']}: файл в полном качестве, обложку, подпись и что отметить. Снимать и монтировать ничего не нужно.`, menu());
    return today(chat);
  }

  // ---------- the owner: adding a person, outcomes, replies ----------
  const ADD = /^(\/add|➕?\s*добавить человека)$/i;
  async function onOwnerMessage(msg) {
    const chat = msg.chat.id, text = msg.text?.trim() || '';
    // A reply to a forwarded question goes back to the person.
    const to = msg.reply_to_message && loadJobs().asks?.[msg.reply_to_message.message_id];
    if (to) {
      if (text) await html(to, `<b>${esc(ownerName())}:</b> ${esc(text)}`);
      else await tg.call('copyMessage', {chat_id: to, from_chat_id: chat, message_id: msg.message_id}).catch(() => {});
      await html(chat, 'Передал ✓');
      return true;
    }
    if (ADD.test(text)) { adding.set(chat, {step: 'name', platforms: []}); await html(chat, 'Как зовут человека?'); return true; }
    const a = adding.get(chat);
    if (a?.step === 'name' && text) {
      a.name = text.slice(0, 60); a.step = 'role';
      await html(chat, `Кем ${esc(a.name)} будет в студии?`, kb([[['Снимает и скидывает материал', 'po:ar:member']], [['Выкладывает готовое', 'po:ar:pub']], [['Ведёт студию вместе со мной', 'po:ar:editor']]]));
      return true;
    }
    return false;
  }
  const platKeys = (a) => {
    const rows = [], all = plats();
    for (let i = 0; i < all.length; i += 2) rows.push(all.slice(i, i + 2).map((p) => [`${a.platforms.includes(p.id) ? '✓ ' : ''}${p.name}`, `po:ap:${p.id}`]));
    rows.push([['Дальше', 'po:an']]);
    return kb(rows);
  };
  async function invite(chat, a) {
    const t = team();
    const pins = new Set(t.invites.map((x) => x.pin));
    let pin; do pin = String(100000 + Math.floor(Math.random() * 900000)); while (pins.has(pin));
    const inv = {code: randomBytes(18).toString('base64url'), pin, name: a.name, note: '', role: a.role === 'editor' ? 'editor' : 'member', onCamera: false, web: a.role === 'editor',
      telegram: true, expires: now() + 864e5, claimed: [], ...(a.role === 'pub' ? {publishes: {platforms: a.platforms, lead: a.lead}} : {}), by: 'бот'};
    t.invites.push(inv);
    writeJson(MEMBERS, t);
    adding.delete(chat);
    const start = `${process.env.RELAY_NODE && process.env.TG_RELAY ? `${process.env.RELAY_NODE}--` : ''}inv_${inv.code}`;
    const link = botName() ? `https://t.me/${botName()}?start=${start}` : '';
    const tail = a.role === 'pub' ? `\n\nПакеты по этим площадкам (${esc(a.platforms.map(platName).join(', '))}) теперь идут ${esc(a.name)}. Тебе — короткая отметка «вышло» со ссылкой.` : '';
    return html(chat, `${esc(a.name)} — ссылка-приглашение: ${link ? esc(link) : `код ${pin}`}\n<i>действует сутки, одна на человека${link ? ` · или код ${pin}` : ''}</i>${tail}`);
  }
  async function onOwnerButton(q) {
    const chat = q.message.chat.id;
    const [, act, arg] = q.data.split(':');
    tg.call('answerCallbackQuery', {callback_query_id: q.id}).catch(() => {});
    const a = adding.get(chat);
    if (act === 'ar' && a) {
      a.role = arg;
      if (arg !== 'pub') return invite(chat, a);
      a.step = 'platforms';
      return html(chat, 'Какие площадки на нём? Телеграм-канал выходит сам, его не отдаём.', platKeys(a));
    }
    if (act === 'ap' && a) {
      a.platforms = a.platforms.includes(arg) ? a.platforms.filter((x) => x !== arg) : [...a.platforms, arg];
      return tg.call('editMessageReplyMarkup', {chat_id: chat, message_id: q.message.message_id, reply_markup: platKeys(a)}).catch(() => {});
    }
    if (act === 'an' && a) {
      if (!a.platforms.length) return html(chat, 'Отметь хотя бы одну площадку.');
      a.step = 'lead';
      return html(chat, 'Когда присылать ему готовое?', kb([Object.entries(LEADS).map(([k, t]) => [t, `po:al:${k}`])]));
    }
    if (act === 'al' && a) { a.lead = LEADS[arg] ? arg : '1h'; return invite(chat, a); }
    if (act === 'ok') return tg.call('editMessageReplyMarkup', {chat_id: chat, message_id: q.message.message_id, reply_markup: {inline_keyboard: []}}).catch(() => {});
    if (act === 's') {
      const old = findJob(arg);
      const item = old && itemOf(old);
      if (!item) return html(chat, 'Этого выпуска уже нет.');
      // The moved item has a new time: its job goes to the owner, the publisher is off it.
      const key = `${item.id}|${old.platform}|${item.at}`;
      const j = putJob({id: jobId(key), key, item: item.id, title: item.title, format: item.format, platform: old.platform, at: Date.parse(item.at), person: old.person, name: old.name, back: now()});
      await tg.call('editMessageReplyMarkup', {chat_id: chat, message_id: q.message.message_id, reply_markup: {inline_keyboard: []}}).catch(() => {});
      await html(chat, `Пакет ниже — тот же, что у ${esc(old.name)}; с ${esc(old.name)} снял.`);
      await sendPackage(chat, j, item);
      const pc = team().people.find((p) => p.id === old.person)?.telegram?.chatId;
      if (pc) await html(pc, `«${esc(item.title)}» ${esc(ownerName())} выложит сам — с тебя снято.`, menu());
    }
  }

  return {tick, onMessage, onButton, welcome, onOwnerMessage, onOwnerButton, today, pack};
}

const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
