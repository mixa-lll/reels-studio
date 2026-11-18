#!/usr/bin/env node
// Graphics of a reel as separate layers, tied to the speech instead of to seconds of the render.
//
//   node scripts/layers.mjs <reel folder>           layers + graphics.json
//   node scripts/layers.mjs <reel folder> place     move the montage's times to the cut now (see place())
//
// Reads the montage (project/src/Montage.jsx: graphics placed with <At a={…} b={…}>…</At>, times in
// seconds of the montage built from cut.applied.json), renders every <At> block alone on a transparent
// frame (one Remotion render, a frame per block, the block taken where it is fully on screen), crops
// each to its pixels and writes:
//   layers/gNN.png          the block, cropped;
//   graphics.json           {frame: [1080, 1920], items: [{id, label, z, layer, box: [x, y, w, h],
//                           from: {clip, src}, to: {clip, src}}]}
// `from`/`to` are moments of the SOURCE (cut.json clip index + source second): when a clip is trimmed,
// a graphic stays on its words. The studio places the layers over the live cut with them; the final
// render still comes from Montage.jsx (REELS.md, «Graphics as layers»).
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const dir = resolve(process.argv[2] || '.');
const proj = join(dir, 'project'), srcFile = join(proj, 'src', 'Montage.jsx');
if (!existsSync(srcFile)) { console.error(`no ${srcFile}`); process.exit(1); }
const applied = JSON.parse(readFileSync(join(dir, existsSync(join(dir, 'cut.applied.json')) ? 'cut.applied.json' : 'cut.json'), 'utf8'));
const src = readFileSync(srcFile, 'utf8');
if (process.argv[3] === 'place') { place(); process.exit(0); }

// Numeric constants of the file (G0 = 13.11, TOTAL = 79.16, FPS = 30) to read a={G0}.
const consts = {};
for (const m of src.matchAll(/(?:^|[\s,;])(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*([\d.]+)\s*[,;\n]/g)) consts[m[1]] = Number(m[2]);
const FPS = consts.FPS || 30;
const num = (x) => { x = x.trim(); return /^[\d.]+$/.test(x) ? Number(x) : consts[x]; };

// The montage body and its <At> blocks, in order.
const body0 = src.indexOf('export const Montage'), body1 = src.indexOf('\n);', body0);
if (body0 < 0 || body1 < 0) { console.error('no `export const Montage = () => (…);` in Montage.jsx'); process.exit(1); }
const body = src.slice(body0, body1);
const person = body.indexOf('person.webm');
const blocks = [];
let n = 0;
const newBody = body.replace(/<At\s+a=\{([^}]+)\}\s+b=\{([^}]+)\}>([\s\S]*?)<\/At>/g, (all, a, b, inner, off) => {
  const A = num(a), B = num(b);
  if (A == null || B == null) return all;
  const label = (inner.match(/l1="([^"]+)"/) || inner.match(/title="([^"]+)"/) || inner.match(/>([^<>{}]{3,})</) || inner.match(/resort="(\w+)"/) || inner.match(/<(\w+)/) || [, 'графика'])[1].trim();
  blocks.push({a: A, b: B, label, z: person >= 0 && off > person ? 'front' : 'behind'});
  return all.replace('<At ', `<At i={${n++}} `);
});
if (!blocks.length) { console.error('no <At a={…} b={…}> blocks'); process.exit(1); }

// A copy of the file that draws one block at a time, frozen, with no video, mask or subtitles.
let copy = src.slice(0, body0) + newBody + src.slice(body1);
copy = copy
  .replace(/<OffthreadVideo[^>]*cut\.mov[^>]*\/>/g, '')
  .replace(/<AbsoluteFill>\s*<OffthreadVideo[^>]*person\.webm[^>]*\/>\s*<\/AbsoluteFill>/g, '')
  .replace(/<Captions\s*\/>/g, '')
  .replace("style={{ background: '#000' }}", "style={{ background: 'transparent' }}")
  .replace(/const At = \(\{ a, b, children \}\) =>/, 'const At = ({ a, b, children, i }) => (globalThis.__ONLY != null && i !== globalThis.__ONLY) ? null :');
