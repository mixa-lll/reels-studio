// A Telegram chat or channel export (Telegram Desktop › Export chat history), sent as a .zip:
// Claude can't unpack it, so the posts become one Markdown digest and the photos (the design
// lives there) come out next to it, each post linking its own.
// No dependencies: a small zip reader on top of zlib (stored and deflated entries, no zip64).
import {inflateRawSync} from 'node:zlib';

/** Entries of a zip buffer: [{name, size, read()}]. Empty when it is not a zip. */
export function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count && at + 46 <= buf.length && buf.readUInt32LE(at) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(at + 10), csize = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28), xlen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nlen);
    at += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    out.push({name, size, read: () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
    }});
  }
  return out;
}

const plain = (t) => Array.isArray(t) ? t.map((x) => typeof x === 'string' ? x : x.text || '').join('') : t || '';
const day = (d) => String(d || '').slice(0, 16).replace('T', ' ');

const MEDIA = {photo: 'фото', video_file: 'видео', animation: 'гифка', voice_message: 'голосовое', video_message: 'кружок', audio_file: 'аудио', sticker: 'стикер'};

/** result.json (JSON export) → Markdown: one block per message with date, author, media, reactions, text. */
function fromJson(j) {
  const msgs = (j.messages || []).filter((m) => m.type === 'message');
  const lines = [`# ${j.name || 'Telegram'} — выгрузка`, '', `Тип: ${j.type || '?'} · сообщений: ${msgs.length}${msgs.length ? ` · ${day(msgs[0].date)} — ${day(msgs.at(-1).date)}` : ''}`, ''];
  for (const m of msgs) {
    const media = m.photo ? 'фото' : MEDIA[m.media_type] || (m.file ? 'файл' : '');
    const react = (m.reactions || []).map((r) => `${r.emoji || r.document_id || '★'}${r.count}`).join(' ');
    const meta = [day(m.date), m.from, media && `[${media}]`, m.forwarded_from && `переслано от ${m.forwarded_from}`, react && `реакции: ${react}`].filter(Boolean).join(' · ');
    const text = plain(m.text).trim();
    if (!text && !media) continue;
    lines.push(`## ${meta}`, ...(m.photo && !/^\(/.test(m.photo) ? [`![фото](${m.photo})`] : []), text, '');
  }
  return {name: j.name, count: msgs.length, md: lines.join('\n')};
}

const unhtml = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

/** messages*.html (HTML export) → Markdown: the date title and the text of each message. */
function fromHtml(pages) {
  const lines = [];
  let count = 0, name = '';
  for (const html of pages) {
    name ||= unhtml(/<div class="text bold">([\s\S]*?)<\/div>/.exec(html)?.[1] || '');
    for (const part of html.split(/<div class="message default/).slice(1)) {
      const date = /class="pull_right date details" title="([^"]+)"/.exec(part)?.[1] || '';
      const text = unhtml(/<div class="text">([\s\S]*?)<\/div>/.exec(part)?.[1] || '');
      const photo = /class="photo_wrap[^"]*" href="([^"]+)"/.exec(part)?.[1];
      const media = photo || /class="(video_file_wrap|media_wrap)/.exec(part) ? ' · [медиа]' : '';
      if (!text && !media) continue;
      count++;
      lines.push(`## ${date}${media}`, ...(photo ? [`![фото](${photo})`] : []), text, '');
    }
  }
  return {name, count, md: [`# ${name || 'Telegram'} — выгрузка`, '', `Сообщений: ${count}`, '', ...lines].join('\n')};
}

/** A zip buffer → {name, count, md, photos: [{path, read}]} when it holds a Telegram export, otherwise null.
 *  Photo paths are relative to the export folder, as the digest links them; thumbnails are left out. */
export function telegramDigest(buf) {
  const entries = zipEntries(buf);
  const json = entries.find((e) => /(^|\/)result\.json$/.test(e.name));
  const html = entries.filter((e) => /(^|\/)messages\d*\.html$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, 'en', {numeric: true}));
  const root = (json || html[0])?.name.replace(/[^/]*$/, '');
  if (root === undefined) return null;
  let d = null;
  if (json) { try { d = fromJson(JSON.parse(json.read().toString('utf8'))); } catch {} }
  if (!d && html.length) d = fromHtml(html.map((e) => e.read()?.toString('utf8') || ''));
  if (!d) return null;
  d.photos = entries.filter((e) => e.name.startsWith(root + 'photos/') && /\.(jpe?g|png|webp)$/i.test(e.name) && !/_thumb\./.test(e.name))
    .map((e) => ({path: e.name.slice(root.length), read: e.read}));
  return d;
}
