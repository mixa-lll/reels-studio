#!/usr/bin/env node
// Telegram ↔ coding agent bridge for the reels workflow.
// One owner, one agent turn at a time; messages that arrive mid-turn are queued.
import {spawn} from 'node:child_process';
import {existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA, INBOX, ROOT, STUDIO, env, loadState, saveState, settings} from './config.mjs';
import {runAgent} from './agents.mjs';
import {activityLabel, classify} from './activity.mjs';
import {activeMenu, onMenuButton, onMenuText} from './menu.mjs';
import {currentKeys, forgetKeys, replyKeyboard, splitKeyLine} from './keys.mjs';
import {applyProfile} from './profile.mjs';
import {transcribe} from './stt.mjs';
import {botChangedSince, head, pendingUpdates, pullUpdates} from './update.mjs';
import {telegram} from './telegram.mjs';

if (!env.token) {
  console.error('TELEGRAM_BOT_TOKEN is not set (see .env.example).');
  process.exit(1);
}

const LANG = process.env.BOT_LANG === 'en' ? 'en' : 'ru';
const T = {
  ru: {
    hello: '🎬 Привет! Я делаю рилсы: присылаю идеи, монтирую выбранные, правлю по твоим ответам на видео.\n\n🎙 Со мной можно говорить голосовыми — так даже быстрее: надиктуй идею или правки, я пойму.\n\nДля начала расскажи, о чём будут рилсы: продукт, ссылка, аудитория.',
    queued: (n) => `📥 ещё ${n} в очереди`,
    accepted: '⏳ Принял, начинаю',
    min: (m) => (m < 1 ? 'меньше минуты' : `${m} мин`),
    cancelled: '⏹ Остановил.',
    stop: '⏹ Стоп',
    now: '⚡ Учесть сейчас',
    saving: '🧠 Сохраняю контекст перед новой сессией',
    idle: 'Сейчас ничего не делаю.',
    fresh: '🆕 Следующее сообщение начнёт новую сессию. Что важно — сохраню перед этим.',
    failed: '⚠️ Агент упал:',
    unfinished: '🗂 Незаконченные рилсы — выбери, к какому вернуться:',
    hint: 'Или напиши / надиктуй свой вариант',
    noUnfinished: 'Незаконченных рилсов нет. /ideas — новые идеи.',
    updated: (subjects) => `🔄 Я обновился:\n${subjects.map((x) => `• ${x}`).join('\n')}`,
    ideasPrompt: 'Пачка идей для рилсов: раздел «1. Ideas» в REELS.md.',
  },
  en: {
    hello: '🎬 Hi! I make reels: I pitch ideas, edit the ones you pick and revise them from your replies to the video.\n\n🎙 You can talk to me with voice messages, it is often faster: dictate an idea or edits and I will get it.\n\nFirst tell me what the reels are about: product, link, audience.',
    queued: (n) => `📥 ${n} more queued`,
    accepted: '⏳ Got it, starting',
    min: (m) => (m < 1 ? 'under a minute' : `${m} min`),
    cancelled: '⏹ Stopped.',
    stop: '⏹ Stop',
    now: '⚡ Take it now',
    saving: '🧠 Saving context before a new session',
    idle: 'Nothing is running.',
    fresh: '🆕 The next message starts a new session. What matters is saved first.',
    failed: '⚠️ The agent failed:',
    unfinished: '🗂 Unfinished reels — pick one to get back to:',
    hint: 'Or type / dictate your own',
    noUnfinished: 'No unfinished reels. /ideas for new ones.',
    updated: (subjects) => `🔄 I updated myself:\n${subjects.map((x) => `• ${x}`).join('\n')}`,
    ideasPrompt: 'A batch of reel ideas: section "1. Ideas" in REELS.md.',
  },
}[LANG];

// After a self-restart, wait for the previous process to finish exiting.
const waitPid = Number(process.env.REELS_BOT_WAIT_PID);
while (waitPid) {
  try {
    process.kill(waitPid, 0);
    await new Promise((r) => setTimeout(r, 200));
  } catch {
    break;
  }
}

