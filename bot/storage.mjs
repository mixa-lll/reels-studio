// Disk housekeeping for reels, shared by the web studio and the bot.
//
// A reel keeps every version it ever had, and a version is a 300 MB video. The rules:
// - the current version, the one picked for «Готово», masters (1080p/1440p/master), variants
//   and versions waiting in the outbox are never touched;
// - the previous version keeps only its light copy (to compare), older ones only a frame,
//   ARCHIVED.json and project-snapshot/ (the reel's code, enough to rebuild);
// - an accepted reel (done/published) drops the draft copies of all its old versions;
// - a reel published N days ago is packed: also its project/public media goes.
// Files go to the project's bin (.trash/) for 30 days, so a mistake can be undone (restore()).
// Each move is recorded next to the version.

import {cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';

export const DEFAULT_POLICY = {keepPrevious: true, archiveOlder: true, finalOnly: true, packAfterDays: 14};
const MASTER = /1440p|1080p|master/i;
const VIDEO = /\.(mp4|mov|webm)$/i;
const DAY = 864e5;

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + '\n');

export const readPolicy = (file) => ({...DEFAULT_POLICY, ...readJson(file, {})});

export function dirSize(p) {
  let n = 0;
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    for (const f of readdirSync(p)) n += dirSize(join(p, f));
  } catch {}
  return n;
}

export const versionDirs = (reelDir) => {
  const d = join(reelDir, 'versions');
  return existsSync(d) ? readdirSync(d).filter((v) => /^v\d+$/.test(v)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) : [];
};

// Copies the reel's code (not its media) next to a version, so an archived one can be rebuilt.
export function snapshot(reelDir, v) {
  const target = join(reelDir, 'versions', v, 'project-snapshot');
  const project = join(reelDir, 'project');
  if (existsSync(target) || !existsSync(project)) return;
  mkdirSync(target, {recursive: true});
  for (const f of readdirSync(project)) {
    const full = join(project, f);
    if (f === 'node_modules' || f === 'public' || lstatSync(full).isSymbolicLink()) continue;
    if (lstatSync(full).isDirectory() ? f === 'src' : /\.(mjs|js|ts|tsx|json|md)$/.test(f) && f !== 'package-lock.json') cpSync(full, join(target, f), {recursive: true});
  }
}

// When the reel came out: an item linked to it marked published, its Instagram post, or the
// first time the studio saw it in «Published» (remembered in storage.json).
export function publishedAt(reelDir, {items = [], status} = {}) {
  const id = basename(reelDir);
  const times = items.filter((x) => x.ref?.kind === 'reel' && x.ref.id === id).flatMap((x) => [
    x.stage === 'published' ? x.stageAt : null,
    ...(x.published || []).map((p) => Date.parse(p.timestamp || '') || null),
  ]).filter(Boolean);
  const meta = readJson(join(reelDir, 'storage.json'), {});
  if (status === 'published' && !meta.seenPublishedAt) {
    meta.seenPublishedAt = Date.now();
    try { writeJson(join(reelDir, 'storage.json'), meta); } catch {}
  }
  if (meta.seenPublishedAt) times.push(meta.seenPublishedAt);
  return times.length ? Math.min(...times) : null;
}

// What a pass would remove, without removing anything.
// mode: 'rules' (the policy), 'latest' (the «keep only the latest» button), 'pack'.
export function plan(reelDir, {policy = DEFAULT_POLICY, accepted = false, mode = 'rules', protect = []} = {}) {
  const vs = versionDirs(reelDir);
  const out = [];
  if (!vs.length) return out;
  const ready = readJson(join(reelDir, 'ready.json'), {}).v;
  const keepV = new Set([vs.at(-1), ready, ...protect].filter(Boolean));
  const older = vs.slice(0, -1);
  older.forEach((v, i) => {
    if (keepV.has(v)) return;
    const vdir = join(reelDir, 'versions', v);
    const files = readdirSync(vdir);
    // A master is a deliverable, not a draft (RU v1, EN v2…): such a version stays whole.
    if (files.some((f) => MASTER.test(f)) || files.includes('variant.json')) return;
    const videos = files.filter((f) => VIDEO.test(f)).map((f) => ({path: join(vdir, f), size: statSync(join(vdir, f)).size, v})).sort((a, b) => a.size - b.size);
    if (!videos.length) return;
    const previous = i === older.length - 1;
    let drop = [];
    if (mode === 'latest' || mode === 'pack' || (accepted && policy.finalOnly)) drop = videos;
    else if (previous) drop = policy.keepPrevious ? videos.slice(1) : policy.archiveOlder ? videos : [];
    else if (policy.archiveOlder) drop = videos;
    out.push(...drop);
  });
  if (mode === 'pack') {
    const pub = join(reelDir, 'project', 'public');
    const size = dirSize(pub);
    if (size) out.push({path: pub, size, v: null, public: true});
  }
  return out;
}

// The studio's own bin: projects/<p>/.trash/, same disk (a move, not a copy), readable by the
// studio (the macOS Trash is not, for a background service), emptied after TRASH_DAYS.
export const TRASH_DAYS = 30;
export const trashDir = (reelDir) => join(reelDir, '..', '..', '.trash');

function toTrash(path, trash, label) {
  mkdirSync(trash, {recursive: true});
  let to = join(trash, label);
  for (let i = 2; existsSync(to); i++) to = join(trash, label.replace(/(\.[^.]*)?$/, ` ${i}$1`));
  renameSync(path, to);
  // The bin counts days from the move, not from when the file was made.
  const now = new Date();
  utimesSync(to, now, now);
  return to;
}

