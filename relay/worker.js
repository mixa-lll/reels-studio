// Relay for the studios running on people's own computers (Misha's Mac, Seva's machine…).
// A computer cannot be reached from outside (home NAT, Cloudflare Tunnel blocked), so it keeps
// outbound WebSockets to this Worker. Two things go through them:
//
//   web — a browser request on the node's host (reels.mygudauri.org, seva.reels.mygudauri.org) is
//         sent down the node's socket, its studio answers from localhost, the answer streams back.
//   tg  — one Telegram bot for everyone: Telegram posts every update here (webhook /__tg); the
//         Router knows whose studio each person belongs to and the update goes to that node's
//         queue (TgQueue), which hands it to the node's bot over its socket, or keeps it until the
//         computer wakes up (and tells the person once that it is offline).
//
// Config: secret NODES = {"misha": {"secret", "host", "name", "default": true, "users": [tg ids]},
// "seva": {...}}; TG_WEBHOOK_SECRET; TELEGRAM_BOT_TOKEN. Without NODES: one node «misha» with
// RELAY_SECRET (the original single-Mac setup).
//
// Devices (#142): one owner's computers are nodes with the same "owner" and the same host
// ({"misha-macbook": {..., "name": "MacBook", "owner": "misha"}, "misha-imac": {..., "owner": "misha"}}).
// The browser's cookie `device` picks the computer (`?device=<node>` sets it; the studio opens that
// link on its computer at start); no cookie → a page to choose, with who is online. /__devices
// lists them for the studio's header. In Telegram a reply goes to the device that sent the message
// (Router remembers message_id → node, the bots report them to /__tgsent); anything else goes to the
// owner's active device — where the studio was opened last, or the one picked with /device.
//
// Web frames on the socket:
//   text  {t:'req', id, method, path, headers, body}  Worker → Mac (body: bool, bytes follow)
//   text  {t:'reqend', id}                            Worker → Mac, request body finished
//   text  {t:'head', id, status, headers}             Mac → Worker
//   text  {t:'end', id} / {t:'err', id, message}      Mac → Worker
//   text  {t:'ack', id}                               Worker → Mac, one chunk handed on (flow control)
//   text  {t:'cancel', id}                            Worker → Mac, the browser went away
//   binary [u32 id][bytes]                            body chunks, both ways
// Bot frames (/__tgsocket): {t:'update', u} Worker → bot; {t:'ack', id} bot → Worker.

const CHUNK = 256 * 1024;

export function nodesOf(env) {
  let nodes = null;
  try { nodes = env.NODES ? JSON.parse(env.NODES) : null; } catch {}
  nodes ||= {misha: {secret: env.RELAY_SECRET, host: 'reels.mygudauri.org', name: 'Миши', default: true, users: []}};
  // NODES_MORE adds nodes and fields to existing ones without rewriting NODES (whose other nodes'
  // secrets nobody can read back): {"misha": {"owner": "misha", "name": "MacBook"}, "misha-2": {...}}.
  let more = null;
  try { more = env.NODES_MORE ? JSON.parse(env.NODES_MORE) : null; } catch {}
  for (const [n, x] of Object.entries(more || {})) nodes[n] = {...nodes[n], ...x};
  return nodes;
}
const defaultNode = (nodes) => Object.keys(nodes).find((n) => nodes[n].default) || Object.keys(nodes)[0];
const TG_API = (env) => env.TG_API || 'https://api.telegram.org';

// The owner's devices: every node with the same owner (a node without one is alone).
export const devicesOf = (nodes, node) => {
  const owner = nodes[node]?.owner;
  return owner ? Object.keys(nodes).filter((n) => nodes[n].owner === owner) : nodes[node] ? [node] : [];
};
export const readCookie = (header, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header || '')?.[1] || null;
// Which studio a browser request goes to: {node} or {choose: [nodes]} (several devices, no cookie);
// `set` — a ?device= link: remember it in the cookie and drop it from the address.
export function pickWeb(nodes, host, {device = null, cookie = null} = {}) {
  const here = Object.keys(nodes).filter((n) => nodes[n].host === host);
  if (!here.length) return {node: defaultNode(nodes)};
  if (device && here.includes(device)) return {node: device, set: device};
  if (cookie && here.includes(cookie)) return {node: cookie};
  if (here.length === 1) return {node: here[0]};
  return {choose: here};
}
const deviceCookie = (node) => `device=${node}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

async function online(env, node) {
  try { return (await (await relayOf(env, node).fetch('https://relay/__status')).json()).online; } catch { return false; }
}
async function botOnline(env, node) {
  try { return (await (await env.TGQUEUE.get(env.TGQUEUE.idFromName(`tg:${node}`)).fetch('https://queue/status')).json()).online; } catch { return false; }
}
const router = (env) => env.ROUTER.get(env.ROUTER.idFromName('router'));
const routerCall = async (env, path, body) => (await router(env).fetch(`https://router${path}`, {method: 'POST', body: JSON.stringify(body)})).json();

