// Modes and plans (handbook/LAUNCH.md): what a project shows and what it may do.
// One list for the bot, the web studio and the mini app; they all ask can(settings, feature).
//
// A project's settings.json may carry {mode, plan}. Without a plan the project is
// unrestricted — that is every project made before plans existed, so nothing changes for them.

export const MODES = {
  solo: {name: 'Один', about: 'эксперт, блогер, маленький бизнес'},
  team: {name: 'Команда', about: 'школа, клиника, студия — участники присылают материал'},
  agency: {name: 'Агентство', about: 'SMM-специалист с несколькими клиентами'},
};

// Features, in the words of the interface:
//   posts — посты и карусели · plan — календарь и стратегия · reels — ролики по шаблонам и редактор
//   selfShoot — съёмка себя с суфлёром · members — участники и приглашения · tasks — задания людям
//   inbox — входящие от участников · approval — согласующий по ссылке · projects — несколько проектов
const POSTS = ['posts', 'plan'];
const VIDEO = [...POSTS, 'reels', 'selfShoot'];
const TEAM = [...VIDEO, 'members', 'tasks', 'inbox', 'approval'];
export const PLANS = {
  posts: {name: 'Посты', features: POSTS, limits: {posts: 30, people: 1}},
  video: {name: 'Посты + видео', features: VIDEO, limits: {posts: 60, reels: 8, people: 1}},
  team: {name: 'Команда', features: TEAM, limits: {posts: 120, reels: 20, people: 15}},
  agency: {name: 'Агентство', features: [...TEAM, 'projects'], limits: {posts: 120, reels: 20, people: 15, projects: 10}},
};
export const FEATURE_NAMES = {posts: 'посты и карусели', plan: 'календарь и стратегия', reels: 'ролики и редактор', selfShoot: 'съёмка себя с суфлёром',
  members: 'участники', tasks: 'задания людям', inbox: 'входящие', approval: 'согласование по ссылке', projects: 'несколько проектов'};

/** True when the project's plan includes the feature (or it has no plan). A solo project hides team features whatever the plan. */
export function can(settings = {}, feature) {
  if (settings.mode === 'solo' && ['members', 'tasks', 'inbox', 'approval'].includes(feature)) return false;
  const plan = PLANS[settings.plan];
  return plan ? plan.features.includes(feature) : true;
}

/** The plan's features and limits as one object for a page: {mode, plan, features: {name: bool}, limits}. */
export function access(settings = {}) {
  const features = Object.fromEntries(Object.keys(FEATURE_NAMES).map((f) => [f, can(settings, f)]));
  return {mode: settings.mode || null, plan: settings.plan || null, features, limits: PLANS[settings.plan]?.limits || null};
}

/** The cheapest plan that has the feature, for «доступно в тарифе …». */
export const planFor = (feature) => Object.entries(PLANS).find(([, p]) => p.features.includes(feature))?.[1].name || null;
