// One project on several of the owner's computers (issue #142).
//
// Light part — texts and data (ideas.md, items.json, plan, PLAYBOOK, refs, each reel's README,
// *.json and project/src): the project folder is a git repository of its own (private, not the
// code's), and the studio pulls and pushes it (on start, every minute, after a Claude turn and an
// edit). A merge git cannot do keeps both versions: ours in place, theirs next to it as
// «<name>.конфликт-<device>.<ext>», and a question in sync-conflicts.json for the owner.
//
// Heavy part — sources/, versions/, project/public/ of each reel: never in git. The reel's
// files.json lists them with sizes and sha256; each file goes to R2 once, under <project>/media/<hash>,
// and a computer that opens the reel downloads what it lacks (its sources, the latest version, the
// small files of older ones).
//
// Who holds a reel: files.json.holder = {node, name, at}. Only the holder renders, cleans and runs
// Claude on it. Another computer asks for it (handoff) and the holder, on its next pass, sends its
// last edits and media and hands it over; «force» takes it without waiting (the holder sleeps).
//
// Local bookkeeping lives in <project>/.sync/ (never in git): hashes, what is in the cloud, when
// each reel was opened here.

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, relative, sep} from 'node:path';
import {get, head, put} from './cloud.mjs';

const DAY = 864e5;
export const HEAVY = ['sources', 'versions', join('project', 'public')];
export const EVICT_DAYS = 14;
// Any file bigger than this that git would take is left out of it (and named in the log).
const GIT_MAX = 5 * 1024 * 1024;
// Older versions' files under this size (frames, json, snapshots) come along when a reel is opened.
const SMALL = 2 * 1024 * 1024;

