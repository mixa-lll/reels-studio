// Several devices of one owner behind one address (relay/worker.js, issue #142): the cookie picks the
// studio, Telegram replies go back to the device that sent the message, the rest to the active one.
// The Worker runs here in Node with its Durable Objects replaced by small fakes (Router is the real one).
import assert from 'node:assert/strict';

const W = await import('../relay/worker.js');
const {sign} = await import('../bot/device.mjs');

const NODES = {
  'misha-macbook': {secret: 's1', host: 'reels.mygudauri.org', name: 'MacBook', owner: 'misha', default: true},
  'misha-imac': {secret: 's2', host: 'reels.mygudauri.org', name: 'iMac', owner: 'misha'},
  seva: {secret: 's3', host: 'seva.reels.mygudauri.org', name: 'Севы', users: [300]},
};

// ---------- pure parts ----------
assert.deepEqual(W.devicesOf(NODES, 'misha-imac'), ['misha-macbook', 'misha-imac']);
assert.deepEqual(W.devicesOf(NODES, 'seva'), ['seva']);
assert.equal(W.readCookie('sid_x=1; device=misha-imac; a=b', 'device'), 'misha-imac');
assert.equal(W.readCookie('mydevice=x', 'device'), null);
const host = 'reels.mygudauri.org';
assert.deepEqual(W.pickWeb(NODES, host, {}), {choose: ['misha-macbook', 'misha-imac']}, 'no cookie, two devices: choose');
assert.deepEqual(W.pickWeb(NODES, host, {cookie: 'misha-imac'}), {node: 'misha-imac'});
assert.deepEqual(W.pickWeb(NODES, host, {cookie: 'seva'}), {choose: ['misha-macbook', 'misha-imac']}, 'a cookie for another host does not count');
assert.deepEqual(W.pickWeb(NODES, host, {device: 'misha-imac', cookie: 'misha-macbook'}), {node: 'misha-imac', set: 'misha-imac'}, '?device= wins and is remembered');
assert.deepEqual(W.pickWeb(NODES, 'seva.reels.mygudauri.org', {}), {node: 'seva'});
assert.equal(sign('v8 готова', {e: {DEVICE_NAME: 'MacBook'}}), 'MacBook · v8 готова');
assert.equal(sign('MacBook · v8', {e: {DEVICE_NAME: 'MacBook'}}), 'MacBook · v8', 'never twice');
assert.equal(sign('<b>v8</b>', {html: true, e: {DEVICE_NAME: 'Mac<Book>'}}), 'Mac&lt;Book&gt; · <b>v8</b>');
assert.equal(sign('v8', {e: {}}), 'v8', 'one computer: unsigned');

// ---------- the Worker with fake Durable Objects ----------
const storage = () => {
  const m = new Map();
  return {
    get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { for (const x of [k].flat()) m.delete(x); },
    list: async ({prefix = '', limit = Infinity} = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().slice(0, limit)),
  };
};
const router = new W.Router({storage: storage()});
const online = {'misha-macbook': true, 'misha-imac': true, seva: true};
const queues = {};
const queue = (name) => (queues[name] ||= {got: [], fetch: async (url, init) => {
  const node = name.slice(3), path = new URL(url).pathname;
  if (path === '/status') return Response.json({online: online[node]});
  if (path === '/drain') { const updates = queues[name].got.splice(0); return Response.json({updates}); }
  queues[name].got.push(JSON.parse(init.body));
  return Response.json({online: online[node]});
}});
const relays = {};
const env = {
  NODES: JSON.stringify(NODES), TG_WEBHOOK_SECRET: 'hook', TELEGRAM_BOT_TOKEN: 'tok', TG_API: 'https://tg.test',
  ROUTER: {idFromName: (n) => n, get: () => ({fetch: (u, init) => router.fetch(new Request(u, init))})},
  TGQUEUE: {idFromName: (n) => n, get: (n) => queue(n)},
  RELAY: {idFromName: (n) => n, get: (n) => ({fetch: async (req) => {
    const node = n.split(':')[1];
    if (new URL(req.url ?? req).pathname === '/__status') return Response.json({online: online[node]});
    (relays[node] ||= []).push(req);
    return new Response(`studio ${node}`);
  }})},
};
// What the Worker says to Telegram itself (/device, «спит»).
const said = [];
globalThis.fetch = async (url, init) => { said.push({url: String(url), body: JSON.parse(init.body)}); return Response.json({ok: true, result: {message_id: 1}}); };

