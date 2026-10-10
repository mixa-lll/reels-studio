// Keeps the computer awake, two ways:
//   - while the agent works on a task (or renders): always, on battery too, so a task
//     never freezes half-way because the machine dozed off;
//   - while idle: only on the charger and only if the owner asked (`keepAwake` in
//     data/settings.json), so messages and morning ideas are not missed.
// No system settings change and no admin rights are needed: the bot holds an OS
// "stay awake" request that disappears with it. A closed laptop lid still sleeps.
import {spawn} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

let holder = null;

// Windows: ask the system to stay awake while on AC power, re-checked every 30 s.
const WIN_SCRIPT = `
Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
Add-Type -AssemblyName System.Windows.Forms
while ($true) {
  $ac = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -eq 'Online'
  if ($ac) { [void][W.P]::SetThreadExecutionState(0x80000001) } else { [void][W.P]::SetThreadExecutionState(0x80000000) }
  Start-Sleep -Seconds 30
}`;

// Linux: on mains power if any AC adapter reports online (desktops have none: always).
function linuxOnAc() {
  const dir = '/sys/class/power_supply';
  if (!existsSync(dir)) return true;
  const adapters = readdirSync(dir).filter((d) => existsSync(join(dir, d, 'online')));
  if (!adapters.length) return true;
  return adapters.some((d) => readFileSync(join(dir, d, 'online'), 'utf8').trim() === '1');
}

function start() {
  if (process.platform === 'darwin') {
    // -s: prevent system sleep, honoured only on AC power; -w: until the bot exits.
    return spawn('caffeinate', ['-s', '-w', String(process.pid)], {stdio: 'ignore'});
  }
  if (process.platform === 'win32') {
    return spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'ByPass', '-Command', WIN_SCRIPT], {stdio: 'ignore', windowsHide: true});
  }
  if (!linuxOnAc()) return null;
  return spawn('systemd-inhibit', ['--what=sleep:idle', '--who=reels-bot', '--why=Telegram reels bot is running', '--mode=block', 'sleep', 'infinity'], {stdio: 'ignore'});
}

function stop() {
  holder?.kill();
  holder = null;
}

/** Applies the setting; call it periodically (Linux follows the charger this way). */
export function keepAwake(enabled) {
  if (!enabled) return stop();
  if (process.platform === 'linux' && holder && !linuxOnAc()) return stop();
  if (holder && holder.exitCode === null) return;
  try {
    holder = start();
    holder?.on('error', () => (holder = null));
  } catch {
    holder = null;
  }
}

// ---------- during a task ----------

let taskHolder = null;

const WIN_TASK = `
Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][W.P]::SetThreadExecutionState(0x80000001)
while ($true) { Start-Sleep -Seconds 3600 }`;

/** Holds an idle-sleep block for the duration of an agent task, on any power source. */
export function taskAwake(on) {
  if (!on) {
    taskHolder?.kill();
    taskHolder = null;
    return;
  }
  if (taskHolder && taskHolder.exitCode === null) return;
  try {
    taskHolder = process.platform === 'darwin'
      // -i: prevent idle sleep, on battery too; -w: until the bot exits at the latest.
      ? spawn('caffeinate', ['-i', '-w', String(process.pid)], {stdio: 'ignore'})
      : process.platform === 'win32'
        ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'ByPass', '-Command', WIN_TASK], {stdio: 'ignore', windowsHide: true})
        : spawn('systemd-inhibit', ['--what=sleep:idle', '--who=reels-bot', '--why=Reels bot is working on a task', '--mode=block', 'sleep', 'infinity'], {stdio: 'ignore'});
    taskHolder.on('error', () => (taskHolder = null));
  } catch {
    taskHolder = null;
  }
}

process.on('exit', () => {
  stop();
  taskAwake(false);
});
