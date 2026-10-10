// /settings: the owner's switches as a button menu the bot handles itself (instant,
// no agent turn). Ideas settings live in the active project's settings.json, the
// machine-wide ones in data/settings.json; the agent edits the same files when asked.

const TIMES = ['07:00', '08:00', '09:00', '10:00', '12:00', '15:00', '18:00', '21:00'];
const DAYS = ['daily', 'weekdays', 'weekends'];

const L = {
  ru: {
    title: '⚙️ Настройки',
    project: (name) => `📁 Проект «${name}»: идеи — по его расписанию`,
    ideasOn: (at, days) => `💡 Идеи: ${L.ru.days[days]} в ${at}`,
    ideasOff: '💡 Идеи: выключены',
    updates: (on) => `🔄 Проверка обновлений: ${on ? 'вкл' : 'выкл'}`,
    global: (on) => `🧩 Глобальные настройки Claude: ${on ? 'да' : 'нет'}`,
    awake: (on) => `☕ Не засыпать на зарядке: ${on ? 'да' : 'нет'}`,
    awakeOn: '☕ Не давать компьютеру засыпать на зарядке',
    awakeOff: '☕ Разрешить компьютеру засыпать',
    globalHint: 'Плагины, MCP-подключения и хуки твоего Claude Code. Вступает в силу со следующей задачи.',
    time: (at) => `🕐 Время: ${at}`,
    daysBtn: (d) => `📅 ${L.ru.days[d][0].toUpperCase()}${L.ru.days[d].slice(1)}`,
    off: '🔕 Выключить идеи',
    on: '🔔 Включить идеи',
    close: '✖️ Закрыть',
    back: '⬅️ Назад',
    updatesOff: '🔄 Не проверять обновления',
    updatesOn: '🔄 Проверять обновления',
    globalAllow: '🧩 Разрешить глобальные настройки Claude',
    globalHide: '🧩 Скрыть глобальные настройки Claude',
    pickTime: 'Во сколько присылать идеи?\n\n✍️ Или напиши своё время, например 9:30',
    pickDays: 'В какие дни присылать идеи?',
    days: {daily: 'каждый день', weekdays: 'по будням', weekends: 'по выходным'},
    badTime: 'Не понял время. Напиши в формате 9:30 или 18:00.',
  },
  en: {
    title: '⚙️ Settings',
    project: (name) => `📁 Project «${name}»: ideas on its own schedule`,
    ideasOn: (at, days) => `💡 Ideas: ${L.en.days[days]} at ${at}`,
    ideasOff: '💡 Ideas: off',
    updates: (on) => `🔄 Update checks: ${on ? 'on' : 'off'}`,
    global: (on) => `🧩 Global Claude settings: ${on ? 'yes' : 'no'}`,
    awake: (on) => `☕ Stay awake on the charger: ${on ? 'yes' : 'no'}`,
    awakeOn: '☕ Keep the computer awake on the charger',
    awakeOff: '☕ Let the computer sleep',
    globalHint: 'Your Claude Code plugins, MCP connections and hooks. Applies from the next task.',
    time: (at) => `🕐 Time: ${at}`,
    daysBtn: (d) => `📅 ${L.en.days[d][0].toUpperCase()}${L.en.days[d].slice(1)}`,
    off: '🔕 Turn ideas off',
    on: '🔔 Turn ideas on',
    close: '✖️ Close',
    back: '⬅️ Back',
    updatesOff: '🔄 Stop checking for updates',
    updatesOn: '🔄 Check for updates',
    globalAllow: '🧩 Allow global Claude settings',
    globalHide: '🧩 Hide global Claude settings',
    pickTime: 'When should ideas arrive?\n\n✍️ Or type your own time, e.g. 9:30',
    pickDays: 'On which days?',
    days: {daily: 'every day', weekdays: 'on weekdays', weekends: 'on weekends'},
    badTime: 'Could not read the time. Type it like 9:30 or 18:00.',
  },
};

