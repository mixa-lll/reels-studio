#!/usr/bin/env node
// Confirms the bot's owner on the computer it runs on, so no secret has to travel.
// Whoever presses Start becomes a *request*; the installing agent asks the user
// «is this you?» and approves it here. The running bot picks the approval up.
//
//   node bot/claim.mjs --wait-owner [seconds=600]  wait until the bot has an owner (link
//                                             opened, or approved here); prints who
//   node bot/claim.mjs --wait [seconds=600]   wait for someone to press Start; prints who
//   node bot/claim.mjs --approve              make that person the owner
//   node bot/claim.mjs --reject               turn the request down
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA, loadState} from './config.mjs';

export const REQUEST = join(DATA, 'owner-request.json');
export const APPROVED = join(DATA, 'owner-approved.json');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('claim.mjs')) {
  const [action, arg] = process.argv.slice(2);
  if (action === '--wait-owner') {
    const until = Date.now() + Number(arg ?? 600) * 1000;
    while (!loadState().ownerId) {
      if (Date.now() > until) {
        console.log('No owner yet: the link has not been opened.');
        process.exit(2);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`Owner connected: ${loadState().ownerName || 'yes'}`);
    process.exit(0);
  }
  if (loadState().ownerId) {
    console.log('The bot already has an owner.');
    process.exit(0);
  }
  if (action === '--wait') {
    const until = Date.now() + Number(arg ?? 600) * 1000;
    while (!existsSync(REQUEST)) {
      if (Date.now() > until) {
        console.log('Nobody pressed Start yet.');
        process.exit(2);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    const r = read(REQUEST);
    console.log(`Start pressed by: ${r.name}${r.username ? ` (@${r.username})` : ''}`);
  } else if (action === '--approve') {
    if (!existsSync(REQUEST)) {
      console.error('No request to approve: ask the user to press Start in the bot first.');
      process.exit(1);
    }
    writeFileSync(APPROVED, JSON.stringify(read(REQUEST)));
    rmSync(REQUEST, {force: true});
    console.log('Approved; the bot greets its owner in a few seconds.');
  } else if (action === '--reject') {
    rmSync(REQUEST, {force: true});
    console.log('Request removed.');
  } else {
    console.error('Usage: node bot/claim.mjs --wait [seconds] | --approve | --reject');
    process.exit(1);
  }
}
