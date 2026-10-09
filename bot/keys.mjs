// The reply keyboard under the input field: the owner's main options at this moment
// (ideas, «make now / set up», edits). Only one exists at a time; the bot removes it as
// soon as work moves on. Inline buttons are for optional actions on a single message.
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA} from './config.mjs';

const FILE = join(DATA, 'keyboard.json');

/** Always the last button under a batch of ideas; the bot adds it, not the agent. */
export const moreIdeasLabel = () => (process.env.BOT_LANG === 'en' ? '🎲 More ideas' : '🎲 Другие идеи');
const KEY_LINE = /\n?\s*⌨️\s*(.+?)\s*$/;

/** Reply-keyboard markup; the labels are remembered so taps can be recognised. */
export function replyKeyboard(labels, {menu, tune, placeholder, retry, retryLabel, more} = {}) {
  writeFileSync(FILE, JSON.stringify({labels, menu, tune, retry, retryLabel, more}));
  return {
    keyboard: labels.map((text) => [{text}]),
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: placeholder?.slice(0, 64),
  };
}

/** The keyboard currently shown, or null. */
export function currentKeys() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Forgets the keyboard; returns true if one was shown. */
export function forgetKeys() {
  if (!existsSync(FILE)) return false;
  rmSync(FILE, {force: true});
  return true;
}

/** Splits a trailing `⌨️ A | B | C` line off an agent reply. */
export function splitKeyLine(text) {
  const m = text.match(KEY_LINE);
  if (!m) return {text, labels: null};
  const labels = m[1].split('|').map((s) => s.trim()).filter(Boolean);
  return {text: text.slice(0, m.index).trimEnd(), labels: labels.length ? labels : null};
}