// The owner's devices with who is online: the picker, the «спит» page, the studio's header, /device.
async function deviceList(env, nodes, node, {bots = false} = {}) {
  const list = devicesOf(nodes, node);
  const owner = nodes[node]?.owner;
  const {node: active} = owner ? await routerCall(env, '/active', {owner}) : {};
  return Promise.all(list.map(async (n) => ({node: n, name: nodes[n].name || n, online: await (bots ? botOnline : online)(env, n), active: n === active})));
}

const page = (title, inner, {status = 200, refresh = 0, headers = {}} = {}) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${esc(title)}</title><body style="font:16px/1.5 system-ui;padding:40px 20px;max-width:560px;margin:auto;color:#222">
<style>a.d{display:flex;align-items:center;gap:10px;padding:14px 16px;margin:8px 0;border:1px solid #ddd;border-radius:12px;color:#222;text-decoration:none}a.d:hover{border-color:#222}a.d i{width:9px;height:9px;border-radius:50%;background:#2E8A4F}a.d.off i{background:#B9B7B1}a.d span{margin-left:auto;color:#777;font-size:14px}</style>
${inner}`, {status, headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers}});
const deviceLinks = (list) => list.map((d) => `<a class="d ${d.online ? '' : 'off'}" href="/?device=${encodeURIComponent(d.node)}"><i></i><b>${esc(d.name)}</b><span>${d.online ? 'на связи' : 'спит'}</span></a>`).join('');
// One relay object per studio node, placed in Western Europe next to the studio server (Amsterdam):
// each browser request goes Worker → this object → the server's WebSocket and back, so a far
// object adds its distance twice to every request. A new name (v6) because placement is fixed
// when an object is first created.
const relayOf = (env, node) => env.RELAY.get(env.RELAY.idFromName(`web:${node}:v6`), {locationHint: 'weur'});
const authorized = (req, node) => node?.secret && req.headers.get('authorization') === `Bearer ${node.secret}`;

// Who sent an update: messages, edits, buttons.
const fromOf = (u) => (u.message || u.edited_message || u.callback_query || u.my_chat_member)?.from?.id;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const nodes = nodesOf(env);
    const nodeParam = url.searchParams.get('node') || defaultNode(nodes);

    // Telegram → here → the person's studio.
    if (url.pathname === '/__tg' && req.method === 'POST') {
      if (!env.TG_WEBHOOK_SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_WEBHOOK_SECRET) return new Response('forbidden', {status: 403});
      const u = await req.json().catch(() => null);
      if (!u) return new Response('ok');
      const tg = (method, body) => env.TELEGRAM_BOT_TOKEN ? fetch(`${TG_API(env)}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}).catch(() => {}) : null;
      const cb = u.callback_query;
      const msg = u.message || u.edited_message || cb?.message;
      const route = await routerCall(env, '/route', {user: fromOf(u), text: u.message?.text ?? null, chat: msg?.chat?.id ?? null,
        replyTo: (u.message || u.edited_message)?.reply_to_message?.message_id ?? cb?.message?.message_id ?? null,
        nodes: Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, {users: v.users || [], default: !!v.default, owner: v.owner || null}]))});
      if (route.text != null && u.message) u.message.text = route.text;
      const group = devicesOf(nodes, route.node);

      // The relay's own buttons and /device: they never reach a studio.
      const devMenu = async (chatId, edit) => {
        const list = await deviceList(env, nodes, route.node, {bots: true});
        const text = `Куда идут новые сообщения: ${list.find((d) => d.active)?.name || nodes[route.node]?.name || route.node}.\nОтвет на сообщение уходит тому компьютеру, который его прислал.`;
        const reply_markup = {inline_keyboard: list.map((d) => [{text: `${d.active ? '● ' : ''}${d.name} · ${d.online ? 'на связи' : 'спит'}`, callback_data: `dev:${d.node}`}])};
        return edit ? tg('editMessageText', {chat_id: chatId, message_id: edit, text, reply_markup}) : tg('sendMessage', {chat_id: chatId, text, reply_markup});
      };
      if (group.length > 1 && /^\/device(@\w+)?$/.test(u.message?.text || '')) { await devMenu(u.message.chat.id); return new Response('ok'); }
      const dev = /^dev(send)?:([\w-]+)$/.exec(cb?.data || '');
      if (dev && group.includes(dev[2])) {
        const to = dev[2];
        await routerCall(env, '/active', {owner: nodes[to].owner, node: to});
        if (dev[1]) {
          // «MacBook спит, отправить на iMac?» — what waits for the sleeping one goes to the other.
          for (const n of group) if (n !== to) {
            const {updates} = await (await env.TGQUEUE.get(env.TGQUEUE.idFromName(`tg:${n}`)).fetch('https://queue/drain', {method: 'POST'})).json();
            for (const w of updates) await env.TGQUEUE.get(env.TGQUEUE.idFromName(`tg:${to}`)).fetch('https://queue/push', {method: 'POST', body: JSON.stringify(w)});
          }
          await tg('answerCallbackQuery', {callback_query_id: cb.id, text: `Отправил на ${nodes[to].name || to}`});
          await tg('editMessageText', {chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `➡️ Сообщения ушли на ${nodes[to].name || to}, новые тоже пойдут туда (/device — переключить).`});
        } else {
          await tg('answerCallbackQuery', {callback_query_id: cb.id, text: `Теперь — ${nodes[to].name || to}`});
          await devMenu(cb.message.chat.id, cb.message.message_id);
        }
        return new Response('ok');
      }

      const queue = env.TGQUEUE.get(env.TGQUEUE.idFromName(`tg:${route.node}`));
      const {online: up} = await (await queue.fetch('https://queue/push', {method: 'POST', body: JSON.stringify(u)})).json();
      // Offline: the update waits; the person hears it once (per half hour), not on every message.
      const chat = u.message?.chat;
      if (!up && chat?.type === 'private' && env.TELEGRAM_BOT_TOKEN) {
        const {send} = await routerCall(env, '/notice', {chat: chat.id});
        if (send) {
          const name = nodes[route.node]?.name || route.node;
          const awake = group.length > 1 ? (await Promise.all(group.filter((n) => n !== route.node).map(async (n) => ((await botOnline(env, n)) ? n : null)))).filter(Boolean) : [];
          if (awake.length) {
            await tg('sendMessage', {chat_id: chat.id, text: `💤 ${name} спит. Отправить на ${awake.map((n) => nodes[n].name || n).join(' или ')}?`,
              reply_markup: {inline_keyboard: awake.map((n) => [{text: `Отправить на ${nodes[n].name || n}`, callback_data: `devsend:${n}`}])}});
          } else {
            await tg('sendMessage', {chat_id: chat.id, text: group.length > 1 ? `💤 ${name} сейчас не на связи (спит или выключен). Сообщение сохранено — ответ придёт, как только он проснётся.` : `💤 Компьютер студии ${name} сейчас не на связи (спит или выключен). Сообщение сохранено — бот ответит, как только он проснётся.`});
          }
        }
      }
      return new Response('ok');
    }

    // A node's bot picks up its Telegram updates.
    if (url.pathname === '/__tgsocket') {
      if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', {status: 426});
      if (!authorized(req, nodes[nodeParam])) return new Response('forbidden', {status: 403});
      return env.TGQUEUE.get(env.TGQUEUE.idFromName(`tg:${nodeParam}`)).fetch(req);
    }

    // A node's studio connects for web requests.
    if (url.pathname === '/__relay') {
      if (!authorized(req, nodes[nodeParam])) return new Response('forbidden', {status: 403});
      return relayOf(env, nodeParam).fetch(req);
    }

    // A device reports a message it sent to Telegram: a reply to it comes back to that device.
    if (url.pathname === '/__tgsent' && req.method === 'POST') {
      if (!authorized(req, nodes[nodeParam])) return new Response('forbidden', {status: 403});
      const b = await req.json().catch(() => ({}));
      if (b.chat == null || !Array.isArray(b.ids)) return new Response('bad request', {status: 400});
      await routerCall(env, '/sent', {chat: b.chat, ids: b.ids.slice(0, 100), node: nodeParam});
      return Response.json({ok: true});
    }

    // A browser: the node whose host this is; with several devices on one host, the cookie's.
    const pick = pickWeb(nodes, url.host, {device: url.searchParams.get('device'), cookie: readCookie(req.headers.get('cookie'), 'device')});
    const anyHere = pick.node || pick.choose[0];
    const isPage = req.method === 'GET' && (req.headers.get('accept') || '').includes('text/html');
    if (url.pathname === '/__devices') {
      const list = await deviceList(env, nodes, anyHere);
      return Response.json({current: pick.node || null, devices: list}, {headers: {'cache-control': 'no-store'}});
    }
    if (pick.choose) {
      const list = await deviceList(env, nodes, anyHere);
      return page('Какой компьютер?', `<h1 style="font-size:22px">Какой компьютер открыть?</h1><p>Студия работает на нескольких компьютерах. Выберите, на каком работать из этого браузера — он запомнит.</p>${deviceLinks(list)}`, {refresh: list.some((d) => d.online) ? 0 : 10});
    }
    const node = pick.node;
    if (pick.set) {
      url.searchParams.delete('device');
      if (nodes[node]?.owner) await routerCall(env, '/active', {owner: nodes[node].owner, node});
      return new Response(null, {status: 302, headers: {location: url.pathname + url.search + url.hash, 'set-cookie': deviceCookie(node), 'cache-control': 'no-store'}});
    }
    // The picked device sleeps and another of the owner's is online: offer it at once (pages only;
    // API calls keep waiting a little, the socket often comes back within seconds).
    const group = devicesOf(nodes, node);
    if (isPage && group.length > 1) {
      if (!(await online(env, node))) {
        const others = (await deviceList(env, nodes, node)).filter((d) => d.node !== node && d.online);
        if (others.length) return page('Компьютер спит', `<h1 style="font-size:22px">${esc(nodes[node].name || node)} спит</h1><p>Открыть ${others.map((d) => esc(d.name)).join(' или ')}? Эта страница сама откроет ${esc(nodes[node].name || node)}, как только он проснётся.</p>${deviceLinks(others)}`, {status: 503, refresh: 10});
      } else if (url.pathname === '/' && nodes[node].owner) {
        // Opening the studio makes this device the active one: new Telegram messages go here.
        await routerCall(env, '/active', {owner: nodes[node].owner, node});
      }
    }
    const r = new Request(req);
    r.headers.set('x-relay-node-name', encodeURIComponent(nodes[node]?.name || node));
    return relayOf(env, node).fetch(r);
  },
};

