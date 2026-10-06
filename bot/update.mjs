// Self-update from the git remote. Owner material (studio/, data/) is gitignored,
// so a fast-forward pull never touches it.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from './config.mjs';

const run = promisify(execFile);
const git = async (...args) => (await run('git', args, {cwd: ROOT, timeout: 120_000, windowsHide: true})).stdout.trim();

/** Current commit, or null outside a git checkout. */
export async function head() {
  return git('rev-parse', 'HEAD').catch(() => null);
}

/** Fetches and returns the subjects of upstream commits not yet pulled ([] if none or no remote). */
export async function pendingUpdates() {
  try {
    await git('rev-parse', '--abbrev-ref', '@{u}');
  } catch {
    return [];
  }
  await git('fetch', '--quiet');
  const log = await git('log', '--format=%s', 'HEAD..@{u}');
  return log ? log.split('\n') : [];
}

/** Fast-forwards to upstream; refreshes template deps if they changed. Throws on conflicts. */
export async function pullUpdates() {
  const before = await head();
  await git('pull', '--ff-only', '--quiet');
  const changed = (await git('diff', '--name-only', before, 'HEAD')).split('\n');
  if (changed.some((f) => f.startsWith('template/package'))) {
    await run('npm', ['install', '--silent'], {cwd: `${ROOT}/template`, timeout: 600_000, shell: process.platform === 'win32'});
  }
  return changed;
}

/** Files under bot/ that differ between two commits (the running code is stale if any). */
export async function botChangedSince(commit) {
  if (!commit) return false;
  const diff = await git('diff', '--name-only', commit, 'HEAD', '--', 'bot').catch(() => '');
  return diff.length > 0;
}
