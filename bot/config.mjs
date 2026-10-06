// Paths, .env and persistent state shared by the bot and the send CLI.
import {cpSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// REELS_DATA / REELS_STUDIO move state elsewhere (tests use temp folders).
export const DATA = process.env.REELS_DATA || join(ROOT, 'data');
export const INBOX = join(DATA, 'inbox');
// The owner's own material: brief, ideas, playbook, reels. Seeded from starter/ once.
export const STUDIO = process.env.REELS_STUDIO || join(ROOT, 'studio');
const STATE = join(DATA, 'state.json');

mkdirSync(INBOX, {recursive: true});
if (!existsSync(STUDIO)) cpSync(join(ROOT, 'starter'), STUDIO, {recursive: true});
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

export const env = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  agent: process.env.AGENT || 'claude',
  agentBin: process.env.AGENT_BIN || '',
  agentModel: process.env.AGENT_MODEL || '',
  // Secret in the t.me/<bot>?start=<code> link that makes its opener the owner.
  ownerCode: process.env.OWNER_CODE || '',
  // A session is rotated (after a handoff note) when any limit is hit.
  sessionMaxTokens: Number(process.env.SESSION_MAX_TOKENS || 120_000),
  sessionMaxTurns: Number(process.env.SESSION_MAX_TURNS || 40),
  sessionIdleHours: Number(process.env.SESSION_IDLE_HOURS || 12),
};

/** Owner-facing settings the agent edits on request; re-read on every use. */
export function settings() {
  try {
    return JSON.parse(readFileSync(join(STUDIO, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Reads data/state.json: owner, chat, current session and its counters. */
export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(state) {
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}
