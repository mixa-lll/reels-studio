#!/usr/bin/env node
// Renders a reel project and mirrors the percentage into the bot's progress line.
//
//   node scripts/render.mjs <project> <out.mp4> [label] [-- extra remotion args]
//        render in the foreground (short reels)
//   node scripts/render.mjs <project> <out.mp4> [label] --background [-- …]
//        start in the background and print a job id at once
//   node scripts/render.mjs --wait <job> [seconds=540]
//        wait for that job, at most `seconds`; exit 0 done, 2 still running, 1 failed,
//        3 the owner wrote meanwhile (the job keeps running)
//   node scripts/render.mjs --stop <job>
//        stop that job, e.g. when the owner's new message changes the video
//
// Background jobs survive the agent's per-command time limits; the bot stops them on
// «Stop» and on restart (jobs live in data/renders/<job>.json).
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {killTree} from '../bot/agents.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.REELS_DATA || join(ROOT, 'data');
const JOBS = join(DATA, 'renders');
mkdirSync(JOBS, {recursive: true});
const jobFile = (id) => join(JOBS, `${id}.json`);
const readJob = (id) => JSON.parse(readFileSync(jobFile(id), 'utf8'));
const writeJob = (job) => writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));

const argv = process.argv.slice(2);

if (argv[0] === '--wait' || argv[0] === '--stop') {
  const id = argv[1];
  const since = Date.now();
  const until = since + Number(argv[2] ?? 540) * 1000;
  if (!id || !existsSync(jobFile(id))) {
    console.error(`no render job ${id}`);
    process.exit(1);
  }
  if (argv[0] === '--stop') {
    const job = readJob(id);
    if (job.status === 'running') {
      killTree(job.pid);
      writeJob({...job, status: 'failed', code: 'stopped', tail: 'stopped by the agent'});
    }
    console.log(`stopped render job ${id}`);
    process.exit(0);
  }
  // The bot touches this file when the owner's message joins the running task.
  const ownerWrote = join(DATA, 'owner-wrote.txt');
  for (;;) {
    const job = readJob(id);
    if (job.status === 'done') {
      console.log(`done: ${job.out}`);
      process.exit(0);
    }
    if (job.status === 'failed') {
      console.log(`failed (exit ${job.code}):\n${job.tail}`);
      process.exit(1);
    }
    if (existsSync(ownerWrote) && statSync(ownerWrote).mtimeMs > since) {
      console.log(`the owner just wrote: read their message. The render keeps running (${job.pct ?? 0}%); --wait ${id} again if it still fits, --stop ${id} if the message changes the video`);
      process.exit(3);
    }
    if (Date.now() > until) {
      console.log(`running: ${job.pct ?? 0}% — call --wait ${id} again`);
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const dash = argv.indexOf('--');
const extra = dash >= 0 ? argv.slice(dash + 1) : [];
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const background = own.includes('--background');
const jobArg = own.find((a) => a.startsWith('--job='))?.slice(6);
const [projectArg, outArg, label = '🎬 Рендер'] = own.filter((a) => !a.startsWith('--'));
if (!projectArg || !outArg) {
  console.error('Usage: node scripts/render.mjs <project-dir> <out.mp4> [label] [--background] [-- extra remotion args]');
  process.exit(1);
}
const project = resolve(projectArg);
const out = resolve(outArg);
mkdirSync(dirname(out), {recursive: true});

if (background) {
  // Re-run this script detached, as the job's own process.
  const id = randomBytes(3).toString('hex');
  const log = openSync(join(JOBS, `${id}.log`), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), project, out, label, `--job=${id}`, '--', ...extra], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: process.env,
  });
  writeJob({id, pid: child.pid, out, status: 'running', pct: 0, startedAt: Date.now()});
  child.unref();
  console.log(`started render job ${id}; wait with: node scripts/render.mjs --wait ${id}`);
  process.exit(0);
}

// Same as `npx remotion render`, without depending on npx or a shell.
const cli = join(project, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
const child = spawn(process.execPath, [cli, 'render', 'src/index.ts', 'Reel', out, '--audio-bitrate=256k', ...extra], {
  cwd: project,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let lastStep = -1;
let tail = '';
const onData = (chunk) => {
  process.stdout.write(chunk);
  tail = (tail + chunk).slice(-2000);
  // Remotion prints progress like "Rendered 120/1200".
  for (const [, done, total] of String(chunk).matchAll(/(\d+)\/(\d+)/g)) {
    const pct = Math.floor((Number(done) * 100) / Number(total));
    if (Math.floor(pct / 10) !== lastStep) {
      lastStep = Math.floor(pct / 10);
      writeFileSync(join(DATA, 'status.txt'), `${label} · ${pct}%`);
      if (jobArg) writeJob({...readJob(jobArg), pct});
    }
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('close', (code) => {
  const ok = code === 0 && existsSync(out) && statSync(out).size > 0;
  if (!ok) console.error(`render failed (exit ${code})`);
  if (jobArg) {
    const job = readJob(jobArg);
    writeJob({...job, status: ok ? 'done' : 'failed', code, pct: ok ? 100 : job.pct, tail: ok ? '' : tail.split('\n').slice(-12).join('\n')});
  }
  process.exit(ok ? 0 : 1);
});
