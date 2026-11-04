// The bot on the «Основа» model (handbook/BOT-LEAN.md): the same units of content as the
// web studio, read from projects/<p>/items.json through web/items.mjs, never a list of its
// own. Off until the project's settings.json says {"bot": "lean"}; without it the bot works
// as before.
import {STAGES, syncItems} from '../web/items.mjs';
import {logEvent, readEvents} from '../web/events.mjs';
import {settings, studio} from './config.mjs';

export {logEvent, readEvents};

export const isLean = () => settings().bot === 'lean';

const STAGE_RU = {idea: 'Идея', material: 'Материал', build: 'Сборка', ready: 'Готово', published: 'Вышло'};
const STAGE_EN = {idea: 'Idea', material: 'Material', build: 'Build', ready: 'Ready', published: 'Published'};
const FORMAT_RU = {reel: 'рилс', post: 'пост', carousel: 'карусель', telegram: 'Телеграм', story: 'история'};

export const stageName = (s, lang = 'ru') => (lang === 'ru' ? STAGE_RU : STAGE_EN)[s] || s;

/** The project's items, synced with the folders first; proposals and vanished folders left out. */
export function items(dir = studio()) {
  return syncItems(dir).data.items.filter((x) => !x.missing && !x.proposed);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]);
const day = (at) => (at ? new Date(at).toLocaleDateString('ru-RU', {weekday: 'short', day: 'numeric', month: 'short'}) : '');

/** «/items»: everything in work by stage, published ones only counted. HTML. */
export function itemsText(list = items(), lang = 'ru') {
  const lines = [lang === 'ru' ? '<b>Выпуски по этапам</b>' : '<b>Items by stage</b>'];
  for (const s of STAGES) {
    const of = list.filter((x) => x.stage === s);
    if (!of.length) continue;
    if (s === 'published') { lines.push('', `<b>${stageName(s, lang)}</b> · ${of.length}`); continue; }
    lines.push('', `<b>${stageName(s, lang)}</b> · ${of.length}`);
    for (const x of of.sort((a, b) => String(a.at || '9').localeCompare(String(b.at || '9'))).slice(0, 8)) {
      lines.push(`• ${esc(x.title)} <i>· ${FORMAT_RU[x.format] || x.format}${x.at ? ' · ' + day(x.at) : ''}</i>`);
    }
    if (of.length > 8) lines.push(lang === 'ru' ? `<i>и ещё ${of.length - 8}</i>` : `<i>and ${of.length - 8} more</i>`);
  }
  if (lines.length === 1) lines.push('', lang === 'ru' ? 'Пока пусто.' : 'Nothing yet.');
  return lines.join('\n');
}
