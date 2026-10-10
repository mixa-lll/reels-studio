// Stands in for the claude CLI in tests: reads stream-json messages from stdin, prints
// stream-json, and on "sleep" starts a long child process to test cancelling. A message
// that arrives during a "slow" turn joins it, like the real CLI between tool calls.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const out = (o) => console.log(JSON.stringify(o));
const taken = (text) => out({type: 'user', message: {role: 'user', content: text}, isReplay: true});
const waiting = [];
let turn = null;
let ended = false;

function next() {
  if (!waiting.length) {
    if (ended) process.exit(0);
    return;
  }
  const prompt = waiting.shift();
  turn = [prompt];
  taken(prompt);
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
  const reply = () => {
    out({type: 'result', session_id: 'fake-session', result: `echo: ${turn.map((p) => p.trim()).join('\n')}`, is_error: false});
    turn = null;
    next();
  };
  if (prompt.includes('slow')) return setTimeout(reply, 2500);
  reply();
}

createInterface({input: process.stdin})
  .on('line', (line) => {
    const text = JSON.parse(line).message.content;
    if (turn) {
      turn.push(text);
      taken(text);
    } else {
      waiting.push(text);
      next();
    }
  })
  .on('close', () => {
    ended = true;
    if (!turn) next();
  });
