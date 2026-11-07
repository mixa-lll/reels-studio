// Direct download links for a finished reel: a page in the bot or the studio hands out
// /d/<token>/<file name>, which opens from a phone without signing in. The token is signed
// (HMAC of WEB_KEY) and carries the file and the expiry, so nothing is stored and nothing can
// be guessed or changed; the server still checks the file lies inside the projects folder.
import {createHmac, timingSafeEqual} from 'node:crypto';
import {existsSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {basename, dirname, join, relative, resolve} from 'node:path';

export const LINK_DAYS = 14;
const b64 = (x) => Buffer.from(x).toString('base64url');
const sign = (key, payload) => createHmac('sha256', createHmac('sha256', key).update('reels-download-v1').digest()).update(payload).digest();

/** A token for `rel` (path inside the projects folder), good for LINK_DAYS. */
export function signLink(key, rel, now = Date.now()) {
  const expires = now + LINK_DAYS * 864e5;
  const payload = b64(JSON.stringify({f: rel, e: expires}));
  return {token: `${payload}.${sign(key, payload).toString('base64url')}`, expires};
}

/** {rel, expires} of a token; {expired: true} when its time is over; null when it is not ours. */
export function readLink(key, token, now = Date.now()) {
  const [payload, sig, extra] = String(token).split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const got = Buffer.from(sig, 'base64url'), want = sign(key, payload);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const {f, e} = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return e > now ? {rel: f, expires: e} : {expired: true};
  } catch { return null; }
}

/** The best file of a version folder: the biggest master, else the biggest video. */
export function bestVideo(vdir) {
  if (!existsSync(vdir)) return null;
  const all = readdirSync(vdir).filter((f) => /\.(mp4|mov|webm)$/i.test(f) && !/^raw/i.test(f)).map((f) => ({path: join(vdir, f), size: statSync(join(vdir, f)).size, master: /1080p|1440p|master/i.test(f)}));
  return all.sort((a, b) => b.master - a.master || b.size - a.size)[0]?.path || null;
}

/** The path inside `projects` of a file, through project folders that are links. */
export function projectPath(projects, file) {
  const real = realpathSync(resolve(file));
  for (const name of readdirSync(projects)) {
    let root;
    try { root = realpathSync(join(projects, name)); } catch { continue; }
    if (real.startsWith(root + '/')) return join(name, relative(root, real));
  }
  return null;
}

export const linkPath = (token, file) => `/d/${token}/${encodeURIComponent(basename(file))}`;

/**
 * The link for a reel's video: the version's master, whatever copy was sent to Telegram.
 * Null for files that are not a reel's version, or without a key or a public address.
 */
export function reelLink(file, {projects, key = process.env.WEB_KEY, origin = process.env.MINIAPP_URL, now = Date.now()} = {}) {
  try {
    if (!key || !origin || !file || !/\/reels\/[\w-]+\/versions\/v\d+\/[^/]+\.(mp4|mov|webm)$/i.test(resolve(file))) return null;
    const best = bestVideo(dirname(resolve(file))) || file;
    const rel = projectPath(projects, best);
    if (!rel) return null;
    const {token, expires} = signLink(key, rel, now);
    return {url: new URL(linkPath(token, best), origin).href, expires};
  } catch { return null; }
}

/** The Telegram button for that link: the date says how long it lives. */
export function linkButton(link) {
  const until = new Date(link.expires).toLocaleDateString('ru-RU', {day: 'numeric', month: 'short'}).replace('.', '');
  return {text: process.env.BOT_LANG === 'en' ? `⬇️ Direct link · until ${new Date(link.expires).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'})}` : `⬇️ Прямая ссылка · до ${until}`, url: link.url};
}
