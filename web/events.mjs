// What happened to a project's content, one JSON line per event (handbook/BOT-LEAN.md):
// a stage changed, a version was made, material or a fact arrived. The server, the bot
// and the agent write here through logEvent(); the bot's reminders and the studio's
// «what's new» read the same lines, so both follow one rule.
//
// projects/<p>/events.jsonl: {"t": 1793790000000, "type": "stage", "item": "i-7f3a", ...}
import {appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export const TYPES = ['new', 'stage', 'version', 'material', 'need', 'fact', 'publish'];
const MAX_BYTES = 1024 * 1024;
const KEEP = 2000;

export const eventsFile = (studio) => join(studio, 'events.jsonl');

/** Appends one event; a file past 1 MB keeps its last 2000 lines. Never throws. */
export function logEvent(studio, ev, now = Date.now()) {
  if (!TYPES.includes(ev?.type)) return null;
  const line = {t: now, ...ev};
  try {
    const f = eventsFile(studio);
    appendFileSync(f, JSON.stringify(line) + '\n');
    if (statSync(f).size > MAX_BYTES) {
      const lines = readFileSync(f, 'utf8').trim().split('\n').slice(-KEEP);
      writeFileSync(`${f}.tmp`, lines.join('\n') + '\n');
      renameSync(`${f}.tmp`, f);
    }
  } catch (e) {
    console.error('events', e.message);
  }
  return line;
}

/** Events after `since` (ms), oldest first; `types` narrows them. */
export function readEvents(studio, {since = 0, types = null} = {}) {
  const f = eventsFile(studio);
  if (!existsSync(f)) return [];
  const out = [];
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l) continue;
    try {
      const e = JSON.parse(l);
      if (e.t > since && (!types || types.includes(e.type))) out.push(e);
    } catch {}
  }
  return out;
}
