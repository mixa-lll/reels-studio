#!/usr/bin/env node
// End-to-end self-check on this machine (also run in CI on macOS, Linux and Windows):
// new reel → render → loudness, menus, formatting, activity line, agent adapter with
// stdin prompt and cancel, voice transcription. Uses temp folders, never data/ or studio/.
//   npm test                 everything
//   npm test -- --quick      skip rendering and speech-to-text
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'reels-selftest-'));
process.env.REELS_DATA = join(TMP, 'data');
process.env.REELS_STUDIO = join(TMP, 'studio');
const quick = process.argv.includes('--quick');
const win = process.platform === 'win32';

let failed = 0;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`✘ ${name}\n  ${String(e.stack ?? e).split('\n').slice(0, 6).join('\n  ')}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const node = (args, opts = {}) => execFileSync(process.execPath, args, {cwd: ROOT, encoding: 'utf8', env: process.env, ...opts});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Imported after the env overrides, so state goes to TMP.
const {toHtml, chunks} = await import('../bot/format.mjs');
const {classify} = await import('../bot/activity.mjs');
const menu = await import('../bot/menu.mjs');
const {runAgent} = await import('../bot/agents.mjs');

await check('formatting: Markdown → Telegram HTML', () => {
  const html = toHtml('**bold** and `code <x>`\n- item\n[link](https://e.org)');
  assert(html.includes('<b>bold</b>') && html.includes('<code>code &lt;x&gt;</code>') && html.includes('• item') && html.includes('<a href="https://e.org">link</a>'), html);
  assert(chunks('a'.repeat(5000) + '\n\n' + 'b'.repeat(10)).every((c) => c.length <= 3500), 'chunk too long');
});

await check('keyboard line in agent replies', async () => {
  const {splitKeyLine} = await import('../bot/keys.mjs');
  const r = splitKeyLine('Ideas above.\n\n⌨️ 🚧 Alpha | 🔒 Lock | 🔄 More');
  assert(r.text === 'Ideas above.' && r.labels.length === 3 && r.labels[2] === '🔄 More', JSON.stringify(r));
  assert(splitKeyLine('no keys').labels === null, 'false positive');
});

await check('activity line: Windows and POSIX paths', () => {
  assert(classify({tool: 'write', path: 'C:\\r\\studio\\reels\\01-x\\project\\src\\Reel.tsx'}) === 'scenes', 'win path');
  assert(classify({tool: 'write', path: '/r/studio/reels/01-x/project/src/Reel.tsx'}) === 'scenes', 'posix path');
  assert(classify({tool: 'run', command: 'node bot\\send.mjs --status "x"'}) === null, 'status call');
});

await check('menus: steps with own answer, settings with apply', async () => {
  const log = [];
  let id = 1;
  const tg = {call: async (m) => (log.push(m), {message_id: id++}), sendFile: async () => log.push('file')};
  const steps = {mode: 'steps', title: 'T', sections: [
    {title: 'Look', options: [{label: 'A', value: 'a'}, {label: 'B', value: 'b'}]},
    {title: 'Music', options: [{label: 'M', value: 'm'}]},
    {title: 'Pace', options: [{label: 'Fast', value: 'f'}]},
  ]};
  const s = menu.createMenu(steps);
  await menu.post(tg, 1, menu.loadMenu(s));
  await menu.onMenuButton(tg, 1, `m:${s}:o0.1`);
  await menu.onMenuText(tg, 1, menu.activeMenu(), 'my own track');
  const done = await menu.onMenuButton(tg, 1, `m:${s}:auto`);
  assert(done.includes('"B"') && done.includes('my own track') && done.includes('Decide yourself: Pace'), done);
  const tune = menu.createMenu({mode: 'menu', title: 'v1', sections: [{title: 'Hook', current: 'q', options: [{label: 'Q', value: 'q'}, {label: 'F', value: 'f'}]}]});
  await menu.onMenuButton(tg, 1, `m:${tune}:open`);
  const open = readFileSync(join(process.env.REELS_DATA, 'menus', 'active'), 'utf8');
  await menu.onMenuButton(tg, 1, `m:${open}:o0.1`);
  const applied = await menu.onMenuButton(tg, 1, `m:${open}:apply`);
  assert(applied.includes('"F"'), applied);
});

await check('settings menu: idea time, days, off, typed time', async () => {
  const {view, onSettingsButton, parseTime, ideasDay} = await import('../bot/prefs.mjs');
  let s = {ideasAt: '10:00'};
  const main = view(s, 'main', {lang: 'en', agent: 'claude'});
  assert(main.text.includes('every day at 10:00') && main.reply_markup.inline_keyboard.length >= 4, main.text);
  const apply = (data) => {
    const r = onSettingsButton(data, s);
    s = {...s, ...r.patch};
    return r;
  };
  assert(apply('set:time').awaitTime && apply('set:at:09:00').show === 'main' && s.ideasAt === '09:00', JSON.stringify(s));
  assert(apply('set:days').show === 'days' && apply('set:days:weekdays') && s.ideasDays === 'weekdays', JSON.stringify(s));
  apply('set:ideas:off');
  assert(s.ideasAt === '' && view(s, 'main', {lang: 'en'}).text.includes('Ideas: off'), JSON.stringify(s));
  apply('set:at:09:00');
  assert(s.ideasAt === '09:00', 'turned back on');
  assert(parseTime('9:30') === '09:30' && parseTime('930') === '09:30' && parseTime('18') === '18:00' && parseTime('25:00') === null, 'parseTime');
  assert(!ideasDay({ideasDays: 'weekdays'}, new Date('2026-10-04T12:00')) && ideasDay({ideasDays: 'weekdays'}, new Date('2026-10-05T12:00')), 'weekdays');
});

await check('owner confirmed on the computer, no secret', () => {
  const req = join(process.env.REELS_DATA, 'owner-request.json');
  const none = spawnSync(process.execPath, ['bot/claim.mjs', '--wait', '1'], {cwd: ROOT, encoding: 'utf8', env: process.env});
  assert(none.status === 2, none.stdout);
  writeFileSync(req, JSON.stringify({id: 7, chatId: 7, name: 'Ann', username: 'ann'}));
  assert(node(['bot/claim.mjs', '--wait', '5']).includes('Ann (@ann)'), 'who');
  node(['bot/claim.mjs', '--approve']);
  assert(JSON.parse(readFileSync(join(process.env.REELS_DATA, 'owner-approved.json'), 'utf8')).id === 7 && !existsSync(req), 'approved');
});

await check('keep awake on the charger: turns on and off without errors', async () => {
  const {keepAwake} = await import('../bot/awake.mjs');
  keepAwake(true);
  await new Promise((r) => setTimeout(r, 1500));
  keepAwake(true);
  keepAwake(false);
});

await check('limits: per-reel share, warnings at 80% and 95% once', async () => {
  const {recordTurn, reelSpend, acceptedText, limitWarnings, usageText} = await import('../bot/usage.mjs');
  const W = Date.now() + 86400e3;
  recordTurn({startedAt: 0, reel: '01-x', before: {week: {pct: 40, resetsAt: W}}, after: {week: {pct: 44, resetsAt: W}}, cost: 1});
  recordTurn({startedAt: 0, reel: '01-x', before: {week: {pct: 44, resetsAt: W}}, after: {week: {pct: 47, resetsAt: W}}, cost: 1});
  assert(reelSpend('01-x').week === 7 && reelSpend('01-x').turns === 2, JSON.stringify(reelSpend('01-x')));
  assert(acceptedText('01-x', 'en').includes('7%'), acceptedText('01-x', 'en'));
  const warned = {};
  assert(limitWarnings({week: {pct: 81, resetsAt: W}}, warned, 'en').length === 1, '80% once');
  assert(limitWarnings({week: {pct: 85, resetsAt: W}}, warned, 'en').length === 0, 'no repeat');
  assert(limitWarnings({week: {pct: 95, resetsAt: W}}, warned, 'en')[0]?.loud, '95% loud');
  assert(usageText({week: {pct: 47, resetsAt: W}}, 'en').includes('47%'), 'usage text');
});

await check('agent adapter: stdin prompt, session, activity', async () => {
  const bin = fakeAgentBin();
  const calls = [];
  const r = await runAgent({agent: 'claude', bin, prompt: 'hello\nsecond line "quoted" & <x>', onCall: (c) => calls.push(c)}).done;
  assert(r.text === 'echo: hello\nsecond line "quoted" & <x>', JSON.stringify(r));
  assert(r.sessionId === 'fake-session' && r.context === 100 && calls[0]?.tool === 'run', JSON.stringify({r, calls}));
});

await check('agent adapter: cancel stops the agent and its children', async () => {
  const handle = runAgent({agent: 'claude', bin: fakeAgentBin(), prompt: 'sleep'});
  let child;
  const deadline = Date.now() + 15000;
  // The fake agent reports its child's pid on stderr; give it a moment to start.
  await new Promise((r) => setTimeout(r, 3000));
  handle.kill();
  const r = await handle.done;
  assert(r.cancelled, JSON.stringify(r));
  const pids = execFileSync(win ? 'tasklist' : 'ps', win ? ['/fo', 'csv', '/nh'] : ['-A', '-o', 'pid=,command='], {encoding: 'utf8'});
  child = pids.split('\n').find((l) => l.includes('setTimeout(() => {}, 120000)'));
  while (child && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 500));
    child = execFileSync(win ? 'tasklist' : 'ps', win ? ['/fo', 'csv', '/nh'] : ['-A', '-o', 'pid=,command='], {encoding: 'utf8'})
      .split('\n').find((l) => l.includes('setTimeout(() => {}, 120000)'));
  }
  assert(!child, `child survived: ${child}`);
});

await check('intake: forwards, hidden links, stickers, oversized files, history', async () => {
  const {describe, remember} = await import('../bot/intake.mjs');
  const tg = {download: async (id, dest) => writeFileSync(dest, 'x')};
  const opts = {transcribe: async () => 'hello', lang: 'en'};
  const fwd = await describe(tg, {message_id: 1, text: 'look here', entities: [{type: 'text_link', url: 'https://e.org/a'}], forward_origin: {type: 'channel', chat: {title: 'News', username: 'news'}, message_id: 5, date: 1700000000}}, opts);
  assert(fwd.prompt.includes('forwarded from News (t.me/news/5)') && fwd.prompt.includes('https://e.org/a'), fwd.prompt);
  const st = await describe(tg, {message_id: 2, sticker: {file_id: 's', emoji: '🔥', is_video: true, set_name: 'pack'}}, opts);
  assert(st.prompt.includes('sticker: 🔥 from set pack') && st.prompt.includes('.webm'), st.prompt);
  const big = await describe(tg, {message_id: 3, video: {file_id: 'v', file_size: 30 * 1024 * 1024}}, opts);
  assert(big.problems[0]?.kind === 'tooBig' && big.prompt.includes('too big'), JSON.stringify(big));
  const voice = await describe(tg, {message_id: 4, voice: {file_id: 'a', file_size: 10}}, opts);
  assert(voice.said === 'hello' && voice.prompt.includes('transcript'), voice.prompt);
  remember(fwd.prompt);
  assert(readFileSync(join(process.env.REELS_DATA, 'inbox', 'history.md'), 'utf8').includes('look here'), 'history');
});

await check('errors: plain-language explanations', async () => {
  const {explain, lostSession} = await import('../bot/errors.mjs');
  const kinds = [
    [{spawnError: 'ENOENT', text: 'spawn claude ENOENT'}, 'spawn'],
    [{text: 'Claude AI usage limit reached|1791300000', code: 1}, 'limit'],
    [{text: 'Invalid API key · Please run /login', code: 1}, 'login'],
    [{text: 'API Error: 529 overloaded_error', code: 1}, 'network'],
    [{text: 'Segmentation fault', code: 139}, 'unknown'],
  ].map(([r, k]) => [explain(r, {lang: 'en', bin: 'claude'}), k]);
  for (const [e, k] of kinds) assert(e.kind === k, `${k}: got ${e.kind}`);
  assert(kinds[4][0].text.includes('139') && kinds[4][0].text.includes('Segmentation fault'), 'raw error shown');
  assert(lostSession({text: 'No conversation found with session ID: x'}), 'lost session');
});

await check('end to end: owner link, reply despite a hung progress line, task survives a crash', async () => {
  const {fakeTelegram} = await import('./fake-telegram.mjs');
  const tg = await fakeTelegram();
  const data = mkdtempSync(join(tmpdir(), 'reels-e2e-'));
  const env = {
    ...process.env, TELEGRAM_BOT_TOKEN: '1:test', REELS_TELEGRAM_API: tg.url, REELS_HTTP_TIMEOUT: '1500',
    AGENT: 'claude', AGENT_BIN: fakeAgentBin(), OWNER_CODE: 'abc', BOT_LANG: 'en',
    REELS_DATA: join(data, 'data'), REELS_STUDIO: join(data, 'studio'), REELS_BOT_SUPERVISED: '1',
    REELS_STALL_MS: '6000', REELS_WATCH_MS: '1000',
  };
  const start = () => spawn(process.execPath, ['bot/bot.mjs'], {cwd: ROOT, env, stdio: 'ignore'});
  let bot = start();
  try {
    tg.message(9, '/start wrong');
    await tg.waitFor(/personal bot/);
    tg.message(5, '/start abc');
    await tg.waitFor(/I make reels/);
    // The progress line hangs forever; the agent must still run and the reply arrive.
    tg.hang((method, params) => /ctl:stop/.test(JSON.stringify(params.reply_markup ?? '')));
    tg.message(5, 'hello world');
    await tg.waitFor(/echo:[\s\S]*hello world/);
    tg.hang(null);
    // Crash in the middle of a task: after a restart the task is done anyway.
    tg.message(5, 'slow one');
    await new Promise((r) => setTimeout(r, 1200));
    bot.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    bot = start();
    await tg.waitFor(/echo:[\s\S]*slow one/, 30_000);
    // A vertical video goes out with its real size and a preview frame (not a square).
    // Async: the fake Telegram lives in this process and must keep answering.
    const code = await new Promise((r) => spawn(process.execPath, ['bot/send.mjs', '--file', join(ROOT, 'test', 'fixtures', 'vertical.mp4'), '--caption', '01 «t» · v1'], {cwd: ROOT, env, stdio: 'ignore'}).on('exit', r));
    assert(code === 0, `send.mjs exit ${code}`);
    const video = tg.sent.find((s) => s.method === 'sendVideo');
    assert(video && /name="width"\r\n\r\n1080/.test(video.raw) && /name="height"\r\n\r\n1920/.test(video.raw) && /name="thumbnail"; filename/.test(video.raw), (video?.raw ?? 'no sendVideo').slice(0, 300));
    // An agent error is explained, with a Retry button.
    tg.message(5, 'fail login');
    const err = await tg.waitFor(/not logged in/);
    assert(JSON.stringify(err.reply_markup).includes('Retry'), JSON.stringify(err.reply_markup));
    // A silent agent is stopped by the watchdog and reported.
    tg.message(5, 'hang quietly');
    await tg.waitFor(/no sign of life/, 25_000);
  } finally {
    bot.kill('SIGTERM');
    tg.close();
  }
});

if (!quick) {
  let reel;
  await check('new reel: template copied, node_modules linked', () => {
    reel = node(['scripts/new-reel.mjs', 'selftest']).trim();
    assert(existsSync(join(reel, 'project', 'src', 'Reel.tsx')), 'no project');
    assert(existsSync(join(reel, 'project', 'node_modules', 'remotion')), 'node_modules not linked');
    assert(/[\\/]01-selftest$/.test(reel), reel);
  });

  const raw = join(TMP, 'raw.mp4');
  await check('render: 1 s through scripts/render.mjs with progress', () => {
    node(['scripts/render.mjs', join(reel, 'project'), raw, '🎬 test', '--', '--frames=0-59'], {stdio: 'pipe'});
    assert(statSync(raw).size > 10_000, 'empty video');
    assert(readFileSync(join(process.env.REELS_DATA, 'status.txt'), 'utf8').startsWith('🎬 test'), 'no progress');
  });

  await check('render in the background, then wait', () => {
    const started = node(['scripts/render.mjs', join(reel, 'project'), join(TMP, 'bg.mp4'), '🎬 bg', '--background', '--', '--frames=0-29']);
    const job = started.match(/job ([a-f0-9]+)/)?.[1];
    assert(job, started);
    const r = spawnSync(process.execPath, ['scripts/render.mjs', '--wait', job, '300'], {cwd: ROOT, encoding: 'utf8', env: process.env});
    assert(r.status === 0 && statSync(join(TMP, 'bg.mp4')).size > 5000, `${r.status} ${r.stdout}${r.stderr}`);
  });

  await check('oversized video is compressed under the limit', async () => {
    const {fitForTelegram} = await import('../bot/media.mjs');
    // The 1 s render against a small limit: the same code path as a 74 MB reel against 50 MB.
    const limit = Math.floor(statSync(raw).size * 0.6);
    const fit = fitForTelegram(raw, 'video', limit);
    assert(fit.note && statSync(fit.path).size <= limit, JSON.stringify({fit, size: statSync(fit.path).size, limit}));
  });

  await check('beat grid: 120 BPM click track', () => {
    const clicks = join(TMP, 'clicks.wav');
    writeFileSync(clicks, clickTrack(120, 20));
    const out = JSON.parse(node(['scripts/beats.mjs', clicks]));
    assert(Math.abs(out.bpm - 120) < 1 && Math.abs(out.barSeconds - 2) < 0.02 && out.bars.length >= 9, JSON.stringify({bpm: out.bpm, bar: out.barSeconds}));
  });

  await check('loudness: scripts/loudnorm.mjs on a video with a tone', () => {
    const withTone = join(TMP, 'tone.mp4');
    ffmpeg(['-y', '-i', raw, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'copy', '-c:a', 'aac', '-shortest', withTone]);
    const out = node(['scripts/loudnorm.mjs', withTone, join(TMP, 'norm.mp4')]);
    const lufs = Number(out.match(/Integrated: (-?[\d.]+)/)?.[1]);
    assert(Math.abs(lufs + 15) < 1.5, out);
  });

  await check('voice: local speech-to-text', async () => {
    const {transcribe} = await import('../bot/stt.mjs');
    const wav = join(TMP, 'speech.wav');
    // No TTS on CI: Whisper must at least run end to end on a short tone without failing.
    ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', wav]);
    process.env.STT_MODEL = process.env.STT_MODEL || 'tiny';
    const text = await transcribe(wav, 'en');
    assert(text !== null, 'transcription failed (is uv installed?)');
  });
}

rmSync(TMP, {recursive: true, force: true});
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

// ---------- helpers ----------

// The fake agent as a CLI: a .cmd shim on Windows (like npm installs), a script elsewhere.
function fakeAgentBin() {
  const script = join(ROOT, 'test', 'fake-agent.mjs');
  if (win) {
    const cmd = join(TMP, 'fake-claude.cmd');
    writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const sh = join(TMP, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {mode: 0o755});
  return sh;
}

// A mono 16-bit WAV with a 30 ms 1 kHz click on every beat.
function clickTrack(bpm, seconds, rate = 22050) {
  const n = rate * seconds;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  const beat = (60 / bpm) * rate;
  for (let i = 0; i < n; i++) {
    const v = i % beat < 0.03 * rate ? Math.sin((2 * Math.PI * 1000 * i) / rate) * 0.8 : 0;
    wav.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return wav;
}

function ffmpeg(args) {
  const system = spawnSync('ffmpeg', ['-version'], {stdio: 'ignore'}).status === 0;
  const remotion = join(ROOT, 'template', 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
  const ffArgs = ['-loglevel', 'error', ...args];
  const [cmd, full] = system ? ['ffmpeg', ffArgs] : [process.execPath, [remotion, 'ffmpeg', ...ffArgs]];
  const r = spawnSync(cmd, full, {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(r.stderr);
}
