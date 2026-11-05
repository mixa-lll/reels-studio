// Instagram accounts of a project, as the studio last saw them: projects/<p>/instagram/<account>/
// profile.json plus the pictures next to it (avatar.jpg, media/<code>.jpg). The CDN links of
// Instagram expire within days, so every picture is downloaded at once. Two sources fill it:
// a snapshot of the public profile page (what any visitor sees, no login) and, once the owner
// connects the account, the official Instagram API (refresh() below, every few hours and on the
// «Обновить сейчас» button). The mockups «Как увидят» and the «Вышло» marks read the same file.
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f); };
const safeAccount = (a) => typeof a === 'string' && /^[\w.]{1,30}$/.test(a);
export const accountOf = (s) => String(s || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').split(/[/?#]/)[0].toLowerCase();

// A shortcode is the media id in base64 (A–Z a–z 0–9 - _); its upper bits are the time in ms
// since Instagram's epoch, so the date of a post is known from its link alone.
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function shortcodeTime(code) {
  let id = 0n;
  for (const ch of String(code)) { const n = ALPHA.indexOf(ch); if (n < 0) return null; id = id * 64n + BigInt(n); }
  return new Date(Number((id >> 23n) + 1314220021721n)).toISOString();
}
export const shortcodeOf = (url) => /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/.exec(String(url || ''))?.[1] || null;

export const igDir = (studio, account) => join(studio, 'instagram', account);

/** Every saved account of a project: [{account, ...profile.json}], newest posts first. */
export function listAccounts(studio) {
  const root = join(studio, 'instagram');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(safeAccount).map((a) => readProfile(studio, a)).filter(Boolean);
}
export function readProfile(studio, account) {
  if (!safeAccount(account)) return null;
  const p = readJson(join(igDir(studio, account), 'profile.json'), null);
  if (!p) return null;
  p.media = (p.media || []).slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return p;
}
export function writeProfile(studio, account, profile) {
  const dir = igDir(studio, account);
  mkdirSync(join(dir, 'media'), {recursive: true});
  writeJson(join(dir, 'profile.json'), profile);
}

/** Medians of the latest posts: what a new one will likely show in the mockups. */
export function typical(profile) {
  const med = (k) => { const v = (profile?.media || []).slice(0, 12).map((m) => m[k]).filter((n) => Number.isFinite(n)).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  return {likes: med('likes'), comments: med('comments'), views: med('views')};
}

// ---------- matching posts to items ----------

const words = (t) => new Set(String(t || '').toLowerCase().replace(/#\S+/g, ' ').match(/[\p{L}\d]{4,}/gu) || []);
const overlap = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };

/** Posts of an account against items.json: linked ones by their link, the rest offered by date
 *  and caption. Returns {linked: [{item, media}], offers: [{media, item, score}], loose: [media]}. */
export function match(profile, items) {
  const byCode = new Map();
  for (const it of items) for (const p of it.published || []) { const c = shortcodeOf(p.url); if (c) byCode.set(c, it); }
  const linked = [], offers = [], loose = [];
  for (const m of profile.media || []) {
    const it = byCode.get(m.code);
    if (it) { linked.push({item: it, media: m}); continue; }
    const t = Date.parse(m.timestamp);
    let best = null;
    for (const x of items) {
      if ((x.published || []).some((p) => accountOf(p.account) === profile.account)) continue;
      if (x.format && m.type && !(x.format === m.type || (x.format === 'post' && m.type === 'carousel'))) continue;
      const at = Date.parse(x.at || '');
      const days = Number.isFinite(at) ? Math.abs(at - t) / 864e5 : 30;
      const score = (days <= 1 ? 0.5 : days <= 3 ? 0.3 : days <= 7 ? 0.1 : 0) + overlap(m.caption, `${x.title} ${x.idea?.about || ''} ${x.caption || ''}`) * 0.5;
      if (score >= 0.35 && (!best || score > best.score)) best = {media: m, item: x, score: Math.round(score * 100) / 100};
    }
    if (best) offers.push(best); else loose.push(m);
  }
  return {linked, offers, loose};
}

// ---------- the official API ----------
// Instagram API with Instagram Login (a business or creator account). The token lives only in the
// environment (IG_TOKEN_<ACCOUNT> with dots as _, e.g. IG_TOKEN_MY_GUDAURI): never in a file the
// studio serves, never in a log line or an error shown to anyone.

const GRAPH = 'https://graph.instagram.com/v23.0';
export const tokenFor = (account) => process.env[`IG_TOKEN_${String(account).toUpperCase().replace(/\./g, '_')}`] || '';
const TYPE = {VIDEO: 'reel', REELS: 'reel', IMAGE: 'post', CAROUSEL_ALBUM: 'carousel'};

async function graph(path, token, params = {}) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token);
  const r = await fetch(u, {signal: AbortSignal.timeout(20000)});
  const body = await r.json().catch(() => ({}));
  // The URL holds the token: errors carry Instagram's message only.
  if (!r.ok) throw new Error(body?.error?.message ? `Instagram: ${body.error.message}` : `Instagram: HTTP ${r.status}`);
  return body;
}
async function save(url, file) {
  if (!url) return false;
  try {
    const r = await fetch(url, {signal: AbortSignal.timeout(20000)});
    if (!r.ok) return false;
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch { return false; }
}

/** One account from the API into profile.json; pictures that are already saved are kept. */
export async function refresh(studio, account) {
  const token = tokenFor(account);
  if (!token) throw new Error('аккаунт не подключён');
  const me = await graph('/me', token, {fields: 'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count'});
  const acct = accountOf(me.username) || account;
  const dir = igDir(studio, acct);
  mkdirSync(join(dir, 'media'), {recursive: true});
  const old = readProfile(studio, acct) || {};
  const media = [];
  let page = await graph('/me/media', token, {fields: 'id,shortcode,permalink,media_type,media_product_type,timestamp,caption,thumbnail_url,media_url,like_count,comments_count', limit: '50'});
  while (page && media.length < 100) {
    media.push(...(page.data || []));
    page = page.paging?.next && media.length < 100 ? await fetch(page.paging.next, {signal: AbortSignal.timeout(20000)}).then((r) => r.json()).catch(() => null) : null;
  }
  const out = [];
  for (const m of media) {
    const code = m.shortcode || shortcodeOf(m.permalink);
    if (!code) continue;
    const type = m.media_product_type === 'REELS' ? 'reel' : TYPE[m.media_type] || 'post';
    const thumb = `media/${code}.jpg`;
    if (!existsSync(join(dir, thumb))) await save(m.thumbnail_url || m.media_url, join(dir, thumb));
    let views = null, reach = null, saved = null, shares = null;
    try {
      const ins = await graph(`/${m.id}/insights`, token, {metric: type === 'reel' ? 'views,reach,saved,shares' : 'views,reach,saved'});
      const v = (n) => ins.data?.find((x) => x.name === n)?.values?.[0]?.value ?? null;
      views = v('views'); reach = v('reach'); saved = v('saved'); shares = v('shares');
    } catch { /* insights need the instagram_business_manage_insights permission */ }
    out.push({id: m.id, code, permalink: m.permalink, type, timestamp: m.timestamp, caption: m.caption || '', likes: m.like_count ?? null, comments: m.comments_count ?? null, views, reach, saved, shares, thumb: existsSync(join(dir, thumb)) ? thumb : null});
  }
  if (me.profile_picture_url) await save(me.profile_picture_url, join(dir, 'avatar.jpg'));
  const profile = {...old, account: acct, name: me.name || old.name, bio: me.biography ?? old.bio, link: me.website ?? old.link,
    followers: me.followers_count, following: me.follows_count, posts: me.media_count, avatar: existsSync(join(dir, 'avatar.jpg')) ? 'avatar.jpg' : old.avatar,
    media: out, source: 'api', fetchedAt: new Date().toISOString(), error: null};
  writeProfile(studio, acct, profile);
  return profile;
}

/** refresh() that keeps the last good profile and only notes the error (shown as «ошибка»). */
export async function refreshSafe(studio, account) {
  try { return await refresh(studio, account); } catch (e) {
    const p = readProfile(studio, account);
    if (p) writeProfile(studio, account, {...p, error: String(e.message || e).slice(0, 200), errorAt: new Date().toISOString()});
    throw e;
  }
}
