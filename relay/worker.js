// Relay for the web studio running on the owner's Mac.
// The Mac cannot be reached from outside (home NAT, Cloudflare Tunnel blocked), so it keeps an
// outbound WebSocket to this Worker, just like the bot polls Telegram. A browser request is sent
// down that socket, the Mac answers from localhost, and the answer streams back to the browser.
//
// Frames on the socket:
//   text  {t:'req', id, method, path, headers, body}  Worker → Mac (body: bool, bytes follow)
//   text  {t:'reqend', id}                            Worker → Mac, request body finished
//   text  {t:'head', id, status, headers}             Mac → Worker
//   text  {t:'end', id} / {t:'err', id, message}      Mac → Worker
//   text  {t:'ack', id}                               Worker → Mac, one chunk handed on (flow control)
//   text  {t:'cancel', id}                            Worker → Mac, the browser went away
//   binary [u32 id][bytes]                            body chunks, both ways

const CHUNK = 256 * 1024;

export default {
  async fetch(req, env) {
    const stub = env.RELAY.get(env.RELAY.idFromName('mac-v2'));
    return stub.fetch(req);
  },
};

const offline = (why = '') => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Студия недоступна</title><body style="font:16px/1.5 system-ui;padding:40px 20px;max-width:560px;margin:auto;color:#222">
<h1 style="font-size:22px">Мак сейчас не на связи</h1><p>Студия работает на компьютере Миши. Похоже, он выключен, спит или без интернета. Страница сама обновится, как только он появится.</p>`,
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
      if (!this.env.RELAY_SECRET || req.headers.get('authorization') !== `Bearer ${this.env.RELAY_SECRET}`) return new Response('forbidden', {status: 403});
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
    if (!ws) return offline("no-socket");

    const id = this.seq++;
    const headers = Object.fromEntries(req.headers);
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
      return offline('send-failed');
    }

    const timer = setTimeout(() => this.settle(id, offline('timeout')), 60_000);
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
      const {readable, writable} = new TransformStream(undefined, {highWaterMark: 4});
      p.writer = writable.getWriter();
      const headers = new Headers();
      for (const [k, v] of m.headers) headers.append(k, v);
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