// One instance per folder: Telegram allows a single long-poll per token.
const PID_FILE = join(DATA, 'bot.pid');
if (existsSync(PID_FILE)) {
  const pid = Number(readFileSync(PID_FILE, 'utf8'));
  try {
    process.kill(pid, 0);
    if (pid !== process.pid) {
      console.error(`Already running as pid ${pid}; stop it first.`);
      process.exit(1);
    }
  } catch {}
}
writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => {
  // A restart mid-turn: stop the agent and leave a note, the turn is redone on start.
  if (current?.handle) {
    current.handle.kill();
    if (state.pending) state.note = 'The bot restarted while you were working on the message below. Check what is already done on disk, then finish it.';
    saveState(state);
  }
  rmSync(PID_FILE, {force: true});
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const tg = telegram(env.token);
const state = loadState();
const STATUS_FILE = join(DATA, 'status.txt');
const SENT_FILE = join(DATA, 'sent.txt');
const queue = [];
let current = null; // {handle, statusId, startedAt, activity, lastText, sentMark, reason}

if (await applyProfile(tg, env.token, state, LANG).catch((e) => console.error('profile', e.message))) saveState(state);

// ---------- progress line ----------

const mtime = (f) => (existsSync(f) ? statSync(f).mtimeMs : 0);

// A stale reply keyboard goes as soon as work moves on; a throwaway message carries
// the removal (it can't ride on the progress message, which has inline buttons).
async function clearKeyboard() {
  if (!forgetKeys()) return;
  const msg = await tg.call('sendMessage', {chat_id: state.chatId, text: '⌛', disable_notification: true, reply_markup: {remove_keyboard: true}}).catch(() => null);
  if (msg) await tg.call('deleteMessage', {chat_id: state.chatId, message_id: msg.message_id}).catch(() => {});
}

// ---------- unfinished reels ----------
//
// Each reel's README.md starts with `# NN «Title»` and has a `Status:` line
// (in work / in review / done / published / cancelled), kept current by the agent.

const FINISHED = /^(done|published|cancelled|готово|опубликовано|отмена)/i;

function unfinishedReels() {
  const dir = join(STUDIO, 'reels');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => /^\d{2}-/.test(d)).sort().flatMap((d) => {
    const readme = join(dir, d, 'README.md');
    const text = existsSync(readme) ? readFileSync(readme, 'utf8') : '';
    const status = text.match(/^\**Status:?\**:?\s*(.+)$/im)?.[1]?.trim() ?? '';
    if (FINISHED.test(status)) return [];
    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? d;
    const versions = existsSync(join(dir, d, 'versions'))
      ? readdirSync(join(dir, d, 'versions')).filter((v) => /^v\d+$/.test(v)).sort((a, b) => a.slice(1) - b.slice(1))
      : [];
    return [{folder: d, title, version: versions.at(-1)}];
  });
}

async function showUnfinished() {
  const reels = unfinishedReels();
  if (!reels.length) return tg.sendText(state.chatId, T.noUnfinished);
  await tg.call('sendMessage', {
    chat_id: state.chatId,
    text: T.unfinished,
    reply_markup: {inline_keyboard: reels.map((r) => [{text: `${r.title}${r.version ? ` · ${r.version}` : ''}`.slice(0, 60), callback_data: `u:${r.folder}`.slice(0, 64)}])},
  });
}

// Progress line: the agent's own stage, what it is doing right now, elapsed time.
function statusText() {
  const stage = existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, 'utf8').trim() : '';
  const now = activityLabel(current.activity, LANG);
  const lines = stage ? [stage, `↳ ${now}`] : [now];
  lines.push(`⏱ ${T.min(Math.floor((Date.now() - current.startedAt) / 60_000))}`);
  if (queue.length) lines.push(T.queued(queue.length));
  return lines.join('\n');
}

// Controls under the progress line: stop, or stop and take queued messages in right away.
function controls() {
  const row = [{text: T.stop, callback_data: 'ctl:stop'}];
  if (queue.length) row.push({text: T.now, callback_data: 'ctl:now'});
  return {inline_keyboard: [row]};
}

