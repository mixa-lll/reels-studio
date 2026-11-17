// «Сделать по образцу» (web/copyreel.mjs) on a fake reel in a temp folder.
import assert from 'node:assert/strict';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {copyReel} from '../web/copyreel.mjs';

const root = mkdtempSync(join(tmpdir(), 'reels-copy-'));
mkdirSync(join(root, 'template', 'node_modules'), {recursive: true});
const studio = join(root, 'studio');
const src = join(studio, 'reels', '04-kanatka-kobi');
const put = (f, data = 'x') => { mkdirSync(join(f, '..'), {recursive: true}); writeFileSync(f, data); };
put(join(src, 'README.md'), '# 04 Канатка Коби\n\n## Сценарий\n\nХук: 4 часа в очереди.\n');
put(join(src, 'scenes.json'), JSON.stringify([{t: '0:00', name: 'Хук', screen: 'ведущая', text: '4 часа', sound: 'щелчок', need: 'дубль', have: 'face.mp4', status: 'готово'}]));
put(join(src, 'publish.json'), '{"instagram": "подпись"}');
put(join(src, 'project', 'src', 'Reel.jsx'), 'export default 1');
put(join(src, 'project', 'public', 'face.mp4'));
put(join(src, 'project', 'public', 'photos', 'p1.jpg'));
put(join(src, 'project', 'public', 'music.mp3'));
put(join(src, 'project', 'public', 'voice.wav'));
put(join(src, 'project', 'public', 'logo.png'));
put(join(src, 'project', 'public', 'mask', 'p0001.png'));
put(join(src, 'sources', 'take.mov'));
put(join(src, 'versions', 'v1', 'r-v1.mp4'));
const rd = (id, f) => readFileSync(join(studio, 'reels', id, f), 'utf8');

// New material: code, music and logo come; footage, voice, versions stay behind.
const m = copyReel(studio, '04-kanatka-kobi', {mode: 'material', root});
assert.equal(m.id, '05-kanatka-kobi-po-obraztsu-04');
const md = join(studio, 'reels', m.id);
assert.ok(existsSync(join(md, 'project', 'src', 'Reel.jsx')));
assert.ok(existsSync(join(md, 'project', 'public', 'music.mp3')));
assert.ok(existsSync(join(md, 'project', 'public', 'logo.png')));
assert.ok(!existsSync(join(md, 'project', 'public', 'face.mp4')));
assert.ok(!existsSync(join(md, 'project', 'public', 'photos', 'p1.jpg')));
assert.ok(!existsSync(join(md, 'project', 'public', 'voice.wav')));
assert.ok(!existsSync(join(md, 'project', 'public', 'mask', 'p0001.png')));
assert.ok(!existsSync(join(md, 'versions', 'v1')));
assert.ok(!existsSync(join(md, 'sources', 'take.mov')));
assert.ok(lstatSync(join(md, 'project', 'node_modules')).isSymbolicLink());
const sc = JSON.parse(rd(m.id, 'scenes.json'))[0];
assert.equal(sc.text, '4 часа');
assert.equal(sc.have, '');
assert.equal(sc.status, 'нужно');
assert.match(rd(m.id, 'README.md'), /^# 05 Канатка Коби — новый материал/);
assert.match(rd(m.id, 'README.md'), /Хук: 4 часа в очереди/);
assert.equal(JSON.parse(rd(m.id, 'based-on.json')).from, '04-kanatka-kobi');
assert.ok(existsSync(join(md, 'publish.json')));

// Another language: footage and sources come along, the slug gets -en, and back gets -ru.
const l = copyReel(studio, '04-kanatka-kobi', {mode: 'lang', root});
assert.equal(l.id, '06-kanatka-kobi-en');
assert.ok(existsSync(join(studio, 'reels', l.id, 'project', 'public', 'face.mp4')));
assert.ok(existsSync(join(studio, 'reels', l.id, 'sources', 'take.mov')));
assert.match(l.title, /\(EN\)$/);
assert.match(l.prompt, /Russian → English/);
assert.equal(copyReel(studio, l.id, {mode: 'lang', root}).id, '07-kanatka-kobi-ru');

// New theme: style only, scenes keep just the rhythm.
const t = copyReel(studio, '04-kanatka-kobi', {mode: 'theme', root});
const ts = JSON.parse(rd(t.id, 'scenes.json'))[0];
assert.deepEqual([ts.t, ts.text, ts.sound], ['0:00', '', 'щелчок']);
assert.ok(!existsSync(join(studio, 'reels', t.id, 'publish.json')));

assert.throws(() => copyReel(studio, '04-kanatka-kobi', {mode: 'nope', root}));
rmSync(root, {recursive: true, force: true});
console.log('copyreel: ok');
