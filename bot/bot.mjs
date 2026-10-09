#!/usr/bin/env node
// Telegram ↔ coding agent bridge for the reels workflow.
// One owner, one agent turn at a time; messages that arrive mid-turn are queued.
import {spawn} from 'node:child_process';
import {existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA, INBOX, ROOT, STUDIO, env, loadState, saveState, settings, writeSettings} from './config.mjs';
import {APPROVED as CLAIM_APPROVED, REQUEST as CLAIM_REQUEST} from './claim.mjs';
import {killTree, runAgent} from './agents.mjs';
import {activityLabel, classify} from './activity.mjs';
import {activeMenu, onMenuButton, onMenuText, postPending} from './menu.mjs';
import {currentKeys, forgetKeys, replyKeyboard, splitKeyLine} from './keys.mjs';
import {applyProfile} from './profile.mjs';
import {keepAwake, taskAwake} from './awake.mjs';
import {acceptedText, codexLimits, limitWarnings, recordTurn, touchedReel, usageText} from './usage.mjs';
import {badTime, ideasDay, onSettingsButton, parseTime, view as settingsView} from './prefs.mjs';
import {transcribe} from './stt.mjs';
import {describe, remember} from './intake.mjs';
import {explain, lostSession} from './errors.mjs';
import * as updates from './update.mjs';
const {botChangedSince, head, pendingUpdates, pullUpdates, remoteUrl, upstreamHead} = updates;
import {telegram} from './telegram.mjs';