// The progress message id is persisted, so one left behind by a crash or restart
// is removed on the next start. Result messages are never deleted.
async function postStatus(text) {
  const msg = await tg.call('sendMessage', {chat_id: state.chatId, text, disable_notification: true, reply_markup: controls()});
  current.statusId = state.statusId = msg.message_id;
  current.lastText = text;
  saveState(state);
}

async function deleteStatus(id) {
  await tg.call('deleteMessage', {chat_id: state.chatId, message_id: id}).catch(() => {});
  if (state.statusId === id) {
    delete state.statusId;
    saveState(state);
  }
}

async function dropStatus() {
  if (!current?.statusId) return;
  await deleteStatus(current.statusId);
  current.statusId = null;
}

async function refreshStatus() {
  if (!current?.statusId) return;
  // The agent sent something itself: move the progress line below it.
  const sent = mtime(SENT_FILE);
  if (sent > current.sentMark) {
    current.sentMark = sent;
    await dropStatus();
    await postStatus(statusText());
    return;
  }
  const text = statusText();
  if (text === current.lastText) return;
  current.lastText = text;
  await tg.call('editMessageText', {chat_id: state.chatId, message_id: current.statusId, text, reply_markup: controls()}).catch(() => {});
}

// One refresh at a time; a turn waits for it before removing the line.
let refreshing = Promise.resolve();
setInterval(() => {
  refreshing = refreshing.then(refreshStatus).catch((e) => console.error('status', e.message));
}, 3000);

// ---------- sessions ----------
//
// Durable memory lives in files (brief, ideas, PLAYBOOK, each reel's README), so a
// session is only a working cache. It is rotated when it grows too big, too long or
// goes stale; before that the agent writes a handoff note that seeds the next session.

const HANDOFF_FILE = join(DATA, 'handoff.md');
const PREAMBLE = 'You are running as the reels Telegram bot. Follow AGENTS.md and REELS.md. Talk to the owner through your final reply and `node bot/send.mjs`; name each stage of your work with `node bot/send.mjs --status "<emoji> <stage>"` (e.g. «💡 Придумываю идеи», «🎬 Монтирую v2»).';
const HANDOFF_PROMPT = `This session is about to be closed. Bring the files in studio/ up to date first (ideas.md, each touched reel's README.md, PLAYBOOK.md), then write ${HANDOFF_FILE}: what is in progress, what waits for the owner, which version of which reel was sent last, decisions not yet in files. At most 30 lines. Reply with one word: done.`;

function rotationDue() {
  if (!state.sessionId) return false;
  if (state.rotate) return true;
  const idleHours = (Date.now() - (state.lastTurnAt ?? 0)) / 3_600_000;
  return (state.sessionContext ?? 0) > env.sessionMaxTokens
    || (state.sessionTurns ?? 0) >= env.sessionMaxTurns
    || idleHours > env.sessionIdleHours;
}

function openingPrompt(prompt) {
  const handoff = existsSync(HANDOFF_FILE) ? readFileSync(HANDOFF_FILE, 'utf8').trim() : '';
  return [PREAMBLE, handoff && `Handoff from your previous session:\n${handoff}`, prompt].filter(Boolean).join('\n\n');
}

// ---------- agent turns ----------

/** Runs one agent call under a live progress line. */
async function runWithStatus(prompt, firstLine) {
  rmSync(STATUS_FILE, {force: true});
  current = {startedAt: Date.now(), activity: 'think', sentMark: mtime(SENT_FILE)};
  await postStatus(firstLine);
  const handle = runAgent({
    agent: env.agent,
    bin: env.agentBin,
    model: env.agentModel,
    sessionId: state.sessionId,
    prompt: state.sessionId ? prompt : openingPrompt(prompt),
    onCall: (call) => {
      const key = classify(call);
      if (key) current.activity = key;
    },
  });
  current.handle = handle;
  const res = await handle.done;
  res.reason = current.reason;
  await refreshing;
  await dropStatus();
  current = null;

  if (res.sessionId) {
    if (res.sessionId !== state.sessionId) Object.assign(state, {sessionTurns: 0, sessionContext: 0});
    state.sessionId = res.sessionId;
    state.sessionTurns = (state.sessionTurns ?? 0) + 1;
    if (res.context) state.sessionContext = res.context;
    state.lastTurnAt = Date.now();
    saveState(state);
  }
  return res;
}

