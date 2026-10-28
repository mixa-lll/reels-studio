// Comments for the next version of a reel (reels/<id>/edits.json), shared by the web page
// (Д3) and the mini app's editor (SE1–SE5). One item per comment:
//   {id, stage: 'script'|'scenes'|'video', t: seconds, text, voice, by, at, state: 'open'|'sent'|'done'|'note',
//    quote?: words picked in the script, scene?: index in scenes.json, hint?: 'blur'|'replace'|'trim'|'remove',
//    shape?: {kind: 'rect', x, y, w, h} | {kind: 'brush', pts: [[x, y], …]} | {kind: 'point', x, y} | {kind: 'frame'}
//            (fractions of the frame, 0–1), point?: {x, y} (% of the frame, the web's older form), forV?, result?}
// «note» is Claude's own pre-build check (faces, subtitles, consents), shown with the comments.
import {randomBytes} from 'node:crypto';
import {readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const STAGES = ['script', 'scenes', 'video'];
const HINTS = ['blur', 'replace', 'trim', 'remove'];
const f01 = (n) => Math.min(1, Math.max(0, Math.round(Number(n) * 1000) / 1000));
const ok = (n) => Number.isFinite(Number(n));

function cleanShape(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.kind === 'frame') return {kind: 'frame'};
  if (s.kind === 'point' && ok(s.x) && ok(s.y)) return {kind: 'point', x: f01(s.x), y: f01(s.y)};
  if (s.kind === 'rect' && [s.x, s.y, s.w, s.h].every(ok)) return {kind: 'rect', x: f01(s.x), y: f01(s.y), w: f01(s.w), h: f01(s.h)};
  if (s.kind === 'brush' && Array.isArray(s.pts)) {
    const pts = s.pts.filter((p) => Array.isArray(p) && ok(p[0]) && ok(p[1])).map(([x, y]) => [f01(x), f01(y)]);
    const step = Math.ceil(pts.length / 80) || 1;
    return pts.length > 1 ? {kind: 'brush', pts: pts.filter((_, i) => i % step === 0)} : null;
  }
  return null;
}

export const readEdits = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'edits.json'), 'utf8')); } catch { return []; } };

/** Applies {action: 'add'|'remove'|'send', …} to the reel's list; null for a bad request. */
export function changeEdits(dir, b, by) {
  let list = readEdits(dir);
  if (b.action === 'add' && String(b.text || '').trim()) {
    const shape = cleanShape(b.shape);
    // The web page sends a point in percent; the mini app a shape in fractions — keep both readable.
    const point = b.point && ok(b.point.x) && ok(b.point.y) ? {x: Math.round(b.point.x), y: Math.round(b.point.y)}
      : shape?.kind === 'point' ? {x: Math.round(shape.x * 100), y: Math.round(shape.y * 100)} : null;
    list.push({id: randomBytes(5).toString('hex'), stage: STAGES.includes(b.stage) ? b.stage : 'video', t: Math.max(0, Number(b.t) || 0),
      text: String(b.text).trim().slice(0, 600), point, ...(shape ? {shape} : {}), ...(HINTS.includes(b.hint) ? {hint: b.hint} : {}),
      ...(typeof b.quote === 'string' && b.quote.trim() ? {quote: b.quote.trim().slice(0, 200)} : {}),
      ...(Number.isInteger(b.scene) && b.scene >= 0 ? {scene: b.scene} : {}),
      voice: !!b.voice, state: 'open', by, at: Date.now()});
  } else if (b.action === 'remove') list = list.filter((x) => x.id !== b.id || x.state !== 'open');
  else if (b.action === 'send') list = list.map((x) => (x.state === 'open' ? {...x, state: 'sent', forV: String(b.forV || '').slice(0, 10)} : x));
  else return null;
  writeFileSync(join(dir, 'edits.json.tmp'), JSON.stringify(list, null, 2));
  renameSync(join(dir, 'edits.json.tmp'), join(dir, 'edits.json'));
  return list;
}

const HINT_RU = {blur: 'размыть', replace: 'заменить кадр', trim: 'обрезать', remove: 'убрать'};
const tc = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pct = (n) => Math.round(n * 100);
function where(x, scenes) {
  if (x.stage === 'script') return `сценарий${x.scene != null && scenes[x.scene] ? `, сцена «${scenes[x.scene].name}»` : ''}${x.quote ? `, к словам «${x.quote}»` : ''}`;
  if (x.stage === 'scenes') return `сцена ${x.scene != null ? x.scene + 1 : '?'}${scenes[x.scene] ? ` «${scenes[x.scene].name}» (${scenes[x.scene].have || scenes[x.scene].screen || ''})` : ''}`;
  const s = x.shape;
  const area = !s ? (x.point ? `точка ${x.point.x}% слева, ${x.point.y}% сверху` : '')
    : s.kind === 'frame' ? 'весь кадр'
    : s.kind === 'point' ? `точка ${pct(s.x)}% слева, ${pct(s.y)}% сверху`
    : s.kind === 'rect' ? `обведена область ${pct(s.x)}–${pct(s.x + s.w)}% слева, ${pct(s.y)}–${pct(s.y + s.h)}% сверху`
    : `проведено кистью около ${pct(Math.min(...s.pts.map((p) => p[0])))}–${pct(Math.max(...s.pts.map((p) => p[0])))}% слева, ${pct(Math.min(...s.pts.map((p) => p[1])))}–${pct(Math.max(...s.pts.map((p) => p[1])))}% сверху`;
  return `ролик ${tc(x.t)}${area ? `, ${area}` : ''}`;
}

/** The comments as one message for the reel chat: what to change in the next version. */
export function buildRequest(items, scenes, nextV) {
  return `Комментарии к ${nextV}:\n${items.map((x, i) => `${i + 1}. [${where(x, scenes || [])}]${x.hint ? ` (${HINT_RU[x.hint]})` : ''} ${x.text} — ${x.by || ''}`).join('\n')}\n` +
    `Перед сборкой проверь лица (ничего на лице), субтитры и согласия людей в кадре; если что-то не так, допиши в edits.json пункт {"state":"note","by":"Claude","stage":"video","t":секунда,"text":"что не так"}. ` +
    `Собери ${nextV} черновиком и отметь в edits.json, что сделано.`;
}
