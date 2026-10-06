#!/usr/bin/env node
// Keeps the bot running where no service manager does it (Windows autostart):
// restarts it after a crash or a self-update, with a growing pause on fast crash loops.
import {spawn} from 'node:child_process';
import {mkdirSync, openSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'data'), {recursive: true});
const log = openSync(join(ROOT, 'data', 'bot.log'), 'a');
let pause = 2000;

function start() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [join(ROOT, 'bot', 'bot.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: {...process.env, REELS_BOT_SUPERVISED: '1'},
  });
  child.on('exit', () => {
    // A run that lasted a minute resets the back-off.
    pause = Date.now() - startedAt > 60_000 ? 2000 : Math.min(pause * 2, 60_000);
    setTimeout(start, pause);
  });
}

start();