export const GITIGNORE = `# Reels Studio (bot/sync.mjs): only the light part of the project is in git.
# Media lives in Cloudflare R2 by hash, listed in each reel's files.json.
.sync/
.trash/
.trash-cloud.json
node_modules/
reels/*/sources/
reels/*/versions/
reels/*/project/public/
reels/*/project/out/
reels/*/project/node_modules/
inbox/
*.mp4
*.mov
*.m4v
*.webm
*.mkv
*.wav
*.mp3
*.m4a
*.aac
*.aif
*.aiff
*.heic
*.psd
*.zip
*.part
.DS_Store
`;

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { mkdirSync(dirname(f), {recursive: true}); writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const local = (projectDir, name) => join(projectDir, '.sync', name);

// ---------- git ----------

function git(dir, args, {who, raw = false} = {}) {
  const env = {...process.env, GIT_TERMINAL_PROMPT: '0'};
  if (who) Object.assign(env, {GIT_AUTHOR_NAME: who, GIT_COMMITTER_NAME: who, GIT_AUTHOR_EMAIL: 'studio@reels.local', GIT_COMMITTER_EMAIL: 'studio@reels.local'});
  const r = spawnSync('git', args, {cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  return {ok: r.status === 0, out: raw ? r.stdout || '' : (r.stdout || '').trim(), err: (r.stderr || '').trim()};
}
const must = (r, what) => { if (!r.ok) throw new Error(`git ${what}: ${r.err || r.out}`); return r.out; };

export const isRepo = (dir) => existsSync(join(dir, '.git'));
const branchOf = (dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
const hasRemote = (dir) => git(dir, ['remote']).out.split('\n').includes('origin');

// Turns a project folder into its sync repository (first computer) — scripts/sync-setup.mjs.
export function initRepo(dir, {remote, who = 'studio'} = {}) {
  if (!isRepo(dir)) must(git(dir, ['init', '-q', '-b', 'main']), 'init');
  const ig = join(dir, '.gitignore');
  if (!existsSync(ig)) writeFileSync(ig, GITIGNORE);
  if (remote && !hasRemote(dir)) must(git(dir, ['remote', 'add', 'origin', remote]), 'remote');
  commitAll(dir, who, 'Студия: проект в git');
  if (remote) must(git(dir, ['push', '-q', '-u', 'origin', 'HEAD']), 'push');
}

// Everything git may take, minus files too big for it (they stay local and are named).
function commitAll(dir, who, msg) {
  git(dir, ['add', '-A']);
  const staged = git(dir, ['diff', '--cached', '--name-only', '-z']).out.split('\0').filter(Boolean);
  const big = staged.filter((f) => { try { return statSync(join(dir, f)).size > GIT_MAX; } catch { return false; } });
  if (big.length) {
    git(dir, ['reset', '-q', '--', ...big]);
    const ex = join(dir, '.git', 'info', 'exclude');
    mkdirSync(dirname(ex), {recursive: true});
    let was = '';
    try { was = readFileSync(ex, 'utf8'); } catch {}
    writeFileSync(ex, was + (was && !was.endsWith('\n') ? '\n' : '') + big.map((f) => '/' + f + '\n').join(''));
  }
  if (!git(dir, ['diff', '--cached', '--quiet']).ok) must(git(dir, ['commit', '-q', '-m', msg], {who}), 'commit');
  return big;
}

// The file next to a conflicted one that keeps the other computer's version.
export const conflictCopy = (file, from) => {
  const ext = extname(file);
  return `${file.slice(0, file.length - ext.length)}.конфликт-${from}${ext}`;
};

// files.json from two computers: the later holder and handoff win, the file lists join.
export function mergeFilesJson(a = {}, b = {}) {
  const at = (x) => x?.at || 0;
  const holder = at(a.holder) >= at(b.holder) ? a.holder : b.holder;
  let handoff = at(a.handoff) >= at(b.handoff) ? a.handoff : b.handoff;
  if (handoff && holder?.node === handoff.to && at(holder) >= at(handoff)) handoff = null;
  // The holder's list is the truth about the media; the other side may only add.
  const main = holder?.node && b.holder?.node === holder.node && at(b.holder) > at(a.holder) ? b : a;
  const other = main === a ? b : a;
  const byPath = new Map((other.files || []).map((f) => [f.path, f]));
  for (const f of main.files || []) byPath.set(f.path, f);
  return {...other, ...main, holder: holder || null, handoff: handoff || null, files: [...byPath.values()].sort((x, y) => x.path.localeCompare(y.path))};
}

// Pulls, merges and pushes the project's light part. Returns {pulled, pushed, conflicts, big}.
export function syncGit(dir, {node = 'device', name = node} = {}) {
  const out = {pulled: false, pushed: false, conflicts: [], big: []};
  if (!isRepo(dir)) return {...out, skipped: 'no repo'};
  out.big = commitAll(dir, name, `Правки (${name})`);
  if (!hasRemote(dir)) return out;
  const branch = branchOf(dir);
  for (let attempt = 0; attempt < 3; attempt++) {
    must(git(dir, ['fetch', '-q', 'origin']), 'fetch');
    const theirs = `origin/${branch}`;
    if (git(dir, ['rev-parse', '-q', '--verify', theirs]).ok) {
      const before = git(dir, ['rev-parse', 'HEAD']).out;
      const m = git(dir, ['merge', '-q', '--no-edit', theirs], {who: name});
      if (!m.ok) out.conflicts.push(...resolve(dir, node, name));
      out.pulled ||= git(dir, ['rev-parse', 'HEAD']).out !== before;
    }
    const ahead = git(dir, ['rev-list', '--count', `${theirs}..HEAD`]);
    if (ahead.ok && ahead.out === '0') return out;
    if (git(dir, ['push', '-q', 'origin', `HEAD:${branch}`]).ok) { out.pushed = true; return out; }
    // Someone pushed in between: fetch and merge again.
  }
  throw new Error('git push: the remote keeps moving');
}

// A merge git could not do: files.json is merged by its rules, anything else keeps both versions.
function resolve(dir, node, name) {
  const files = git(dir, ['diff', '--name-only', '--diff-filter=U', '-z']).out.split('\0').filter(Boolean);
  const from = git(dir, ['log', '-1', '--format=%an', 'MERGE_HEAD']).out.replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'другой';
  const list = readJson(join(dir, 'sync-conflicts.json'), []);
  const done = [];
  for (const f of files) {
    const stage = (n) => { const r = git(dir, ['show', `:${n}:${f}`], {raw: true}); return r.ok ? r.out : null; };
    const ours = stage(2), theirs = stage(3);
    const full = join(dir, f);
    if (basename(f) === 'files.json' && ours && theirs) {
      writeJson(full, mergeFilesJson(JSON.parse(ours), JSON.parse(theirs)));
    } else if (ours != null && theirs != null) {
      writeFileSync(full, ours);
      const copy = conflictCopy(f, from);
      writeFileSync(join(dir, copy), theirs);
      list.push({file: f, copy, from, by: name, at: Date.now()});
      done.push(f);
    } else {
      // Changed on one side, deleted on the other: keep the file.
      const keep = ours ?? theirs;
      if (keep != null) writeFileSync(full, keep);
      list.push({file: f, copy: null, from, by: name, at: Date.now(), note: ours == null ? 'удалён здесь, изменён там — оставлен' : 'изменён здесь, удалён там — оставлен'});
      done.push(f);
    }
  }
  if (done.length) writeJson(join(dir, 'sync-conflicts.json'), list);
  git(dir, ['add', '-A']);
  must(git(dir, ['commit', '-q', '--no-edit'], {who: name}), 'commit merge');
  return done;
}

export const conflicts = (dir) => readJson(join(dir, 'sync-conflicts.json'), []);
export function dismissConflict(dir, file, {removeCopy = false} = {}) {
  const list = conflicts(dir);
  const left = list.filter((c) => c.file !== file);
  if (removeCopy) for (const c of list) if (c.file === file && c.copy) rmSync(join(dir, c.copy), {force: true});
  writeJson(join(dir, 'sync-conflicts.json'), left);
}

// ---------- heavy files ----------

function walk(root, rel = '') {
  const full = join(root, rel);
  let st;
  try { st = lstatSync(full); } catch { return []; }
  if (st.isSymbolicLink()) return [];
  if (!st.isDirectory()) return /\.part$|^\.DS_Store$/.test(basename(rel)) ? [] : [{rel, size: st.size, mtime: Math.floor(st.mtimeMs)}];
  // The player's light copy and frame strip are made again where needed.
  if (basename(rel) === '.preview' || basename(rel) === 'node_modules') return [];
  return readdirSync(full).flatMap((f) => walk(root, rel ? join(rel, f) : f));
}

const hashFile = (f) => new Promise((ok, fail) => {
  const h = createHash('sha256');
  createReadStream(f).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', fail);
});

const toPosix = (p) => p.split(sep).join('/');
export const filesJson = (reelDir) => join(reelDir, 'files.json');
export const readFiles = (reelDir) => ({files: [], holder: null, handoff: null, ...readJson(filesJson(reelDir), {})});
const projectOf = (reelDir) => join(reelDir, '..', '..');

// Lists the reel's heavy files with hashes (cached by size and time) and writes files.json.
export async function manifest(reelDir) {
  const proj = projectOf(reelDir);
  const cache = readJson(local(proj, 'hashes.json'), {});
  const files = [];
  for (const top of HEAVY) for (const f of walk(join(reelDir, top))) {
    const path = toPosix(join(top, f.rel));
    const key = `${basename(reelDir)}/${path}`;
    const c = cache[key];
    const hash = c && c.size === f.size && c.mtime === f.mtime ? c.hash : await hashFile(join(reelDir, top, f.rel));
    cache[key] = {size: f.size, mtime: f.mtime, hash};
    files.push({path, size: f.size, hash});
  }
  writeJson(local(proj, 'hashes.json'), cache);
  const cur = readFiles(reelDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(cur.files) !== JSON.stringify(files)) writeJson(filesJson(reelDir), {...cur, files});
  return files;
}

export const mediaKey = (project, hash) => `${project}/media/${hash}`;
const inCloud = (proj) => readJson(local(proj, 'cloud.json'), {});
const markCloud = (proj, hashes) => { const c = inCloud(proj); for (const h of hashes) c[h] = 1; writeJson(local(proj, 'cloud.json'), c); };

// Sends every listed file the cloud does not have yet. Returns bytes sent.
export async function pushMedia(reelDir, project, cfg) {
  if (!cfg) return 0;
  const proj = projectOf(reelDir);
  const sent = inCloud(proj);
  let bytes = 0;
  for (const f of readFiles(reelDir).files) {
    if (sent[f.hash]) continue;
    const key = mediaKey(project, f.hash);
    if ((await head(cfg, key)) !== f.size) { await put(cfg, key, join(reelDir, f.path)); bytes += f.size; }
    markCloud(proj, [f.hash]);
  }
  return bytes;
}

const latestVersion = (files) => files.map((f) => /^versions\/(v\d+)\//.exec(f.path)?.[1]).filter(Boolean).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).at(-1);
// What opening the reel needs here: its sources, project/public, the latest version, small files of the rest.
export function needed(reelDir) {
  const {files} = readFiles(reelDir);
  const latest = latestVersion(files);
  return files.filter((f) => {
    const want = !f.path.startsWith('versions/') || f.path.startsWith(`versions/${latest}/`) || f.size <= SMALL;
    if (!want) return false;
    try { return statSync(join(reelDir, f.path)).size !== f.size; } catch { return true; }
  });
}

// Downloads what the reel lacks. progress({total, done, file}) after each file.
export async function fetchMedia(reelDir, project, cfg, progress = () => {}) {
  const want = needed(reelDir);
  const total = want.reduce((s, f) => s + f.size, 0);
  let done = 0;
  progress({total, done, file: null});
  if (!cfg || !want.length) return {total, done};
  for (const f of want) {
    progress({total, done, file: f.path});
    const to = join(reelDir, f.path);
    await get(cfg, mediaKey(project, f.hash), to);
    const got = statSync(to).size;
    if (got !== f.size) { rmSync(to, {force: true}); throw new Error(`${f.path}: arrived ${got} of ${f.size} bytes`); }
    // What came from the cloud is in it: never sent again, and may be dropped from this disk later.
    const proj = projectOf(reelDir);
    markCloud(proj, [f.hash]);
    const cache = readJson(local(proj, 'hashes.json'), {});
    const st = statSync(to);
    cache[`${basename(reelDir)}/${f.path}`] = {size: st.size, mtime: Math.floor(st.mtimeMs), hash: f.hash};
    writeJson(local(proj, 'hashes.json'), cache);
    done += f.size;
    progress({total, done, file: f.path});
  }
  unmarkEvicted(projectOf(reelDir), basename(reelDir));
  return {total, done};
}

// ---------- who holds a reel ----------

export const holderOf = (reelDir) => readFiles(reelDir).holder || null;
export const heldHere = (reelDir, node) => { const h = holderOf(reelDir); return !h || !node || h.node === node; };

function setHold(reelDir, patch) {
  writeJson(filesJson(reelDir), {...readFiles(reelDir), ...patch});
}

// Opening a reel here: free → this computer holds it; held elsewhere → nothing changes.
export function open(reelDir, {node, name}) {
  const proj = projectOf(reelDir);
  const opened = readJson(local(proj, 'opened.json'), {});
  opened[basename(reelDir)] = Date.now();
  writeJson(local(proj, 'opened.json'), opened);
  const h = holderOf(reelDir);
  if (!node) return h;
  if (!h) { setHold(reelDir, {holder: {node, name, at: Date.now()}}); return holderOf(reelDir); }
  return h;
}

// «Забрать сюда»: asks the holder to hand over (force: take it now — the holder sleeps).
export function claim(reelDir, {node, name, force = false}) {
  const h = holderOf(reelDir);
  if (!h || h.node === node || force) { setHold(reelDir, {holder: {node, name, at: Date.now()}, handoff: null}); return {held: true}; }
  setHold(reelDir, {handoff: {to: node, name, at: Date.now()}});
  return {held: false, waiting: h};
}

// On the holder: reels someone asked for are handed over after their last edits and media went up.
// busy(reel) → true waits (Claude is still working on it).
export async function handOver(projectDir, project, {node, cfg, busy = () => false}) {
  const out = [];
  for (const reel of reelNames(projectDir)) {
    const dir = join(projectDir, 'reels', reel);
    const {holder, handoff} = readFiles(dir);
    if (!handoff || holder?.node !== node || handoff.to === node || busy(reel)) continue;
    await manifest(dir);
    await pushMedia(dir, project, cfg);
    setHold(dir, {holder: {node: handoff.to, name: handoff.name, at: Date.now()}, handoff: null});
    out.push(reel);
  }
  return out;
}

const reelNames = (projectDir) => {
  const root = join(projectDir, 'reels');
  return existsSync(root) ? readdirSync(root).filter((r) => !r.startsWith('.') && statSync(join(root, r)).isDirectory()) : [];
};

// ---------- the local copy ----------

const evicted = (proj) => readJson(local(proj, 'evicted.json'), {});
const unmarkEvicted = (proj, reel) => { const e = evicted(proj); if (e[reel]) { delete e[reel]; writeJson(local(proj, 'evicted.json'), e); } };
export const isEvicted = (reelDir) => Boolean(evicted(projectOf(reelDir))[basename(reelDir)]);

// Reels not opened here for EVICT_DAYS keep their media only in the cloud: files the cloud is known
// to have leave this disk; opening the reel brings them back. Returns bytes freed.
export function evictIdle(projectDir, {days = EVICT_DAYS, busy = () => false} = {}) {
  const opened = readJson(local(projectDir, 'opened.json'), {});
  const cloud = inCloud(projectDir);
  const ev = evicted(projectDir);
  let freed = 0;
  for (const reel of reelNames(projectDir)) {
    const dir = join(projectDir, 'reels', reel);
    const seen = opened[reel] || statSync(dir).mtimeMs;
    if (busy(reel) || Date.now() - seen < days * DAY) continue;
    let n = 0;
    for (const f of readFiles(dir).files) {
      const full = join(dir, f.path);
      if (!cloud[f.hash] || !existsSync(full) || statSync(full).size !== f.size) continue;
      rmSync(full, {force: true});
      n += f.size;
    }
    if (n) { ev[reel] = Date.now(); freed += n; }
  }
  writeJson(local(projectDir, 'evicted.json'), ev);
  return freed;
}

// ---------- one pass ----------

// The whole round for one project, as the studio runs it every minute:
// media of reels held here up → light part through git → hand over what was asked for.
export async function syncProject(projectDir, project, {node, name, cfg, busy = () => false} = {}) {
  const out = {media: 0, handed: [], git: null};
  if (cfg && node) for (const reel of reelNames(projectDir)) {
    const dir = join(projectDir, 'reels', reel);
    if (!heldHere(dir, node) || isEvicted(dir)) continue;
    // A reel without a holder that has media becomes this computer's: it is where the files are.
    if (!holderOf(dir) && HEAVY.some((h) => existsSync(join(dir, h)))) setHold(dir, {holder: {node, name, at: Date.now()}});
    await manifest(dir);
    out.media += await pushMedia(dir, project, cfg);
  }
  out.git = syncGit(projectDir, {node, name});
  out.handed = node ? await handOver(projectDir, project, {node, cfg, busy}) : [];
  if (out.handed.length) out.git = syncGit(projectDir, {node, name});
  return out;
}

export const relPath = (projectDir, f) => toPosix(relative(projectDir, f));
