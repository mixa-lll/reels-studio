#!/usr/bin/env node
// Sends a folder or a file to the studio's cloud archive (Cloudflare R2, bot/cloud.mjs) and frees
// the disk; a note «<name>.в-облаке.json» stays in its place. Back: --back <note>.
//   node scripts/cloud-archive.mjs "<path>" [prefix]     (prefix defaults to manual)
//   node scripts/cloud-archive.mjs --back "<path>.в-облаке.json"
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {archiveFolder, unarchiveFolder} from '../bot/cloud.mjs';

try { process.loadEnvFile(join(fileURLToPath(new URL('..', import.meta.url)), '.env')); } catch {}
const [a, b] = process.argv.slice(2);
const gb = (n) => (n / 1e9).toFixed(2) + ' GB';
if (a === '--back' && b) {
  const {path, size} = await unarchiveFolder(resolve(b));
  console.log(`back: ${path} (${gb(size)})`);
} else if (a && existsSync(a)) {
  const {key, size, note} = await archiveFolder(resolve(a), b || 'manual');
  console.log(`in the cloud: ${key} (${gb(size)}); note: ${note}`);
} else {
  console.error('usage: node scripts/cloud-archive.mjs <path> [prefix] | --back <note>');
  process.exit(1);
}
