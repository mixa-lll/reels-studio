// The bot's public face: avatar, descriptions and the command menu.
// Applied on startup; bump PROFILE_VERSION to push changes to existing bots.
// The display name stays whatever the owner picked in @BotFather.
import {openAsBlob} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from './config.mjs';

const PROFILE_VERSION = 7;

const TEXT = {
  ru: {
    description:
      '🎬 Делаю рилсы вместе с тобой — от идеи до готового видео.\n\n'
      + '💡 Каждое утро — 4 идеи под твой продукт или блог\n'
      + '🎨 Предлагаю стиль и музыку, монтирую сам\n'
      + '✏️ Правки — ответом на видео\n'
      + '🎙 Можно писать или говорить голосовыми — я понимаю\n'
      + '✅ «Принять» — и файл в полном качестве у тебя\n\n'
      + 'Нажми «Старт» и расскажи, о чём будут рилсы.',
    short: 'Идеи, монтаж и правки рилсов прямо в чате — текстом или голосом. Работает на твоём AI-агенте.',
    commands: {ideas: 'Идеи для рилсов прямо сейчас', unfinished: 'Незаконченные рилсы — вернуться и доделать', projects: 'Проекты: сменить или начать новый', settings: 'Настройки: когда присылать идеи и другое', update: 'Проверить обновления бота', usage: 'Лимиты агента и сколько уходит на рилс', stop: 'Остановить текущую задачу', new: 'Начать новую сессию агента'},
  },
  en: {
    description:
      '🎬 I make reels with you, from idea to finished video.\n\n'
      + '💡 4 fresh ideas every morning for your product or blog\n'
      + '🎨 I suggest the look and music and do the editing\n'
      + '✏️ Edits: just reply to the video\n'
      + '🎙 Type or send voice messages — I understand both\n'
      + '✅ «Accept» — and the full-quality file is yours\n\n'
      + 'Press Start and tell me what your reels are about.',
    short: 'Reel ideas, editing and revisions right in the chat, by text or voice. Runs on your own AI agent.',
    commands: {ideas: 'Reel ideas right now', unfinished: 'Unfinished reels — get back to one', projects: 'Projects: switch or start a new one', settings: 'Settings: when ideas arrive and more', update: 'Check for bot updates', usage: 'Agent limits and what a reel takes', stop: 'Stop the current task', new: 'Start a new agent session'},
  },
};

/** Sets avatar, descriptions and commands once per PROFILE_VERSION. */
export async function applyProfile(tg, token, state, lang) {
  const t = TEXT[lang];
  await tg.call('setMyCommands', {
    commands: Object.entries(t.commands).map(([command, description]) => ({command, description})),
  });
  if (state.profileVersion === PROFILE_VERSION && state.profileLang === lang) return false;

  await tg.call('setMyDescription', {description: t.description});
  await tg.call('setMyShortDescription', {short_description: t.short});

  // Profile photos can only be uploaded as a new file via multipart.
  const form = new FormData();
  form.append('photo', JSON.stringify({type: 'static', photo: 'attach://avatar'}));
  form.append('avatar', await openAsBlob(join(ROOT, 'bot/assets/avatar.jpg')), 'avatar.jpg');
  const res = await fetch(`${process.env.REELS_TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/setMyProfilePhoto`, {method: 'POST', body: form, signal: AbortSignal.timeout(60_000)});
  const json = await res.json();
  if (!json.ok) console.error('setMyProfilePhoto:', json.description);

  Object.assign(state, {profileVersion: PROFILE_VERSION, profileLang: lang});
  return true;
}