// Empties what has been in the bin longer than TRASH_DAYS. Returns bytes freed.
export function emptyTrash(projectDir, days = TRASH_DAYS) {
  const trash = join(projectDir, '.trash');
  if (!existsSync(trash)) return 0;
  let freed = 0;
  for (const f of readdirSync(trash)) {
    const full = join(trash, f);
    if (Date.now() - lstatSync(full).mtimeMs < days * DAY) continue;
    freed += dirSize(full);
    rmSync(full, {recursive: true, force: true});
  }
  return freed;
}

// Runs a plan: snapshots, moves files to the Trash, records each move. Returns bytes freed.
export function apply(reelDir, opts = {}) {
  const vs = versionDirs(reelDir);
  if (!vs.length) return 0;
  snapshot(reelDir, vs.at(-1));
  const reel = basename(reelDir);
  let freed = 0;
  for (const x of plan(reelDir, opts)) {
    if (!existsSync(x.path)) continue;
    const to = toTrash(x.path, trashDir(reelDir), `${reel} ${x.public ? 'project-public' : `${x.v} ${basename(x.path)}`}`);
    freed += x.size;
    const rec = {from: x.path, to, size: x.size, at: Date.now()};
    if (x.public) {
      const meta = readJson(join(reelDir, 'storage.json'), {});
      writeJson(join(reelDir, 'storage.json'), {...meta, packed: Date.now(), trash: [...(meta.trash || []), rec]});
    } else {
      const vdir = join(reelDir, 'versions', x.v);
      snapshot(reelDir, x.v);
      const prev = readJson(join(vdir, 'ARCHIVED.json'), {freed: 0});
      const left = readdirSync(vdir).filter((f) => VIDEO.test(f)).length;
      writeJson(join(vdir, 'ARCHIVED.json'), {...prev, state: left ? 'previous' : 'old', at: Date.now(), freed: (prev.freed || 0) + x.size, trash: [...(prev.trash || []), rec]});
    }
  }
  return freed;
}

// Puts back whatever of this reel is still in the Trash. Returns how many items came back.
export function restore(reelDir) {
  let n = 0;
  const back = (recs) => (recs || []).filter((r) => {
    if (!r.to || !existsSync(r.to) || existsSync(r.from)) return true;
    try { renameSync(r.to, r.from); n++; return false; } catch { return true; }
  });
  for (const v of versionDirs(reelDir)) {
    const f = join(reelDir, 'versions', v, 'ARCHIVED.json');
    const a = readJson(f, null);
    if (!a?.trash) continue;
    const left = back(a.trash);
    if (left.length === a.trash.length) continue;
    // Everything back: the version is whole again.
    if (left.length) writeJson(f, {...a, trash: left});
    else rmSync(f);
  }
  const mf = join(reelDir, 'storage.json');
  const meta = readJson(mf, null);
  if (meta?.trash) {
    const left = back(meta.trash);
    writeJson(mf, {...meta, trash: left, packed: left.some((r) => r.from.endsWith('public')) ? meta.packed : null});
  }
  return n;
}

// What is still in the Trash for this reel (bytes), so the page can offer «вернуть».
export const inTrash = (reelDir) => [
  ...versionDirs(reelDir).flatMap((v) => readJson(join(reelDir, 'versions', v, 'ARCHIVED.json'), {}).trash || []),
  ...(readJson(join(reelDir, 'storage.json'), {}).trash || []),
].filter((r) => r.to && existsSync(r.to)).reduce((s, r) => s + r.size, 0);

export const isPacked = (reelDir) => Boolean(readJson(join(reelDir, 'storage.json'), {}).packed);

// Unsent outbox packages keep their version whole.
export const outboxVersions = (outboxFile, project, reel) => readJson(outboxFile, []).filter((o) => o.project === project && o.reel === reel && !o.sent && !o.cancelled).map((o) => o.version).filter(Boolean);

// One pass over a project's reels: rules everywhere, packing for reels out for N days.
// statusOf(reel) → 'done' | 'published' | …; busy(reel) → true skips a reel being worked on.
export function sweep(projectDir, {policy = DEFAULT_POLICY, statusOf = () => null, busy = () => false, outbox, project, dry = false} = {}) {
  const root = join(projectDir, 'reels');
  if (!existsSync(root)) return {freed: 0, reels: [], emptied: 0};
  const items = readJson(join(projectDir, 'items.json'), {}).items || [];
  let freed = 0;
  const reels = [];
  for (const r of readdirSync(root)) {
    const dir = join(root, r);
    if (r.startsWith('.') || !statSync(dir).isDirectory() || busy(r)) continue;
    const status = statusOf(r);
    const pub = publishedAt(dir, {items, status});
    const accepted = ['done', 'published'].includes(status) || Boolean(pub);
    const protect = outbox ? outboxVersions(outbox, project, r) : [];
    const pack = Boolean(pub && policy.packAfterDays > 0 && Date.now() - pub >= policy.packAfterDays * DAY);
    const opts = {policy, accepted, protect, mode: pack ? 'pack' : 'rules'};
    const n = dry ? plan(dir, opts).reduce((s, x) => s + x.size, 0) : apply(dir, opts);
    if (n) reels.push({reel: r, freed: n, packed: pack});
    freed += n;
  }
  return {freed, reels, emptied: dry ? 0 : emptyTrash(projectDir)};
}
