// Paths, .env and persistent state shared by the bot and the send CLI.
import {copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// REELS_DATA / REELS_PROJECTS move state elsewhere (tests use temp folders).
export const DATA = process.env.REELS_DATA || join(ROOT, 'data');
// The owner's material, one folder per project: brief, ideas, playbook, reels, inbox.
// One project is active at a time (state.project); bot/projects.mjs creates and switches them.
export const PROJECTS = process.env.REELS_PROJECTS || join(ROOT, 'projects');
export const FIRST_PROJECT = 'main';
const STATE = join(DATA, 'state.json');
// Machine-wide switches; everything else in settings belongs to the active project.
const GLOBAL_SETTINGS = join(DATA, 'settings.json');
export const GLOBAL_KEYS = ['updateChecks', 'autoUpdate', 'agentGlobalSettings', 'keepAwake'];

mkdirSync(DATA, {recursive: true});
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

/**
 * The active project's folder. Agent turns get it as REELS_STUDIO, so the scripts and
 * send CLI they run stay in the project the turn started in.
 */
export function studio() {
  return process.env.REELS_STUDIO || join(PROJECTS, loadState().project || FIRST_PROJECT);
}

/** Files the owner sent to the active project, and history.md listing them all. */
export const inbox = () => join(studio(), 'inbox');

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

/**
 * Owner-facing settings the agent edits on request; re-read on every use. The active
 * project's settings.json, with the machine-wide keys from data/settings.json on top.
 */
export function settings() {
  return {...readJson(join(studio(), 'settings.json')), ...readJson(GLOBAL_SETTINGS)};
}

/** Merges `patch` into the right settings file (undefined values remove a key). */
export function writeSettings(patch) {
  for (const [file, keys] of [[GLOBAL_SETTINGS, (k) => GLOBAL_KEYS.includes(k)], [join(studio(), 'settings.json'), (k) => !GLOBAL_KEYS.includes(k)]]) {
    const mine = Object.entries(patch).filter(([k]) => keys(k));
    if (!mine.length) continue;
    const next = {...readJson(file), ...Object.fromEntries(mine)};
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  }
  return settings();
}

/** Reads data/state.json: owner, chat, current session and its counters. */
export function loadState() {
  // A crash mid-write cannot corrupt it (writes are atomic), but fall back to the
  // previous copy just in case.
  for (const file of [STATE, `${STATE}.bak`]) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
  }
  return {};
}

export function saveState(state) {
  const tmp = `${STATE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  if (existsSync(STATE)) copyFileSync(STATE, `${STATE}.bak`);
  renameSync(tmp, STATE);
}
