// This computer as one of the owner's devices (several studios of one owner, issue #142).
//
//   DEVICE_NAME=MacBook        what people see: the studio's header, the signature in Telegram
//   RELAY_NODE=misha-macbook   its node in the relay's NODES (relay/worker.js), latin
//
// Without DEVICE_NAME nothing changes: one computer, unsigned messages.

const env = () => process.env;
export const deviceNode = (e = env()) => e.RELAY_NODE || null;
export const deviceName = (e = env()) => e.DEVICE_NAME || null;

// The relay's https address from the bot socket (wss://reels.mygudauri.org/__tgsocket) or the web one.
export function relayBase(e = env()) {
  const u = e.TG_RELAY || e.RELAY_URL;
  if (!u) return null;
  try {
    const x = new URL(u);
    return `${x.protocol === 'ws:' ? 'http:' : 'https:'}//${x.host}`;
  } catch { return null; }
}

const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
// «MacBook · v8 готова». Only when this computer has a name; never twice.
export function sign(text, {html = false, e = env()} = {}) {
  const name = deviceName(e);
  if (!name || typeof text !== 'string' || !text) return text;
  const tag = `${html ? escHtml(name) : name} · `;
  return text.startsWith(tag) ? text : tag + text;
}

// Tells the relay which messages this device sent, so a reply to one comes back here
// (the relay's Router remembers message_id → node). Never throws, never blocks for long.
export async function noteSent(chat, ids, e = env()) {
  const base = relayBase(e), node = deviceNode(e);
  if (!base || !node || !e.RELAY_SECRET || !deviceName(e) || !ids.length) return false;
  try {
    const r = await fetch(`${base}/__tgsent?node=${encodeURIComponent(node)}`, {method: 'POST', headers: {authorization: `Bearer ${e.RELAY_SECRET}`, 'content-type': 'application/json'},
      body: JSON.stringify({chat, ids}), signal: AbortSignal.timeout(5000)});
    return r.ok;
  } catch { return false; }
}
