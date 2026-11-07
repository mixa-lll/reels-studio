// Direct download links (web/dllink.mjs) against the real web server and bot/send.mjs on a fake
// Telegram: a good link gives the master with its name, ranges work, a changed, expired or
// escaping link gives nothing, the session stays required elsewhere, the token stays out of logs.
//   node test/dllink.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fakeTelegram} from './fake-telegram.mjs';
import {readLink, reelLink, signLink} from '../web/dllink.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'test-key-0123456789abcdef', PORT = 8097, ORIGIN = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'reels-dl-'));
const vdir = join(root, 'projects', 'main', 'reels', '05-snow', 'versions', 'v2');
mkdirSync(vdir, {recursive: true});
const fixture = join(ROOT, 'test', 'fixtures', 'vertical.mp4');
copyFileSync(fixture, join(vdir, 'snow-v2.mp4'));
writeFileSync(join(vdir, 'snow-v2-1080p.mp4'), Buffer.alloc(200000, 7));
writeFileSync(join(root, 'secret.txt'), 'nope');
const step = (s) => console.log(`✓ ${s}`);

// Tokens on their own.
const {token, expires} = signLink(KEY, 'main/x.mp4', 1000);
assert.deepEqual(readLink(KEY, token, 2000), {rel: 'main/x.mp4', expires});
assert.deepEqual(readLink(KEY, token, expires + 1), {expired: true});
assert.equal(readLink('other-key', token, 2000), null);
assert.equal(readLink(KEY, token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), 2000), null);
assert.equal(readLink(KEY, 'junk', 2000), null);
assert.equal(expires - 1000, 14 * 864e5);
step('токен: подпись, срок 14 дней, чужой ключ и подделка не проходят');

const server = spawn(process.execPath, ['web/server.mjs'], {cwd: ROOT, env: {...process.env, WEB_KEY: KEY, PORT: String(PORT), REELS_BOT_ROOT: root, REELS_MEMBERS: join(root, 'shared', 'access.json')}, stdio: 'ignore'});
mkdirSync(join(root, 'shared'), {recursive: true});
const tg = await fakeTelegram();
try {
  for (let i = 0; i < 50; i++) { try { await fetch(ORIGIN + '/login'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const link = reelLink(join(vdir, 'snow-v2.mp4'), {projects: join(root, 'projects'), key: KEY, origin: ORIGIN});
  assert.ok(link.url.endsWith('/snow-v2-1080p.mp4'), 'the master, not the copy that was sent');

  let r = await fetch(link.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), "attachment; filename*=UTF-8''snow-v2-1080p.mp4");
  assert.equal(r.headers.get('content-length'), '200000');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await r.arrayBuffer()).byteLength, 200000);
  step('ссылка без входа отдаёт мастер целиком, с именем файла');

  r = await fetch(link.url, {headers: {range: 'bytes=100-199'}});
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  step('докачка: диапазоны работают');

  const [, , t, name] = new URL(link.url).pathname.split('/');
  assert.equal((await fetch(`${ORIGIN}/d/${t.slice(0, -2)}xx/${name}`)).status, 404);
  assert.equal((await fetch(`${ORIGIN}/d/${signLink(KEY, 'main/reels/05-snow/versions/v2/snow-v2.mp4', Date.now() - 15 * 864e5).token}/x`)).status, 410);
  assert.equal((await fetch(`${ORIGIN}/d/${signLink(KEY, '../secret.txt').token}/x`)).status, 404);
  assert.equal((await fetch(`${ORIGIN}/d/${signLink(KEY, 'main/nothing.mp4').token}/x`)).status, 404);
  assert.equal((await fetch(`${ORIGIN}/media?p=${encodeURIComponent(join(vdir, 'snow-v2.mp4'))}`)).status, 401);
  step('подделка 404, истёкшая 410, вне папки проектов 404, /media по-прежнему со входом');

  const logged = ['data/shared/log.jsonl', 'shared/log.jsonl'].map((f) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return ''; } }).join('');
  assert.match(logged, /скачан файл snow-v2-1080p\.mp4/);
  assert.ok(!logged.includes(t), 'no token in the log');
  step('в журнале имя файла, токена нет');

  const state = join(root, 'tgdata');
  mkdirSync(state, {recursive: true});
  writeFileSync(join(state, 'state.json'), JSON.stringify({ownerId: 5, chatId: 5, project: 'main'}));
  const env = {...process.env, TELEGRAM_BOT_TOKEN: '1:test', REELS_TELEGRAM_API: tg.url, WEB_KEY: KEY, MINIAPP_URL: 'https://studio.test/app', REELS_DATA: state, REELS_PROJECTS: join(root, 'projects'), BOT_LANG: 'ru'};
  const code = await new Promise((res) => spawn(process.execPath, ['bot/send.mjs', '--file', join(vdir, 'snow-v2.mp4'), '--caption', '05 «Снег» · v2'], {cwd: ROOT, env, stdio: 'ignore'}).on('exit', res));
  assert.equal(code, 0);
  const video = tg.sent.find((m) => m.method === 'sendVideo');
  assert.match(video.raw, /Прямая ссылка · до /);
  assert.match(video.raw, /https:\/\/studio\.test\/d\/[\w.-]+\/snow-v2-1080p\.mp4/);
  step('бот: у ролика кнопка «Прямая ссылка · до …» на мастер');
  console.log('\nПрямые ссылки работают.');
} finally {
  server.kill();
  tg.close();
}
