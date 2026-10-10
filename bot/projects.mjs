#!/usr/bin/env node
// Projects: independent sets of the owner's material (brief, ideas, playbook, reels,
// inbox), one folder each under projects/. One is active at a time; the bot switches
// between turns, so a session never sees two projects.
//
// The agent asks for a switch from inside a turn; the bot carries it out after the turn:
//   node bot/projects.mjs list                         slug, name and which one is active
//   node bot/projects.mjs new "<name>" [--carry "…"]   create one (prints its folder) and move to it
//   node bot/projects.mjs switch <slug> [--carry "…"]  move to an existing one
//   node bot/projects.mjs archive <slug>               move an inactive one to projects/.archive/
// --carry: the owner's request that led here, in their words with file paths; the new
// project's first turn starts from it.
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {DATA, FIRST_PROJECT, GLOBAL_KEYS, PROJECTS, ROOT, loadState} from './config.mjs';

const STARTER = join(ROOT, 'starter');
const REQUEST = join(DATA, 'project-request.json');
const dir = (slug) => join(PROJECTS, slug);
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

const RU = 'а:a б:b в:v г:g д:d е:e ё:e ж:zh з:z и:i й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:h ц:ts ч:ch ш:sh щ:sch ъ: ы:y ь: э:e ю:yu я:ya';
const TRANSLIT = Object.fromEntries(RU.split(' ').map((p) => p.split(':')));

/** A free folder name for a project called `name`. */
function slugFor(name) {
  const base = [...name.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'project';
  let slug = base;
  for (let i = 2; existsSync(dir(slug)) || existsSync(join(PROJECTS, '.archive', slug)); i++) slug = `${base}-${i}`;
  return slug;
}

/** Display name: the `name` in its settings.json, or '' until the agent gives one. */
export const projectName = (slug) => readJson(join(dir(slug), 'settings.json')).name ?? '';

/** Projects in creation order: [{slug, name}]. */
export function listProjects() {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS, {withFileTypes: true})
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({slug: d.name, name: projectName(d.name), created: readJson(join(dir(d.name), 'settings.json')).created ?? ''}))
    .sort((a, b) => (a.slug === FIRST_PROJECT ? -1 : b.slug === FIRST_PROJECT ? 1 : a.created.localeCompare(b.created)))
    .map(({slug, name}) => ({slug, name}));
}

export const projectExists = (slug) => Boolean(slug) && !slug.startsWith('.') && existsSync(join(dir(slug), 'settings.json'));

function seed(slug, name) {
  cpSync(STARTER, dir(slug), {recursive: true});
  const file = join(dir(slug), 'settings.json');
  const s = readJson(file);
  for (const k of GLOBAL_KEYS) delete s[k];
  writeFileSync(file, JSON.stringify({name, created: new Date().toISOString(), ...s}, null, 2) + '\n');
  return slug;
}

/** Creates a project from starter/ and returns its slug. */
export const createProject = (name = '') => seed(slugFor(name), name);

/**
 * True for a project nobody worked in: brief still the starter one, no reels, nothing
 * sent. Such a project is removed when the owner leaves it, so a stray tap leaves no trace.
 */
export function untouched(slug) {
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const reels = join(dir(slug), 'reels');
  return read(join(dir(slug), 'brief.md')) === read(join(STARTER, 'brief.md'))
    && !existsSync(join(dir(slug), 'inbox'))
    && (!existsSync(reels) || readdirSync(reels).every((f) => f.startsWith('.')));
}

export function removeProject(slug) {
  rmSync(dir(slug), {recursive: true, force: true});
}

// Paths written into notes before projects existed, rewritten to where things are now.
function rewritePaths(root, slug) {
  const to = `projects/${slug}/`;
  const walk = (d) => {
    for (const e of readdirSync(d, {withFileTypes: true})) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!/^(node_modules|project|sources|versions)$/.test(e.name)) walk(full);
      } else if (/\.(md|json)$/.test(e.name)) {
        const text = readFileSync(full, 'utf8');
        const next = text.replace(/(?<![\w.-])data\/inbox\//g, `${to}inbox/`).replace(/(?<![\w.-])studio\//g, to);
        if (next !== text) writeFileSync(full, next);
      }
    }
  };
  walk(root);
}

