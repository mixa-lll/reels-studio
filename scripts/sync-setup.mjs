#!/usr/bin/env node
// Connects a project to several of the owner's computers (bot/sync.mjs, issue #142).
//
// First computer — the project becomes a git repository (light part only), its media goes to R2:
//   node scripts/sync-setup.mjs <project> <remote>      e.g. main git@github.com:mixa-lll/reels-main.git
// Another computer — the light part comes down, media is fetched when a reel is opened:
//   node scripts/sync-setup.mjs --clone <remote> <project>
//
// The remote is a private repository of its own (never the code's). Needs DEVICE_NAME, RELAY_NODE
// and R2_* in .env.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cloudConfig} from '../bot/cloud.mjs';
import {deviceName, deviceNode} from '../bot/device.mjs';
import {initRepo, isRepo, syncProject} from '../bot/sync.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile(join(ROOT, '.env')); } catch {}
const node = deviceNode(), name = deviceName() || node;
const args = process.argv.slice(2);
const fail = (m) => { console.error(m); process.exit(1); };
if (!node || !process.env.DEVICE_NAME) fail('Set DEVICE_NAME and RELAY_NODE in .env first.');
if (!cloudConfig()) console.warn('R2_* is not set: texts will sync, media will not.');

if (args[0] === '--clone') {
  const [, remote, project] = args;
  if (!remote || !project) fail('usage: node scripts/sync-setup.mjs --clone <remote> <project>');
  const dir = join(ROOT, 'projects', project);
  if (existsSync(dir)) fail(`${dir} already exists`);
  mkdirSync(join(ROOT, 'projects'), {recursive: true});
  const r = spawnSync('git', ['clone', '-q', remote, project], {cwd: join(ROOT, 'projects'), stdio: 'inherit'});
  if (r.status) process.exit(r.status);
  console.log(`${project}: light part here; each reel's media comes down when it is opened in the studio.`);
} else {
  const [project, remote] = args;
  if (!project || !remote) fail('usage: node scripts/sync-setup.mjs <project> <remote>');
  const dir = join(ROOT, 'projects', project);
  if (!existsSync(dir)) fail(`no project ${dir}`);
  if (isRepo(dir)) fail(`${realpathSync(dir)} is a git repository already`);
  initRepo(dir, {remote, who: name});
  console.log(`${project}: in git (${realpathSync(dir)}). Sending media to the cloud…`);
  const out = await syncProject(dir, project, {node, name, cfg: cloudConfig()});
  console.log(`done: ${Math.round(out.media / 1e6)} MB of media in the cloud.`);
}
