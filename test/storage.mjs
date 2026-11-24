// Storage rules (bot/storage.mjs) on a fake reel in a temp folder, with a fake Trash.
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'reels-storage-'));
const S = await import('../bot/storage.mjs');
const onMac = true;
const bin = join(home, 'proj', '.trash');

function reel(name, versions) {
  const dir = join(home, 'proj', 'reels', name);
  for (const [v, files] of Object.entries(versions)) {
    mkdirSync(join(dir, 'versions', v), {recursive: true});
    for (const [f, size] of Object.entries(files)) writeFileSync(join(dir, 'versions', v, f), Buffer.alloc(size));
  }
  mkdirSync(join(dir, 'project', 'src'), {recursive: true});
  writeFileSync(join(dir, 'project', 'src', 'Reel.tsx'), 'x');
  mkdirSync(join(dir, 'project', 'public'), {recursive: true});
  writeFileSync(join(dir, 'project', 'public', 'clip.mp4'), Buffer.alloc(500));
  return dir;
}
const vfiles = (dir, v) => readdirSync(join(dir, 'versions', v)).filter((f) => /\.mp4$/.test(f)).sort();
const old = new Date(Date.now() - 60 * 864e5);
const age = (dir) => { for (const v of readdirSync(join(dir, 'versions'))) for (const f of readdirSync(join(dir, 'versions', v))) utimesSync(join(dir, 'versions', v, f), old, old); };
const draft = (n) => ({[`r-${n}.mp4`]: 300, [`r-${n}.tg.mp4`]: 50, [`r-${n}-cover.png`]: 5});

// Rules, in work: the current and the previous version stay whole, older ones keep only a frame
// and the code — a master does not save an old version.
let d = reel('01-rules', {v1: draft(1), v2: {...draft(2), 'r-2-1440p.mp4': 900}, v3: draft(3), v4: draft(4), v5: draft(5)});
age(d);
assert.equal(S.plan(d).reduce((s, x) => s + x.size, 0), 350 + 1250 + 350);
assert.equal(S.apply(d), 1950);
assert.deepEqual(vfiles(d, 'v1'), []);
assert.deepEqual(vfiles(d, 'v2'), []);
assert.deepEqual(vfiles(d, 'v3'), []);
assert.deepEqual(vfiles(d, 'v4'), ['r-4.mp4', 'r-4.tg.mp4']);
assert.deepEqual(vfiles(d, 'v5'), ['r-5.mp4', 'r-5.tg.mp4']);
assert.ok(existsSync(join(d, 'versions', 'v1', 'project-snapshot', 'src', 'Reel.tsx')));
assert.ok(existsSync(join(d, 'versions', 'v1', 'r-1-cover.png')));
assert.equal(readdirSync(bin).length, 7);
assert.equal(S.apply(d), 0, 'a second pass finds nothing');
S.sweep(join(home, 'proj'), {busy: (r) => r !== '01-rules'});
assert.equal(readdirSync(bin).length, 7, 'files made 60 days ago stay in the bin 30 days after the move');

// Restore puts everything back.
if (onMac) {
  assert.equal(S.restore(d), 7);
  assert.deepEqual(vfiles(d, 'v1'), ['r-1.mp4', 'r-1.tg.mp4']);
  assert.ok(!existsSync(join(d, 'versions', 'v1', 'ARCHIVED.json')));
  assert.equal(S.inTrash(d), 0);
}

// «Keep only the latest»: every old draft goes, the picked one («Готово») and outbox stay.
d = reel('02-latest', {v1: draft(1), v2: draft(2), v3: draft(3), v4: draft(4)});
writeFileSync(join(d, 'ready.json'), JSON.stringify({v: 'v2'}));
assert.equal(S.apply(d, {mode: 'latest', protect: ['v3']}), 350);
assert.deepEqual(vfiles(d, 'v1'), []);
assert.deepEqual(vfiles(d, 'v2'), ['r-2.mp4', 'r-2.tg.mp4']);
assert.deepEqual(vfiles(d, 'v3'), ['r-3.mp4', 'r-3.tg.mp4']);