const btn = (text, data) => ({text, callback_data: `set:${data}`});

/** Normalises «9:30», «930», «9» to «09:30»; null if it is not a time. */
export function parseTime(text) {
  const m = text.trim().match(/^(\d{1,2})(?:[:.\s]?(\d{2}))?$/);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2] ?? 0)];
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
}

/** True if ideas are due on this date. */
export function ideasDay(s, date) {
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  return s.ideasDays === 'weekdays' ? !weekend : s.ideasDays === 'weekends' ? weekend : true;
}

/** Text and keyboard of a settings view: 'main' | 'time' | 'days'. */
export function view(s, which, {lang, agent, project}) {
  const t = L[lang];
  const at = s.ideasAt ?? '10:00';
  const days = s.ideasDays ?? 'daily';
  const lastAt = s.ideasAtBefore ?? '10:00';
  if (which === 'time') {
    const rows = [];
    for (let i = 0; i < TIMES.length; i += 4) rows.push(TIMES.slice(i, i + 4).map((x) => btn(x === at ? `✅ ${x}` : x, `at:${x}`)));
    rows.push([btn(t.back, 'main')]);
    return {text: t.pickTime, reply_markup: {inline_keyboard: rows}};
  }
  if (which === 'days') {
    return {text: t.pickDays, reply_markup: {inline_keyboard: [...DAYS.map((d) => [btn(`${d === days ? '✅ ' : ''}${t.days[d]}`, `days:${d}`)]), [btn(t.back, 'main')]]}};
  }
  const updatesOn = s.updateChecks !== false && s.autoUpdate !== false;
  const lines = [`**${t.title}**`, '', ...(project ? [t.project(project)] : []), at ? t.ideasOn(at, days) : t.ideasOff, t.awake(s.keepAwake === true), t.updates(updatesOn)];
  if (agent === 'claude') lines.push(t.global(s.agentGlobalSettings === true), `_${t.globalHint}_`);
  const rows = at
    ? [[btn(t.time(at), 'time'), btn(t.daysBtn(days), 'days')], [btn(t.off, 'ideas:off')]]
    : [[btn(t.on, `at:${lastAt}`)]];
  rows.push([btn(s.keepAwake === true ? t.awakeOff : t.awakeOn, 'awake')]);
  rows.push([btn(updatesOn ? t.updatesOff : t.updatesOn, 'updates')]);
  if (agent === 'claude') rows.push([btn(s.agentGlobalSettings === true ? t.globalHide : t.globalAllow, 'global')]);
  rows.push([btn(t.close, 'close')]);
  return {text: lines.join('\n'), reply_markup: {inline_keyboard: rows}};
}

/**
 * Applies a `set:…` tap. Returns {patch, show, awaitTime?, close?}: settings to write
 * and the view to show next.
 */
export function onSettingsButton(data, s) {
  const [, action, ...rest] = data.split(':');
  const arg = rest.join(':');
  if (action === 'main' || action === 'time' || (action === 'days' && !arg)) return {patch: {}, show: action, awaitTime: action === 'time'};
  if (action === 'at') return {patch: {ideasAt: arg}, show: 'main', scheduled: arg};
  if (action === 'days') return {patch: {ideasDays: arg}, show: 'main'};
  if (action === 'ideas') return {patch: {ideasAt: '', ideasAtBefore: s.ideasAt || '10:00'}, show: 'main'};
  if (action === 'updates') return {patch: {updateChecks: s.updateChecks === false || s.autoUpdate === false, autoUpdate: undefined}, show: 'main'};
  if (action === 'awake') return {patch: {keepAwake: s.keepAwake !== true}, show: 'main'};
  if (action === 'global') return {patch: {agentGlobalSettings: s.agentGlobalSettings !== true}, show: 'main'};
  return {patch: {}, close: true};
}

export const badTime = (lang) => L[lang].badTime;