async function rotate() {
  rmSync(HANDOFF_FILE, {force: true});
  const res = await runWithStatus(HANDOFF_PROMPT, T.saving);
  // A failed handoff still rotates: the files remain the memory.
  if (res.reason === 'stop') return false;
  for (const k of ['sessionId', 'sessionTurns', 'sessionContext', 'rotate']) delete state[k];
  saveState(state);
  return true;
}

async function runTurn(prompt) {
  // Kept until the turn ends, so a restart can redo it.
  state.pending = prompt;
  saveState(state);
  if (rotationDue() && !(await rotate())) {
    delete state.pending;
    return saveState(state);
  }
  const res = await runWithStatus(prompt, T.accepted);
  delete state.pending;
  saveState(state);
  if (res.cancelled) {
    // Tell the next turn why the previous one ended mid-way.
    if (res.reason === 'stop') state.note = 'Your previous turn was stopped by the owner. Do not resume it unless asked.';
    if (res.reason === 'now') state.note = 'The owner interrupted your previous turn with the message below. Check what is already done on disk, then continue with it in mind.';
    saveState(state);
    return;
  }
  // A trailing `⌨️ A | B` line becomes the owner's keyboard of next options.
  const {text: body, labels} = res.error ? {text: `${T.failed}\n${res.text}`, labels: null} : splitKeyLine(res.text.trim());
  if (body || labels) {
    await tg.call('sendChatAction', {chat_id: state.chatId, action: 'typing'});
    const extra = labels ? {reply_markup: replyKeyboard(labels, {placeholder: T.hint})} : {};
    await tg.sendText(state.chatId, labels ? `${body || '👇'}\n\n✍️ ${T.hint}` : body, extra);
  }
}

async function drain() {
  while (!current && queue.length) {
    // Everything that piled up during the last turn goes in as one message.
    let prompt = queue.splice(0).join('\n\n---\n\n');
    if (state.note) {
      prompt = `(${state.note})\n\n${prompt}`;
      delete state.note;
    }
    try {
      await runTurn(prompt);
    } catch (e) {
      console.error('turn', e);
      current = null;
    }
  }
}

function enqueue(prompt) {
  clearKeyboard().catch(() => {});
  queue.push(prompt);
  if (!current) drain();
}

/** Stops the running turn. 'stop' drops the queue, 'now' runs it right away. */
function interrupt(reason) {
  if (reason === 'stop') queue.length = 0;
  if (!current) return false;
  current.reason = reason;
  current.handle?.kill();
  return true;
}

// ---------- incoming updates ----------

// Returns {prompt, said}: the full message for the agent and just what the owner typed or said.
async function describe(msg) {
  const parts = [];
  let said = null;
  const reply = msg.reply_to_message;
  if (reply) parts.push(`(in reply to: "${reply.caption ?? reply.text ?? 'a file'}")`);
  const file =
    msg.voice ? {id: msg.voice.file_id, name: `voice-${msg.message_id}.ogg`, kind: 'voice note'}
    : msg.video_note ? {id: msg.video_note.file_id, name: `circle-${msg.message_id}.mp4`, kind: 'video note'}
    : msg.video ? {id: msg.video.file_id, name: msg.video.file_name ?? `video-${msg.message_id}.mp4`, kind: 'video'}
    : msg.audio ? {id: msg.audio.file_id, name: msg.audio.file_name ?? `audio-${msg.message_id}.mp3`, kind: 'audio'}
    : msg.document ? {id: msg.document.file_id, name: msg.document.file_name ?? `file-${msg.message_id}`, kind: 'file'}
    : msg.photo ? {id: msg.photo.at(-1).file_id, name: `photo-${msg.message_id}.jpg`, kind: 'photo'}
    : null;
  if (file) {
    const dest = join(INBOX, `${Date.now()}-${file.name.replace(/[^\w.\-]+/g, '_')}`);
    try {
      await tg.download(file.id, dest);
      parts.push(`(attached ${file.kind}: ${dest})`);
      // Agents cannot hear: voice and video notes arrive as text.
      if (file.kind === 'voice note' || file.kind === 'video note') {
        said = await transcribe(dest, LANG);
        parts.push(said ? `(transcript: "${said}")` : '(transcription failed; ask the owner for text if you cannot transcribe it yourself)');
      }
    } catch (e) {
      parts.push(`(attached ${file.kind}, download failed: ${e.message}; Bot API limit is 20 MB)`);
    }
  }
  const text = msg.text ?? msg.caption;
  if (text) parts.push(text);
  return {prompt: parts.join('\n'), said: text ?? said};
}

