// Test accounts: a whole pretend client — its own project with a mode and a plan, demo
// strategy and ideas, and its own people — to run a scenario end to end in the bot, the
// web studio and the mini app, then remove it with everything that appeared in it.
//
// A test account is a project folder named test-<id> with {test: true, mode, plan} in its
// settings.json. Its people sit in the shared access.json with {test: true, project: <slug>}
// and belong to that project only. Real projects and real people are never touched.
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {MODES, PLANS} from './plans.mjs';

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2) + '\n'); renameSync(`${f}.tmp`, f); };
const rid = (n = 6) => randomBytes(n).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, n).toLowerCase();

const DEMO_STRATEGY = {
  platforms: [
    {id: 'ig', name: 'Instagram', account: '@demo', audience: 'клиенты и те, кто выбирает', lang: 'русский', time: '19:00',
      formats: [{kind: 'reel', spec: '9:16 · 15–30 с', perWeek: 2}, {kind: 'carousel', spec: '4:5 · до 10 слайдов', perWeek: 1}, {kind: 'photo', spec: '4:5', perWeek: 1}], memory: []},
    {id: 'tg', name: 'Телеграм-канал', account: '@demo_channel', audience: 'постоянные', lang: 'русский', time: '12:00',
      formats: [{kind: 'text', spec: 'до 1000 знаков', perWeek: 2}, {kind: 'photo', spec: 'фото + текст', perWeek: 1}], memory: []},
  ],
  rubrics: [
    {id: 'how', name: 'Как это делается', color: '#22A55B', share: 40, why: 'сохраняют и пересылают', about: 'процесс изнутри', template: 'steps'},
    {id: 'people', name: 'Люди', color: '#8B5CF6', share: 35, why: 'доверие', about: 'кто работает и как', template: 'intro'},
    {id: 'news', name: 'Новости и события', color: '#3B82F6', share: 25, why: 'повод прийти', about: 'что будет и что было'},
  ],
  rhythm: {season: 'Обычная неделя', slots: [
    {day: 2, time: '19:00', rubric: 'how', platform: 'ig', kind: 'reel'},
    {day: 3, time: '12:00', rubric: 'news', platform: 'tg', kind: 'text'},
    {day: 5, time: '19:00', rubric: 'people', platform: 'ig', kind: 'carousel'},
  ]},
  events: [],
  voice: {about: 'Просто и по делу, как друг, который в этом разбирается.', never: ['канцелярит', 'восклицательные знаки подряд'],
    styles: [{name: 'Тёплый', when: 'люди', sample: 'Это Лена — она знает, как сделать утро лучше.'}, {name: 'Деловой', when: 'новости', sample: 'С понедельника открываемся на час раньше.'}]},
};
const DEMO_IDEAS = `# Ideas

## Owner's ideas

### Как мы готовимся к открытию
Format: рилс · шаги
Hook: «Пять вещей, которые мы делаем до 9 утра»

### Знакомьтесь: новый сотрудник
Format: карусель
Hook: «Он пришёл к нам три недели назад»
`;

// People of a test account by mode: who is needed to try its scenarios.
const PEOPLE = {
  solo: [],
  team: [{name: 'Редактор', role: 'editor'}, {name: 'Участник «в кадре»', role: 'member', onCamera: true}, {name: 'Участник', role: 'member'}, {name: 'Сам собирает', role: 'member', selfBuild: true}],
  agency: [{name: 'Редактор', role: 'editor'}, {name: 'Участник «в кадре»', role: 'member', onCamera: true}, {name: 'Участник', role: 'member'}],
};

export const isTest = (projects, slug) => !!readJson(join(projects, slug, 'settings.json'), {}).test;

/** Test accounts, newest first: [{slug, name, mode, plan, created, people}]. */
export function listSandboxes({projects, access}) {
  if (!existsSync(projects)) return [];
  const people = readJson(access, {}).people || [];
  return readdirSync(projects).filter((s) => s.startsWith('test-') && isTest(projects, s)).map((slug) => {
    const s = readJson(join(projects, slug, 'settings.json'), {});
    return {slug, name: s.name, mode: s.mode, plan: s.plan, created: s.created, people: people.filter((x) => x.project === slug).map((x) => ({id: x.id, name: x.name, role: x.role}))};
  }).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** Creates a test account; returns its slug. */
export function createSandbox({projects, access, starter}, {mode = 'team', plan = 'team'} = {}) {
  if (!MODES[mode] || !PLANS[plan]) throw new Error('unknown mode or plan');
  const slug = `test-${rid()}`;
  const dir = join(projects, slug);
  cpSync(starter, dir, {recursive: true});
  const s = readJson(join(dir, 'settings.json'), {});
  writeJson(join(dir, 'settings.json'), {...s, name: `Тест · ${MODES[mode].name} · ${PLANS[plan].name}`, test: true, mode, plan, created: new Date().toISOString()});
  writeJson(join(dir, 'strategy.json'), DEMO_STRATEGY);
  writeFileSync(join(dir, 'ideas.md'), DEMO_IDEAS);
  writeFileSync(join(dir, 'brief.md'), '# Демо-проект\n\nТестовый аккаунт: небольшой бизнес, ведёт Instagram и Телеграм-канал. Всё здесь можно менять и удалять.\n');
  mkdirSync(access.slice(0, access.lastIndexOf('/')), {recursive: true});
  const a = {people: [], invites: [], sessions: [], ...readJson(access, {})};
  for (const p of PEOPLE[mode]) a.people.push({id: randomBytes(18).toString('base64url'), name: `${p.name} · ${slug.slice(5)}`, role: p.role, added: Date.now(), test: true, project: slug, ...(p.onCamera ? {onCamera: true} : {}), ...(p.selfBuild ? {selfBuild: true} : {})});
  writeJson(access, a);
  return slug;
}

/**
 * Removes a test account and everything that belongs to it: the project folder (reels,
 * posts, inbox, tasks, takes), the studio's chats of it, its people with their sessions
 * and invites, its outbox items and its log lines. Returns {name, people} or null.
 */
export function removeSandbox({projects, access, chats, outbox, log, botState}, slug) {
  if (!/^test-[a-z0-9]+$/.test(slug) || !isTest(projects, slug)) return null;
  const name = readJson(join(projects, slug, 'settings.json'), {}).name || slug;
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
