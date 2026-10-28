// Short calls to Claude for the bot's own scenarios (handbook/LAUNCH.md, «Новый диалоговый
// бот»): no tools, no session, an answer in JSON. The long agent turns stay in agents.mjs.
import {spawn} from 'node:child_process';
import {env} from './config.mjs';

/** Asks once and returns the first JSON object in the answer, or null (no Claude, timeout, bad JSON). */
export function askJson(prompt, {timeout = 120_000} = {}) {
  if (env.agent !== 'claude' || !env.agentBin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const args = ['-p', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'local', '--output-format', 'text', ...(env.agentModel ? ['--model', env.agentModel] : [])];
    const child = spawn(env.agentBin, args, {stdio: ['pipe', 'pipe', 'ignore']});
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const m = /\{[\s\S]*\}/.exec(out);
      try { resolve(m ? JSON.parse(m[0]) : null); } catch { resolve(null); }
    });
    child.stdin.end(prompt);
  });
}
