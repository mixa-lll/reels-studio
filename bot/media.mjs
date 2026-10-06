// Fits outgoing files into Telegram's bot limits: 50 MB per file, 10 MB per photo.
// Uses system ffmpeg/ffprobe, or the ones bundled with Remotion.
import {spawnSync} from 'node:child_process';
import {statSync} from 'node:fs';
import {join, parse} from 'node:path';
import {ROOT} from './config.mjs';

export const SEND_LIMIT = 50 * 1024 * 1024;
export const PHOTO_LIMIT = 10 * 1024 * 1024;
const TARGET = 47 * 1024 * 1024;

const REMOTION = join(ROOT, 'template', 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
const hasSystem = (bin) => spawnSync(bin, ['-version'], {stdio: 'ignore'}).status === 0;

function tool(bin, args) {
  const [cmd, full] = hasSystem(bin) ? [bin, args] : [process.execPath, [REMOTION, bin, ...args]];
  const r = spawnSync(cmd, full, {encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20});
  if (r.status !== 0) throw new Error(`${bin}: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}

const duration = (file) => Number(tool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());
const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * Returns {path, note}: the file itself if it fits, otherwise a compressed copy next
 * to it and a short note for the owner. Throws if it cannot be made to fit.
 */
export function fitForTelegram(file, kind) {
  const size = statSync(file).size;
  const limit = kind === 'photo' ? PHOTO_LIMIT : SEND_LIMIT;
  if (size <= limit) return {path: file, note: null};

  const {dir, name} = parse(file);
  if (kind === 'photo') {
    const out = join(dir, `${name}.tg.jpg`);
    tool('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', "scale='min(2560,iw)':-2", '-q:v', '3', out]);
    return {path: out, note: `${mb(size)} → ${mb(statSync(out).size)}`};
  }
  if (kind === 'video' || kind === 'document' && /\.(mp4|mov|webm|mkv)$/i.test(file)) {
    // Bitrate that fills ~47 MB for this length, leaving room for 192k audio.
    const secs = duration(file);
    const videoKbps = Math.max(300, Math.floor((TARGET * 8) / secs / 1000) - 192);
    const out = join(dir, `${name}.tg.mp4`);
    tool('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${videoKbps}k`,
      '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
    if (statSync(out).size > SEND_LIMIT) throw new Error(`still ${mb(statSync(out).size)} after compression`);
    return {path: out, note: `${mb(size)} → ${mb(statSync(out).size)}`};
  }
  if (kind === 'audio') {
    const out = join(dir, `${name}.tg.mp3`);
    tool('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-b:a', '192k', out]);
    if (statSync(out).size > SEND_LIMIT) throw new Error(`still ${mb(statSync(out).size)} after compression`);
    return {path: out, note: `${mb(size)} → ${mb(statSync(out).size)}`};
  }
  throw new Error(`${mb(size)} is over Telegram's 50 MB limit for bots`);
}