// Log lines carry the time; network errors their real cause (ECONNRESET, ETIMEDOUT…).
for (const level of ['log', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(new Date().toISOString(), ...args.map((a) => (a instanceof Error && a.cause ? `${a.message} (${a.cause.code ?? a.cause.message ?? a.cause})` : a)));
}

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
    cancelled: '⏹ Остановил.',
    stop: '⏹ Стоп',
    now: '⚡ Учесть сейчас',
    saving: '🧠 Сохраняю контекст перед новой сессией',
    idle: 'Сейчас ничего не делаю.',
    fresh: '🆕 Следующее сообщение начнёт новую сессию. Что важно — сохраню перед этим.',
    unfinished: '🗂 Незаконченные рилсы — выбери, к какому вернуться:',
    hint: 'Или напиши / надиктуй свой вариант',
    private: 'Это личный бот. Свой можно поставить: github.com/fivol/reels-bot',
    conflict: '⚠️ С этим же ключом Telegram запущен ещё один бот (на другом компьютере?). Пока он работает, я не получаю сообщения. Останови второй или попроси агента выпустить новый ключ.',
    confirmOnComputer: '👋 Привет! Подтверди на компьютере, в окне установки, что это ты, — и начнём.',
    tooBig: (what, size) => `⚠️ ${what} весит ${size} — Telegram не даёт ботам скачивать файлы больше 20 МБ. Пришли его обычным видео/фото (не «файлом» — Telegram сам сожмёт) или ссылкой на Google Диск / Яндекс Диск.`,
    sttFailed: '⚠️ Не смог распознать голосовое (локальный Whisper не запустился). Агенту передал файл; если он не разберёт — напиши текстом.',
    sttSetup: '🎙 Первое голосовое: ставлю распознавание речи. Это разово, займёт пару минут.',
    listening: '🎧 Слушаю голосовое…',
    downloadFailed: (what, err) => `⚠️ Не смог скачать ${what}: ${err}. Попробуй прислать ещё раз.`,
    noUnfinished: 'Незаконченных рилсов нет. /ideas — новые идеи.',
    updated: (subjects) => `🔄 Обновился:\n${subjects.map((x) => `• ${x}`).join('\n')}`,
    updateAvailable: (subjects, url) => `🔄 Есть новая версия бота:\n${subjects.map((x) => `• ${x}`).join('\n')}\n\nОбновление подтянет код из ${url || 'репозитория'}; твои рилсы, настройки и история не меняются. Без твоего «Обновить» ничего не ставится.`,
    updateYes: '⬆️ Обновить',
    updateNo: 'Не сейчас',
    updateLater: 'Обновлюсь, как только закончу текущую задачу.',
    upToDate: '✅ Стоит последняя версия бота.',
    applying: '⬆️ Новая версия уже скачана — перезапускаюсь на неё.',
    newCode: 'перезапустился на новой версии',
    updateCheckFailed: (e) => `⚠️ Не смог проверить обновления: ${e}`,
    backedUp: (dir) => `твои правки в файлах бота сохранены в ${dir}`,
    ideasPrompt: 'Пачка идей для рилсов: раздел «1. Ideas» в REELS.md.',
    morePrompt: '(tapped «🎲 Другие идеи»: pitch a fresh batch of 4 NEW ideas per «1. Ideas» in REELS.md — none of the ones already shown; those stay in ideas.md. Keyboard: only the new ones, via --ideas.)',
  },
  en: {
    hello: '🎬 Hi! I make reels: I pitch ideas, edit the ones you pick and revise them from your replies to the video.\n\n🎙 You can talk to me with voice messages, it is often faster: dictate an idea or edits and I will get it.\n\nFirst tell me what the reels are about: product, link, audience.',
    queued: (n) => `📥 ${n} more queued`,
    accepted: '⏳ Got it, starting',
    cancelled: '⏹ Stopped.',
    stop: '⏹ Stop',
    now: '⚡ Take it now',
    saving: '🧠 Saving context before a new session',
    idle: 'Nothing is running.',
    fresh: '🆕 The next message starts a new session. What matters is saved first.',
    unfinished: '🗂 Unfinished reels — pick one to get back to:',
    hint: 'Or type / dictate your own',
    private: 'This is a personal bot. Get your own: github.com/fivol/reels-bot',
    conflict: '⚠️ Another copy of this bot runs with the same Telegram key (another computer?). While it runs I get no messages. Stop it or ask the agent for a new key.',
    confirmOnComputer: '👋 Hi! Confirm on your computer, in the setup window, that this is you — and we start.',
    tooBig: (what, size) => `⚠️ The ${what} is ${size} — Telegram does not let bots download files over 20 MB. Send it as a regular video/photo (not as a file, Telegram compresses it) or as a Google Drive / Dropbox link.`,
    sttFailed: '⚠️ Could not transcribe the voice message (local Whisper failed). The agent got the file; if it cannot read it, please type it.',
    sttSetup: '🎙 First voice message: setting up speech recognition. One time only, a couple of minutes.',
    listening: '🎧 Listening to the voice message…',
    downloadFailed: (what, err) => `⚠️ Could not download the ${what}: ${err}. Please send it again.`,
    noUnfinished: 'No unfinished reels. /ideas for new ones.',
    updated: (subjects) => `🔄 Updated:\n${subjects.map((x) => `• ${x}`).join('\n')}`,
    updateAvailable: (subjects, url) => `🔄 A new version of the bot is available:\n${subjects.map((x) => `• ${x}`).join('\n')}\n\nUpdating pulls the code from ${url || 'the repository'}; your reels, settings and history stay as they are. Nothing is installed without your «Update».`,
    updateYes: '⬆️ Update',
    updateNo: 'Not now',
    updateLater: 'I will update as soon as the current task is done.',
    upToDate: '✅ The bot is up to date.',
    applying: '⬆️ A new version is already downloaded — restarting into it.',
    newCode: 'restarted on the new version',
    updateCheckFailed: (e) => `⚠️ Could not check for updates: ${e}`,
    backedUp: (dir) => `your edits to the bot's files are saved in ${dir}`,
    ideasPrompt: 'A batch of reel ideas: section "1. Ideas" in REELS.md.',
    morePrompt: '(tapped «🎲 More ideas»: pitch a fresh batch of 4 NEW ideas per «1. Ideas» in REELS.md — none of the ones already shown; those stay in ideas.md. Keyboard: only the new ones, via --ideas.)',
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
  stopRenders();
  if (current?.handle) {
    current.handle.kill();
    if (state.pending) state.note = 'The bot restarted while you were working on the message below. Check what is already done on disk, then finish it.';
    saveState(state);
  }
  rmSync(PID_FILE, {force: true});
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const tg = telegram(env.token);

// A crash of the bot itself is reported too; the service manager then restarts it.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, async (e) => {
    console.error(ev, e);
    const text = `⚠️ ${LANG === 'en' ? 'The bot crashed and restarts' : 'Бот упал и перезапускается'}: ${String(e?.message ?? e).slice(0, 500)}`;
    await Promise.race([state.chatId ? tg.sendText(state.chatId, text, {silent: true}) : null, new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
    process.exit(1);
  });
}
const state = loadState();
const STATUS_FILE = join(DATA, 'status.txt');
const SENT_FILE = join(DATA, 'sent.txt');
const KEYS_FILE = join(DATA, 'keyboard.json');
const queue = [];
let current = null; // {handle, statusId, startedAt, activity, lastText, sentMark, reason}

if (await applyProfile(tg, env.token, state, LANG).catch((e) => console.error('profile', e.message))) saveState(state);

// ---------- progress line ----------

const mtime = (f) => (existsSync(f) ? statSync(f).mtimeMs : 0);

// A stale reply keyboard goes as soon as work moves on; a small «⌛» message carries
// the removal (it can't ride on the progress message, which has inline buttons). It stays
// until a later message takes over the keyboard: deleting it right away brings the old
// keyboard back in Telegram clients, which show the last keyboard still in the chat.
async function clearKeyboard() {
  if (!forgetKeys()) return;
  const msg = await tg.call('sendMessage', {chat_id: state.chatId, text: '⌛', disable_notification: true, reply_markup: {remove_keyboard: true}}).catch(() => null);
  if (!msg) return;
  await dropKeyAck();
  state.keyAck = msg.message_id;
  saveState(state);
}

