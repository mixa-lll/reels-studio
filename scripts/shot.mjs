#!/usr/bin/env node
// Fresh screenshots of a live site for phone and screen scenes («show the real product»):
//   node scripts/shot.mjs <url> <out.jpg|png> [--desktop] [--full] [--wait 6] [--lang ru]
//        [--click "button text"] [--js "code run before the shot"] [--storage '{"key":"value"}']
// Mobile by default: iPhone 390×844 at 3× (1170 px wide), touch on. --full takes the whole
// page (scrolled through first, so lazy images load). Cookie and notice buttons («Понятно»,
// «Got it», «Accept», «Принять») are closed. Uses the installed Google Chrome --headless=new:
// Cloudflare turns away Remotion's headless shell (Error 1010, reel 15).
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv.splice(i, 1), true) : false;
};
const desktop = flag('desktop'), full = flag('full');
const wait = Number(opt('wait') || 6) * 1000, lang = opt('lang') || 'ru';
const click = opt('click'), js = opt('js'), storage = opt('storage');
const [url, out] = argv;
if (!url || !out) {
  console.error('Usage: node scripts/shot.mjs <url> <out.jpg> [--desktop] [--full] [--wait 6] [--lang ru] [--click "…"] [--js "…"] [--storage \'{"k":"v"}\']');
  process.exit(1);
}
const CHROMES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const chrome = process.env.CHROME || CHROMES.find(existsSync);
if (!chrome) {
  console.error('No Chrome found: install Google Chrome or set CHROME=<path>.');
  process.exit(1);
}
const W = desktop ? 1440 : 390, H = desktop ? 900 : 844, SCALE = desktop ? 2 : 3;
const UA = desktop ? undefined : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'reels-shot-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars',
  `--window-size=${W},${H}`, `--lang=${lang}`, 'about:blank'], {stdio: 'ignore'});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 75 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const wait_ = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && wait_.has(m.id)) { wait_.get(m.id)(m.result ?? m.error); wait_.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { wait_.set(++id, r); ws.send(JSON.stringify({id, method, params})); });
  const run = async (expr) => (await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true})).result?.value;
  if (UA) await send('Network.setUserAgentOverride', {userAgent: UA, acceptLanguage: lang});
  await send('Emulation.setDeviceMetricsOverride', {width: W, height: H, deviceScaleFactor: SCALE, mobile: !desktop});
  if (!desktop) await send('Emulation.setTouchEmulationEnabled', {enabled: true});
  await send('Emulation.setLocaleOverride', {locale: lang}).catch(() => {});
  if (storage) await send('Page.addScriptToEvaluateOnNewDocument', {source: `for (const [k, v] of Object.entries(${storage})) localStorage.setItem(k, v);`});
  await send('Page.enable');
  await send('Page.navigate', {url});
  await sleep(wait);
  const closeNotices = "[...document.querySelectorAll('button,a,[role=button]')].filter((b) => /^(Понятно|Принять|Принять все|Got it|Accept|Accept all|OK|Ок)$/i.test(b.textContent.trim())).forEach((b) => b.click())";
  await run(closeNotices);
  await sleep(600);
  if (click) {
    const hit = await run(`(() => { const el = [...document.querySelectorAll('a,button,[role=button],[onclick]')].find((e) => e.textContent.trim().includes(${JSON.stringify(click)})); if (!el) return false; el.click(); return true; })()`);
    console.log(hit ? `clicked «${click}»` : `«${click}» not found`);
    await sleep(3000);
  }
  if (js) { console.log('js →', JSON.stringify(await run(js))); await sleep(2000); }
  let clip;
  if (full) {
    const h = await run('document.documentElement.scrollHeight');
    for (let y = 0; y < h; y += 600) { await run(`window.scrollTo(0, ${y})`); await sleep(300); }
    await run('window.scrollTo(0, 0)');
    await sleep(1500);
    await run(closeNotices);
    clip = {x: 0, y: 0, width: W, height: Math.min(await run('document.documentElement.scrollHeight'), 12000), scale: 1};
  }
  const png = /\.png$/i.test(out);
  const shot = await send('Page.captureScreenshot', {format: png ? 'png' : 'jpeg', ...(png ? {} : {quality: 92}), ...(clip ? {clip, captureBeyondViewport: true} : {})});
  if (!shot?.data) throw new Error('no screenshot');
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`→ ${out} (${W * SCALE} px wide${clip ? `, ${clip.height * SCALE} px tall` : ''}) · ${await run('document.title')}`);
  ws.close();
} catch (e) {
  console.error('shot failed:', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  await sleep(300);
  rmSync(profile, {recursive: true, force: true});
}
