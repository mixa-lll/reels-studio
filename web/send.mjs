#!/usr/bin/env node
// Web stand-in for bot/send.mjs: same options, but instead of Telegram every call is
// appended to $REELS_DATA/events.jsonl, which the web server streams to the browser.
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';

const DATA = process.env.REELS_DATA;
if (!DATA) {
  console.error('REELS_DATA is not set');
  process.exit(1);
}
const {values: o} = parseArgs({
  options: {
    status: {type: 'string'},
    text: {type: 'string'},
    file: {type: 'string'},
    caption: {type: 'string'},
    buttons: {type: 'string'},
    keyboard: {type: 'string'},
    document: {type: 'boolean'},
    menu: {type: 'string'},
    ideas: {type: 'boolean'},
    silent: {type: 'boolean'},
    notify: {type: 'boolean'},
  },
});

if (o.status !== undefined) {
  writeFileSync(join(DATA, 'status.txt'), o.status);
  process.exit(0);
}

const list = (s) => s?.split('|').map((x) => x.trim()).filter(Boolean);
const keys = list(o.keyboard) ?? [];
if (o.ideas) keys.splice(0, keys.length, ...keys.filter((k) => !/^🎲/.test(k)), '🎲 Другие идеи');
// A menu file (bot/menu.mjs format) becomes sections of buttons on the page; a tap
// comes back to the agent as one line naming the menu, the section and the option.
let menu;
if (o.menu) {
  try {
    const m = JSON.parse(readFileSync(o.menu, 'utf8'));
    menu = {
      title: m.title ?? '',
      sections: (m.sections ?? []).map((s) => ({title: s.title ?? '', prompt: s.prompt ?? '', current: s.current, options: (s.options ?? []).map((x) => ({label: x.label, value: x.value, note: x.note}))})),
    };
  } catch {}
}
const event = o.file
  ? {type: 'file', path: resolve(o.file), caption: o.caption ?? '', buttons: list(o.buttons) ?? [], document: !!o.document, menu}
  : o.text
    ? {type: 'text', text: o.text, keys, buttons: list(o.buttons) ?? [], menu}
    : menu
      ? {type: 'menu', menu}
      : null;
if (event) appendFileSync(join(DATA, 'events.jsonl'), JSON.stringify({...event, at: Date.now()}) + '\n');
console.log('sent');
