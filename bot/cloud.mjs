// The studio's cloud: Cloudflare R2 through its S3 API, no dependencies (Signature V4 by hand).
//
// Set in .env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// (R2_ENDPOINT instead of the account id points it elsewhere, e.g. a test server).
// What goes there (bot/storage.mjs decides what leaves a reel, this file where it goes):
// - the studio's bin (.trash/): <project>/trash/<name>…, deleted from the cloud after CLOUD_TRASH_DAYS;
// - a packed reel's media and sources: <project>/archive/<name>…, kept for good;
// - folders sent by hand (scripts/cloud-archive.mjs): <prefix>/<name>…, kept for good.
// A file leaves the disk only after the cloud reports the same size back.

import {createHash, createHmac} from 'node:crypto';
import {createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {basename, dirname, join, sep} from 'node:path';
import {cloudIndexFile, readCloudIndex, trashRecords} from './storage.mjs';

export const CLOUD_TRASH_DAYS = 30;
const DAY = 864e5;
// Packed media is an archive, not a bin: it stays in the cloud.
const ARCHIVE = / (project-public|sources)( \d+)?$/;

export function cloudConfig(env = process.env) {
  const {R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: id, R2_SECRET_ACCESS_KEY: secret, R2_BUCKET: bucket} = env;
  const endpoint = env.R2_ENDPOINT || (account ? `https://${account}.r2.cloudflarestorage.com` : '');
  return endpoint && id && secret && bucket ? {endpoint: endpoint.replace(/\/$/, ''), id, secret, bucket} : null;
}

const hmac = (key, s) => createHmac('sha256', key).update(s).digest();
const sha = (s) => createHash('sha256').update(s).digest('hex');
// S3 wants every byte but A-Z a-z 0-9 - _ . ~ percent-encoded, slashes kept between segments.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const keyPath = (cfg, key) => `/${enc(cfg.bucket)}/${key.split('/').map(enc).join('/')}`;

function signed(cfg, method, key, extra = {}) {
  const url = new URL(cfg.endpoint);
  const path = keyPath(cfg, key);
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const headers = {host: url.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': now, ...extra};
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [method, path, '', ...names.map((h) => `${h}:${lower[h]}`), '', names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha(canonical)].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + cfg.secret, day), 'auto'), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.id}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', k).update(toSign).digest('hex')}`;
  return {url, path, headers};
}

