// Publishing packages planned in the web studio (POST /api/publish): at the chosen time the
// bot sends the caption, the video and the cover to whoever planned it, and they post it
// from the phone. The list sits next to the team list (REELS_MEMBERS) in outbox.json.
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {FILE as MEMBERS} from './members.mjs';

const FILE = MEMBERS ? join(dirname(MEMBERS), 'outbox.json') : '';

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; } };
const save = (items) => { writeFileSync(`${FILE}.tmp`, JSON.stringify(items, null, 2)); renameSync(`${FILE}.tmp`, FILE); };

/** Items whose time has come and that are neither sent nor cancelled. */
export function due(now = Date.now()) {
  if (!FILE) return [];
  return load().filter((o) => !o.sent && !o.cancelled && o.at <= now);
}

/** Marks one item sent (or failed, with the error) so it is not sent twice. */
export function mark(id, fields) {
  const items = load();
  const it = items.find((o) => o.id === id);
  if (!it) return;
  Object.assign(it, fields);
  save(items);
}

/** The Telegram chat of the person who planned it, if they linked the bot. */
export function chatOf(personId) {
  try {
    const a = JSON.parse(readFileSync(MEMBERS, 'utf8'));
    return a.people?.find((p) => p.id === personId)?.telegram?.chatId || null;
  } catch {
    return null;
  }
}

export const filesThere = (files) => files.filter((f) => existsSync(f));
