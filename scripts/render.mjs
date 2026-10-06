#!/usr/bin/env node
// Renders a reel project and mirrors the percentage into the bot's progress line.
// Usage: node scripts/render.mjs <project-dir> <out.mp4> [label] [-- extra remotion args]
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dash = process.argv.indexOf('--');
const extra = dash > 0 ? process.argv.slice(dash + 1) : [];
const [projectArg, outArg, label = '🎬 Рендер'] = process.argv.slice(2, dash > 0 ? dash : undefined);
if (!projectArg || !outArg) {
  console.error('Usage: node scripts/render.mjs <project-dir> <out.mp4> [label]');
  process.exit(1);
}
const project = resolve(projectArg);
const out = resolve(outArg);
mkdirSync(dirname(out), {recursive: true});

// Same as `npx remotion render`, without depending on npx or a shell.
const cli = join(project, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
const child = spawn(process.execPath, [cli, 'render', 'src/index.ts', 'Reel', out, '--audio-bitrate=256k', ...extra], {
  cwd: project,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let lastStep = -1;
const onData = (chunk) => {
  process.stdout.write(chunk);
  // Remotion prints progress like "Rendered 120/1200".
  for (const [, done, total] of String(chunk).matchAll(/(\d+)\/(\d+)/g)) {
    const pct = Math.floor((Number(done) * 100) / Number(total));
    if (Math.floor(pct / 10) !== lastStep) {
      lastStep = Math.floor(pct / 10);
      const data = process.env.REELS_DATA || join(ROOT, 'data');
      mkdirSync(data, {recursive: true});
      writeFileSync(join(data, 'status.txt'), `${label} · ${pct}%`);
    }
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('close', (code) => {
  const ok = code === 0 && existsSync(out) && statSync(out).size > 0;
  if (!ok) console.error(`render failed (exit ${code})`);
  process.exit(ok ? 0 : 1);
});
