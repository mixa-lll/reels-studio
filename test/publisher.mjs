// The «Выкладывает» role end to end (bot/publisher.mjs, canvas botlean В1–В6), on a fake
// Telegram and a hand-moved clock: the owner adds a person from the bot, the person joins,
// gets «Сегодня», packages of three kinds come on time, a late carousel is moved to tomorrow
// and the owner takes it over, a question goes to the owner and the reply comes back.
//   node test/publisher.mjs
import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'pub-'));
process.env.REELS_MEMBERS = join(tmp, 'shared', 'access.json');
mkdirSync(join(tmp, 'shared'));
const OWNER = 11, ANYA = 500;
writeFileSync(process.env.REELS_MEMBERS, JSON.stringify({people: [{id: 'owner', name: 'Миша', role: 'editor', isOwner: true}], invites: [], sessions: []}));

// A studio: strategy, a ready reel with a master and a cover, a carousel, a story.
const studio = join(tmp, 'studio');
const w = (f, v) => { mkdirSync(join(f, '..'), {recursive: true}); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
w(join(studio, 'strategy.json'), {platforms: [{id: 'ig-en', name: 'Instagram EN', account: '@my.gudauri'}, {id: 'ig-ru', name: 'Instagram RU', account: '@my.gudauri_ru'}, {id: 'tg', name: 'Телеграм'}]});
const vdir = join(studio, 'reels', '05-snowboard-vs-ski', 'versions', 'v2');
mkdirSync(vdir, {recursive: true});
copyFileSync(join(HERE, 'fixtures', 'vertical.mp4'), join(vdir, 'snowboard-vs-ski-v2-1080p.mp4'));
copyFileSync(join(HERE, 'fixtures', 'vertical.thumb.jpg'), join(vdir, 'snowboard-vs-ski-v2-cover.jpg'));
w(join(studio, 'reels', '05-snowboard-vs-ski', 'README.md'), '# 05 Сноуборд против лыж\n');
w(join(studio, 'reels', '05-snowboard-vs-ski', 'publish.json'), {captions: [{platform: 'Instagram RU', text: 'Лыжник видит сноубордиста посреди трассы. Кто вы?'}, {platform: 'Телеграм', text: 'не то'}], checks: [{ok: false, text: 'отметить @mygudauri'}]});
for (const [id, kind, n] of [['01-map', 'carousel', 3], ['02-now', 'photo', 1]]) {
  w(join(studio, 'posts', id, 'post.json'), {kind, title: id, captions: [{platform: 'Instagram EN', text: 'Gudauri ski map in 3 slides.'}], ...(kind === 'photo' ? {photos: [{out: 'images/now.jpg', chosen: true}], link: 'https://mygudauri.org/now'} : {})});
  mkdirSync(join(studio, 'posts', id, 'images'), {recursive: true});
  for (let i = 1; i <= n; i++) copyFileSync(join(HERE, 'fixtures', 'vertical.thumb.jpg'), join(studio, 'posts', id, 'images', kind === 'photo' ? 'now.jpg' : `slide-0${i}.png`));
}
const DAY = '2026-11-10';
w(join(studio, 'items.json'), {v: 1, items: [
  {id: 'i-reel', format: 'reel', title: 'Сноуборд против лыж', stage: 'ready', at: `${DAY}T18:00`, ref: {kind: 'reel', id: '05-snowboard-vs-ski'}},
  {id: 'i-car', format: 'carousel', title: 'Карта трасс', stage: 'ready', at: `${DAY}T19:00`, platforms: ['ig-en'], ref: {kind: 'post', id: '01-map'}},
  {id: 'i-story', format: 'story', title: 'Снег сейчас', stage: 'ready', at: `${DAY}T12:00`, ref: {kind: 'post', id: '02-now'}},
  {id: 'i-tg', format: 'telegram', title: 'Канал', stage: 'ready', at: `${DAY}T13:00`},
  {id: 'i-wip', format: 'reel', title: 'Ещё монтируется', stage: 'build', at: `${DAY}T20:00`},
]});

const {publisherUi} = await import('../bot/publisher.mjs');
const {claim, member} = await import('../bot/members.mjs');

// A fake Telegram that keeps everything sent, per chat.
const sent = [];
let mid = 1000;
const tg = {
  async call(method, p) { sent.push({method, ...p}); return {message_id: ++mid}; },
  async sendFile(chat_id, path, opts) { sent.push({method: 'sendFile', chat_id, path, ...opts}); return {message_id: ++mid}; },
};
let T = Date.parse(`${DAY}T08:00`);
const ui = publisherUi({tg, studio: () => studio, projectName: () => 'My Gudauri', owner: () => ({chat: OWNER, name: 'Миша'}), botName: () => 'mygudauri_bot', now: () => T});
const to = (chat) => sent.filter((m) => m.chat_id === chat);
const texts = (chat) => to(chat).map((m) => m.text || m.caption || '').join('\n---\n');
const lastKb = (chat) => to(chat).filter((m) => m.reply_markup?.inline_keyboard).at(-1)?.reply_markup.inline_keyboard.flat();
const press = (chat, data, fn = 'onButton') => ui[fn]({id: 'q', data, from: {id: chat}, message: {chat: {id: chat}, message_id: 1}});
const say = (chat, text, extra = {}) => (chat === OWNER ? ui.onOwnerMessage : ui.onMessage)({chat: {id: chat}, from: {id: chat}, message_id: ++mid, text, ...extra});
const items = () => JSON.parse(readFileSync(join(studio, 'items.json'), 'utf8')).items;
const step = (name) => console.log(`✓ ${name}`);

// В1: the owner adds Аня from the bot.
assert.equal(await say(OWNER, 'Добавить человека'), true);
await say(OWNER, 'Аня');
assert.deepEqual(lastKb(OWNER).map((b) => b.text), ['Снимает и скидывает материал', 'Выкладывает готовое', 'Ведёт студию вместе со мной']);
await press(OWNER, 'po:ar:pub', 'onOwnerButton');
assert.match(texts(OWNER), /Телеграм-канал выходит сам/);
assert.ok(!lastKb(OWNER).some((b) => /Телеграм/.test(b.text)), 'the channel is never offered');
for (const p of ['ig-ru', 'ig-en', 'story']) await press(OWNER, `po:ap:${p}`, 'onOwnerButton');
await press(OWNER, 'po:an', 'onOwnerButton');
await press(OWNER, 'po:al:1h', 'onOwnerButton');
const inv = JSON.parse(readFileSync(process.env.REELS_MEMBERS, 'utf8')).invites[0];
assert.deepEqual(inv.publishes, {platforms: ['ig-ru', 'ig-en', 'story'], lead: '1h'});
assert.ok(inv.expires - T <= 864e5, 'link lives a day');
assert.match(texts(OWNER), /t\.me\/mygudauri_bot\?start=inv_/);
step('В1 владелец добавил Аню: площадки, «за час», ссылка на сутки');

// В2: Аня joins by the link and gets «Сегодня».
const joined = claim(inv.code, {id: ANYA, first_name: 'Аня'}, ANYA);
assert.equal(joined.role, 'publisher');
assert.equal(member(ANYA).role, 'publisher');
assert.equal(JSON.parse(readFileSync(process.env.REELS_MEMBERS, 'utf8')).invites.length, 0, 'one link per person');
await ui.welcome(ANYA, 'Аня');
let a = texts(ANYA);
assert.match(a, /ты выкладываешь/);
assert.match(a, /Сегодня 4 выхода/);
assert.match(a, /Ещё монтируется · ещё не готово/);
assert.match(a, /12:00.*Сторис · Снег сейчас/);
assert.match(a, /Instagram RU/);
assert.doesNotMatch(a, /Канал/, 'no Telegram channel');
assert.match(a, /Пакеты придут в 11:00, 17:00, 18:00/);
assert.deepEqual(to(ANYA).at(-1).reply_markup.keyboard.flat().map((b) => b.text), ['Сегодня', 'Неделя', 'Выложено', 'Вопрос Миша']);
step('В2 Аня вошла: «Сегодня» с выходами дня (неготовое помечено) и меню');

// Nothing before its time.
T = Date.parse(`${DAY}T10:59`); let n = sent.length; await ui.tick();
assert.equal(sent.length, n, 'no package before the lead time');

// В4: the story at 11:00 for 12:00 — the frame, the sticker link, the buttons.
T = Date.parse(`${DAY}T11:00`); n = sent.length; await ui.tick();
let pkg = sent.slice(n);
assert.match(pkg[0].text, /Сторис.*Снег сейчас\nInstagram сторис · выложить в 12:00 · 1 кадр/);
assert.ok(pkg.some((m) => m.method === 'sendFile' && m.asDocument && m.path.endsWith('now.jpg')));
assert.ok(pkg.some((m) => /Ссылка для стикера.*mygudauri\.org\/now/.test(m.text || '')));
assert.deepEqual(pkg.at(-1).reply_markup.inline_keyboard.flat().map((b) => b.text), ['Выложено', 'Не получается']);
await ui.tick();
assert.equal(sent.length, n + pkg.length, 'a package goes once');
const storyJob = pkg.at(-1).reply_markup.inline_keyboard[0][0].callback_data.split(':')[2];
await press(ANYA, `pb:d:${storyJob}`);
await press(ANYA, `pb:x:${storyJob}`);
assert.match(texts(OWNER), /✓ <b>Вышло<\/b> · Снег сейчас · сторис/);
step('В4 сторис: кадр файлом, ссылка для стикера, «Выложено» без ссылки → владельцу «Вышло»');

// В3: the reel at 17:00 for 18:00 — video as a document with its size, the cover, the caption.
T = Date.parse(`${DAY}T17:00`); n = sent.length; await ui.tick();
pkg = sent.slice(n);
assert.match(pkg[0].text, /Рилс.*Сноуборд против лыж[\s\S]*Instagram RU · выложить в 18:00/);
const video = pkg.find((m) => m.method === 'sendFile' && m.path.endsWith('.mp4'));
assert.ok(video.asDocument, 'the reel goes as a document, without recompression');
assert.match(video.caption, /\d+×\d+ · \d:\d\d · \d+ МБ · файлом, без сжатия/);
assert.ok(pkg.some((m) => m.method === 'sendFile' && /cover/.test(m.path) && m.asDocument));
assert.ok(pkg.some((m) => /<pre>Лыжник видит сноубордиста/.test(m.text || '')), 'the Instagram RU caption, copyable');
assert.ok(!pkg.some((m) => /не то/.test(m.text || '')), 'not the Telegram caption');
assert.ok(pkg.some((m) => /Перед публикацией[\s\S]*отметить @mygudauri/.test(m.text || '')));
const reelJob = pkg.at(-1).reply_markup.inline_keyboard[0][0].callback_data.split(':')[2];
T = Date.parse(`${DAY}T18:03`);
await press(ANYA, `pb:d:${reelJob}`);
await say(ANYA, 'https://instagram.com/reel/abc');
assert.match(texts(ANYA), /Записал ✓/);
const reel = items().find((x) => x.id === 'i-reel');
assert.equal(reel.stage, 'published');
assert.equal(reel.posted[0].url, 'https://instagram.com/reel/abc');
assert.match(texts(OWNER), /Вышло<\/b> · Сноуборд против лыж · рилс\n<i>Instagram RU · 18:03 · Аня<\/i>\n<a href="https:\/\/instagram\.com\/reel\/abc">/);
step('В3 рилс: видео документом с размером, обложка, подпись RU, чек-лист; ссылка → выпуск «Вышло»');

// В4: the carousel at 18:00 for 19:00 — slides in order, the EN caption.
T = Date.parse(`${DAY}T18:00`); n = sent.length; await ui.tick();
pkg = sent.slice(n);
assert.match(pkg[0].text, /Карусель.*Карта трасс[\s\S]*Instagram EN · выложить в 19:00 · 3 слайда по порядку/);
assert.deepEqual(pkg.filter((m) => m.method === 'sendFile').map((m) => m.path.split('/').pop()), ['slide-01.png', 'slide-02.png', 'slide-03.png']);
assert.ok(pkg.some((m) => /<pre>Gudauri ski map/.test(m.text || '')));
const carJob = pkg.at(-1).reply_markup.inline_keyboard[0][0].callback_data.split(':')[2];
step('В4 карусель: слайды файлами по порядку, подпись EN');

// В5: 19:15 without a mark — «Всё в порядке?», reason, to tomorrow.
T = Date.parse(`${DAY}T19:14`); n = sent.length; await ui.tick();
assert.equal(sent.length, n, 'not late yet');
T = Date.parse(`${DAY}T19:15`); await ui.tick();
assert.match(texts(ANYA), /должен был выйти в 19:00. Всё в порядке\?/);
assert.deepEqual(lastKb(ANYA).map((b) => b.text), ['Выкладываю', 'Не получается']);
await press(ANYA, `pb:n:${carJob}`);
assert.deepEqual(lastKb(ANYA).map((b) => b.text), ['Нет доступа к аккаунту', 'Файл не открывается', 'Не успеваю сегодня', 'Другое — скажу голосом']);
await press(ANYA, `pb:r:${carJob}:time`);
assert.deepEqual(lastKb(ANYA).map((b) => b.text), ['На завтра', 'Отдать Миша']);
await press(ANYA, `pb:t:${carJob}`);
assert.equal(items().find((x) => x.id === 'i-car').at, '2026-11-11T19:00');
assert.match(texts(ANYA), /Перенёс на ср, 19:00. Пакет пришлю снова в 18:00/);
assert.match(texts(OWNER), /⏳ <b>Карта трасс<\/b> перенесена на завтра, 19:00\n<i>Аня: не успеваю сегодня<\/i>/);
assert.deepEqual(lastKb(OWNER).map((b) => b.text), ['Хорошо', 'Выложу сам']);
step('В5 опоздание: «Всё в порядке?» → причина → «На завтра», выпуск перенесён');

// В6: the owner takes it — the same package to the owner, Аня is off it.
n = sent.length;
await press(OWNER, `po:s:${carJob}`, 'onOwnerButton');
pkg = sent.slice(n);
assert.ok(pkg.some((m) => m.chat_id === OWNER && /то же, что у Ани|что у Аня/.test(m.text || '')));
assert.equal(pkg.filter((m) => m.chat_id === OWNER && m.method === 'sendFile').length, 3);
assert.ok(pkg.some((m) => m.chat_id === ANYA && /выложит сам — с тебя снято/.test(m.text || '')));
T = Date.parse('2026-11-11T18:00'); n = sent.length; await ui.tick();
assert.ok(!sent.slice(n).some((m) => m.chat_id === ANYA && /<b>Карусель<\/b>/.test(m.text || '')), 'no package to Аня for the taken item');
assert.match(texts(ANYA), /Карта трасс · выложит Миша/, 'her morning list says the owner has it');
step('В6 владелец: «Выложу сам» → пакет ему, у Ани снято, завтра ей не приходит');

// «Отдать Мише» straight from the package.
w(join(studio, 'items.json'), {v: 1, items: [...items(), {id: 'i-r2', format: 'reel', title: 'Цены', stage: 'ready', at: '2026-11-11T21:00', ref: {kind: 'reel', id: '05-snowboard-vs-ski'}}]});
T = Date.parse('2026-11-11T20:00'); n = sent.length; await ui.tick();
const r2 = sent.slice(n).at(-1).reply_markup.inline_keyboard[0][0].callback_data.split(':')[2];
await press(ANYA, `pb:n:${r2}`);
await press(ANYA, `pb:r:${r2}:access`);
n = sent.length;
await press(ANYA, `pb:g:${r2}`);
assert.ok(sent.slice(n).some((m) => m.chat_id === OWNER && /Аня отдал\(а\) выкладку: нет доступа к аккаунту/.test(m.text || '')));
assert.ok(sent.slice(n).some((m) => m.chat_id === OWNER && m.method === 'sendFile' && m.path.endsWith('.mp4')));
step('«Отдать Мише»: пакет с причиной уходит владельцу');

// «Вопрос Мише»: the question goes to the owner, the reply comes back.
await say(ANYA, 'Вопрос Миша');
await say(ANYA, 'а если выложу раньше?');
const q = to(OWNER).at(-1);
assert.match(q.text, /❓ <b>Аня<\/b> \(выкладывает\):\nа если выложу раньше\?/);
// The owner replies to the question's message (its id is what the fake returned for it).
const qid = JSON.parse(readFileSync(join(tmp, 'shared', 'publish-jobs.json'), 'utf8')).asks;
const askId = Number(Object.keys(qid)[0]);
await say(OWNER, 'Не надо: время выбрано под охваты.', {reply_to_message: {message_id: askId}});
assert.match(texts(ANYA), /<b>Миша:<\/b> Не надо: время выбрано под охваты\./);
step('«Вопрос Мише»: вопрос владельцу, ответ реплаем — обратно Ане');

// «Неделя» and «Выложено».
await say(ANYA, 'Неделя');
assert.match(to(ANYA).at(-1).text, /<b>Неделя<\/b>/);
await say(ANYA, 'Выложено');
assert.match(to(ANYA).at(-1).text, /Сноуборд против лыж · Instagram RU\n\s+https:\/\/instagram\.com\/reel\/abc/);
step('меню: «Неделя», «Выложено» со ссылками');

console.log('\nВсе шаги роли «Выкладывает» прошли.');
