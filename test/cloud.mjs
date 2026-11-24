// The cloud (bot/cloud.mjs) against a fake S3 server on localhost: the bin goes up and comes back.
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fakeS3} from './fake-s3.mjs';

const {objects, cfg, close} = await fakeS3();

const C = await import('../bot/cloud.mjs');
const S = await import('../bot/storage.mjs');
const home = mkdtempSync(join(tmpdir(), 'reels-cloud-'));
const proj = join(home, 'proj');
const bin = join(proj, '.trash');

assert.equal(C.cloudConfig({}), null, 'no keys, no cloud');
assert.ok(C.cloudConfig({R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'd'}).endpoint.endsWith('a.r2.cloudflarestorage.com'));

// A reel with old versions and sources; the rules move them into the bin.
const dir = join(proj, 'reels', '01-погода');
for (const v of ['v1', 'v2', 'v3']) { mkdirSync(join(dir, 'versions', v), {recursive: true}); writeFileSync(join(dir, 'versions', v, `погода-${v}.mp4`), Buffer.alloc(300, v)); }
writeFileSync(join(dir, 'versions', 'v3', 'погода-v3-1440p.mp4'), Buffer.alloc(900));
mkdirSync(join(dir, 'sources'), {recursive: true});
writeFileSync(join(dir, 'sources', 'C1 (1).mp4'), Buffer.alloc(700, 7));
assert.equal(S.apply(dir), 600, 'a master on v3: v1 and v2 go');
mkdirSync(join(bin, '01-погода sources'), {recursive: true});
writeFileSync(join(bin, '01-погода sources', 'C1 (1).mp4'), Buffer.alloc(700, 7));

// Offload: everything in the bin goes up and leaves the disk; packed media goes to the archive.
const r = await C.offloadTrash(proj, 'main', cfg);
assert.deepEqual(r.errors, []);
assert.equal(r.sent, 3);
assert.deepEqual(readdirSync(bin), []);
assert.ok(objects.has('/reels/main/trash/01-погода v1 погода-v1.mp4'));
assert.ok(objects.has('/reels/main/archive/01-погода sources/C1 (1).mp4'));
assert.equal(S.inTrash(dir), 600, 'what is in the cloud still counts as «can be restored»');
assert.equal(C.cloudBytes(proj), 1300);

// Restore: download, put back, remove from the cloud.
assert.equal(await C.fetchBack(dir, cfg), 2);
assert.equal(S.restore(dir), 2);
assert.equal(readFileSync(join(dir, 'versions', 'v1', 'погода-v1.mp4')).length, 300);
assert.ok(!objects.has('/reels/main/trash/01-погода v1 погода-v1.mp4'));

// Expiry: the bin after 30 days is deleted in the cloud, the archive stays.
S.apply(dir);
await C.offloadTrash(proj, 'main', cfg);
const idx = JSON.parse(readFileSync(S.cloudIndexFile(proj), 'utf8'));
for (const e of Object.values(idx)) e.at -= 31 * 864e5;
writeFileSync(S.cloudIndexFile(proj), JSON.stringify(idx));
const x = await C.offloadTrash(proj, 'main', cfg);
assert.equal(x.expired, 600);
assert.deepEqual([...objects.keys()], ['/reels/main/archive/01-погода sources/C1 (1).mp4']);

// A folder sent by hand leaves a note and comes back from it.
const old = join(home, 'монтаж');
mkdirSync(join(old, 'день 1'), {recursive: true});
writeFileSync(join(old, 'день 1', 'a.mov'), Buffer.alloc(1000, 1));
const {note} = await C.archiveFolder(old, 'рилсы', cfg);
assert.ok(!existsSync(old) && existsSync(note));
assert.ok(objects.has('/reels/рилсы/монтаж/день 1/a.mov'));
await C.unarchiveFolder(note, cfg);
assert.equal(readFileSync(join(old, 'день 1', 'a.mov')).length, 1000);
assert.ok(!existsSync(note));

close();
rmSync(home, {recursive: true, force: true});
console.log('cloud: ok');
