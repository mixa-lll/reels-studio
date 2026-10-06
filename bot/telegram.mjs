// Minimal Telegram Bot API client on top of fetch. No dependencies.
import {openAsBlob} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {chunks, toHtml} from './format.mjs';
import {fitForTelegram} from './media.mjs';

/** Creates a client bound to a bot token. */
export function telegram(token) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, params = {}) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.description}`);
    return json.result;
  }

  async function upload(method, field, path, params = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    form.append(field, await openAsBlob(path), basename(path));
    const res = await fetch(`${base}/${method}`, {method: 'POST', body: form});
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.description}`);
    return json.result;
  }

  return {
    call,

    /**
     * Sends Markdown as Telegram HTML in chunks; falls back to plain text if rejected.
     * `silent: true` delivers without a notification sound (statuses, acknowledgements).
     */
    async sendText(chatId, text, {silent = false, ...extra} = {}) {
      const parts = chunks(text);
      for (const [i, md] of parts.entries()) {
        // Buttons and the notification go with the last chunk only.
        const last = i === parts.length - 1;
        const more = {...(last ? extra : {}), disable_notification: silent || !last};
        try {
          await call('sendMessage', {chat_id: chatId, text: toHtml(md), parse_mode: 'HTML', link_preview_options: {is_disabled: true}, ...more});
        } catch {
          await call('sendMessage', {chat_id: chatId, text: md, ...more});
        }
      }
    },

    /** Sends a file; videos and photos play inline unless asDocument is set. */
    async sendFile(chatId, path, {caption, buttons, markup, asDocument, silent = false} = {}) {
      const ext = path.split('.').pop().toLowerCase();
      const kind = asDocument ? 'document'
        : ['mp4', 'mov', 'webm'].includes(ext) ? 'video'
        : ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? 'photo'
        : ['mp3', 'm4a', 'wav', 'ogg'].includes(ext) ? 'audio'
        : 'document';
      const method = {video: 'sendVideo', photo: 'sendPhoto', audio: 'sendAudio', document: 'sendDocument'}[kind];
      // Over the limit: send a compressed copy and say where the original is.
      const fit = fitForTelegram(path, kind);
      if (fit.note) {
        const ru = process.env.BOT_LANG !== 'en';
        const line = ru
          ? `📦 Сжал ${fit.note}, чтобы пролезть в лимит Telegram. Оригинал: ${path}`
          : `📦 Compressed ${fit.note} to fit Telegram's limit. Original: ${path}`;
        caption = caption ? `${caption}\n\n${line}` : line;
      }
      return upload(method, kind, fit.path, {
        chat_id: String(chatId),
        caption: caption && toHtml(caption.slice(0, 1000)),
        parse_mode: caption ? 'HTML' : undefined,
        reply_markup: markup ?? (buttons?.length ? keyboard(buttons) : undefined),
        supports_streaming: kind === 'video' ? 'true' : undefined,
        disable_notification: silent ? 'true' : undefined,
      });
    },

    /** Downloads a file by file_id to the given path. */
    async download(fileId, dest) {
      const file = await call('getFile', {file_id: fileId});
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    },
  };
}

/**
 * Inline keyboard, one button per row. Callback data is the button index: labels can
 * be longer than Telegram's 64-byte limit, the bot reads them back from the message.
 */
export function keyboard(labels) {
  return {inline_keyboard: labels.map((text, i) => [{text, callback_data: `b:${i}`}])};
}
