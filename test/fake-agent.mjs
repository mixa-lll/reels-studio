// Stands in for the claude CLI in tests: reads the prompt from stdin, prints
// stream-json, and on "sleep" starts a long child process to test cancelling.
import {spawn} from 'node:child_process';

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const out = (o) => console.log(JSON.stringify(o));
  out({type: 'system', subtype: 'init', session_id: 'fake-session'});
  out({type: 'assistant', message: {usage: {input_tokens: 10, cache_read_input_tokens: 90}, content: [{type: 'tool_use', name: 'Bash', input: {command: 'node scripts/render.mjs p o.mp4'}}]}});
  if (prompt.includes('fail login')) {
    console.error('Invalid API key · Please run /login');
    process.exit(1);
  }
  if (prompt.includes('hang quietly')) return setTimeout(() => {}, 600_000);
  if (prompt.includes('sleep')) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {stdio: 'ignore'});
    console.error(`child ${child.pid}`);
    setTimeout(() => {}, 120000);
    return;
  }
  const reply = () => out({type: 'result', session_id: 'fake-session', result: `echo: ${prompt.trim()}`, is_error: false});
  if (prompt.includes('slow')) return setTimeout(reply, 2500);
  reply();
});