/**
 * Makes sure an active project exists. The one-folder layout of older versions
 * (studio/ + data/inbox + data/handoff.md) becomes the first project; global switches
 * move to data/settings.json. Returns true if state changed.
 */
export function ensureProjects(state) {
  mkdirSync(PROJECTS, {recursive: true});
  const old = join(ROOT, 'studio');
  if (!process.env.REELS_PROJECTS && existsSync(old) && !existsSync(dir(FIRST_PROJECT))) {
    renameSync(old, dir(FIRST_PROJECT));
    const first = dir(FIRST_PROJECT);
    if (existsSync(join(DATA, 'inbox'))) renameSync(join(DATA, 'inbox'), join(first, 'inbox'));
    if (existsSync(join(DATA, 'handoff.md'))) renameSync(join(DATA, 'handoff.md'), join(first, 'handoff.md'));
    const file = join(first, 'settings.json');
    const s = readJson(file);
    const global = Object.fromEntries(GLOBAL_KEYS.filter((k) => k in s).map((k) => [k, s[k]]));
    for (const k of GLOBAL_KEYS) delete s[k];
    writeFileSync(file, JSON.stringify({name: '', ...s}, null, 2) + '\n');
    writeFileSync(join(DATA, 'settings.json'), JSON.stringify({...readJson(join(DATA, 'settings.json')), ...global}, null, 2) + '\n');
    rewritePaths(first, FIRST_PROJECT);
    console.log(`moved studio/ to projects/${FIRST_PROJECT}/`);
  }
  if (!listProjects().length) seed(FIRST_PROJECT, '');
  if (projectExists(state.project)) return false;
  state.project = listProjects()[0].slug;
  // Everything said in the chat so far belongs to it.
  state.projectLog ??= [[0, state.project]];
  return true;
}

/** The project that was active when message `id` was sent (message ids only grow). */
export function projectAt(state, id) {
  return (state.projectLog ?? []).filter(([from]) => from <= id).at(-1)?.[1] ?? state.project;
}

/** The switch the agent asked for during its turn, or null; read once. */
export function takeRequest() {
  if (!existsSync(REQUEST)) return null;
  const r = readJson(REQUEST);
  rmSync(REQUEST, {force: true});
  return projectExists(r.slug) ? r : null;
}

export const dropRequest = () => rmSync(REQUEST, {force: true});

// ---------- CLI for the agent ----------

if (process.argv[1]?.endsWith('projects.mjs')) {
  const {values: o, positionals: [action, arg]} = parseArgs({allowPositionals: true, options: {carry: {type: 'string'}}});
  const active = loadState().project;
  const request = (slug, created) => {
    writeFileSync(REQUEST, JSON.stringify({slug, created, carry: o.carry ?? ''}));
    console.log(`The bot moves to it right after this turn. Before ending the turn: update this project's files and its handoff.md as on a session close; end with NO_REPLY, the bot tells the owner.`);
  };
  if (action === 'list') {
    for (const p of listProjects()) console.log(`${p.slug === active ? '* ' : '  '}${p.slug}  ${p.name || '(no name yet)'}`);
  } else if (action === 'new' && arg !== undefined) {
    const slug = createProject(arg.trim());
    console.log(relative(ROOT, dir(slug)));
    request(slug, true);
  } else if (action === 'switch' && projectExists(arg)) {
    if (arg === active) console.log('Already the active project.');
    else request(arg, false);
  } else if (action === 'archive' && projectExists(arg) && arg !== active) {
    mkdirSync(join(PROJECTS, '.archive'), {recursive: true});
    renameSync(dir(arg), join(PROJECTS, '.archive', arg));
    console.log(`Moved to projects/.archive/${arg}`);
  } else {
    console.error('Usage: node bot/projects.mjs list | new "<name>" [--carry "…"] | switch <slug> [--carry "…"] | archive <inactive slug>');
    process.exit(1);
  }
}
