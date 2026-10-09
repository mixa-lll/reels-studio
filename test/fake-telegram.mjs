// A tiny stand-in for the Telegram Bot API, for end-to-end tests: queue updates,
// record what the bot sends, and make chosen requests hang to simulate a dead network.
import {createServer} from 'node:http';

/** Starts the fake on a free port; resolves to a controller. */
export async function fakeTelegram() {
  const updates = [];
  const sent = [];
  let nextUpdate = 1;
  let nextMessage = 100;
  let hang = () => false;

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      let params = {};
      try {
        params = JSON.parse(body || '{}');
      } catch {}
      if (hang(method, params, body)) return; // never answer: a silently dead connection
      const ok = (result) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ok: true, result}));
      };
      if (method === 'getUpdates') {
        const batch = updates.splice(0);
        return setTimeout(() => ok(batch), batch.length ? 0 : 300);
      }
      if (method === 'sendMessage') {
        sent.push({method, ...params});
        return ok({message_id: nextMessage++, chat: {id: params.chat_id}, text: params.text});
      }
      // Multipart uploads (sendVideo…) are kept raw for inspection.
      sent.push({method, ...params, raw: params && Object.keys(params).length ? undefined : body});
      ok(true);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    sent,
    /** Queues an incoming message from a user. */
    message(from, text) {
      updates.push({update_id: nextUpdate++, message: {message_id: nextMessage++, from: {id: from, first_name: 'Test'}, chat: {id: from, type: 'private'}, date: Date.now() / 1000, text}});
    },
    /** Requests matching `fn(method, params, rawBody)` hang until `hang(null)`. */
    hang(fn) {
      hang = fn ?? (() => false);
    },
    /** Waits for a sent message whose text matches `re`. */
    async waitFor(re, ms = 20_000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const m = sent.find((s) => s.method === 'sendMessage' && re.test(s.text ?? ''));
        if (m) return m;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no message matching ${re} within ${ms} ms; sent: ${sent.filter((s) => s.method === 'sendMessage').map((s) => JSON.stringify(s.text).slice(0, 60)).join(' | ')}`);
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