/** Deletes the «⌛» once a newer message carries a keyboard or its removal. */
async function dropKeyAck() {
  const id = state.keyAck;
  if (!id) return;
  delete state.keyAck;
  saveState(state);
  await tg.call('deleteMessage', {chat_id: state.chatId, message_id: id}).catch(() => {});
}

// ---------- owner ----------

async function becomeOwner({id, chatId, name}) {
  Object.assign(state, {ownerId: id, chatId, ownerName: name});
  saveState(state);
  await tg.sendText(state.chatId, T.hello);
}

// Approval written by `node bot/claim.mjs --approve` on this computer.
setInterval(() => {
  if (state.ownerId || !existsSync(CLAIM_APPROVED)) return;
  const who = JSON.parse(readFileSync(CLAIM_APPROVED, 'utf8'));
  rmSync(CLAIM_APPROVED, {force: true});
  becomeOwner(who).catch((e) => console.error('owner', e.message));
}, 2000);

// Stay awake on the charger if the owner asked; re-applied as settings change.
keepAwake(settings().keepAwake === true);
setInterval(() => keepAwake(settings().keepAwake === true), 30_000);

// ---------- /settings ----------

const settingsOpts = () => ({lang: LANG, agent: env.agent});

async function showSettings() {
  const v = settingsView(settings(), 'main', settingsOpts());
  await tg.sendText(state.chatId, v.text, {silent: true, reply_markup: v.reply_markup});
}

async function editSettings(messageId, which) {
  const v = settingsView(settings(), which, settingsOpts());
  const {toHtml} = await import('./format.mjs');
  await tg.call('editMessageText', {chat_id: state.chatId, message_id: messageId, text: toHtml(v.text), parse_mode: 'HTML', reply_markup: v.reply_markup}).catch(() => {});
}

// A time chosen after today's slot has passed starts tomorrow, not right away.
function scheduleFrom(time) {
  if (time && new Date().toTimeString().slice(0, 5) >= time) {
    state.lastIdeasDay = new Date().toLocaleDateString('sv');
    saveState(state);
  }
}

async function onSettings(q) {
  const r = onSettingsButton(q.data, settings());
  const id = q.message.message_id;
  state.awaitingTime = r.awaitTime ? id : undefined;
  saveState(state);
  if (r.close) return tg.call('editMessageReplyMarkup', {chat_id: state.chatId, message_id: id, reply_markup: {inline_keyboard: []}}).catch(() => {});
  if (Object.keys(r.patch).length) writeSettings(r.patch);
  if (r.scheduled) scheduleFrom(r.scheduled);
  await editSettings(id, r.show);
}

// A typed time while the time picker is open.
async function onSettingsTime(text) {
  const time = parseTime(text);
  if (!time) return tg.sendText(state.chatId, badTime(LANG), {silent: true});
  writeSettings({ideasAt: time});
  scheduleFrom(time);
  const id = state.awaitingTime;
  delete state.awaitingTime;
  saveState(state);
  await editSettings(id, 'main');
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
  if (!reels.length) return tg.sendText(state.chatId, T.noUnfinished, {silent: true});
  await tg.call('sendMessage', {
    chat_id: state.chatId,
    disable_notification: true,
    text: T.unfinished,
    reply_markup: {inline_keyboard: reels.map((r) => [{text: `${r.title}${r.version ? ` · ${r.version}` : ''}`.slice(0, 60), callback_data: `u:${r.folder}`.slice(0, 64)}])},
  });
}

// Progress line: one line — whatever is newest, the agent's own stage or what it is
// doing right now — plus the queue when there is one.
function statusText() {
  const stage = existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, 'utf8').trim() : '';
  const stageAt = mtime(STATUS_FILE);
  const now = stage && stageAt >= (current.activityAt ?? 0) ? stage : activityLabel(current.activity, LANG);
  return queue.length ? `${now}\n${T.queued(queue.length)}` : now;
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
  const msg = await tg.call('sendMessage', {chat_id: state.chatId, text, disable_notification: true, reply_markup: controls()}, {retries: 0});
  current.statusId = state.statusId = msg.message_id;
  current.lastText = text;
  saveState(state);
}

