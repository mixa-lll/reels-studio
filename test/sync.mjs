// One project on two computers (bot/sync.mjs): two folders, a bare git repository as the project's
// remote and a fake S3 for media. Texts travel through git, media through the cloud by hash, a reel
// changes hands, a conflict keeps both versions.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fakeS3} from './fake-s3.mjs';

const S = await import('../bot/sync.mjs');
const {objects, cfg, close} = await fakeS3();
const home = mkdtempSync(join(tmpdir(), 'reels-sync-'));
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'core.quotepath=false', ...a], {cwd, encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const remote = join(home, 'remote.git');
git(home, 'init', '-q', '--bare', '-b', 'main', remote);

const A = {node: 'misha-macbook', name: 'MacBook', cfg};
const B = {node: 'misha-imac', name: 'iMac', cfg};
const a = join(home, 'macbook', 'main');
const b = join(home, 'imac', 'main');

// The first computer: a project with texts, a reel with sources and two versions.
const reelA = join(a, 'reels', '01-погода');
mkdirSync(join(reelA, 'sources'), {recursive: true});
mkdirSync(join(reelA, 'versions', 'v1'), {recursive: true});
mkdirSync(join(reelA, 'versions', 'v2'), {recursive: true});
mkdirSync(join(reelA, 'project', 'src'), {recursive: true});
mkdirSync(join(reelA, 'project', 'public'), {recursive: true});
writeFileSync(join(a, 'ideas.md'), '# Идеи\n\n- погода\n');
writeFileSync(join(a, 'items.json'), '{"items": []}\n');
writeFileSync(join(reelA, 'README.md'), '# Погода\n');
writeFileSync(join(reelA, 'project', 'src', 'Reel.tsx'), 'export const Reel = () => null;\n');
writeFileSync(join(reelA, 'sources', 'C1.mp4'), Buffer.alloc(3000, 1));
writeFileSync(join(reelA, 'project', 'public', 'music.mp3'), Buffer.alloc(1200, 2));
writeFileSync(join(reelA, 'versions', 'v1', 'погода-v1.mp4'), Buffer.alloc(2500 * 1024, 3));
writeFileSync(join(reelA, 'versions', 'v1', 'thumb.jpg'), Buffer.alloc(100, 4));
writeFileSync(join(reelA, 'versions', 'v2', 'погода-v2.mp4'), Buffer.alloc(2600, 5));
writeFileSync(join(a, 'big-notes.txt'), Buffer.alloc(6 * 1024 * 1024, 65));
S.initRepo(a, {remote, who: 'MacBook'});
assert.ok(!git(a, 'ls-files').includes('C1.mp4'), 'media never goes to git');
assert.ok(!git(a, 'ls-files').includes('big-notes.txt'), 'a file over 5 MB stays out of git');

// Its pass: the reel with media becomes MacBook's, the media goes up by hash, files.json goes to git.
const r1 = await S.syncProject(a, 'main', A);
assert.equal(S.holderOf(reelA).node, 'misha-macbook');
assert.equal(r1.media, 3000 + 1200 + 2500 * 1024 + 100 + 2600);
const files = S.readFiles(reelA).files;
assert.equal(files.length, 5);
for (const f of files) assert.ok(objects.has(`/reels/main/media/${f.hash}`), f.path);
assert.ok(git(a, 'ls-files').includes('reels/01-погода/files.json'));
assert.equal((await S.syncProject(a, 'main', A)).media, 0, 'nothing is sent twice');

// The second computer clones the light part.
mkdirSync(join(home, 'imac'), {recursive: true});
git(join(home, 'imac'), 'clone', '-q', remote, 'main');
const reelB = join(b, 'reels', '01-погода');
assert.equal(readFileSync(join(b, 'ideas.md'), 'utf8'), '# Идеи\n\n- погода\n');
assert.ok(existsSync(join(reelB, 'project', 'src', 'Reel.tsx')));
assert.ok(!existsSync(join(reelB, 'sources')), 'no media yet');

// A text edited on one shows up on the other after a pass on each.
writeFileSync(join(b, 'ideas.md'), '# Идеи\n\n- погода\n- снег\n');
await S.syncProject(b, 'main', B);
await S.syncProject(a, 'main', A);
assert.match(readFileSync(join(a, 'ideas.md'), 'utf8'), /снег/);

// Opening the reel on the iMac: it is MacBook's — it shows that, does not take it.
assert.equal(S.open(reelB, B).node, 'misha-macbook');
assert.ok(!S.heldHere(reelB, 'misha-imac'));
// What opening needs: sources, public, the latest version, small files of v1 (not v1's video).
const want = S.needed(reelB).map((f) => f.path).sort();
assert.deepEqual(want, ['project/public/music.mp3', 'sources/C1.mp4', 'versions/v1/thumb.jpg', 'versions/v2/погода-v2.mp4']);
const steps = [];
const got = await S.fetchMedia(reelB, 'main', cfg, (p) => steps.push(p.done));
assert.equal(got.done, 3000 + 1200 + 100 + 2600);
assert.equal(steps.at(-1), got.total);
assert.equal(statSync(join(reelB, 'sources', 'C1.mp4')).size, 3000);
assert.deepEqual(S.needed(reelB), []);

// «Забрать сюда»: a request; MacBook hands over on its pass after sending its last edits.
writeFileSync(join(reelA, 'README.md'), '# Погода\n\nСценарий: дождь.\n');
writeFileSync(join(reelA, 'versions', 'v2', 'погода-v2-1440p.mp4'), Buffer.alloc(4000, 6));
assert.deepEqual(S.claim(reelB, B), {held: false, waiting: S.holderOf(reelB)});
await S.syncProject(b, 'main', B);
// Claude still working on it on the MacBook: it waits.
assert.deepEqual((await S.syncProject(a, 'main', {...A, busy: () => true})).handed, []);
const r2 = await S.syncProject(a, 'main', A);
assert.deepEqual(r2.handed, ['01-погода']);
assert.equal(S.holderOf(reelA).node, 'misha-imac');
await S.syncProject(b, 'main', B);
assert.ok(S.heldHere(reelB, 'misha-imac'), 'now the iMac holds it');
assert.match(readFileSync(join(reelB, 'README.md'), 'utf8'), /дождь/, 'with the last edits');
await S.fetchMedia(reelB, 'main', cfg);
assert.equal(statSync(join(reelB, 'versions', 'v2', 'погода-v2-1440p.mp4')).size, 4000, 'and the last media');
// The MacBook does not hold it any more: its passes leave the manifest alone.
assert.ok(!S.heldHere(reelA, 'misha-macbook'));

// A conflict git cannot merge: both versions stay, and there is a question.
writeFileSync(join(a, 'ideas.md'), '# Идеи\n\n- погода в горах\n');
writeFileSync(join(b, 'ideas.md'), '# Идеи\n\n- погода у моря\n');
await S.syncProject(a, 'main', A);
const c = await S.syncProject(b, 'main', B);
assert.deepEqual(c.git.conflicts, ['ideas.md']);
assert.match(readFileSync(join(b, 'ideas.md'), 'utf8'), /у моря/, 'ours in place');
assert.match(readFileSync(join(b, 'ideas.конфликт-MacBook.md'), 'utf8'), /в горах/, 'theirs next to it');
assert.equal(S.conflicts(b)[0].file, 'ideas.md');
await S.syncProject(a, 'main', A);
assert.equal(S.conflicts(a)[0].from, 'MacBook', 'the question reaches the other computer too');
S.dismissConflict(a, 'ideas.md', {removeCopy: true});
assert.deepEqual(S.conflicts(a), []);
assert.ok(!existsSync(join(a, 'ideas.конфликт-MacBook.md')));

// files.json edited on both: merged by its rules, not as a conflict copy.
const m = S.mergeFilesJson({holder: {node: 'x', at: 1}, files: [{path: 'a', hash: '1'}]}, {holder: {node: 'y', at: 2}, handoff: {to: 'y', at: 1}, files: [{path: 'b', hash: '2'}]});
assert.equal(m.holder.node, 'y');
assert.equal(m.handoff, null, 'a handoff the holder already took is done');
assert.deepEqual(m.files.map((f) => f.path), ['a', 'b']);

// Force: the iMac sleeps, the MacBook takes the reel back at once.
assert.deepEqual(S.claim(reelA, {...A, force: true}), {held: true});

// Not opened for 14 days: media known to be in the cloud leaves the disk; opening brings it back.
const opened = JSON.parse(readFileSync(join(b, '.sync', 'opened.json'), 'utf8'));
opened['01-погода'] = Date.now() - 15 * 864e5;
writeFileSync(join(b, '.sync', 'opened.json'), JSON.stringify(opened));
const freed = S.evictIdle(b);
assert.ok(freed >= 3000 + 4000, `freed ${freed}`);
assert.ok(!existsSync(join(reelB, 'sources', 'C1.mp4')));
assert.ok(S.isEvicted(reelB));
await S.fetchMedia(reelB, 'main', cfg);
assert.ok(existsSync(join(reelB, 'sources', 'C1.mp4')) && !S.isEvicted(reelB));

close();
rmSync(home, {recursive: true, force: true});
console.log('sync: ok');
