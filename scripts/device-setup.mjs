#!/usr/bin/env node
// Sets up another computer of the same owner (issue #142): its settings come from the studio's cloud.
// The first computer uploads them with --put; on the new one .env needs only the four R2_* lines.
//   node scripts/device-setup.mjs --put <node> <file.env>   (first computer)
//   node scripts/device-setup.mjs <node>                    (the new computer)
// Lines already set in this .env (R2 keys, AGENT_BIN…) are kept; the rest is added.
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cloudConfig, get, put} from '../bot/cloud.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV = join(ROOT, '.env');
try { process.loadEnvFile(ENV); } catch {}
const cfg = cloudConfig();
if (!cfg) { console.error('Put R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET into .env first.'); process.exit(1); }
const key = (node) => `devices/${node}.env`;
const [a, b, c] = process.argv.slice(2);

if (a === '--put' && b && c) {
  await put(cfg, key(b), c);
  console.log(`${b}: settings are in the cloud`);
} else if (a && /^[\w-]+$/.test(a)) {
  const dir = mkdtempSync(join(tmpdir(), 'device-'));
  const tmp = join(dir, 'device.env');
  await get(cfg, key(a), tmp);
  const have = existsSync(ENV) ? readFileSync(ENV, 'utf8') : '';
  const set = new Set(have.split('\n').map((l) => /^([A-Z0-9_]+)=(.+)$/.exec(l)?.[1]).filter(Boolean));
  const lines = have.split('\n');
  const added = [];
  for (const l of readFileSync(tmp, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
    if (!m || set.has(m[1])) continue;
    const i = lines.findIndex((x) => x.startsWith(m[1] + '='));
    if (i >= 0) lines[i] = l; else lines.push(l);
    added.push(m[1]);
  }
  writeFileSync(ENV, lines.join('\n').replace(/\n*$/, '\n'));
  rmSync(dir, {recursive: true, force: true});
  console.log(`${a}: added ${added.join(', ') || 'nothing'}`);
} else {
  console.error('usage: node scripts/device-setup.mjs <node> | --put <node> <file.env>');
  process.exit(1);
}
