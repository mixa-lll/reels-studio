// Team members besides the owner, invited from the web version.
//
// The list lives in REELS_MEMBERS (a JSON file the web version writes too):
//   {people: [{id, name, role: 'editor'|'member', isOwner?, deputyUntil?, onCamera?, telegram?: {id, chatId, username}}],
//    invites: [{code, name, role, expires, telegram: bool, web: bool, person?, claimed?: [...]}]}
// (bot/roles.mjs; older owner / viewer / author lists read as the new shape.)
// Without REELS_MEMBERS the bot stays a one-owner bot. Members share the owner's
// project and agent; the bot serves one person at a time (see bot.mjs, «team»).
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {dirname, join} from 'node:path';
import {isEditor, normalize} from './roles.mjs';

export const FILE = process.env.REELS_MEMBERS || '';

function load() {
  try {
    const a = {people: [], invites: [], sessions: [], ...JSON.parse(readFileSync(FILE, 'utf8'))};
    a.people = a.people.map(normalize);
    return a;
  } catch {
    return {people: [], invites: [], sessions: []};
  }
}
function save(a) {
  writeFileSync(`${FILE}.tmp`, JSON.stringify(a, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
}

/**
 * The team member with this Telegram id, or null. In the bot an editor (or a deputy)
 * talks to the agent ('editor'); a member gets the button dialog for sending material
 * ('author', bot/author.mjs).
 */
export function member(telegramId) {
  const p = FILE ? load().people.find((x) => x.telegram?.id === telegramId && !x.isOwner) : null;
  if (p) return {name: p.name, role: isEditor(p) ? 'editor' : 'author', onCamera: !!p.onCamera, chatId: p.telegram.chatId};
  // Partners listed in the environment are editors without an invite: on the shared
  // stage the bot has one owner, and the other partner gets in through MINIAPP_OWNERS
  // (the same ids the mini app treats as owners) or BOT_EDITORS.
  const ids = `${process.env.BOT_EDITORS || ''},${process.env.MINIAPP_OWNERS || ''}`.split(',').map((x) => Number(x.trim())).filter(Boolean);
  return ids.includes(telegramId) ? {name: 'Соавтор', role: 'editor', onCamera: true, chatId: telegramId} : null;
}

/** Notes when a member last wrote, for the web version's list of sessions (at most once a minute). */
export function touch(telegramId) {
  if (!FILE) return;
  const a = load();
  const p = a.people.find((x) => x.telegram?.id === telegramId);
  if (!p || Date.now() - (p.telegram.seen ?? 0) < 60_000) return;
  p.telegram.seen = Date.now();
  save(a);
}

/** Turns an invite code from t.me/<bot>?start=inv_<code> into a member. */
export function claim(code, from, chatId) {
  if (!FILE || !existsSync(FILE)) return null;
  const a = load();
  const inv = a.invites.find((x) => (x.code === code || x.pin === code) && x.telegram && x.expires > Date.now() && !x.claimed?.includes('telegram'));
  if (!inv) return null;
  let person = a.people.find((x) => x.id === inv.person);
  if (!person) {
    person = normalize({id: randomBytes(18).toString('base64url'), name: inv.name, role: inv.role, onCamera: !!inv.onCamera, web: !!inv.web, deputyUntil: inv.deputyUntil || null, added: Date.now()});
    a.people.push(person);
    inv.person = person.id;
  }
  person.telegram = {id: from.id, chatId, username: from.username ?? null};
  inv.claimed = [...(inv.claimed ?? []), 'telegram'];
  // One link per channel: once every channel it was made for is used, it is gone.
  if (!inv.web || inv.claimed.includes('web')) a.invites = a.invites.filter((x) => x !== inv);
  save(a);
  appendLog(person.name, 'подключился к Telegram-боту по приглашению');
  return {name: person.name, role: isEditor(person) ? 'editor' : 'author'};
}

/** The bot's @username, for the web version's invite links. */
export function publishBot(username) {
  if (!FILE) return;
  try {
    writeFileSync(join(dirname(FILE), 'bot.json'), JSON.stringify({username}));
  } catch {}
}

function appendLog(who, what) {
  try {
    writeFileSync(join(dirname(FILE), 'log.jsonl'), JSON.stringify({at: Date.now(), who, what}) + '\n', {flag: 'a'});
  } catch {}
}
