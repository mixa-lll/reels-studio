// Builds or refreshes projects/<p>/items.json from the reel and post folders, plan.json and
// the pitches in ideas.md (handbook/LEAN.md). Old files stay as they are; the first run keeps
// plan.json.bak. Running it again adds only what is new.
//   node scripts/lean-migrate.mjs <project or folder> [--dry]
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {STAGES, syncItems} from '../web/items.mjs';

const [arg, flag] = process.argv.slice(2);
if (!arg) { console.error('usage: node scripts/lean-migrate.mjs <project or folder> [--dry]'); process.exit(1); }
const studio = existsSync(join(arg, 'ideas.md')) || existsSync(join(arg, 'reels')) ? resolve(arg) : join(import.meta.dirname, '..', 'projects', arg);
if (!existsSync(studio)) { console.error(`no project at ${studio}`); process.exit(1); }
const dry = flag === '--dry';
const {data, added} = syncItems(studio, {dry});
const count = (pick) => Object.entries(data.items.reduce((m, x) => ((m[pick(x)] = (m[pick(x)] || 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(', ');
console.log(`${dry ? 'would add' : 'added'} ${added.length}, items ${data.items.length}`);
console.log(`stages: ${STAGES.map((s) => `${s} ${data.items.filter((x) => x.stage === s && !x.proposed).length}`).join(', ')}; proposals ${data.items.filter((x) => x.proposed).length}`);
console.log(`formats: ${count((x) => x.format)}`);
for (const x of data.items.filter((y) => !y.proposed)) console.log(`  ${x.stage.padEnd(9)} ${x.format.padEnd(8)} ${x.rubric || '—'}\t${x.at || ''}\t${x.title}`);