const browse = (path, {cookie, accept = 'text/html'} = {}) => W.default.fetch(new Request(`https://${host}${path}`, {headers: {accept, ...(cookie ? {cookie} : {})}}), env);
const text = async (r) => r.text();

// A new browser (a phone): the choice, with who is online.
online['misha-imac'] = false;
let r = await browse('/');
assert.equal(r.status, 200);
let html = await text(r);
assert.match(html, /Какой компьютер открыть/);
assert.match(html, /MacBook<\/b><span>на связи/);
assert.match(html, /iMac<\/b><span>спит/);
// The studio's start link sets the cookie and makes the device active.
r = await browse('/?device=misha-macbook&x=1');
assert.equal(r.status, 302);
assert.equal(r.headers.get('location'), '/?x=1');
assert.match(r.headers.get('set-cookie'), /^device=misha-macbook; Path=\/; Secure/);
r = await browse('/', {cookie: 'device=misha-macbook'});
assert.equal(await text(r), 'studio misha-macbook');
// The header's list.
r = await browse('/__devices', {cookie: 'device=misha-macbook', accept: '*/*'});
assert.deepEqual(await r.json(), {current: 'misha-macbook', devices: [
  {node: 'misha-macbook', name: 'MacBook', online: true, active: true}, {node: 'misha-imac', name: 'iMac', online: false, active: false}]});
// The picked one sleeps: «iMac спит, открыть MacBook?».
r = await browse('/', {cookie: 'device=misha-imac'});
assert.equal(r.status, 503);
html = await text(r);
assert.match(html, /iMac спит/);
assert.match(html, /href="\/\?device=misha-macbook"/);
// An API call is not answered by that page: it goes on to the device (whose relay waits for it).
r = await browse('/api/me', {cookie: 'device=misha-imac', accept: 'application/json'});
assert.equal(await text(r), 'studio misha-imac');
online['misha-imac'] = true;
r = await browse('/', {cookie: 'device=misha-imac'});
assert.equal(await text(r), 'studio misha-imac', 'awake again');

// ---------- Telegram ----------
const OWNER = 100;
let uid = 1;
const tgPost = (u, secret = 'hook') => W.default.fetch(new Request(`https://${host}/__tg`, {method: 'POST', headers: {'x-telegram-bot-api-secret-token': secret}, body: JSON.stringify({update_id: uid++, ...u})}), env);
const msg = (text, extra = {}) => ({message: {message_id: 1000 + uid, from: {id: OWNER}, chat: {id: OWNER, type: 'private'}, text, ...extra}});
const sent = (node, secret, ids) => W.default.fetch(new Request(`https://${host}/__tgsent?node=${node}`, {method: 'POST', headers: {authorization: `Bearer ${secret}`}, body: JSON.stringify({chat: OWNER, ids})}), env);
const last = (node) => queues[`tg:${node}`]?.got.at(-1);