if (!copy.includes('globalThis.__ONLY')) { console.error('could not patch `const At = ({ a, b, children }) =>`'); process.exit(1); }
// Frozen where the block is fully in: ~0.8 s in, or its middle if it is short.
const snap = blocks.map((x) => Math.round(Math.min(x.a + 0.8, (x.a + x.b) / 2) * FPS));
const tmpJsx = join(proj, 'src', '_Layers.jsx'), tmpEntry = join(proj, 'src', '_layers-entry.jsx'), out = join(dir, 'layers_tmp');
writeFileSync(tmpJsx, copy);
writeFileSync(tmpEntry, `import {registerRoot, Composition, Sequence, useCurrentFrame} from 'remotion';
import {Montage} from './_Layers.jsx';
const SNAP = ${JSON.stringify(snap)};
// Frame k shows block k as it is at its own SNAP frame: the montage is shifted so that its time there is SNAP[k]
// (a Freeze would leave the montage's sequences cut to this short composition).
const One = () => { const k = useCurrentFrame(); globalThis.__ONLY = k; return <Sequence from={k - SNAP[k]}><Montage /></Sequence>; };
registerRoot(() => <Composition id="Layers" component={One} durationInFrames={${blocks.length}} fps={${FPS}} width={1080} height={1920} />);
`);
rmSync(out, {recursive: true, force: true}); mkdirSync(out, {recursive: true});
const r = spawnSync('npx', ['remotion', 'render', tmpEntry, 'Layers', out, '--sequence', '--image-format=png', '--concurrency=2', '--log=error'], {cwd: proj, stdio: 'inherit'});
// The temporary files go whatever happened: they are not part of the reel.
rmSync(tmpJsx, {force: true}); rmSync(tmpEntry, {force: true});
if (r.status !== 0) { rmSync(out, {recursive: true, force: true}); console.error('render failed'); process.exit(1); }

// Crop each frame to its pixels (alpha > 8), keep where it sits on the 1080×1920 frame.
const frames = readdirSync(out).filter((f) => f.endsWith('.png')).sort();
mkdirSync(join(dir, 'layers'), {recursive: true});
const py = `
import sys, json
from PIL import Image
out = []
for i, f in enumerate(sys.argv[2:]):
    im = Image.open(f).convert('RGBA'); b = im.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    if not b: out.append(None); continue
    p = '%s/layers/g%02d.png' % (sys.argv[1], i); im.crop(b).save(p, optimize=True); out.append([b[0], b[1], b[2] - b[0], b[3] - b[1]])
print(json.dumps(out))`;
const crop = spawnSync('python3', ['-c', py, dir, ...frames.map((f) => join(out, f))], {encoding: 'utf8'});
if (crop.status !== 0) { console.error(crop.stderr); process.exit(1); }
const boxes = JSON.parse(crop.stdout);
rmSync(out, {recursive: true, force: true});

// Montage seconds → a moment of the source: the clip of cut.applied.json and its source second.
const starts = applied.clips.reduce((a, c, i) => (a.push(i ? a[i - 1] + applied.clips[i - 1].out - applied.clips[i - 1].in : 0), a), []);
const at = (t, end) => {
  let i = starts.findLastIndex((s) => t >= s - 1e-6);
  if (i < 0) i = 0;
  if (end && i > 0 && Math.abs(t - starts[i]) < 1e-3) i--; // an end exactly on a joint belongs to the clip before
  const c = applied.clips[i];
  return {clip: i, src: Math.round((c.in + Math.min(c.out - c.in, Math.max(0, t - starts[i]))) * 1000) / 1000};
};
const items = blocks.map((x, i) => boxes[i] && {id: `g${String(i).padStart(2, '0')}`, label: x.label, z: x.z, layer: `layers/g${String(i).padStart(2, '0')}.png`, box: boxes[i], from: at(x.a), to: at(x.b, true)}).filter(Boolean);
writeFileSync(join(dir, 'graphics.json'), JSON.stringify({frame: [1080, 1920], madeFrom: 'project/src/Montage.jsx', base: applied.clips.map((c) => ({in: c.in, out: c.out})), items}, null, 1) + '\n');
console.log(`${items.length} layers → ${join(dir, 'graphics.json')}`);
for (const x of items) console.log(`  ${x.id}  ${x.z.padEnd(6)} clip ${x.from.clip} ${x.from.src}–${x.to.src}  ${x.label}`);

