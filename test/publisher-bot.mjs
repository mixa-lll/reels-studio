// The «Выкладывает» role through the real bot process on a fake Telegram (test/publisher.mjs
// covers every branch with a hand-moved clock; this one checks the wiring in bot/bot.mjs):
// the owner adds a person by «Добавить человека», the person joins by the link, gets a story
// package on the bot's own 30-second clock, marks it posted with a link, the owner sees «Вышло».
//   node test/publisher-bot.mjs   (about 40 s)
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fakeTelegram} from './fake-telegram.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const data = mkdtempSync(join(tmpdir(), 'reels-pub-'));
const OWNER = 5, ANYA = 500;
const members = join(data, 'shared', 'access.json');
mkdirSync(join(data, 'shared'), {recursive: true});
writeFileSync(members, JSON.stringify({people: [], invites: [], sessions: []}));

// A project with one story ready to go out in half an hour.
const studio = join(data, 'projects', 'main');
mkdirSync(join(studio, 'posts', '02-now', 'images'), {recursive: true});
writeFileSync(join(studio, 'settings.json'), JSON.stringify({name: 'My Gudauri'}));
writeFileSync(join(studio, 'strategy.json'), JSON.stringify({platforms: [{id: 'ig-ru', name: 'Instagram RU'}, {id: 'tg', name: 'Телеграм'}]}));
copyFileSync(join(ROOT, 'test', 'fixtures', 'vertical.thumb.jpg'), join(studio, 'posts', '02-now', 'images', 'now.jpg'));
writeFileSync(join(studio, 'posts', '02-now', 'post.json'), JSON.stringify({kind: 'photo', title: 'Снег сейчас', photos: [{out: 'images/now.jpg', chosen: true}], captions: [{platform: 'Instagram RU', text: 'Снег сейчас — смотри камеры.'}]}));
const d = new Date(Date.now() + 30 * 60e3);
const at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
writeFileSync(join(studio, 'items.json'), JSON.stringify({v: 1, items: [{id: 'i-story', format: 'story', title: 'Снег сейчас', stage: 'ready', at, ref: {kind: 'post', id: '02-now'}}]}));

const tg = await fakeTelegram();
const env = {
  ...process.env, TELEGRAM_BOT_TOKEN: '1:test', REELS_TELEGRAM_API: tg.url, REELS_HTTP_TIMEOUT: '1500',
  AGENT: 'claude', AGENT_BIN: '/usr/bin/false', OWNER_CODE: 'abc', BOT_LANG: 'ru', REELS_MEMBERS: members,
  REELS_DATA: join(data, 'data'), REELS_PROJECTS: join(data, 'projects'), REELS_BOT_SUPERVISED: '1',
};
const bot = spawn(process.execPath, ['bot/bot.mjs'], {cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit']});
const step = (s) => console.log(`✓ ${s}`);
const waitIn = async (chat, re, ms = 20_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const m = tg.sent.find((s) => String(s.chat_id) === String(chat) && re.test(s.text ?? ''));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${re} in chat ${chat}; got: ${tg.sent.filter((s) => String(s.chat_id) === String(chat)).map((s) => JSON.stringify(s.text ?? s.method).slice(0, 70)).join(' | ')}`);
};
try {
  tg.message(OWNER, '/start abc');
  await new Promise((r) => setTimeout(r, 2500));
  tg.message(OWNER, 'Добавить человека');
  await waitIn(OWNER, /Как зовут человека/);
  tg.message(OWNER, 'Аня');
  await waitIn(OWNER, /Кем Аня будет в студии/);
  tg.tap(OWNER, 'po:ar:pub');
  await waitIn(OWNER, /Телеграм-канал выходит сам/);
  tg.tap(OWNER, 'po:ap:ig-ru');
  tg.tap(OWNER, 'po:ap:story');
  tg.tap(OWNER, 'po:an');
  await waitIn(OWNER, /Когда присылать/);
  tg.tap(OWNER, 'po:al:1h');
  await waitIn(OWNER, /Аня — ссылка-приглашение/);
  step('владелец: «Добавить человека» → роль, площадки, срок → ссылка');

  const inv = JSON.parse(readFileSync(members, 'utf8')).invites[0];
  tg.message(ANYA, `/start inv_${inv.code}`);
  await waitIn(ANYA, /ты выкладываешь/);
  await waitIn(ANYA, /Сегодня 1 выход/);
  step('Аня вошла по ссылке: приветствие и «Сегодня»');

  const head = await waitIn(ANYA, /<b>Сторис<\/b> · Снег сейчас/, 45_000);
  assert.ok(tg.sent.some((s) => s.method === 'sendDocument'), 'the frame goes as a document');
  const btn = await waitIn(ANYA, /Как выложишь — отметь/);
  const job = btn.reply_markup.inline_keyboard[0][0].callback_data.split(':')[2];
  void head;
  step('пакет пришёл по часам бота: заголовок, кадр файлом, кнопки');

  tg.tap(ANYA, `pb:d:${job}`);
  await waitIn(ANYA, /Пришли ссылку на пост/);
  tg.message(ANYA, 'https://instagram.com/stories/x/1');
  await waitIn(ANYA, /Записал ✓/);
  await waitIn(OWNER, /Вышло<\/b> · Снег сейчас · сторис/);
  const item = JSON.parse(readFileSync(join(studio, 'items.json'), 'utf8')).items[0];
  assert.equal(item.stage, 'published');
  step('«Выложено» + ссылка → выпуск «Вышло», владельцу итог');
  console.log('\nРоль «Выкладывает» работает в настоящем процессе бота.');
} finally {
  bot.kill();
  tg.close();
}
