#!/usr/bin/env node
// Creates <project>/reels/<NN>-<slug>/ in the active project with sources/, versions/
// and project/ (a copy of template/ whose node_modules is linked, not copied: ~700 MB).
// Usage: node scripts/new-reel.mjs <slug>     → prints the new folder
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Agent turns get the active project as REELS_STUDIO; run by hand, ask the bot's state.
const active = () => {
  try {
    return JSON.parse(readFileSync(join(process.env.REELS_DATA || join(ROOT, 'data'), 'state.json'), 'utf8')).project;
  } catch {}
};
const REELS = join(process.env.REELS_STUDIO || join(process.env.REELS_PROJECTS || join(ROOT, 'projects'), active() || 'main'), 'reels');
const slug = (process.argv[2] ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
if (!slug) {
  console.error('Usage: node scripts/new-reel.mjs <latin-slug>');
  process.exit(1);
}

mkdirSync(REELS, {recursive: true});
const taken = readdirSync(REELS).map((d) => Number(d.slice(0, 2))).filter(Number.isFinite);
const nn = String(Math.max(0, ...taken) + 1).padStart(2, '0');
const reel = join(REELS, `${nn}-${slug}`);
const project = join(reel, 'project');

for (const d of ['sources', 'versions']) mkdirSync(join(reel, d), {recursive: true});
cpSync(join(ROOT, 'template'), project, {recursive: true, filter: (src) => !src.includes('node_modules')});

const modules = join(ROOT, 'template', 'node_modules');
if (existsSync(modules)) {
  // A junction needs no admin rights on Windows; elsewhere it is a plain symlink.
  symlinkSync(modules, join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}
console.log(reel);