// ── place ──
// The owner trimmed the cut: every time in Montage.jsx is a second of the montage the graphics were made
// on (graphics.json `base`). Each such second is a moment of the source; find that moment in the cut now
// (cut.json) and write the new second back — At a/b, s(…), the k(…) helpers' arguments and the
// constants they start from, TOTAL. A moment trimmed away sticks to its clip's edge. Durations written as
// s(3.21) inside a block become s(b) - s(a) first, so they stretch with it. After it the file is in the
// new cut's seconds and graphics.json's base is the new cut: run it once per applied cut.
function place() {
  const g = JSON.parse(readFileSync(join(dir, 'graphics.json'), 'utf8'));
  const cut = JSON.parse(readFileSync(join(dir, 'cut.json'), 'utf8'));
  if (!Array.isArray(g.base)) { console.error('graphics.json has no base cut: run `node scripts/layers.mjs <reel>` first'); process.exit(1); }
  const st = (cl) => cl.reduce((a, c, i) => (a.push(i ? a[i - 1] + cl[i - 1].out - cl[i - 1].in : 0), a), []);
  const bs = st(g.base), ns = st(cut.clips), btot = bs.at(-1) + g.base.at(-1).out - g.base.at(-1).in, ntot = ns.at(-1) + cut.clips.at(-1).out - cut.clips.at(-1).in;
  const W = (t) => {
    if (t >= btot - 1e-6) return ntot - (btot - t);
    const i = Math.max(0, bs.findLastIndex((x) => t >= x - 1e-6)), src = g.base[i].in + (t - bs[i]);
    let j = cut.clips.findIndex((c, k) => k === i && src >= c.in - 1e-3 && src <= c.out + 1e-3);
    if (j < 0) j = cut.clips.findIndex((c) => src >= c.in - 1e-3 && src <= c.out + 1e-3);
    if (j < 0) { j = Math.min(i, cut.clips.length - 1); const c = cut.clips[j]; return ns[j] + (src < c.in ? 0 : c.out - c.in); }
    return ns[j] + (src - cut.clips[j].in);
  };
  const r2 = (x) => String(Math.round(x * 100) / 100);
  let s = readFileSync(srcFile, 'utf8');
  const before = s;
  // durations inside a block → s(b) - s(a)
  s = s.replace(/<At\s+a=\{([\d.]+)\}\s+b=\{([\d.]+)\}>([\s\S]*?)<\/At>/g, (all, a, b, inner) => {
    const d = Number(b) - Number(a);
    return all.replace(/s\(([\d.]+)\)(?!\s*-)/g, (m, x, off) => (Math.abs(Number(x) - d) < 0.02 && !/-\s*$/.test(inner.slice(0, off)) ? `(s(${b}) - s(${a}))` : m));
  });
  // helpers made with k(X): their numeric arguments are seconds too
  const helpers = [...s.matchAll(/(\w+)\s*=\s*k\((\w+)\)/g)];
  const names = ['s', ...helpers.map((m) => m[1])];
  s = s.replace(new RegExp(`\\b(${names.join('|')})\\(([\\d.]+)\\)`, 'g'), (m, f, x) => `${f}(${r2(W(Number(x)))})`);
  s = s.replace(/<At(\s+i=\{\d+\})?\s+a=\{([\d.]+)\}\s+b=\{([\d.]+)\}>/g, (m, i, a, b) => `<At a={${r2(W(Number(a)))}} b={${r2(W(Number(b)))}}>`);
  // the constants the helpers start from (const G0 = 13.11, g = k(G0))
  for (const [, , base] of helpers) s = s.replace(new RegExp(`\\b(const\\s+${base}\\s*=\\s*)([\\d.]+)`), (m, h, x) => h + r2(W(Number(x))));
  s = s.replace(/(export\s+const\s+TOTAL\s*=\s*)([\d.]+)/, (m, h) => h + r2(ntot));
  writeFileSync(srcFile, s);
  g.base = cut.clips.map((c) => ({in: c.in, out: c.out}));
  writeFileSync(join(dir, 'graphics.json'), JSON.stringify(g, null, 1) + '\n');
  const changed = before.split('\n').filter((l, i) => l !== s.split('\n')[i]).length;
  console.log(`Montage.jsx: ${changed} lines moved to the cut now (${r2(btot)} s → ${r2(ntot)} s); graphics.json base updated`);
}
