#!/usr/bin/env node
// CLI the agent calls to talk to the owner while it works.
//
//   --status "🎵 Подбираю музыку"                 update the live progress line
//   --text "…" --keyboard "A|B" [--menu tune.json]
//                                                 message + the owner's main options as a keyboard under
//                                                 the input field; --menu adds «🎛 Настроить подробнее»
//   --text "…" [--buttons "A|B"]                  message + inline buttons (optional actions on it)
//   --file path.mp4 --caption "…" [--buttons "…"] [--menu tune.json] [--document]
//   --menu steps.json                             open a button menu now (see bot/menu.mjs)
//
// Messages with buttons get a «type or dictate your own» line automatically.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {DATA, env, loadState} from './config.mjs';
import {createMenu, customHint, loadMenu, post, tuneLabel} from './menu.mjs';
import {replyKeyboard} from './keys.mjs';
import {keyboard, telegram} from './telegram.mjs';

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
  },
});

// The bot owns the progress message; we only hand it the new stage.
if (o.status !== undefined) {
  writeFileSync(join(DATA, 'status.txt'), o.status);
  process.exit(0);
}

const {chatId} = loadState();
if (!chatId) {
  console.error('No owner yet: nobody has written to the bot.');
  process.exit(1);
}
const tg = telegram(env.token);
const list = (s) => s?.split('|').map((x) => x.trim()).filter(Boolean);
const buttons = list(o.buttons);
const keys = list(o.keyboard);
const menuId = o.menu ? createMenu(JSON.parse(readFileSync(o.menu, 'utf8'))) : null;

if (o.text) {
  let markup;
  if (keys) {
    if (menuId) keys.push(tuneLabel());
    markup = replyKeyboard(keys, {menu: menuId, tune: tuneLabel(), placeholder: customHint().replace(/^✍️\s*/, '')});
  } else if (buttons || menuId) {
    markup = keyboard(buttons ?? []);
    if (menuId) markup.inline_keyboard.push([{text: tuneLabel(), callback_data: `m:${menuId}:open`}]);
  }
  const text = markup ? `${o.text}\n\n${customHint()}` : o.text;
  await tg.call('sendChatAction', {chat_id: chatId, action: 'typing'});
  await tg.sendText(chatId, text, markup ? {reply_markup: markup} : {});
} else if (o.file) {
  const video = /\.(mp4|mov|webm)$/i.test(o.file) && !o.document;
  await tg.call('sendChatAction', {chat_id: chatId, action: video ? 'upload_video' : 'upload_document'});
  let markup = buttons?.length ? keyboard(buttons) : undefined;
  if (menuId) {
    markup ??= {inline_keyboard: []};
    markup.inline_keyboard.push([{text: tuneLabel(), callback_data: `m:${menuId}:open`}]);
  }
  await tg.sendFile(chatId, o.file, {caption: o.caption, markup, asDocument: o.document});
} else if (menuId) {
  await post(tg, chatId, loadMenu(menuId));
}
// Tell the bot to move its progress line below what we just sent.
writeFileSync(join(DATA, 'sent.txt'), String(Date.now()));
console.log('sent');
