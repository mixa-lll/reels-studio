// Units of content (handbook/LEAN.md): every reel, post, carousel or Telegram text is one
// item of one format that goes idea → material → build → ready → published. The list lives
// in projects/<p>/items.json and points at the reel and post folders, which stay as they are:
// the bot and the agent keep using them, ideas.md and plan.json. syncItems() reads those
// sources, adds what is new and moves each item's stage forward when the files say so.
import {existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {listPosts} from './posts.mjs';
import {logEvent} from './events.mjs';

export const STAGES = ['idea', 'material', 'build', 'ready', 'published'];
export const FORMATS = ['reel', 'post', 'carousel', 'telegram', 'story'];
const POST_FORMAT = {photo: 'post', carousel: 'carousel', text: 'telegram'};
const SECTION = {'In work': 'work', 'In review': 'review', Done: 'done', Published: 'published'};
const IDEA_SECTIONS = /^(Owner's ideas|My ideas)$/;

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f); };
const rank = (s) => STAGES.indexOf(s);
export const newId = (prefix = 'i') => `${prefix}-${randomBytes(4).toString('hex')}`;

/** ideas.md: «## Section» then «### Title» entries with Format:/Hook:/Plot: lines. */
export function parseIdeas(studio) {
  const out = [];
  let section = '', cur = null;
  for (const line of read(join(studio, 'ideas.md')).split('\n')) {
    const h2 = /^## (.+)/.exec(line);
    if (h2) { section = h2[1].trim(); cur = null; continue; }
    const h3 = /^### (.+)/.exec(line);
    if (h3) { cur = {section, title: h3[1].trim(), lines: []}; out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return out;
}
const field = (idea, name) => idea.lines.find((l) => l.startsWith(name + ':'))?.slice(name.length + 1).trim() || '';
const reelNumber = (s) => /^(\d{1,3})\b/.exec(s)?.[1]?.padStart(2, '0');

/** A pitch's format from its «Format:» line; reels unless it says otherwise. */
export function guessFormat(text) {
  const t = String(text).toLowerCase();
  if (/карусел|carousel/.test(t)) return 'carousel';
  if (/телеграм|telegram/.test(t)) return 'telegram';
  if (/истори|stor(y|ies)/.test(t)) return 'story';
  if (/\bпост|фото-пост|photo post/.test(t)) return 'post';
  return 'reel';
}

/** What the reel and post folders and ideas.md say, without the web's thumbs. */
export function readSources(studio) {
  const ideas = parseIdeas(studio);
  const status = {};
  for (const i of ideas) { const n = reelNumber(i.title); if (n && SECTION[i.section]) status[n] = SECTION[i.section]; }
  const root = join(studio, 'reels');
  const reels = (existsSync(root) ? readdirSync(root) : []).filter((r) => /^[\w-]{1,80}$/.test(r) && statSync(join(root, r)).isDirectory()).map((r) => {
    const dir = join(root, r);
    const vd = join(dir, 'versions');
    const versions = existsSync(vd) ? readdirSync(vd).filter((v) => /^v\d+$/.test(v)).length : 0;
    const title = (/^#\s*(.+)/m.exec(read(join(dir, 'README.md')))?.[1] || r).replace(/^\d+[\s—–-]*/, '').replace(/[«»]/g, '').replace(/\s*\(.*\)\s*$/, '').trim();
    const scenes = readJson(join(dir, 'scenes.json'), []);
    return {id: r, title, status: status[reelNumber(r)] || 'none', versions, need: Array.isArray(scenes) ? scenes : []};
  });
  const posts = listPosts(studio, () => null).map((x) => {
    const post = readJson(join(studio, 'posts', x.id, 'post.json'), {});
    const sources = existsSync(join(studio, 'posts', x.id, 'sources')) ? readdirSync(join(studio, 'posts', x.id, 'sources')).length : 0;
    return {...x, sources, hasPhotos: (post.photos || []).length > 0};
  });
  const pitches = ideas.filter((i) => IDEA_SECTIONS.test(i.section));
  return {reels, posts, pitches, plan: readJson(join(studio, 'plan.json'), {})};
}

/** The stage the files show; null when they say nothing (a bare idea). */
export function derivedStage(item, src) {
  const ref = item.ref;
  if (ref?.kind === 'reel') {
    const r = src.reels.find((x) => x.id === ref.id);
    if (!r) return null;
    if (r.status === 'published') return 'published';
    if (r.status === 'done') return 'ready';
    return r.versions ? 'build' : 'material';
  }
  if (ref?.kind === 'post') {
    const x = src.posts.find((y) => y.id === ref.id);
    if (!x) return null;
    if (x.stage === 'done') return 'published';
    if (x.stage === 'publish') return 'ready';
    if (x.kind === 'photo' && !x.sources && !x.hasPhotos) return 'material';
    return 'build';
  }
  return null;
}

/** The checklist «что снять»: the reel's scenes with what they need, else the item's own. */
export function needOf(item, src) {
  if (item.ref?.kind === 'reel') {
    const r = src.reels.find((x) => x.id === item.ref.id);
    const list = (r?.need || []).filter((s) => s.need).map((s) => ({text: s.need, have: s.have || '', done: s.status === 'готово', scene: s.name || ''}));
    if (list.length) return list;
  }
  return item.need || [];
}

export const itemsFile = (studio) => join(studio, 'items.json');
export const loadItems = (studio) => readJson(itemsFile(studio), {v: 1, items: []});
export const saveItems = (studio, data) => writeJson(itemsFile(studio), data);

/**
 * Brings items.json up to date with the folders: an item per reel and post, Claude's pitches
 * as proposals, stages moved forward. Returns {data, changed, added}; writes unless dry.
 * The first run keeps a copy of plan.json as plan.json.bak.
 */
export function syncItems(studio, {dry = false, now = Date.now()} = {}) {
  const first = !existsSync(itemsFile(studio));
  const data = loadItems(studio);
  data.items ||= [];
  const src = readSources(studio);
  const at = src.plan.at || {}, rubric = src.plan.rubric || {};
  let changed = first;
  const added = [];
  const byRef = (kind, id) => data.items.find((x) => x.ref?.kind === kind && x.ref.id === id);
  const add = (item) => { data.items.push(item); added.push(item); changed = true; };

  for (const r of src.reels) {
    if (byRef('reel', r.id)) continue;
    // A reel started from an idea in the last hours becomes that idea's folder.
    const waiting = data.items.filter((x) => x.starting && now - x.starting < 6 * 3600e3 && x.format === 'reel' && x.ref?.kind !== 'reel').sort((a, b) => b.starting - a.starting)[0];
    if (waiting) { waiting.ref = {kind: 'reel', id: r.id}; delete waiting.starting; delete waiting.proposed; changed = true; continue; }
    add({id: newId(), format: 'reel', title: r.title, stage: 'idea', rubric: rubric['reel:' + r.id] || null, at: at['reel:' + r.id] || null, ref: {kind: 'reel', id: r.id}, created: now});
  }
  for (const x of src.posts) {
    if (byRef('post', x.id)) continue;
    const key = 'post:' + x.id;
    add({id: newId(), format: POST_FORMAT[x.kind] || 'post', title: x.title, stage: 'idea', rubric: rubric[key] || x.rubric || null,
      at: at[key] || (x.at ? new Date(x.at).toISOString().slice(0, 16) : null), ref: {kind: 'post', id: x.id}, created: now});
  }
  // Claude's and the owner's pitches in ideas.md: proposals without a date until someone takes them.
  const titles = new Set(src.pitches.map((i) => i.title));
  // «Расписать идеи»: Claude adds Date: and Rubric: lines to its pitches; they fill a proposal
  // until someone sets its own date or rubric.
  const pitchAt = (i) => (/^\d{4}-\d\d-\d\d(T\d\d:\d\d)?$/.test(field(i, 'Date')) ? field(i, 'Date') : null);
  for (const i of src.pitches) {
    const had = byRef('idea', i.title);
    if (had) {
      if (had.proposed && !had.at && pitchAt(i)) { had.at = pitchAt(i); changed = true; }
      if (had.proposed && !had.rubric && field(i, 'Rubric')) { had.rubric = field(i, 'Rubric'); changed = true; }
      if (had.proposed && had.idea && !had.idea.why && field(i, 'Why')) { had.idea.why = field(i, 'Why'); changed = true; }
      continue;
    }
    add({id: newId(), format: guessFormat(field(i, 'Format')), title: i.title.replace(/^\p{Extended_Pictographic}️?\s*/u, ''), stage: 'idea', rubric: field(i, 'Rubric') || null, at: pitchAt(i),
      ref: {kind: 'idea', id: i.title}, proposed: true, by: i.section === "Owner's ideas" ? 'owner' : 'Claude',
      idea: {about: field(i, 'Plot'), hook: field(i, 'Hook').replace(/^[«"]|[»"]$/g, ''), flow: [], ...(field(i, 'Why') ? {why: field(i, 'Why')} : {})}, created: now});
  }
  // A pitch that left ideas.md before anyone took it (made into a reel, cancelled) goes away.
  const before = data.items.length;
  data.items = data.items.filter((x) => !(x.proposed && x.ref?.kind === 'idea' && !titles.has(x.ref.id)));
  if (data.items.length !== before) changed = true;

  for (const item of data.items) {
    const d = derivedStage(item, src);
    const gone = (item.ref?.kind === 'reel' || item.ref?.kind === 'post') && d === null;
    if (!!item.missing !== gone) { if (gone) item.missing = true; else delete item.missing; changed = true; }
    if (!d) continue;
    // «Вернуть в сборку» holds until a new version appears.
    if (item.hold) {
      const r = item.ref.kind === 'reel' ? src.reels.find((x) => x.id === item.ref.id) : null;
      if (r && r.versions > item.hold.versions) { delete item.hold; changed = true; } else continue;
    }
    if (rank(d) > rank(item.stage)) {
      if (!dry && !first) logEvent(studio, {type: 'stage', item: item.id, from: item.stage, to: d, by: 'files'}, now);
      item.stage = d; item.stageAt = now; changed = true;
    }
  }
  if (changed && !dry) {
    if (first && existsSync(join(studio, 'plan.json')) && !existsSync(join(studio, 'plan.json.bak'))) writeFileSync(join(studio, 'plan.json.bak'), read(join(studio, 'plan.json')));
    saveItems(studio, data);
    // The first run brings the whole history in: that is not news.
    if (!first) for (const x of added) if (!x.proposed) logEvent(studio, {type: 'new', item: x.id, format: x.format, by: 'files'}, now);
  }
  return {data, changed, added, src};
}

/** The plan.json key of an item that has a folder: the bot and the agent still read plan.json. */
export const planKey = (item) => (item.ref?.kind === 'reel' || item.ref?.kind === 'post' ? `${item.ref.kind}:${item.ref.id}` : null);

/**
 * Applies the fields a person may change. A stage set back by hand is held until the files
 * move past it (a new version of the reel). Returns the item or null.
 */
export function changeItem(studio, id, b, {by, now = Date.now()} = {}) {
  const data = loadItems(studio);
  const item = data.items.find((x) => x.id === id);
  if (!item) return null;
  if (typeof b.title === 'string' && b.title.trim()) item.title = b.title.trim().slice(0, 140);
  if (b.format !== undefined && FORMATS.includes(b.format) && !item.ref?.kind?.match(/reel|post/)) item.format = b.format;
  if (b.rubric !== undefined) item.rubric = b.rubric ? String(b.rubric).slice(0, 60) : null;
  if (b.at !== undefined) item.at = b.at ? String(b.at).slice(0, 25) : null;
  if (b.group !== undefined) item.group = b.group ? String(b.group).slice(0, 40) : undefined;
  if (Array.isArray(b.platforms)) item.platforms = b.platforms.map(String).slice(0, 10);
  if (b.idea && typeof b.idea === 'object') item.idea = {about: String(b.idea.about ?? item.idea?.about ?? '').slice(0, 2000), hook: String(b.idea.hook ?? item.idea?.hook ?? '').slice(0, 300), flow: (Array.isArray(b.idea.flow) ? b.idea.flow : item.idea?.flow || []).map((s) => String(s).slice(0, 300)).slice(0, 12)};
  if (Array.isArray(b.need) && item.ref?.kind !== 'reel') item.need = b.need.map((n) => ({text: String(n.text || '').slice(0, 200), have: String(n.have || '').slice(0, 200), done: !!n.done})).slice(0, 30);
  if (b.take) { delete item.proposed; item.takenBy = by; }
  if (b.starting) item.starting = now;
  // Links an idea to the post folder made for it (reels link themselves in syncItems).
  if (b.link?.kind === 'post' && /^[\w-]{1,80}$/.test(b.link.id || '') && existsSync(join(studio, 'posts', b.link.id))) {
    // A sync may have added the fresh folder on its own a moment ago: that copy goes.
    data.items = data.items.filter((x) => !(x !== item && x.ref?.kind === 'post' && x.ref.id === b.link.id && now - (x.created || 0) < 5 * 60e3));
    if (!data.items.some((x) => x.ref?.kind === 'post' && x.ref.id === b.link.id)) { item.ref = {kind: 'post', id: b.link.id}; delete item.proposed; }
  }
  if (b.stage !== undefined && STAGES.includes(b.stage) && b.stage !== item.stage) {
    logEvent(studio, {type: 'stage', item: item.id, from: item.stage, to: b.stage, by}, now);
    if (rank(b.stage) < rank(item.stage) && item.ref?.kind === 'reel') {
      const vd = join(studio, 'reels', item.ref.id, 'versions');
      item.hold = {stage: b.stage, versions: existsSync(vd) ? readdirSync(vd).filter((v) => /^v\d+$/.test(v)).length : 0};
    }
    item.stage = b.stage; item.stageAt = now;
  }
  item.updated = now; item.updatedBy = by;
  saveItems(studio, data);
  mirrorPlan(studio, item);
  return item;
}

/** New items, one per format; several formats share a group (one material → several items). */
export function createItems(studio, {formats, title, rubric = null, at = null, idea = null, by, now = Date.now()}) {
  const list = (Array.isArray(formats) ? formats : [formats]).filter((f) => FORMATS.includes(f));
  if (!list.length || !String(title || '').trim()) return [];
  const data = loadItems(studio);
  const group = list.length > 1 ? newId('g') : undefined;
  const made = list.map((format) => ({id: newId(), format, title: String(title).trim().slice(0, 140), stage: 'idea', rubric, at, group,
    idea: idea ? {about: String(idea.about || '').slice(0, 2000), hook: String(idea.hook || '').slice(0, 300), flow: (idea.flow || []).map(String).slice(0, 12)} : undefined,
    by, created: now}));
  data.items.push(...made);
  saveItems(studio, data);
  for (const x of made) logEvent(studio, {type: 'new', item: x.id, format: x.format, by}, now);
  return made;
}

/** Keeps plan.json's date and rubric in step for items that have a folder. */
export function mirrorPlan(studio, item) {
  const key = planKey(item);
  if (!key) return;
  const f = join(studio, 'plan.json');
  const plan = readJson(f, {});
  plan.at ||= {}; plan.rubric ||= {};
  if (item.at) plan.at[key] = item.at; else delete plan.at[key];
  if (item.rubric) plan.rubric[key] = item.rubric; else delete plan.rubric[key];
  writeJson(f, plan);
}

/** The other way round: /api/plan/set changed plan.json, the item follows. */
export function followPlan(studio, key, {at, rubric}) {
  const [kind, id] = key.split(':');
  const data = loadItems(studio);
  const item = data.items.find((x) => x.ref?.kind === kind && x.ref.id === id);
  if (!item) return;
  if (at !== undefined) item.at = at || null;
  if (rubric !== undefined) item.rubric = rubric || null;
  saveItems(studio, data);
}
