// Adapters that run a coding agent CLI headless, resume its session and stream
// coarse activity (for the progress line) back to the bot.
import {execFileSync, spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA, ROOT} from './config.mjs';

// Tool calls → a neutral shape for bot/activity.mjs.
function claudeCall(tool) {
  const i = tool.input ?? {};
  if (tool.name === 'WebSearch') return {tool: 'search'};
  if (tool.name === 'WebFetch') return {tool: 'fetch'};
  if (/^(Read|Glob|Grep|LS)$/.test(tool.name)) return {tool: 'read', path: i.file_path ?? i.path};
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool.name)) return {tool: 'write', path: i.file_path};
  if (tool.name === 'Bash') return {tool: 'run', command: i.command};
  return {tool: 'other'};
}

function emptyMcp() {
  const file = join(DATA, 'mcp-none.json');
  writeFileSync(file, '{"mcpServers":{}}');
  return file;
}

const ADAPTERS = {
  claude: {
    bin: 'claude',
    // The prompt goes in on stdin: no quoting issues with .cmd shims on Windows.
    args: ({sessionId, model, isolated}) => [
      '-p',
      '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      // Without the owner's global settings, plugins, hooks and MCP servers. An empty
      // MCP config file, not inline JSON: cmd.exe on Windows mangles quotes.
      ...(isolated ? ['--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', emptyMcp()] : []),
      ...(model ? ['--model', model] : []),
      ...(sessionId ? ['--resume', sessionId] : []),
    ],
    // Returns {sessionId?, call?, context?, text?, error?} for one JSON line of output.
    parse(ev) {
      if (ev.type === 'system' && ev.subtype === 'init') return {sessionId: ev.session_id};
      if (ev.type === 'assistant') {
        const u = ev.message?.usage;
        // Per-call usage = how full the context window is right now.
        const context = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined;
        const tool = ev.message?.content?.find((c) => c.type === 'tool_use');
        return {context, call: tool ? claudeCall(tool) : undefined};
      }
      if (ev.type === 'result') {
        const error = ev.is_error || (ev.subtype && ev.subtype !== 'success');
        return {sessionId: ev.session_id, text: ev.result ?? (error ? ev.subtype : ''), error};
      }
      return {};
    },
  },

  codex: {
    bin: 'codex',
    args: ({sessionId, model}) => [
      'exec', '--json', '--skip-git-repo-check',
      // Rendering needs Chromium, npm and downloads, which the workspace sandbox blocks.
      '--dangerously-bypass-approvals-and-sandbox',
      ...(model ? ['--model', model] : []),
      // `-` reads the prompt from stdin.
      ...(sessionId ? ['resume', sessionId, '-'] : ['-']),
    ],
    parse(ev) {
      if (ev.type === 'thread.started') return {sessionId: ev.thread_id};
      const item = ev.item;
      if (ev.type === 'item.started' && item) {
        if (item.type === 'web_search') return {call: {tool: 'search'}};
        if (item.type === 'file_change') return {call: {tool: 'write', path: item.changes?.[0]?.path}};
        if (item.type === 'command_execution') return {call: {tool: 'run', command: item.command}};
      }
      if (ev.type === 'item.completed' && item?.type === 'agent_message') return {text: item.text};
      if (ev.type === 'turn.failed') return {error: true, text: ev.error?.message ?? 'turn failed'};
      if (ev.type === 'error') return {error: true, text: ev.message ?? JSON.stringify(ev)};
      return {};
    },
  },
};

export const AGENTS = Object.keys(ADAPTERS);

// Every descendant of pid. Agents put their shell commands in separate process
// groups, so a group kill alone would leave a render running.
function descendants(pid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {encoding: 'utf8'})
    .trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const out = [];
  const walk = (p) => rows.filter(([, pp]) => pp === p).forEach(([c]) => (out.push(c), walk(c)));
  walk(pid);
  return out;
}

/** Stops a process and everything it started. */
export function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {stdio: 'ignore'});
    } catch {}
    return;
  }
  const pids = [pid, ...descendants(pid)];
  const signal = (sig) => pids.forEach((p) => {
    try {
      process.kill(p, sig);
    } catch {}
  });
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 3000).unref();
}

/**
 * Runs one agent turn. Calls onCall({tool, path?, command?}) on every tool call.
 * Resolves to {sessionId, text, error, cancelled, context, code, stderr, spawnError}; `kill()` on the returned
 * handle stops the agent and everything it spawned. The session survives a kill.
 */
export function runAgent({agent, bin, model, prompt, sessionId, onCall, isolated = false}) {
  const a = ADAPTERS[agent];
  if (!a) throw new Error(`Unknown AGENT "${agent}", expected one of: ${AGENTS.join(', ')}`);
  const child = spawn(bin || a.bin, a.args({sessionId, model, isolated}), {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    // npm-installed CLIs are .cmd shims on Windows, which only a shell can start.
    shell: process.platform === 'win32',
    windowsHide: true,
    env: {...process.env, REELS_BOT: '1'},
  });

  child.stdin.end(prompt);
  let stderr = '';
  let killed = false;
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));

  const done = new Promise((resolve) => {
    const out = {sessionId, text: '', error: false};
    createInterface({input: child.stdout}).on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const r = a.parse(ev);
      if (r.sessionId) out.sessionId = r.sessionId;
      if (r.call) onCall?.(r.call);
      if (r.context) out.context = r.context;
      if (r.text !== undefined) out.text = r.text;
      if (r.error) out.error = true;
    });
    child.on('close', (code) => {
      out.code = code;
      out.stderr = stderr.trim();
      // Agents exit with code 143 rather than by signal, so track the kill ourselves.
      if (killed) out.cancelled = true;
      else if (code !== 0) {
        out.error = true;
        if (!out.text) out.text = out.stderr.split('\n').slice(-5).join('\n') || `exit code ${code}`;
      }
      resolve(out);
    });
    // Spawn failures (e.g. ENOENT: the CLI is not installed or AGENT_BIN is wrong).
    child.on('error', (e) => resolve({...out, error: true, spawnError: e.code ?? 'spawn', text: e.message}));
  });

  const kill = () => {
    killed = true;
    killTree(child.pid);
  };
  return {done, kill};
}