// A master on the current version: the reel is finished, only the current version keeps videos;
// the latest of each variant (RU, EN) is a deliverable and stays.
d = reel('05-master', {v1: draft(1), v2: {...draft(2), 'r-2-1440p.mp4': 900}, v3: draft(3), v4: {...draft(4), 'r-4-1440p.mp4': 900}});
writeFileSync(join(d, 'versions', 'v1', 'variant.json'), JSON.stringify({label: 'RU'}));
S.apply(d);
assert.deepEqual(vfiles(d, 'v1'), ['r-1.mp4', 'r-1.tg.mp4'], 'the latest RU variant stays');
assert.deepEqual(vfiles(d, 'v2'), []);
assert.deepEqual(vfiles(d, 'v3'), [], 'the previous version goes once there is a master');
assert.deepEqual(vfiles(d, 'v4'), ['r-4-1440p.mp4', 'r-4.mp4', 'r-4.tg.mp4']);

// Packing: published 20 days ago → old drafts and project/public go; sweep finds it via items.json.
d = reel('03-pack', {v1: draft(1), v2: draft(2)});
writeFileSync(join(home, 'proj', 'items.json'), JSON.stringify({items: [{ref: {kind: 'reel', id: '03-pack'}, stage: 'published', stageAt: Date.now() - 20 * 864e5}]}));
const dry = S.sweep(join(home, 'proj'), {dry: true});
assert.ok(dry.reels.find((x) => x.reel === '03-pack' && x.packed));
assert.ok(existsSync(join(d, 'project', 'public')), 'dry run removes nothing');
S.sweep(join(home, 'proj'), {busy: (r) => r !== '03-pack'});
assert.ok(!existsSync(join(d, 'project', 'public')));
assert.deepEqual(vfiles(d, 'v1'), []);
assert.ok(S.isPacked(d));
if (onMac) {
  S.restore(d);
  assert.ok(existsSync(join(d, 'project', 'public', 'clip.mp4')));
  assert.ok(!S.isPacked(d));
}

// Packing with the cloud on: the sources go too (into the bin, from where cloud.mjs takes them).
d = reel('06-pack-cloud', {v1: draft(1), v2: draft(2)});
mkdirSync(join(d, 'sources'), {recursive: true});
writeFileSync(join(d, 'sources', 'C1.mp4'), Buffer.alloc(700));
writeFileSync(join(home, 'proj', 'items.json'), JSON.stringify({items: [{ref: {kind: 'reel', id: '06-pack-cloud'}, stage: 'published', stageAt: Date.now() - 20 * 864e5}]}));
S.sweep(join(home, 'proj'), {busy: (r) => r !== '06-pack-cloud', cloud: true});
assert.ok(!existsSync(join(d, 'sources')) && !existsSync(join(d, 'project', 'public')));
assert.ok(existsSync(join(bin, '06-pack-cloud sources', 'C1.mp4')));
S.restore(d);
assert.ok(existsSync(join(d, 'sources', 'C1.mp4')));

// Not yet 14 days: rules only, project/public stays.
d = reel('04-fresh', {v1: draft(1), v2: draft(2)});
writeFileSync(join(home, 'proj', 'items.json'), JSON.stringify({items: [{ref: {kind: 'reel', id: '04-fresh'}, stage: 'published', stageAt: Date.now() - 3 * 864e5}]}));
S.sweep(join(home, 'proj'), {busy: (r) => r !== '04-fresh'});
assert.ok(existsSync(join(d, 'project', 'public')));
assert.deepEqual(vfiles(d, 'v1'), [], 'published counts as accepted: drafts of old versions go');

// The bin empties itself after 30 days.
for (const f of readdirSync(bin)) utimesSync(join(bin, f), new Date(Date.now() - 31 * 864e5), new Date(Date.now() - 31 * 864e5));
assert.ok(S.emptyTrash(join(home, 'proj')) > 0);
assert.equal(readdirSync(bin).length, 0);
rmSync(home, {recursive: true, force: true});

console.log('storage: ok');
