#!/usr/bin/env node
// Renders cover stills for web/cover.mjs:  node cover-render.mjs <job.json>
//   job: {bundle: <cache dir>, jobs: [{out: <png>, props: {...CoverProps}}]}
// The bundle is made once and reused until the cover sources change; the stills run one after another
// in one browser. Images come in as data URIs inside props, so no public folder is needed.
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundle} from '@remotion/bundler';
import {ensureBrowser, openBrowser, renderStill, selectComposition} from '@remotion/renderer';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src', 'cover');
const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const stamp = readdirSync(SRC).map((f) => Math.round(statSync(join(SRC, f)).mtimeMs)).join('-');
const dir = `${job.bundle}-${stamp}`;
let serveUrl = dir;
if (!existsSync(join(dir, 'index.html'))) serveUrl = await bundle({entryPoint: join(SRC, 'index.ts'), outDir: dir});

await ensureBrowser();
const browser = await openBrowser('chrome');
try {
  for (const j of job.jobs) {
    const composition = await selectComposition({serveUrl, id: 'CoverDS', inputProps: j.props, puppeteerInstance: browser});
    await renderStill({composition, serveUrl, output: j.out, inputProps: j.props, imageFormat: 'png', puppeteerInstance: browser});
    console.log('done ' + j.out);
  }
} finally {
  await browser.close({silent: true});
}