const offline = (why = '', name = 'Миши') => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Студия недоступна</title><body style="font:16px/1.5 system-ui;padding:40px 20px;max-width:560px;margin:auto;color:#222">
<h1 style="font-size:22px">Компьютер студии сейчас не на связи</h1><p>Эта студия работает на компьютере ${name}. Похоже, он выключен, спит или без интернета. Страница сама обновится, как только он появится.</p>`,
  {status: 503, headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30', 'x-relay': why}});

const frame = (id, bytes) => {
  const out = new Uint8Array(4 + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out;
};

export class Relay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.seq = 1;
    this.pending = new Map(); // id → {resolve, writer, settled}
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // The newest open socket: after a redeploy or a quick reconnect stale ones may still be listed.
  mac() {
    return this.ctx.getWebSockets('mac').filter((w) => w.readyState === WebSocket.OPEN).at(-1);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/__status') return Response.json({online: !!this.mac()});
    if (url.pathname === '/__relay') {
      if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', {status: 426});
      for (const old of this.ctx.getWebSockets('mac')) try { old.close(1012, 'replaced'); } catch {}
      this.failAll('mac reconnected');
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['mac']);
      return new Response(null, {status: 101, webSocket: client});
    }
    // The Mac's socket drops now and then and comes back within seconds: wait for it a little
    // before telling the browser the Mac is offline.
    let ws = this.mac();
    for (let waited = 0; !ws && waited < 15_000; waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
      ws = this.mac();
    }
    const nodeName = req.headers.get('x-relay-node-name') ? decodeURIComponent(req.headers.get('x-relay-node-name')) : undefined;
    if (!ws) return offline('no-socket', nodeName);

    const id = this.seq++;
    const headers = Object.fromEntries(req.headers);
    delete headers['x-relay-node-name'];
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-host'] = url.host;
    headers['x-forwarded-for'] = req.headers.get('cf-connecting-ip') || '';
    const hasBody = req.body && !['GET', 'HEAD'].includes(req.method);

    const res = new Promise((resolve) => this.pending.set(id, {resolve, writer: null, settled: false, chain: Promise.resolve()}));
    try {
      ws.send(JSON.stringify({t: 'req', id, method: req.method, path: url.pathname + url.search, headers, body: !!hasBody}));
      if (hasBody) {
        const reader = req.body.getReader();
        let buf = new Uint8Array(0);
        for (;;) {
          const {done, value} = await reader.read();
          if (value) {
            const joined = new Uint8Array(buf.length + value.length);
            joined.set(buf);
            joined.set(value, buf.length);
            buf = joined;
            while (buf.length >= CHUNK) { ws.send(frame(id, buf.subarray(0, CHUNK))); buf = buf.slice(CHUNK); }
          }
          if (done) break;
        }
        if (buf.length) ws.send(frame(id, buf));
        ws.send(JSON.stringify({t: 'reqend', id}));
      }
    } catch (e) {
      this.pending.delete(id);
      return offline('send-failed', nodeName);
    }

    const timer = setTimeout(() => this.settle(id, offline('timeout', nodeName)), 60_000);
    const out = await res;
    clearTimeout(timer);
    return out;
  }

  settle(id, response) {
    const p = this.pending.get(id);
    if (!p || p.settled) return;
    p.settled = true;
    p.resolve(response);
    if (!p.writer) this.pending.delete(id);
  }

  failAll(why) {
    for (const [id, p] of this.pending) {
      if (!p.settled) this.settle(id, offline('fail-all:' + why));
      else p.writer?.abort(why).catch(() => {});
    }
    this.pending.clear();
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string') {
      const view = new Uint8Array(msg);
      const id = new DataView(view.buffer, view.byteOffset).getUint32(0);
      const p = this.pending.get(id);
      if (!p?.writer) return;
      const bytes = view.slice(4);
      // Writes and the final close run in arrival order: the handler awaits, so the next
      // frame (or 'end') can arrive before this chunk has been handed on.
      p.chain = p.chain.then(async () => {
        await p.writer.ready;
        await p.writer.write(bytes);
        ws.send(JSON.stringify({t: 'ack', id}));
      }).catch(() => {
        if (this.pending.get(id) === p) this.pending.delete(id);
        try { ws.send(JSON.stringify({t: 'cancel', id})); } catch {}
      });
      return;
    }
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.t === 'head') {
      const noBody = [101, 204, 205, 304].includes(m.status);
      if (noBody) { this.settle(m.id, new Response(null, {status: m.status, headers: m.headers})); this.pending.delete(m.id); return; }
      const headers = new Headers();
      for (const [k, v] of m.headers) headers.append(k, v);
      // A known length keeps Content-Length on the way out: phones show download progress and
      // size only with it (a plain stream would go out chunked, without a size).
      const len = Number(headers.get('content-length'));
      const {readable, writable} = len > 0 && !headers.get('content-encoding') ? new FixedLengthStream(len) : new TransformStream(undefined, {highWaterMark: 4});
      p.writer = writable.getWriter();
      this.settle(m.id, new Response(readable, {status: m.status, headers}));
    } else if (m.t === 'end') {
      this.pending.delete(m.id);
      p.chain.then(() => p.writer?.close()).catch(() => {});
    } else if (m.t === 'err') {
      this.pending.delete(m.id);
      if (!p.settled) this.settle(m.id, new Response(`Ошибка на Маке: ${m.message}`, {status: 502}));
      else p.chain.then(() => p.writer?.abort(m.message)).catch(() => {});
    }
  }

  webSocketClose() { this.failAll('mac disconnected'); }
  webSocketError() { this.failAll('mac socket error'); }
}

// One node's Telegram updates: kept in storage until its bot acknowledges them, so nothing is lost
// while the computer sleeps; sent in order as soon as the bot's socket is open.
export class TgQueue {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  bot() { return this.ctx.getWebSockets('bot').filter((w) => w.readyState === WebSocket.OPEN).at(-1); }
  key(id) { return `u:${String(id).padStart(14, '0')}`; }
  async flush(ws) {
    const all = await this.ctx.storage.list({prefix: 'u:'});
    for (const u of all.values()) ws.send(JSON.stringify({t: 'update', u}));
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/__tgsocket') {
      for (const old of this.ctx.getWebSockets('bot')) try { old.close(1012, 'replaced'); } catch {}
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['bot']);
      await this.flush(server);
      return new Response(null, {status: 101, webSocket: client});
    }
    if (url.pathname === '/status') return Response.json({online: !!this.bot()});
    // Everything waiting here, handed to another device of the same owner.
    if (url.pathname === '/drain') {
      const all = await this.ctx.storage.list({prefix: 'u:'});
      await this.ctx.storage.delete([...all.keys()]);
      return Response.json({updates: [...all.values()]});
    }
    if (url.pathname === '/push') {
      const u = await req.json();
      await this.ctx.storage.put(this.key(u.update_id), u);
      const ws = this.bot();
      if (ws) try { ws.send(JSON.stringify({t: 'update', u})); } catch { return Response.json({online: false}); }
      return Response.json({online: !!ws});
    }
    return new Response('not found', {status: 404});
  }
  async webSocketMessage(ws, msg) {
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    if (m.t === 'ack' && Number.isFinite(m.id)) await this.ctx.storage.delete(this.key(m.id));
  }
}

// Whose studio each Telegram user belongs to. A link t.me/<bot>?start=<node>--<payload> (owner
// links, invites from that studio) sends the person there for good and passes «/start <payload>» on;
// «/start <node>--» alone just switches. Unknown people: the node listing them in NODES, else default.
// Among one owner's devices: a reply (or a button) goes to the device whose message it is
// (m:<chat>:<message_id>, reported by /__tgsent), anything else to the owner's active device.
export class Router {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const url = new URL(req.url);
    const b = await req.json();
    const st = this.ctx.storage;
    if (url.pathname === '/notice') {
      const k = `n:${b.chat}`;
      const last = (await st.get(k)) || 0;
      if (Date.now() - last < 30 * 60_000) return Response.json({send: false});
      await st.put(k, Date.now());
      return Response.json({send: true});
    }
    if (url.pathname === '/sent') {
      const day = Math.floor(Date.now() / 864e5);
      for (const id of b.ids) await st.put(`m:${b.chat}:${id}`, b.node);
      // Old message marks go after 90 days, one day's list at a time.
      await st.put(`d:${day}:${b.chat}:${b.ids[0]}`, b.ids.map((id) => `m:${b.chat}:${id}`));
      // Day numbers have the same length for centuries, so the oldest lists come first.
      for (const [k, keys] of await st.list({prefix: 'd:', limit: 20})) {
        if (Number(k.split(':')[1]) > day - 90) break;
        await st.delete(keys); await st.delete(k);
      }
      return Response.json({ok: true});
    }
    if (url.pathname === '/active') {
      if (b.node) await st.put(`active:${b.owner}`, b.node);
      return Response.json({node: (await st.get(`active:${b.owner}`)) || null});
    }
    const nodes = b.nodes || {};
    let text = b.text;
    let node = null;
    let linked = false;
    const link = /^\/start\s+([a-z0-9-]+?)--(\S*)$/i.exec(text || '');
    if (link && nodes[link[1]]) {
      node = link[1];
      linked = true;
      text = link[2] ? `/start ${link[2]}` : '/start';
      if (b.user) await st.put(`user:${b.user}`, node);
    }
    if (!node && b.user) node = await st.get(`user:${b.user}`);
    if (!node || !nodes[node]) node = Object.keys(nodes).find((n) => (nodes[n].users || []).map(Number).includes(Number(b.user))) || Object.keys(nodes).find((n) => nodes[n].default) || Object.keys(nodes)[0];
    const owner = nodes[node]?.owner;
    const group = owner ? Object.keys(nodes).filter((n) => nodes[n].owner === owner) : [node];
    let via = 'person';
    if (group.length > 1) {
      const mine = b.replyTo != null && b.chat != null ? await st.get(`m:${b.chat}:${b.replyTo}`) : null;
      const active = await st.get(`active:${owner}`);
      if (linked) { await st.put(`active:${owner}`, node); via = 'link'; }
      else if (mine && group.includes(mine)) { node = mine; via = 'reply'; }
      else if (active && group.includes(active)) { node = active; via = 'active'; }
    }
    return Response.json({node, via, text: text === b.text ? null : text});
  }
}
