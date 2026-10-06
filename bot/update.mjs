// Updates from the bot's GitHub repo, applied only after the owner taps «Update».
// Two modes:
//   git     — the folder is a git clone: fetch, then fast-forward pull;
//   archive — installed from a downloaded archive (no git needed): the GitHub API tells
//             what changed, and the new version's archive replaces the bot's own files.
// Owner material (studio/, data/, .env, node_modules) is never touched in either mode.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, sep} from 'node:path';
import {promisify} from 'node:util';
import {DATA, ROOT} from './config.mjs';

const run = promisify(execFile);
const REPO = process.env.REELS_REPO || 'fivol/reels-bot';
const BRANCH = process.env.REELS_BRANCH || 'main';
const VERSION = join(DATA, 'version.json');
const MANIFEST = join(DATA, 'manifest.json');
const isGit = () => existsSync(join(ROOT, '.git'));
const git = async (...args) => (await run('git', args, {cwd: ROOT, timeout: 120_000, windowsHide: true})).stdout.trim();

// ---------- GitHub API (archive mode) ----------

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {headers: {accept: 'application/vnd.github+json', 'user-agent': 'reels-bot'}});
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const readJson = (f, fallback) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
let latest = null; // {sha, subjects, files} from the last check
/** Folder with the owner's own edits saved by the last archive update, if any. */
export let lastBackup = null;

// The bot's own files: everything except owner material and installed packages.
const OWN = (rel) => !/^(data|studio|\.git)(\/|$)|(^|\/)node_modules(\/|$)|^\.env$/.test(rel);
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join('/');
    if (!OWN(rel)) continue;
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(rel);
  }
  return out;
}
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifestOf = (dir) => Object.fromEntries(walk(dir).map((f) => [f, hash(join(dir, f))]));

// First start of an archive install: remember what was installed.
async function ensureArchiveVersion() {
  if (existsSync(VERSION)) return readJson(VERSION, {}).sha;
  const {sha} = await api(`/commits/${BRANCH}`);
  writeFileSync(VERSION, JSON.stringify({sha}));
  writeFileSync(MANIFEST, JSON.stringify(manifestOf(ROOT)));
  return sha;
}

// ---------- shared interface ----------

/** Current version (commit sha), or null when unknown. */
export async function head() {
  if (isGit()) return git('rev-parse', 'HEAD').catch(() => null);
  return ensureArchiveVersion().catch(() => readJson(VERSION, {}).sha ?? null);
}

/** Checks the repo; returns the subjects of commits not installed yet ([] if none). */
export async function pendingUpdates() {
  if (isGit()) {
    try {
      await git('rev-parse', '--abbrev-ref', '@{u}');
    } catch {
      return [];
    }
    await git('fetch', '--quiet');
    const log = await git('log', '--format=%s', 'HEAD..@{u}');
    return log ? log.split('\n') : [];
  }
  const current = await ensureArchiveVersion();
  const {sha} = await api(`/commits/${BRANCH}`);
  if (sha === current) return (latest = {sha, subjects: [], files: []}).subjects;
  const cmp = await api(`/compare/${current}...${sha}`);
  latest = {
    sha,
    subjects: cmp.commits.map((c) => c.commit.message.split('\n')[0]).reverse(),
    files: (cmp.files ?? []).map((f) => f.filename),
  };
  return latest.subjects;
}

/** The newest upstream version seen by the last check, or null. */
export async function upstreamHead() {
  if (isGit()) return git('rev-parse', '@{u}').catch(() => null);
  return latest?.sha ?? null;
}

/** Where updates come from, e.g. https://github.com/fivol/reels-bot. */
export async function remoteUrl() {
  if (!isGit()) return `https://github.com/${REPO}`;
  const url = await git('remote', 'get-url', 'origin').catch(() => '');
  return url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
}

/**
 * Installs the newest version; refreshes template packages if they changed. Returns
 * the changed paths. Git mode throws on conflicts (the agent then merges); archive
 * mode backs up bot files the owner edited to data/backup-<time>/ before replacing them.
 */
export async function pullUpdates() {
  let changed;
  if (isGit()) {
    const before = await git('rev-parse', 'HEAD');
    await git('pull', '--ff-only', '--quiet');
    changed = (await git('diff', '--name-only', before, 'HEAD')).split('\n');
  } else {
    if (!latest) await pendingUpdates();
    changed = await installArchive(latest.sha);
  }
  if (changed.some((f) => f.startsWith('template/package'))) {
    await run('npm', ['install', '--silent'], {cwd: join(ROOT, 'template'), timeout: 600_000, shell: process.platform === 'win32'});
  }
  return changed;
}

async function installArchive(sha) {
  const tmp = mkdtempSync(join(tmpdir(), 'reels-update-'));
  try {
    const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${sha}`);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const archive = join(tmp, 'update.tar.gz');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    // tar ships with macOS, Linux and Windows 10+.
    await run('tar', ['-xzf', archive, '-C', tmp], {windowsHide: true});
    const src = join(tmp, readdirSync(tmp).find((d) => statSync(join(tmp, d)).isDirectory()));

    const old = readJson(MANIFEST, {});
    const next = manifestOf(src);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    lastBackup = null;
    // Keep the owner's own edits: a file that differs from what was installed is backed up.
    for (const [rel, sum] of Object.entries(old)) {
      const file = join(ROOT, rel);
      if (existsSync(file) && hash(file) !== sum && next[rel] !== hash(file)) {
        lastBackup = join(DATA, `backup-${stamp}`);
        const dest = join(lastBackup, rel);
        mkdirSync(dirname(dest), {recursive: true});
        cpSync(file, dest);
      }
    }
    for (const rel of Object.keys(next)) {
      mkdirSync(dirname(join(ROOT, rel)), {recursive: true});
      cpSync(join(src, rel), join(ROOT, rel));
    }
    // Files removed upstream go away too.
    for (const rel of Object.keys(old)) if (!next[rel]) rmSync(join(ROOT, rel), {force: true});

    const changed = [...new Set([...Object.keys(next), ...Object.keys(old)])].filter((rel) => old[rel] !== next[rel]);
    writeFileSync(MANIFEST, JSON.stringify(next));
    writeFileSync(VERSION, JSON.stringify({sha}));
    return changed;
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
}

/** True if the bot's code (bot/) changed since `commit` (the running code is stale). */
export async function botChangedSince(commit) {
  if (!commit) return false;
  if (isGit()) {
    const diff = await git('diff', '--name-only', commit, 'HEAD', '--', 'bot').catch(() => '');
    return diff.length > 0;
  }
  const now = readJson(VERSION, {}).sha;
  return Boolean(now && now !== commit);
}
