// Telegram updates through the relay (relay/worker.js) instead of getUpdates: one bot serves several
// studios on different computers, and Telegram allows only one getUpdates reader per bot. The relay
// takes the webhook, picks the studio by who is writing and keeps updates while this computer sleeps.
//
//   TG_RELAY=wss://reels.mygudauri.org/__tgsocket   RELAY_NODE=misha   RELAY_SECRET=…
//
// Each update is handed to `onUpdate` and then acknowledged, so the relay deletes it; one that was
// already seen (an ack lost on a reconnect) is skipped by its update_id.

/** Runs forever; calls `alive()` on every sign of life, like a successful poll. */
export async function relayUpdates({url, node, secret, onUpdate, alive, seen, log = console.log}) {
  const full = `${url}${node ? `?node=${encodeURIComponent(node)}` : ''}`;
  let backoff = 300;
  for (;;) {
    await new Promise((done) => {
      const ws = new WebSocket(full, {headers: {authorization: `Bearer ${secret}`}});
      let ping = null;
      const close = (why) => { clearInterval(ping); log(`telegram relay down: ${why}`); done(); };
      ws.addEventListener('open', () => {
        log(`telegram relay up ${full}`);
        backoff = 300;
        alive();
        ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 20_000);
      });
      ws.addEventListener('message', async ({data}) => {
        alive();
        if (data === 'pong') return;
        let m;
        try { m = JSON.parse(data); } catch { return; }
        if (m.t !== 'update' || !m.u) return;
        if (!seen(m.u.update_id)) await onUpdate(m.u);
        try { ws.send(JSON.stringify({t: 'ack', id: m.u.update_id})); } catch {}
      });
      let ended = false;
      ws.addEventListener('close', (e) => { if (!ended) { ended = true; close(`close ${e.code} ${e.reason}`); } });
      ws.addEventListener('error', (e) => { if (!ended) { ended = true; try { ws.close(); } catch {} close(e.message || 'error'); } });
    });
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 10_000);
  }
}
