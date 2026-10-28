// Test accounts: a pretend new client. It starts empty, as a first visit: the onboarding
// (REELS.md, section 0) asks guiding questions and builds the strategy, the mode, the plan
// and the team from the answers — nobody picks them from a menu. Run a scenario end to
// end in the bot, the web studio and the mini app, then remove it with everything in it.
//
// A test account is a project folder named test-<id> with {test: true} in its settings.json
// (mode and plan appear there after onboarding). Its people sit in the shared access.json with {test: true, project: <slug>}
// and belong to that project only. Real projects and real people are never touched.
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2) + '\n'); renameSync(`${f}.tmp`, f); };
const rid = (n = 6) => randomBytes(n).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, n).toLowerCase();

export const isTest = (projects, slug) => !!readJson(join(projects, slug, 'settings.json'), {}).test;

/** Test accounts, newest first: [{slug, name, mode, plan, created, people}]. */
export function listSandboxes({projects, access}) {
  if (!existsSync(projects)) return [];
  const people = readJson(access, {}).people || [];
  return readdirSync(projects).filter((s) => s.startsWith('test-') && isTest(projects, s)).map((slug) => {
    const s = readJson(join(projects, slug, 'settings.json'), {});
    return {slug, name: `Тест · ${s.name || 'новый клиент'}`, mode: s.mode, plan: s.plan, created: s.created, people: people.filter((x) => x.project === slug).map((x) => ({id: x.id, name: x.name, role: x.role}))};
  }).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** Creates an empty test account (the starter project, as on a first visit); returns its slug. */
export function createSandbox({projects, starter}) {
  const slug = `test-${rid()}`;
  const dir = join(projects, slug);
  cpSync(starter, dir, {recursive: true});
  const s = readJson(join(dir, 'settings.json'), {});
  writeJson(join(dir, 'settings.json'), {...s, name: '', test: true, created: new Date().toISOString()});
  return slug;
}

/** What a test account is called in lists: «Тест · <its name>» once onboarding named it. */
export const sandboxName = (projects, slug) => `Тест · ${readJson(join(projects, slug, 'settings.json'), {}).name || 'новый клиент'}`;

/**
 * Removes a test account and everything that belongs to it: the project folder (reels,
 * posts, inbox, tasks, takes), the studio's chats of it, its people with their sessions
 * and invites, its outbox items and its log lines. Returns {name, people} or null.
 */
export function removeSandbox({projects, access, chats, outbox, log, botState}, slug) {
  if (!/^test-[a-z0-9]+$/.test(slug) || !isTest(projects, slug)) return null;
  const name = sandboxName(projects, slug);
  rmSync(join(projects, slug), {recursive: true, force: true});
  if (chats) rmSync(join(chats, slug), {recursive: true, force: true});
  const a = readJson(access, null);
  let people = 0;
  if (a) {
    const gone = new Set((a.people || []).filter((x) => x.project === slug).map((x) => x.id));
    const names = (a.people || []).filter((x) => gone.has(x.id)).map((x) => x.name);
    people = gone.size;
    a.people = a.people.filter((x) => !gone.has(x.id));
    a.sessions = (a.sessions || []).filter((s) => !gone.has(s.person));
    a.invites = (a.invites || []).filter((i) => !gone.has(i.person));
    writeJson(access, a);
    if (log && existsSync(log)) writeFileSync(log, readFileSync(log, 'utf8').split('\n').filter((l) => !names.some((n) => l.includes(`"who":${JSON.stringify(n)}`)) && !l.includes(slug)).join('\n'));
  }
  if (outbox && existsSync(outbox)) writeJson(outbox, readJson(outbox, []).filter((o) => o.project !== slug));
  // The bot works in one project at a time; if it was here, it goes back to the first one.
  if (botState && existsSync(botState)) {
    const st = readJson(botState, {});
    if (st.project === slug) { st.project = 'main'; writeJson(botState, st); }
  }
  return {name, people};
}
