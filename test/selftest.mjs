#!/usr/bin/env node
// End-to-end self-check on this machine (also run in CI on macOS, Linux and Windows):
// new reel → render → loudness, menus, formatting, activity line, agent adapter with
// stdin prompt and cancel, voice transcription. Uses temp folders, never data/ or studio/.
//   npm test                 everything
//   npm test -- --quick      skip rendering and speech-to-text
import {execFileSync, spawnSync} from 'node:child_process';
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

function ffmpeg(args) {
  const system = spawnSync('ffmpeg', ['-version'], {stdio: 'ignore'}).status === 0;
  const remotion = join(ROOT, 'template', 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
  const ffArgs = ['-loglevel', 'error', ...args];
  const [cmd, full] = system ? ['ffmpeg', ffArgs] : [process.execPath, [remotion, 'ffmpeg', ...ffArgs]];
  const r = spawnSync(cmd, full, {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(r.stderr);
}