function request(cfg, method, key, {headers: extra, body, to} = {}) {
  const {url, path, headers} = signed(cfg, method, key, extra);
  const lib = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request({method, host: url.hostname, port: url.port || undefined, path, headers}, (res) => {
      if (to && res.statusCode === 200) {
        const out = createWriteStream(to);
        res.pipe(out);
        out.on('finish', () => resolve({status: 200, headers: res.headers}));
        out.on('error', reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject);
    req.setTimeout(10 * 60e3, () => req.destroy(new Error('cloud: timeout')));
    if (body) body.pipe(req); else req.end();
  });
}

const fail = (what, r) => new Error(`cloud ${what}: ${r.status} ${(r.text || '').replace(/\s+/g, ' ').slice(0, 200)}`);

export async function head(cfg, key) {
  const r = await request(cfg, 'HEAD', key);
  if (r.status === 404) return null;
  if (r.status !== 200) throw fail('head', r);
  return Number(r.headers['content-length']);
}

// Uploads a file and checks the cloud got all of it (single PUT: up to 5 GB a file).
export async function put(cfg, key, file) {
  const size = statSync(file).size;
  const r = await request(cfg, 'PUT', key, {headers: {'content-length': size}, body: createReadStream(file)});
  if (r.status !== 200) throw fail('put', r);
  if ((await head(cfg, key)) !== size) throw new Error(`cloud put: ${key} arrived incomplete`);
  return size;
}

export async function get(cfg, key, file) {
  mkdirSync(dirname(file), {recursive: true});
  const part = file + '.part';
  const r = await request(cfg, 'GET', key, {to: part});
  if (r.status !== 200) { rmSync(part, {force: true}); throw fail('get', r); }
  renameSync(part, file);
}

export async function del(cfg, key) {
  const r = await request(cfg, 'DELETE', key);
  if (![200, 204, 404].includes(r.status)) throw fail('delete', r);
}

// Every file under a path (or the file itself), as paths relative to it; '' for a file.
function walk(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return [];
  if (!st.isDirectory()) return [''];
  return readdirSync(p).flatMap((f) => walk(join(p, f)).map((r) => (r ? join(f, r) : f)));
}
const joinKey = (key, rel) => (rel ? `${key}/${rel.split(sep).join('/')}` : key);

// Sends a file or a folder to `key`, then removes it from the disk. Returns {files, size}.
export async function upload(cfg, path, key) {
  const files = [];
  for (const rel of walk(path)) files.push({rel, size: await put(cfg, joinKey(key, rel), join(path, rel))});
  rmSync(path, {recursive: true, force: true});
  return {files, size: files.reduce((s, f) => s + f.size, 0)};
}

export async function download(cfg, entry, path) {
  for (const f of entry.files) await get(cfg, joinKey(entry.key, f.rel), join(path, f.rel));
}

export async function remove(cfg, entry) {
  for (const f of entry.files) await del(cfg, joinKey(entry.key, f.rel));
}

const writeIndex = (projectDir, index) => writeFileSync(cloudIndexFile(projectDir), JSON.stringify(index, null, 2) + '\n');
let running = Promise.resolve();
// One pass at a time: the bot and the studio may both ask.
const serial = (fn) => (running = running.then(fn, fn));

// Empties the project's bin into the cloud and lets old bin entries expire there.
export function offloadTrash(projectDir, project, cfg = cloudConfig()) {
  return serial(async () => {
    const out = {sent: 0, bytes: 0, expired: 0, errors: []};
    if (!cfg) return out;
    const trash = join(projectDir, '.trash');
    const index = readCloudIndex(projectDir);
    for (const name of existsSync(trash) ? readdirSync(trash) : []) {
      if (name.startsWith('.') || name.endsWith('.part')) continue;
      const keep = ARCHIVE.test(name);
      const key = `${project}/${keep ? 'archive' : 'trash'}/${name}`;
      try {
        const {files, size} = await upload(cfg, join(trash, name), key);
        index[name] = {key, files, size, at: Date.now(), keep};
        writeIndex(projectDir, index);
        out.sent++; out.bytes += size;
      } catch (e) { out.errors.push(`${name}: ${e.message}`); }
    }
    for (const [name, e] of Object.entries(index)) {
      if (e.keep || Date.now() - e.at < CLOUD_TRASH_DAYS * DAY) continue;
      try { await remove(cfg, e); delete index[name]; writeIndex(projectDir, index); out.expired += e.size; } catch (err) { out.errors.push(`${name}: ${err.message}`); }
    }
    return out;
  });
}

// Downloads this reel's bin entries back from the cloud into the bin, so restore() can put them in place.
export function fetchBack(reelDir, cfg = cloudConfig()) {
  return serial(async () => {
    if (!cfg) return 0;
    const projectDir = join(reelDir, '..', '..');
    const index = readCloudIndex(projectDir);
    let n = 0;
    for (const r of trashRecords(reelDir)) {
      const name = basename(r.to);
      const e = index[name];
      if (!e || existsSync(r.to)) continue;
      await download(cfg, e, r.to);
      await remove(cfg, e);
      delete index[name];
      writeIndex(projectDir, index);
      n++;
    }
    return n;
  });
}

export const cloudBytes = (projectDir) => Object.values(readCloudIndex(projectDir)).reduce((s, e) => s + (e.size || 0), 0);

// A folder sent by hand (scripts/cloud-archive.mjs): a note left in its place says where it went.
export async function archiveFolder(path, prefix, cfg = cloudConfig()) {
  if (!cfg) throw new Error('cloud: R2_* is not set in .env');
  const key = `${prefix}/${basename(path)}`;
  const note = path + '.в-облаке.json';
  const {files, size} = await upload(cfg, path, key);
  writeFileSync(note, JSON.stringify({key, bucket: cfg.bucket, files, size, at: new Date().toISOString(), back: `node scripts/cloud-archive.mjs --back "${note}"`}, null, 2) + '\n');
  return {key, size, note};
}

export async function unarchiveFolder(note, cfg = cloudConfig()) {
  if (!cfg) throw new Error('cloud: R2_* is not set in .env');
  const e = JSON.parse(readFileSync(note, 'utf8'));
  const path = note.replace(/\.в-облаке\.json$/, '');
  if (existsSync(path)) throw new Error(`${path} already exists`);
  await download(cfg, e, path);
  rmSync(note);
  return {path, size: e.size};
}