async function deleteStatus(id) {
  await tg.call('deleteMessage', {chat_id: state.chatId, message_id: id}, {retries: 1}).catch(() => {});
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
  await tg.call('editMessageText', {chat_id: state.chatId, message_id: current.statusId, text, reply_markup: controls()}, {retries: 0}).catch(() => {});
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
async function runWithStatus(prompt, firstLine, {quiet = false} = {}) {
  rmSync(STATUS_FILE, {force: true});
  taskAwake(true);
  current = {startedAt: Date.now(), activity: 'think', sentMark: mtime(SENT_FILE), quiet, firstLine};
  // The progress line is a nicety: a failed or slow send must never hold up the task.
  // Quiet runs (background housekeeping) show it only once the owner writes meanwhile.
  if (!quiet) await postStatus(firstLine).catch((e) => console.error('status', e));
  let res;
  try {
    const handle = runAgent({
      agent: env.agent,
      bin: env.agentBin,
      model: env.agentModel,
      sessionId: state.sessionId,
      // The owner's global agent setup (plugins, hooks, MCP servers) only on an explicit
      // `agentGlobalSettings: true` in studio/settings.json, as /settings and SECURITY.md say.
      isolated: settings().agentGlobalSettings !== true,
      prompt: state.sessionId ? prompt : openingPrompt(prompt),
      onCall: (call) => {
        const key = classify(call);
        if (key && key !== current.activity) Object.assign(current, {activity: key, activityAt: Date.now()});
      },
    });
    current.handle = handle;
    console.log(`turn started${quiet ? ' (housekeeping)' : ''}`);
    res = await handle.done;
    console.log(`turn done in ${Math.round((Date.now() - current.startedAt) / 1000)} s${res.error ? `, error ${res.code ?? ''}` : ''}${res.cancelled ? ', cancelled' : ''}`);
    res.reason = current.reason;
    res.startedAt = current.startedAt;
  } finally {
    await Promise.race([refreshing, new Promise((r) => setTimeout(r, 5000))]);
    await dropStatus().catch(() => {});
    current = null;
    if (!queue.length) taskAwake(false);
  }

  await trackUsage(res);
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

// Limits and spend: logged per turn, attributed to the reel worked on; warnings only
// when a window crosses 80% (quiet) or 95% (with sound).
async function trackUsage(res) {
  try {
    const limits = res.limits ?? (env.agent === 'codex' ? codexLimits(res.sessionId) : null);
    const reel = touchedReel(res.startedAt);
    recordTurn({startedAt: res.startedAt, reel, before: state.limits, after: limits, cost: res.cost, tokens: res.tokens});
    if (reel) state.lastReel = reel;
    if (limits) state.limits = {...state.limits, ...limits};
    state.warned ??= {};
    for (const w of limitWarnings(state.limits, state.warned, LANG)) await tg.sendText(state.chatId, w.text, {silent: !w.loud});
    saveState(state);
  } catch (e) {
    console.error('usage', e.message);
  }
}

async function rotate({quiet = false} = {}) {
  rmSync(HANDOFF_FILE, {force: true});
  const res = await runWithStatus(HANDOFF_PROMPT, T.saving, {quiet});
  // A failed handoff still rotates: the files remain the memory.
  if (res.reason === 'stop') return false;
  for (const k of ['sessionId', 'sessionTurns', 'sessionContext', 'rotate']) delete state[k];
  saveState(state);
  return true;
}

async function runTurn(prompt, retried = false) {
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
  if (res.cancelled && (res.reason === 'stalled' || res.reason === 'overtime')) {
    return onAgentError({...res, error: true, forcedKind: res.reason}, prompt, true);
  }
  // A menu opened during a failed or stopped turn is not shown.
  if (res.error || res.cancelled) await postPending(tg, state.chatId, {drop: true});
  if (res.error && !res.cancelled) return onAgentError(res, prompt, retried);
  if (res.cancelled) {
    // Tell the next turn why the previous one ended mid-way.
    if (res.reason === 'stop') state.note = 'Your previous turn was stopped by the owner. Do not resume it unless asked.';
    if (res.reason === 'now') state.note = 'The owner interrupted your previous turn with the message below. Check what is already done on disk, then continue with it in mind.';
    saveState(state);
    return;
  }
  // The reel was accepted: one quiet line on what it took.
  if (state.acceptedPending) {
    delete state.acceptedPending;
    saveState(state);
    const line = state.lastReel && acceptedText(state.lastReel, LANG);
    if (line) await tg.sendText(state.chatId, line, {silent: true}).catch(() => {});
  }
  // A trailing `⌨️ A | B` line becomes the owner's keyboard of next options.
  let {text: body, labels} = splitKeyLine(res.text.trim());
  // Nothing more after the agent already asked its question with a keyboard (e.g. the
  // review after a version), or when it ends with NO_REPLY.
  const askedAlready = mtime(KEYS_FILE) > res.startedAt;
  if (!labels && (askedAlready || /^NO_REPLY\.?$/i.test(body))) body = '';
  if (body || labels) {
    // Kept in an outbox until delivered, so a restart cannot swallow the answer.
    state.outbox = {text: labels ? `${body || '👇'}\n\n✍️ ${T.hint}` : body, labels};
    saveState(state);
    await flushOutbox();
  }
  // A steps menu the agent opened comes after its reply: status first, question last.
  const asked = (await postPending(tg, state.chatId)) || askedAlready || Boolean(labels);
  if (asked) await dropKeyAck();
}

// Notifications: only messages that need the owner (questions, versions, results,
// errors) make a sound; statuses and acknowledgements arrive silently.
//
// Every failure reaches the owner: a plain explanation, the raw error and its code,
// and a «Retry» button that re-sends the same message.
async function onAgentError(res, prompt, retried) {
  // A session the agent no longer knows: start a fresh one once, silently.
  if (!retried && state.sessionId && lostSession(res)) {
    for (const k of ['sessionId', 'sessionTurns', 'sessionContext']) delete state[k];
    saveState(state);
    return runTurn(prompt, true);
  }
  const e = explain(res, {lang: LANG, bin: env.agentBin || env.agent});
  console.error('agent error', e.kind, res.code, (res.text ?? '').slice(0, 300));
  if (e.kind === 'context') {
    // Too long to even write a handoff: drop the session, the files keep the memory.
    for (const k of ['sessionId', 'sessionTurns', 'sessionContext']) delete state[k];
    saveState(state);
  }
  await tg.sendText(state.chatId, e.text, {reply_markup: replyKeyboard([e.retry], {retry: prompt, retryLabel: e.retry})});
}

// Rotate a session that grew too big or too long while idle, right after a task, so
// the next message does not have to wait for the handoff.
async function rotateIfDue() {
  if (current || queue.length || !rotationDue()) return;
  // At most every 10 minutes: a stopped handoff must not start over in a loop.
  if (Date.now() - (state.rotateTriedAt ?? 0) < 10 * 60_000) return;
  state.rotateTriedAt = Date.now();
  saveState(state);
  console.log('rotating the session while idle');
  await rotate({quiet: true}).catch((e) => console.error('rotate', e));
  drain();
}
// Stale sessions too: checked hourly, so they rotate before the owner writes.
setInterval(() => rotateIfDue(), 3_600_000);

async function drain() {
  while (!current && queue.length) {
    // Everything that piled up during the last turn goes in as one message.
    let prompt = queue.splice(0).join('\n\n---\n\n');
    saveQueue();
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
  if (!current && !queue.length && state.updateApproved) applyUpdate();
  else if (!current && !queue.length) rotateIfDue();
}

// The queue survives restarts: it is mirrored into state.
function saveQueue() {
  state.queue = [...queue];
  saveState(state);
}

function enqueue(prompt) {
  clearKeyboard().catch(() => {});
  queue.push(prompt);
  saveQueue();
  // Housekeeping is running quietly: now the owner should see that the bot is busy.
  if (current?.quiet && !current.statusId) postStatus(current.firstLine).catch(() => {});
  if (!current) drain();
}

function renderRunning() {
  const dir = join(DATA, 'renders');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).filter((x) => x.endsWith('.json')).some((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8')).status === 'running';
    } catch {
      return false;
    }
  });
}

// Background renders run outside the agent's process tree; stop them explicitly.
function stopRenders() {
  const dir = join(DATA, 'renders');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const job = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (job.status !== 'running') continue;
      killTree(job.pid);
      writeFileSync(join(dir, f), JSON.stringify({...job, status: 'failed', code: 'stopped', tail: 'stopped by the owner or a bot restart'}, null, 2));
    } catch {}
  }
}

