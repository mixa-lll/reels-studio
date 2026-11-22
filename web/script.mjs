// The reel's text by meaning blocks and what is on screen in each (reels/<id>/script.json), stage «Сценарий»:
//   {blocks: [{id, role, text, ok?: true, alts?: [{label?, text}],
//              look?: [{kind: 'frame'|'broll'|'gfx'|'text'|'sound', what, at?: words of the text it starts on,
//                       tpl?: template of the project's style, have?: 'style'|'ready'|'shoot'|'new'}]}],
//    text?: {ok, by, at} — step «1 · Текст» approved, look?: {ok, by, at} — step «2 · Вид» approved}
// A block is the unit of everything after it: one take in the prompter, one clip of cut.json, the words graphics hang on.
// The page reorders, approves and takes a variant here; Claude writes the rest from the chat (instructions in server.mjs).
// Every change keeps the previous file as script.before.json, so «↩ Вернуть как было» undoes the last one.
import {randomBytes} from 'node:crypto';
import {copyFileSync, existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const KINDS = ['frame', 'broll', 'gfx', 'text', 'sound'];
const HAVE = ['style', 'ready', 'shoot', 'new'];
const str = (v, n) => String(v ?? '').trim().slice(0, n);

const load = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const save = (f, data) => { writeFileSync(f + '.tmp', JSON.stringify(data, null, 1)); renameSync(f + '.tmp', f); };

/** Words per second of speech: RU and EN both land near 2.5 for a calm voice. */
export const seconds = (text) => Math.max(1, Math.round(String(text || '').split(/\s+/).filter(Boolean).length / 2.5));

function clean(s) {
  if (!s || !Array.isArray(s.blocks)) return null;
  const seen = new Set();
  const blocks = s.blocks.filter((b) => b && str(b.text, 4000)).map((b) => {
    let id = str(b.id, 40).replace(/[^\w-]/g, '') || 'b' + randomBytes(3).toString('hex');
    while (seen.has(id)) id += 'x';
    seen.add(id);
    const out = {id, role: str(b.role, 40), text: str(b.text, 4000)};
    if (b.ok) out.ok = true;
    const alts = Array.isArray(b.alts) ? b.alts.filter((a) => a && str(a.text, 4000)).slice(0, 6).map((a) => ({...(a.label ? {label: str(a.label, 40)} : {}), text: str(a.text, 4000)})) : [];
    if (alts.length) out.alts = alts;
    const look = Array.isArray(b.look) ? b.look.filter((x) => x && str(x.what, 400)).slice(0, 12).map((x) => ({
      kind: KINDS.includes(x.kind) ? x.kind : 'gfx', what: str(x.what, 400),
      ...(str(x.at, 200) ? {at: str(x.at, 200)} : {}), ...(str(x.tpl, 60) ? {tpl: str(x.tpl, 60)} : {}),
      ...(HAVE.includes(x.have) ? {have: x.have} : {}),
    })) : [];
    if (look.length) out.look = look;
    return out;
  });
  const out = {blocks};
  for (const k of ['text', 'look']) if (s[k]?.ok) out[k] = {ok: true, by: str(s[k].by, 60), at: Number(s[k].at) || 0};
  return out;
}

/** The script for the page, with seconds per block and whether «Вернуть как было» has something to return. */
export function readScript(dir) {
  const s = clean(load(join(dir, 'script.json')));
  if (!s) return null;
  let t = 0;
  for (const b of s.blocks) { b.from = t; b.sec = seconds(b.text); t += b.sec; }
  const before = load(join(dir, 'script.before.json'));
  s.total = t;
  s.canUndo = !!before && JSON.stringify(clean(before)) !== JSON.stringify(clean(load(join(dir, 'script.json'))));
  return s;
}

/** Keeps the current file as the one «Вернуть как было» returns to (before a chat turn or a page change). */
export function snapshot(dir) {
  const f = join(dir, 'script.json');
  if (existsSync(f)) copyFileSync(f, join(dir, 'script.before.json'));
}

/** Applies a page action; returns the new script for the page, or null for a bad request.
 *  {op: 'order', ids} · {op: 'ok', ids, on} · {op: 'take', id, alt} · {op: 'step', step: 'text'|'look', on} · {op: 'undo'} */
export function changeScript(dir, b, by) {
  const f = join(dir, 'script.json');
  if (b.op === 'undo') {
    const before = clean(load(join(dir, 'script.before.json')));
    if (!before) return null;
    snapshot(dir);
    save(f, before);
    return readScript(dir);
  }
  const s = clean(load(f));
  if (!s) return null;
  const byId = new Map(s.blocks.map((x) => [x.id, x]));
  if (b.op === 'order') {
    const ids = Array.isArray(b.ids) ? b.ids.filter((id) => byId.has(id)) : [];
    if (ids.length !== s.blocks.length || new Set(ids).size !== ids.length) return null;
    s.blocks = ids.map((id) => byId.get(id));
  } else if (b.op === 'ok') {
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter((id) => byId.has(id));
    if (!ids.length) return null;
    for (const id of ids) { if (b.on === false) delete byId.get(id).ok; else byId.get(id).ok = true; }
    if (b.on === false) delete s.text;
  } else if (b.op === 'take') {
    const x = byId.get(b.id), alt = x?.alts?.[Number(b.alt)];
    if (!alt) return null;
    x.text = alt.text;
    delete x.alts;
  } else if (b.op === 'step' && ['text', 'look'].includes(b.step)) {
    if (b.on === false) delete s[b.step];
    else {
      s[b.step] = {ok: true, by: str(by, 60), at: Date.now()};
      if (b.step === 'text') for (const x of s.blocks) { x.ok = true; delete x.alts; }
    }
  } else return null;
  snapshot(dir);
  save(f, s);
  return readScript(dir);
}