async function onMessage(msg) {
  if (!state.ownerId) {
    // The first person to write becomes the owner; everyone else is ignored.
    Object.assign(state, {ownerId: msg.from.id, chatId: msg.chat.id});
    saveState(state);
    await tg.sendText(state.chatId, T.hello);
    return;
  }
  if (msg.from.id !== state.ownerId) return;

  const cmd = msg.text?.match(/^\/(\w+)/)?.[1];
  if (cmd === 'start') return tg.sendText(state.chatId, T.hello);
  if (cmd === 'stop') return tg.sendText(state.chatId, interrupt('stop') ? T.cancelled : T.idle);
  if (cmd === 'new') {
    // The handoff runs lazily, right before the next turn.
    state.rotate = true;
    saveState(state);
    return tg.sendText(state.chatId, T.fresh);
  }
  if (cmd === 'ideas') return enqueue(T.ideasPrompt);
  if (cmd === 'unfinished') return showUnfinished();

  // 👀 = seen: while the agent is busy (it will be queued) or while a voice note is transcribed.
  if (current || msg.voice || msg.video_note) {
    await tg.call('setMessageReaction', {chat_id: state.chatId, message_id: msg.message_id, reaction: [{type: 'emoji', emoji: '👀'}]}).catch(() => {});
  }
  const {prompt, said} = await describe(msg);
  // A tap on a reply-keyboard button arrives as plain text with its label.
  const keys = currentKeys();
  if (msg.text && keys?.labels?.includes(msg.text)) {
    if (msg.text === keys.tune && keys.menu) {
      await clearKeyboard();
      const result = await onMenuButton(tg, state.chatId, `m:${keys.menu}:open`);
      if (result) enqueue(result);
      return;
    }
    return enqueue(`(tapped keyboard button "${msg.text}")`);
  }
  // An open menu step takes a typed or dictated answer as the owner's own option.
  const menu = said && !msg.reply_to_message && activeMenu();
  if (menu) {
    const result = await onMenuText(tg, state.chatId, menu, said);
    if (result) enqueue(result);
    return;
  }
  if (prompt) enqueue(prompt);
}

async function onButton(q) {
  await tg.call('answerCallbackQuery', {callback_query_id: q.id}).catch(() => {});
  if (q.from.id !== state.ownerId || q.data === 'ctl:done') return;
  if (q.data.startsWith('u:')) {
    const folder = q.data.slice(2);
    const label = q.message?.reply_markup?.inline_keyboard?.flat().find((b) => b.callback_data === q.data)?.text ?? folder;
    await tg.call('editMessageReplyMarkup', {chat_id: state.chatId, message_id: q.message.message_id, reply_markup: {inline_keyboard: [[{text: `✅ ${label}`, callback_data: 'ctl:done'}]]}}).catch(() => {});
    return enqueue(`(the owner wants to continue the unfinished reel studio/reels/${folder} «${label}». Switch to it: send its latest version again exactly as in hand-over — the video with the accept button, then your review with the edit keyboard and the settings menu — and wait for edits.)`);
  }
  if (q.data.startsWith('m:')) {
    await clearKeyboard();
    const result = await onMenuButton(tg, state.chatId, q.data);
    if (result) enqueue(result);
    return;
  }
  if (q.data === 'ctl:stop' || q.data === 'ctl:now') {
    interrupt(q.data.slice(4));
    if (q.data === 'ctl:stop') await tg.sendText(state.chatId, T.cancelled);
    return;
  }
  const msg = q.message;
  const label = msg?.reply_markup?.inline_keyboard?.flat()[Number(q.data.slice(2))]?.text ?? q.data;
  // Keep the choice visible in history and stop double taps.
  if (msg) {
    await tg.call('editMessageReplyMarkup', {
      chat_id: state.chatId,
      message_id: msg.message_id,
      reply_markup: {inline_keyboard: [[{text: `✅ ${label.replace(/^✅\s*/, '')}`, callback_data: 'ctl:done'}]]},
    }).catch(() => {});
  }
  const about = (msg?.caption ?? msg?.text ?? '').slice(0, 1500);
  enqueue(`(pressed button "${label}" under: "${about}")`);
}

