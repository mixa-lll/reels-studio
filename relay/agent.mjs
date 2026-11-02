// Mac side of the relay (see worker.js): keeps an outbound WebSocket to the Cloudflare Worker
// and answers each request from the local web studio (web/server.mjs on 127.0.0.1:PORT).
// Started by launchd (deploy/mac/com.reels-relay.plist); reads RELAY_URL / RELAY_SECRET / PORT from .env.
import {request} from 'node:http';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(join(ROOT, '.env')); } catch {}
const RELAY = process.env.RELAY_URL || 'wss://reels.mygudauri.org/__relay';
const SECRET = process.env.RELAY_SECRET;
const PORT = Number(process.env.PORT || 8080);
if (!SECRET) throw new Error('RELAY_SECRET is not set in .env');

const CHUNK = 256 * 1024;
const WINDOW = 8; // chunks in flight per response before we wait for acks
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);
const log = (...a) => console.log(new Date().toISOString(), ...a);

const frame = (id, bytes) => {
  const out = Buffer.allocUnsafe(4 + bytes.length);
  out.writeUInt32BE(id, 0);
  bytes.copy(out, 4);
  return out;
};

let backoff = 1000;

function connect() {
  const ws = new WebSocket(RELAY, {headers: {authorization: `Bearer ${SECRET}`}});
  ws.binaryType = 'arraybuffer';
  const jobs = new Map(); // id → {req, res, inflight}
  let ping;

  const send = (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(typeof m === 'string' ? m : m); };
  const fail = (id, e) => { send(JSON.stringify({t: 'err', id, message: String(e?.message || e)})); jobs.delete(id); };

  ws.addEventListener('open', () => {
    log('relay up', RELAY);
    backoff = 1000;
    ping = setInterval(() => send('ping'), 25_000);
  });

  ws.addEventListener('message', ({data}) => {
    if (typeof data !== 'string') {
      const buf = Buffer.from(data);
      const job = jobs.get(buf.readUInt32BE(0));
      job?.req.write(buf.subarray(4));
      return;
    }
    if (data === 'pong') return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const job = jobs.get(m.id);
    if (m.t === 'req') start(m);
    else if (m.t === 'reqend') job?.req.end();
    else if (m.t === 'ack' && job) { job.inflight--; if (job.inflight < WINDOW) job.res?.resume(); }
    else if (m.t === 'cancel' && job) { job.req.destroy(); jobs.delete(m.id); }
  });

  function start(m) {
    const headers = {...m.headers, host: `127.0.0.1:${PORT}`};
    delete headers['accept-encoding']; // keep bodies plain; Cloudflare compresses for the browser
    const req = request({host: '127.0.0.1', port: PORT, method: m.method, path: m.path, headers}, (res) => {
      const job = jobs.get(m.id);
      if (!job) return res.destroy();
      job.res = res;
      const pairs = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) if (!HOP.has(res.rawHeaders[i].toLowerCase())) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
      send(JSON.stringify({t: 'head', id: m.id, status: res.statusCode, headers: pairs}));
      res.on('data', (d) => {
        for (let o = 0; o < d.length; o += CHUNK) {
          send(frame(m.id, d.subarray(o, o + CHUNK)));
          job.inflight++;
        }
        if (job.inflight >= WINDOW) res.pause();
      });
      res.on('end', () => { send(JSON.stringify({t: 'end', id: m.id})); jobs.delete(m.id); });
      res.on('error', (e) => fail(m.id, e));
    });
    req.on('error', (e) => fail(m.id, e));
    jobs.set(m.id, {req, res: null, inflight: 0});
    if (!m.body) req.end();
  }

  const down = (why) => {
    clearInterval(ping);
    for (const job of jobs.values()) job.req.destroy();
    jobs.clear();
    log('relay down:', why, `— retry in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };
  let closed = false;
  ws.addEventListener('close', (e) => { if (!closed) { closed = true; down(`close ${e.code} ${e.reason}`); } });
  ws.addEventListener('error', (e) => { if (!closed) { closed = true; try { ws.close(); } catch {} down(e.message || 'error'); } });
}

connect();
