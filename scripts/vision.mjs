// Shared by scripts/mask.mjs and scripts/faces.mjs: the Apple Vision tool (scripts/vision.swift),
// compiled once into data/tools/ and rebuilt when the source changes; video size and rate.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DATA} from '../bot/config.mjs';
import {ffCommand} from '../bot/media.mjs';

export function visionTool() {
  if (process.platform !== 'darwin') throw new Error('needs macOS (Apple Vision): run it in the Mac studio or the Telegram bot there');
  const src = fileURLToPath(new URL('./vision.swift', import.meta.url));
  const bin = join(DATA, 'tools', 'vision');
  if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(join(DATA, 'tools'), {recursive: true});
    const c = spawnSync('swiftc', ['-O', src, '-o', bin], {stdio: 'inherit'});
    if (c.status !== 0) throw new Error('swiftc failed: install the Xcode Command Line Tools (xcode-select --install)');
  }
  return bin;
}

/** {w, h, fps, duration, rotation-applied size} of the first video stream. */
export function probe(file) {
  const [cmd, args] = ffCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,r_frame_rate:stream_side_data=rotation:format=duration', '-of', 'json', file]);
  const r = spawnSync(cmd, args, {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(`ffprobe: ${r.stderr.slice(0, 500)}`);
  const j = JSON.parse(r.stdout);
  const s = j.streams[0];
  const [a, b] = s.r_frame_rate.split('/').map(Number);
  const rot = Math.abs(Number(s.side_data_list?.find((x) => 'rotation' in x)?.rotation || 0));
  const turned = rot === 90 || rot === 270;
  return {w: turned ? s.height : s.width, h: turned ? s.width : s.height, fps: a / (b || 1), duration: Number(j.format.duration)};
}

export const ff = (bin, args) => ffCommand(bin, args);
