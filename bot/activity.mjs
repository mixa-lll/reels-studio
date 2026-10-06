// Turns an agent's raw tool call into a short plain-language line for the
// progress message: what it is doing right now, never the command itself.

const LABELS = {
  ru: {
    think: '🤔 Обдумываю',
    brief: '📋 Читаю бриф',
    playbook: '📒 Сверяюсь с твоими правками',
    research: '🔎 Изучаю сайт и рефы',
    product: '📖 Изучаю продукт',
    ideas: '💡 Записываю идеи',
    notes: '🗂 Обновляю заметки',
    setup: '📦 Готовлю проект',
    music: '🎵 Скачиваю музыку',
    beats: '🥁 Ищу ритм трека',
    scenes: '✂️ Монтирую сцены',
    preview: '👀 Проверяю кадры',
    render: '🎬 Выполняю рендер',
    cover: '🖼 Делаю обложку',
    sound: '🔊 Свожу звук',
    video: '🎞 Обрабатываю видео',
    listen: '🎧 Слушаю запись',
    send: '📤 Отправляю',
    work: '⚙️ Работаю',
  },
  en: {
    think: '🤔 Thinking',
    brief: '📋 Reading the brief',
    playbook: '📒 Checking your past edits',
    research: '🔎 Studying the site and references',
    product: '📖 Studying the product',
    ideas: '💡 Writing ideas down',
    notes: '🗂 Updating notes',
    setup: '📦 Preparing the project',
    music: '🎵 Downloading music',
    beats: '🥁 Finding the beat',
    scenes: '✂️ Editing scenes',
    preview: '👀 Checking frames',
    render: '🎬 Rendering',
    cover: '🖼 Making the cover',
    sound: '🔊 Mixing sound',
    video: '🎞 Processing video',
    listen: '🎧 Listening to the recording',
    send: '📤 Sending',
    work: '⚙️ Working',
  },
};

export const activityLabel = (key, lang) => LABELS[lang][key] ?? LABELS[lang].work;

function forPath(path = '', writing) {
  if (/brief\.md$/.test(path)) return writing ? 'notes' : 'brief';
  if (/PLAYBOOK\.md$/.test(path)) return writing ? 'notes' : 'playbook';
  if (/ideas\.md$/.test(path)) return writing ? 'ideas' : 'brief';
  if (/[\\/]project[\\/](src|public)[\\/]/.test(path)) return 'scenes';
  if (/\.(png|jpe?g|webp)$/i.test(path)) return 'preview';
  if (/README\.md$/.test(path)) return writing ? 'notes' : 'product';
  return writing ? 'notes' : 'product';
}

function forCommand(cmd = '') {
  if (/bot[\\/]send\.mjs/.test(cmd)) return /--status/.test(cmd) ? null : 'send';
  if (/render\.mjs|remotion render/.test(cmd)) return 'render';
  if (/remotion still/.test(cmd)) return 'cover';
  if (/beats\.py|librosa/.test(cmd)) return 'beats';
  if (/loudnorm|alimiter/.test(cmd)) return 'sound';
  if (/whisper/.test(cmd)) return 'listen';
  if (/\.(mp3|wav|m4a)\b/.test(cmd) && /curl|wget|Invoke-WebRequest|iwr/.test(cmd)) return 'music';
  if (/curl|wget|Invoke-WebRequest|iwr/.test(cmd)) return 'research';
  if (/npm (i|install|ci)\b|new-reel\.mjs/.test(cmd)) return 'setup';
  if (/ffmpeg|ffprobe/.test(cmd)) return 'video';
  if (/\b(cat|head|sed -n|grep|rg|ls|find|Get-Content|Select-String|dir|type)\b/.test(cmd)) return 'product';
  return 'work';
}

/**
 * Classifies one tool call: {tool: 'search'|'fetch'|'read'|'write'|'run', path?, command?}.
 * Returns an activity key, or null when the call should not change the line.
 */
export function classify({tool, path, command}) {
  if (tool === 'search' || tool === 'fetch') return 'research';
  if (tool === 'read') return forPath(path, false);
  if (tool === 'write') return forPath(path, true);
  if (tool === 'run') return forCommand(command);
  return 'work';
}