/** Stops the running turn. 'stop' drops the queue, 'now' runs it right away. */
function interrupt(reason) {
  stopRenders();
  if (reason === 'stop') {
    queue.length = 0;
    saveQueue();
  }
  if (!current) return false;
  current.reason = reason;
  current.handle?.kill();
  return true;
}

// ---------- incoming updates ----------

async function onMessage(msg) {
  // Private chats only: a bot added to a group leaves it.
  if (msg.chat.type !== 'private') {
    if (msg.chat.type !== 'channel') await tg.call('leaveChat', {chat_id: msg.chat.id}).catch(() => {});
    return;
  }
  if (!state.ownerId) {
    // No owner yet. With OWNER_CODE set, the t.me/<bot>?start=<code> link claims the
    // bot; otherwise the person becomes a request the user confirms on the computer
    // (`node bot/claim.mjs`), so no secret has to be passed around.
    if (env.ownerCode) {
      const code = msg.text?.match(/^\/start\s+(\S+)/)?.[1];
      if (code !== env.ownerCode) return tg.sendText(msg.chat.id, T.private, {silent: true});
      return becomeOwner({id: msg.from.id, chatId: msg.chat.id, name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')});
    }
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    writeFileSync(CLAIM_REQUEST, JSON.stringify({id: msg.from.id, chatId: msg.chat.id, name, username: msg.from.username}));
    return tg.sendText(msg.chat.id, T.confirmOnComputer);
  }
  if (msg.from.id !== state.ownerId) return tg.sendText(msg.chat.id, T.private, {silent: true}).catch(() => {});

  const cmd = msg.text?.match(/^\/(\w+)/)?.[1];
  if (cmd === 'start') return tg.sendText(state.chatId, T.hello, {silent: true});
  if (cmd === 'stop') return tg.sendText(state.chatId, interrupt('stop') ? T.cancelled : T.idle, {silent: true});
  if (cmd === 'new') {
    // The handoff runs lazily, right before the next turn.
    state.rotate = true;
    saveState(state);
    return tg.sendText(state.chatId, T.fresh, {silent: true});
  }
  if (cmd === 'ideas') return enqueue(T.ideasPrompt);
  if (cmd === 'unfinished') return showUnfinished();
  if (cmd === 'settings') return showSettings();
  if (cmd === 'update') return checkUpdates(true);
  if (cmd === 'usage') return tg.sendText(state.chatId, usageText(state.limits, LANG), {silent: true});
  if (state.awaitingTime && msg.text && !cmd) return onSettingsTime(msg.text);

  // 👀 = seen: while the agent is busy (it will be queued) or while a voice note is transcribed.
  if (current || msg.voice || msg.video_note) {
    await tg.call('setMessageReaction', {chat_id: state.chatId, message_id: msg.message_id, reaction: [{type: 'emoji', emoji: '👀'}]}).catch(() => {});
  }
  const onInstall = () => tg.sendText(state.chatId, T.sttSetup, {silent: true}).catch(() => {});
  const voice = Boolean(msg.voice || msg.video_note);
  const got = Date.now();
  // Speech-to-text takes a few seconds: say so instead of leaving only 👀. The voice note
  // answers whatever was asked, so this message also takes the keyboard away at once.
  const listening = voice
    ? await tg.call('sendMessage', {chat_id: state.chatId, text: T.listening, disable_notification: true, reply_markup: {remove_keyboard: true}}, {retries: 0}).catch(() => null)
    : null;
  if (listening) forgetKeys();
  const {prompt, said, problems} = await describe(tg, msg, {transcribe, lang: LANG, onInstall});
  // It then shows what was heard and stays: the chat keeps the answer readable, and
  // deleting it would bring the old keyboard back.
  if (listening) {
    const heard = said ? `🎙 «${said.length > 500 ? `${said.slice(0, 500)}…` : said}»` : null;
    if (heard) tg.call('editMessageText', {chat_id: state.chatId, message_id: listening.message_id, text: heard}, {retries: 1}).catch(() => {});
    else tg.call('deleteMessage', {chat_id: state.chatId, message_id: listening.message_id}, {retries: 1}).catch(() => {});
  }
  console.log(`message ${msg.message_id}${voice ? `, voice transcribed in ${((Date.now() - got) / 1000).toFixed(1)} s` : ''}`);
  for (const p of problems) {
    const text = p.kind === 'tooBig' ? T.tooBig(p.what, p.size) : p.kind === 'stt' ? T.sttFailed : T.downloadFailed(p.what, p.error);
    await tg.sendText(state.chatId, text).catch(() => {});
  }
  if (prompt) remember(prompt);

  // A setup step is a question with a reply keyboard: the tap or a typed answer goes to it.
  const step = said && !msg.reply_to_message && activeMenu();
  if (step?.mode === 'steps') {
    const result = await onMenuText(tg, state.chatId, step, said);
    if (result) enqueue(result);
    return;
  }
  // A tap on a reply-keyboard button arrives as plain text with its label.
  const keys = currentKeys();
  if (msg.text && keys?.labels?.includes(msg.text)) {
    if (keys.retry && msg.text === keys.retryLabel) return enqueue(keys.retry);
    if (keys.more && msg.text === keys.more) return enqueue(T.morePrompt);
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
  if (prompt) batch(prompt);
}

// Albums and quick follow-ups arrive as separate messages; wait a moment and hand
// them to the agent together.
let batchParts = [];
let batchTimer = null;
function batch(prompt) {
  batchParts.push(prompt);
  // On disk too: Telegram will not resend a message the bot already received.
  state.batch = [...batchParts];
  saveState(state);
  clearTimeout(batchTimer);
  batchTimer = setTimeout(flushBatch, 2000);
}

function flushBatch() {
  const all = batchParts.splice(0);
  delete state.batch;
  if (all.length) enqueue(all.length > 1 ? all.map((p, i) => `[message ${i + 1}]\n${p}`).join('\n\n') : all[0]);
  else saveState(state);
}

async function onButton(q) {
  await tg.call('answerCallbackQuery', {callback_query_id: q.id}).catch(() => {});
  if (q.from.id !== state.ownerId || q.data === 'ctl:done') return;
  if (q.data.startsWith('set:')) return onSettings(q);
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
  if (q.data === 'upd:yes' || q.data === 'upd:no') {
    const label = q.data === 'upd:yes' ? T.updateYes : T.updateNo;
    await tg.call('editMessageReplyMarkup', {chat_id: state.chatId, message_id: q.message.message_id, reply_markup: {inline_keyboard: [[{text: `✅ ${label}`, callback_data: 'ctl:done'}]]}}).catch(() => {});
    if (q.data === 'upd:yes') {
      if (current || queue.length) await tg.sendText(state.chatId, T.updateLater, {silent: true});
      await applyUpdate();
    }
    return;
  }
  if (q.data === 'ctl:stop' || q.data === 'ctl:now') {
    interrupt(q.data.slice(4));
    if (q.data === 'ctl:stop') await tg.sendText(state.chatId, T.cancelled, {silent: true});
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
  if (/Принять|Accept/.test(label)) {
    state.acceptedPending = true;
    saveState(state);
  }
  const about = (msg?.caption ?? msg?.text ?? '').slice(0, 1500);
  enqueue(`(pressed button "${label}" under: "${about}")`);
}

// ---------- daily ideas ----------

setInterval(() => {
  const s = settings();
  const {ideasAt = '10:00'} = s;
  const now = new Date();
  if (!ideasAt || !state.ownerId || !ideasDay(s, now)) return;
  const day = now.toLocaleDateString('sv');
  const hhmm = now.toTimeString().slice(0, 5);
  if (hhmm >= ideasAt && state.lastIdeasDay !== day) {
    state.lastIdeasDay = day;
    saveState(state);
    enqueue(T.ideasPrompt);
  }
}, 60_000);

// ---------- updates ----------
//
// Every 6 hours (and shortly after start) the bot fetches its repo. New commits are
// never applied on their own: the owner gets the list of changes and an «Update»
// button. A failed fast-forward (local edits, diverged history) goes to the agent.

const BOOT_HEAD = await head();
const MERGE_PROMPT = (err) => `The owner approved updating the bot itself, but \`git pull --ff-only\` failed:\n${err}\nMerge the upstream changes, keeping the owner's local changes; run \`node --check\` on every file in bot/. Do not touch studio/ or data/. Then tell the owner in one line what is new.`;

async function announceUpdate() {
  if (!state.updateNote || !state.chatId) return;
  await tg.sendText(state.chatId, T.updated(state.updateNote), {silent: true}).catch(() => {});
  delete state.updateNote;
  saveState(state);
}

function restart() {
  console.log('restarting');
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

// `updateChecks: false` stops even asking; `autoUpdate` is the old name of the key.
const updatesOff = () => settings().updateChecks === false || settings().autoUpdate === false;

// `asked`: the owner ran /update — check even if checks are off, show the offer again
// and say so when there is nothing new.
async function checkUpdates(asked = false) {
  if ((updatesOff() && !asked) || !state.chatId) return;
  try {
    const subjects = await pendingUpdates();
    const upstream = await upstreamHead();
    // Newer code is already on disk (an approved merge, a manual pull): switch to it,
    // and say so after the restart.
    if (!subjects.length && !current && !queue.length && (await botChangedSince(BOOT_HEAD))) {
      if (asked) await tg.sendText(state.chatId, T.applying, {silent: true}).catch(() => {});
      state.updateNote = [T.newCode];
      saveState(state);
      return restart();
    }
    if (asked && !subjects.length) await tg.sendText(state.chatId, T.upToDate, {silent: true});
    if (subjects.length && upstream && (asked || state.updateOffered !== upstream)) {
      state.updateOffered = upstream;
      saveState(state);
      await tg.sendText(state.chatId, T.updateAvailable(subjects.slice(0, 10), await remoteUrl()), {
        reply_markup: {inline_keyboard: [[{text: T.updateYes, callback_data: 'upd:yes'}, {text: T.updateNo, callback_data: 'upd:no'}]]},
      });
    }
  } catch (e) {
    console.error('update', e.message.split('\n')[0]);
    if (asked) await tg.sendText(state.chatId, T.updateCheckFailed(e.message.split('\n')[0]), {silent: true});
  }
}

// Runs after the owner's «Update»; waits for the current task to finish first.
async function applyUpdate() {
  if (current || queue.length) {
    state.updateApproved = true;
    return saveState(state);
  }
  delete state.updateApproved;
  saveState(state);
  try {
    const subjects = await pendingUpdates();
    if (!subjects.length) return;
    const changed = await pullUpdates();
    // Edited bot files replaced by an archive update were backed up; say where.
    state.updateNote = [...subjects.slice(0, 10), ...(updates.lastBackup ? [T.backedUp(updates.lastBackup)] : [])];
    // The running session read the old workflow; the next turn starts fresh from a handoff.
    if (changed.some((f) => /^(REELS|AGENTS)\.md$/.test(f))) state.rotate = true;
    saveState(state);
    if (await botChangedSince(BOOT_HEAD)) return restart();
    await announceUpdate();
  } catch (e) {
    enqueue(MERGE_PROMPT(e.message.split('\n').slice(0, 5).join('\n')));
  }
}

setTimeout(checkUpdates, 60_000);
setInterval(checkUpdates, 6 * 3_600_000);

async function flushOutbox() {
  const o = state.outbox;
  if (!o || !state.chatId) return;
  await tg.call('sendChatAction', {chat_id: state.chatId, action: 'typing'}).catch(() => {});
  // A reply without options still takes over the keyboard removal from the «⌛».
  const markup = o.labels ? replyKeyboard(o.labels, {placeholder: T.hint}) : state.keyAck ? {remove_keyboard: true} : undefined;
  await tg.sendText(state.chatId, o.text, markup ? {reply_markup: markup} : {});
  if (markup) await dropKeyAck();
  delete state.outbox;
  saveState(state);
}

// ---------- watchdogs ----------
//
// After sleep or a network change things can stall in ways a timeout alone won't catch.
// Anything stuck for minutes restarts the bot; the unfinished message is kept in
// state.pending and redone after the restart.

let lastPoll = Date.now();
let lastTick = Date.now();
// Thresholds can be shortened for tests.
const STALL_MS = Number(process.env.REELS_STALL_MS || 15 * 60_000);
const WATCH_MS = Number(process.env.REELS_WATCH_MS || 30_000);
setInterval(() => {
  const now = Date.now();
  const gap = now - lastTick;
  lastTick = now;
  if (gap > WATCH_MS + 60_000) {
    // Timers stood still during sleep: give polling and a starting task a fresh chance.
    console.log(`woke up after ${Math.round(gap / 60_000)} min of sleep`);
    lastPoll = now;
    if (current && !current.handle) current.startedAt = now;
    return;
  }
  // A running agent that went silent (and is not waiting on a render), or a task that
  // runs far too long: stop it and tell the owner, with a Retry button.
  if (current?.handle && !current.reason) {
    const silentFor = now - current.handle.lastActivity();
    if (silentFor > STALL_MS && !renderRunning()) {
      console.error('watchdog: agent silent for 15 min, stopping it');
      current.reason = 'stalled';
      stopRenders();
      current.handle.kill();
    } else if (now - current.startedAt > 120 * 60_000) {
      console.error('watchdog: task over 2 hours, stopping it');
      current.reason = 'overtime';
      stopRenders();
      current.handle.kill();
    }
  }
  if (current && !current.handle && now - current.startedAt > 3 * 60_000) {
    console.error('watchdog: a task never reached the agent for 3 min, restarting');
    return restart();
  }
  if (now - lastPoll > 5 * 60_000) {
    console.error('watchdog: no answer from Telegram for 5 min, restarting');
    return restart();
  }
}, WATCH_MS);

// ---------- long polling ----------

console.log(`reels-bot up: agent=${env.agent}, owner=${state.ownerId ?? 'none yet'}`);
if (state.statusId) await deleteStatus(state.statusId);
await announceUpdate();
await flushOutbox().catch((e) => console.error('outbox', e));
// Restore work interrupted by a restart: the message in progress first, then the queue.
const restored = [state.pending, ...(state.queue ?? [])].filter(Boolean);
const unbatched = state.batch ?? [];
delete state.pending;
state.queue = [];
for (const prompt of restored) enqueue(prompt);
for (const prompt of unbatched) batch(prompt);
let offset = state.offset ?? 0;
let handling = Promise.resolve();
let conflicts = 0;
for (;;) {
  try {
    const updates = await tg.call('getUpdates', {offset, timeout: 50, allowed_updates: ['message', 'edited_message', 'callback_query']});
    lastPoll = Date.now();
    conflicts = 0;
    for (const u of updates) {
      offset = u.update_id + 1;
      state.offset = offset;
      saveState(state);
      // Handled in order but off the polling loop: a long voice transcription must not
      // stop the bot from hearing the next message (or trip the watchdog).
      const m = u.message ?? u.edited_message;
      if (m) handling = handling.then(() => onMessage(m)).catch((e) => console.error('message', e));
      if (u.callback_query) handling = handling.then(() => onButton(u.callback_query)).catch((e) => console.error('button', e));
    }
  } catch (e) {
    console.error('poll', e);
    // 409: another copy of the bot polls with the same token (another computer?).
    if (e.status === 409 && ++conflicts === 6 && state.chatId) {
      tg.sendText(state.chatId, T.conflict).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
