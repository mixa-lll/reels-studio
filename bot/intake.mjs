// Turns any Telegram message into text the agent can act on: every kind of content,
// forwards, replies and hidden links. Files land in the active project's inbox/<day>/,
// and every message is appended to its inbox/history.md so earlier material stays
// reachable after a session change.
import {appendFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {inbox} from './config.mjs';

/** Telegram does not let bots download files bigger than this. */
export const DOWNLOAD_LIMIT = 20 * 1024 * 1024;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const safe = (name) => name.replace(/[^\w.\-]+/g, '_').slice(-80);

// The attachment of a message, if any: {id, name, kind, size, note}.
function attachment(msg) {
  const id = msg.message_id;
  if (msg.photo) {
    const p = msg.photo.at(-1);
    return {id: p.file_id, size: p.file_size, name: `photo-${id}.jpg`, kind: 'photo'};
  }
  if (msg.animation) return {id: msg.animation.file_id, size: msg.animation.file_size, name: msg.animation.file_name ?? `gif-${id}.mp4`, kind: 'GIF (mp4)'};
  if (msg.video) return {id: msg.video.file_id, size: msg.video.file_size, name: msg.video.file_name ?? `video-${id}.mp4`, kind: 'video'};
  if (msg.video_note) return {id: msg.video_note.file_id, size: msg.video_note.file_size, name: `circle-${id}.mp4`, kind: 'video note'};
  if (msg.voice) return {id: msg.voice.file_id, size: msg.voice.file_size, name: `voice-${id}.ogg`, kind: 'voice note'};
  if (msg.audio) return {id: msg.audio.file_id, size: msg.audio.file_size, name: msg.audio.file_name ?? `audio-${id}.mp3`, kind: 'audio', note: [msg.audio.performer, msg.audio.title].filter(Boolean).join(' — ')};
  if (msg.document) return {id: msg.document.file_id, size: msg.document.file_size, name: msg.document.file_name ?? `file-${id}`, kind: `file (${msg.document.mime_type ?? 'unknown type'})`};
  if (msg.sticker) {
    const s = msg.sticker;
    const ext = s.is_animated ? 'tgs' : s.is_video ? 'webm' : 'webp';
    return {id: s.file_id, size: s.file_size, name: `sticker-${id}.${ext}`, kind: 'sticker', note: `${s.emoji ?? ''}${s.set_name ? ` from set ${s.set_name}` : ''}${s.is_animated ? ' (animated Lottie .tgs)' : ''}`};
  }
  return null;
}

// Links hidden behind text (text_link) are invisible in plain text; list them.
function hiddenLinks(entities = []) {
  return entities.filter((e) => e.type === 'text_link').map((e) => e.url);
}

function forwardedFrom(msg) {
  const o = msg.forward_origin;
  if (!o) return null;
  const who = o.type === 'user' ? [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ')
    : o.type === 'hidden_user' ? o.sender_user_name
    : o.type === 'chat' ? o.sender_chat.title
    : o.type === 'channel' ? `${o.chat.title}${o.chat.username ? ` (t.me/${o.chat.username}/${o.message_id})` : ''}`
    : 'someone';
  return `${who}, ${new Date(o.date * 1000).toISOString().slice(0, 16).replace('T', ' ')}`;
}

// Everything that is not a file: places, contacts, polls, dice, stories.
function other(msg) {
  if (msg.venue) return `(venue: ${msg.venue.title}, ${msg.venue.address}; ${msg.venue.location.latitude}, ${msg.venue.location.longitude})`;
  if (msg.location) return `(location: ${msg.location.latitude}, ${msg.location.longitude})`;
  if (msg.contact) return `(contact: ${[msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ')}, ${msg.contact.phone_number})`;
  if (msg.poll) return `(poll: "${msg.poll.question}" — ${msg.poll.options.map((o) => o.text).join(' / ')})`;
  if (msg.dice) return `(dice ${msg.dice.emoji}: ${msg.dice.value})`;
  if (msg.story) return `(forwarded a story from ${msg.story.chat?.title ?? msg.story.chat?.username ?? 'a chat'}; bots cannot open stories, ask for a screen recording)`;
  return null;
}

/**
 * Describes one message for the agent. Downloads its file (transcribing voice), and
 * reports what could not be taken in `problems` (plain-language, for the owner).
 * Returns {prompt, said, problems}.
 */
export async function describe(tg, msg, {transcribe, lang, onInstall}) {
  const parts = [];
  const problems = [];
  let said = null;

  const fwd = forwardedFrom(msg);
  if (fwd) parts.push(`(forwarded from ${fwd})`);
  const reply = msg.reply_to_message;
  if (reply) {
    const quoted = msg.quote?.text ?? reply.caption ?? reply.text ?? (attachment(reply)?.kind ? `a ${attachment(reply).kind}` : 'a message');
    parts.push(`(in reply to: "${quoted}")`);
  }
  if (msg.edit_date) parts.push('(the owner edited an earlier message; this is the new version)');

  const file = attachment(msg);
  if (file) {
    if (file.size && file.size > DOWNLOAD_LIMIT) {
      problems.push({kind: 'tooBig', size: mb(file.size), what: file.kind});
      parts.push(`(attached ${file.kind}, ${mb(file.size)}: too big for the bot to download (Telegram limit 20 MB); the owner was told)`);
    } else {
      const day = new Date().toLocaleDateString('sv');
      mkdirSync(join(inbox(), day), {recursive: true});
      const dest = join(inbox(), day, `${msg.message_id}-${safe(file.name)}`);
      try {
        await tg.download(file.id, dest);
        parts.push(`(attached ${file.kind}${file.note ? `: ${file.note}` : ''} → ${dest})`);
        if (file.kind === 'voice note' || file.kind === 'video note') {
          said = await transcribe(dest, lang, {onInstall});
          if (said) parts.push(`(transcript: "${said}")`);
          else {
            problems.push({kind: 'stt'});
            parts.push('(speech-to-text failed; the owner was told)');
          }
        }
      } catch (e) {
        problems.push({kind: 'download', what: file.kind, error: e.message});
        parts.push(`(attached ${file.kind}, download failed: ${e.message})`);
      }
    }
  }

  const misc = other(msg);
  if (misc) parts.push(misc);
  const text = msg.text ?? msg.caption;
  if (text) parts.push(text);
  const links = hiddenLinks(msg.entities ?? msg.caption_entities);
  if (links.length) parts.push(`(links in the text: ${links.join(', ')})`);

  return {prompt: parts.join('\n'), said: text ?? said, problems};
}

/** Appends what the owner sent to the project's inbox/history.md (newest last). */
export function remember(prompt, when = new Date()) {
  const stamp = when.toISOString().slice(0, 16).replace('T', ' ');
  mkdirSync(inbox(), {recursive: true});
  appendFileSync(join(inbox(), 'history.md'), `\n## ${stamp}\n${prompt}\n`);
}