assert.equal((await tgPost(msg('hi'), 'wrong')).status, 403);
assert.equal((await sent('misha-imac', 's1', [5])).status, 403, 'a device reports only with its own secret');
// Opening the iMac studio made it active: a new message goes there.
await tgPost(msg('новая идея'));
assert.equal(last('misha-imac').message.text, 'новая идея');
// Each device reports what it sent; a reply goes to the one that sent it.
await sent('misha-macbook', 's1', [501]);
await sent('misha-imac', 's2', [502]);
await tgPost(msg('поправь титр', {reply_to_message: {message_id: 501}}));
assert.equal(last('misha-macbook').message.text, 'поправь титр', 'reply to MacBook → MacBook');
await tgPost(msg('и музыку', {reply_to_message: {message_id: 502}}));
assert.equal(last('misha-imac').message.text, 'и музыку', 'reply to device 2 → device 2');
// A button under a MacBook message goes to the MacBook.
await tgPost({callback_query: {id: 'q', from: {id: OWNER}, data: 'b:0', message: {message_id: 501, chat: {id: OWNER, type: 'private'}}}});
assert.equal(last('misha-macbook').callback_query.data, 'b:0');

// /device: the relay answers itself, the studios never see it.
const before = queues['tg:misha-imac'].got.length;
await tgPost(msg('/device'));
assert.equal(queues['tg:misha-imac'].got.length, before);
const menu = said.at(-1);
assert.match(menu.url, /\/sendMessage$/);
assert.deepEqual(menu.body.reply_markup.inline_keyboard.map((row) => row[0].callback_data), ['dev:misha-macbook', 'dev:misha-imac']);
assert.match(menu.body.reply_markup.inline_keyboard[1][0].text, /^● iMac/);
await tgPost({callback_query: {id: 'q2', from: {id: OWNER}, data: 'dev:misha-macbook', message: {message_id: 9, chat: {id: OWNER, type: 'private'}}}});
await tgPost(msg('теперь сюда'));
assert.equal(last('misha-macbook').message.text, 'теперь сюда', '/device switched the active one');

// The active one sleeps: the message waits there, and the bot offers the awake one.
online['misha-macbook'] = false;
await tgPost(msg('ты тут?'));
assert.equal(last('misha-macbook').message.text, 'ты тут?');
const offer = said.at(-1);
assert.equal(offer.body.text, '💤 MacBook спит. Отправить на iMac?');
assert.equal(offer.body.reply_markup.inline_keyboard[0][0].callback_data, 'devsend:misha-imac');
await tgPost({callback_query: {id: 'q3', from: {id: OWNER}, data: 'devsend:misha-imac', message: {message_id: 10, chat: {id: OWNER, type: 'private'}}}});
assert.equal(queues['tg:misha-macbook'].got.length, 0, 'nothing waits for the sleeping one');
assert.equal(last('misha-imac').message.text, 'ты тут?', 'the waiting message moved');
await tgPost(msg('дальше'));
assert.equal(last('misha-imac').message.text, 'дальше', 'and new ones go there too');

// Another owner's studio is untouched: Сева by his id, and his /device is just a message.
await tgPost({message: {message_id: 1, from: {id: 300}, chat: {id: 300, type: 'private'}, text: '/device'}});
assert.equal(last('seva').message.text, '/device');
// A start link pins a person to a device node with a dash in its name.
await tgPost({message: {message_id: 2, from: {id: 400}, chat: {id: 400, type: 'private'}, text: '/start misha-macbook--inv_abc'}});
assert.equal(last('misha-macbook').message.text, '/start inv_abc');

// NODES_MORE adds a device and fields over NODES without rewriting other nodes (their secrets stay).
const merged = W.nodesOf({NODES: JSON.stringify({misha: {secret: 's1', host: 'reels.mygudauri.org', default: true, users: [1]}, seva: {secret: 's2', host: 'seva.reels.mygudauri.org'}}),
  NODES_MORE: JSON.stringify({misha: {owner: 'misha', name: 'MacBook'}, 'misha-2': {secret: 's3', host: 'reels.mygudauri.org', name: 'Mac 2', owner: 'misha'}})});
assert.deepEqual(merged.misha, {secret: 's1', host: 'reels.mygudauri.org', default: true, users: [1], owner: 'misha', name: 'MacBook'});
assert.equal(merged.seva.secret, 's2');
assert.deepEqual(W.devicesOf(merged, 'misha'), ['misha', 'misha-2']);

console.log('devices: ok');