// ---------- daily ideas ----------

setInterval(() => {
  const {ideasAt = '10:00'} = settings();
  if (!ideasAt || !state.ownerId) return;
  const now = new Date();
  const day = now.toLocaleDateString('sv');
  const hhmm = now.toTimeString().slice(0, 5);
  if (hhmm >= ideasAt && state.lastIdeasDay !== day) {
    state.lastIdeasDay = day;
    saveState(state);
    enqueue(T.ideasPrompt);
  }
}, 60_000);

// ---------- self-update ----------
//
// Every 6 hours (and shortly after start) pull new commits from the repo while idle,
// then restart if the bot's own code changed. A failed fast-forward (local edits,
// diverged history) is handed to the agent to merge.

const BOOT_HEAD = await head();
const MERGE_PROMPT = (err) => `Updates for the bot itself are available upstream, but \`git pull --ff-only\` failed:\n${err}\nMerge them, keeping the owner's local changes; run \`node --check\` on every file in bot/. Do not touch studio/ or data/. Then tell the owner in one line what is new.`;

async function announceUpdate() {
  if (!state.updateNote || !state.chatId) return;
  await tg.sendText(state.chatId, T.updated(state.updateNote)).catch(() => {});
  delete state.updateNote;
  saveState(state);
}

function restart() {
  console.log('restarting after update');
  if (process.env.REELS_BOT_SUPERVISED !== '1') {
    // Not under launchd/systemd: start the successor ourselves.
    const log = openSync(join(DATA, 'bot.log'), 'a');
    spawn(process.execPath, [join(ROOT, 'bot/bot.mjs')], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: {...process.env, REELS_BOT_WAIT_PID: String(process.pid)},
    }).unref();
  }
  process.exit(0);
}

async function selfUpdate() {
  if (settings().autoUpdate === false || current || queue.length) return;
  try {
    const subjects = await pendingUpdates();
    if (subjects.length) {
      try {
        const changed = await pullUpdates();
        state.updateNote = subjects.slice(0, 10);
        // The running session read the old workflow; the next turn starts fresh from a handoff.
        if (changed.some((f) => /^(REELS|AGENTS)\.md$/.test(f))) state.rotate = true;
        saveState(state);
      } catch (e) {
        if (state.mergeAsked !== subjects[0]) {
          state.mergeAsked = subjects[0];
          saveState(state);
          enqueue(MERGE_PROMPT(e.message.split('\n').slice(0, 5).join('\n')));
        }
        return;
      }
    }
    // Also covers code the agent merged or edited: restart onto it while idle.
    if (!current && !queue.length && (await botChangedSince(BOOT_HEAD))) return restart();
    await announceUpdate();
  } catch (e) {
    console.error('update', e.message.split('\n')[0]);
  }
}

setTimeout(selfUpdate, 60_000);
setInterval(selfUpdate, 6 * 3_600_000);

// ---------- long polling ----------

console.log(`reels-bot up: agent=${env.agent}, owner=${state.ownerId ?? 'none yet'}`);
if (state.statusId) await deleteStatus(state.statusId);
await announceUpdate();
if (state.pending) {
  const prompt = state.pending;
  delete state.pending;
  enqueue(prompt);
}
let offset = state.offset ?? 0;
for (;;) {
  try {
    const updates = await tg.call('getUpdates', {offset, timeout: 50, allowed_updates: ['message', 'callback_query']});
    for (const u of updates) {
      offset = u.update_id + 1;
      state.offset = offset;
      saveState(state);
      if (u.message) await onMessage(u.message).catch((e) => console.error('message', e));
      if (u.callback_query) await onButton(u.callback_query).catch((e) => console.error('button', e));
    }
  } catch (e) {
    console.error('poll', e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
