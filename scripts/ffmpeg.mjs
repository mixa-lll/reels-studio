#!/usr/bin/env node
// ffmpeg / ffprobe without installing them: the system binary if present, otherwise
// the one bundled with Remotion. Usage: node scripts/ffmpeg.mjs [ffprobe] <args…>
import {spawnSync} from 'node:child_process';
import {ffCommand} from '../bot/media.mjs';

const args = process.argv.slice(2);
const bin = args[0] === 'ffprobe' ? 'ffprobe' : 'ffmpeg';
if (bin === 'ffprobe') args.shift();
const [cmd, full] = ffCommand(bin, args);
process.exit(spawnSync(cmd, full, {stdio: 'inherit', windowsHide: true}).status ?? 1);
