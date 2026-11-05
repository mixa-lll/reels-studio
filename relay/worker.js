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

function nodesOf(env) {
  let nodes = null;
  try { nodes = env.NODES ? JSON.parse(env.NODES) : null; } catch {}
  return nodes || {misha: {secret: env.RELAY_SECRET, host: 'reels.mygudauri.org', name: 'Миши', default: true, users: []}};
}
const defaultNode = (nodes) => Object.keys(nodes).find((n) => nodes[n].default) || Object.keys(nodes)[0];
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
      const router = env.ROUTER.get(env.ROUTER.idFromName('router'));
      const route = await (await router.fetch('https://router/route', {method: 'POST', body: JSON.stringify({user: fromOf(u), text: u.message?.text ?? null, nodes: Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, {users: v.users || [], default: !!v.default}]))})})).json();
      if (route.text != null && u.message) u.message.text = route.text;
      const queue = env.TGQUEUE.get(env.TGQUEUE.idFromName(`tg:${route.node}`));
      const {online} = await (await queue.fetch('https://queue/push', {method: 'POST', body: JSON.stringify(u)})).json();
      // Offline: the update waits; the person hears it once (per half hour), not on every message.
      const chat = u.message?.chat;
      if (!online && chat?.type === 'private' && env.TELEGRAM_BOT_TOKEN) {
        const {send} = await (await router.fetch('https://router/notice', {method: 'POST', body: JSON.stringify({chat: chat.id})})).json();
        if (send) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({chat_id: chat.id, text: `💤 Компьютер студии ${nodes[route.node]?.name || route.node} сейчас не на связи (спит или выключен). Сообщение сохранено — бот ответит, как только он проснётся.`})}).catch(() => {});
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

    // A browser: the node whose host this is.
    const node = Object.keys(nodes).find((n) => nodes[n].host === url.host) || defaultNode(nodes);
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
export class Router {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const url = new URL(req.url);
    const b = await req.json();
    if (url.pathname === '/notice') {
      const k = `n:${b.chat}`;
      const last = (await this.ctx.storage.get(k)) || 0;
      if (Date.now() - last < 30 * 60_000) return Response.json({send: false});
      await this.ctx.storage.put(k, Date.now());
      return Response.json({send: true});
    }
    const nodes = b.nodes || {};
    let text = b.text;
    let node = null;
    const link = /^\/start\s+([a-z0-9]+)--(\S*)$/i.exec(text || '');
    if (link && nodes[link[1]]) {
      node = link[1];
      text = link[2] ? `/start ${link[2]}` : '/start';
      if (b.user) await this.ctx.storage.put(`user:${b.user}`, node);
    }
    if (!node && b.user) node = await this.ctx.storage.get(`user:${b.user}`);
    if (!node || !nodes[node]) node = Object.keys(nodes).find((n) => (nodes[n].users || []).map(Number).includes(Number(b.user))) || Object.keys(nodes).find((n) => nodes[n].default) || Object.keys(nodes)[0];
    return Response.json({node, text: text === b.text ? null : text});
  }
}
