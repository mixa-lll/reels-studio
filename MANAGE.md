# Managing an installed bot (for the agent)

The user comes back to the chat where you installed the bot and asks for something. Same style as setup: in their language, 1–2 lines per message, choices as buttons with the recommended one first, and ask before anything irreversible. The bot's folder is where you installed it (usually `~/reels-bot`); `data/bot.log` is its log.

Autostart entry, per OS (from setup step 7):
- macOS: `~/Library/LaunchAgents/com.reels-bot.plist` — `launchctl bootout gui/$(id -u)/com.reels-bot` stops it, `launchctl bootstrap gui/$(id -u) <plist>` starts it, `launchctl kickstart -k gui/$(id -u)/com.reels-bot` restarts it.
- Linux: `systemctl --user stop|start|restart reels-bot`.
- Windows: `reels-bot.vbs` in the Startup folder; stop with `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*reels-bot*' | ForEach-Object { Stop-Process -Id $_.ProcessId }`, start with `wscript "<that file>"`.
- Started «only now» (no autostart): stop by the pid in `data/bot.pid` (kill the process tree), start with `node bot/run.mjs` in the background.

| The user wants | Do |
|---|---|
| «the bot is silent», «something broke» | Read the tail of `data/bot.log`; check the process is running (`data/bot.pid`); restart it. Explain the cause in one line. If the log shows an agent error (limit, login), say what to do. |
| restart / stop / start | The autostart commands above. |
| update now | Tell them the bot itself offers updates with an «⬆️ Update» button; or apply it here: `git pull` in a git clone, otherwise download and unpack the latest archive as in setup step 1 over the folder — keep `studio/`, `data/`, `.env`, `template/node_modules` — then `npm ci --ignore-scripts` in `template/` if `template/package-lock.json` changed, and restart. |
| new Telegram key (leaked, new bot) | Ask them to send `/revoke` or `/newbot` to @BotFather and paste the reply; put the new token in `.env`; restart. For a new bot also clear `ownerId` in `data/state.json` and give them the start link as in setup step 8. |
| change owner | Clear `ownerId`/`chatId` in `data/state.json`, set a new `OWNER_CODE` in `.env`, restart, send the new start link. |
| switch Claude Code ↔ Codex, another model | Edit `AGENT`, `AGENT_BIN`, `AGENT_MODEL` in `.env`; delete `sessionId` from `data/state.json` (sessions are per agent); restart. |
| ideas time, sleep, global settings | Point to `/settings` in the bot, or edit `studio/settings.json` (the bot re-reads it). |
| move it to another computer | Copy the folder without `template/node_modules`; on the new machine run setup steps 3, 4 and 7; stop the old one first (one bot per token). |
| remove it | Ask: **«Remove the bot? Your reels in studio/ can be kept.»** — `Remove, keep my reels (recommended)` / `Remove everything` / `Cancel`. Then: stop it; delete the autostart entry; delete the folder (moving `studio/` to their Documents first if they keep it); remind them in one line that the Telegram bot itself can be deleted with `/deletebot` in @BotFather. |

Anything else about the bot: read [SECURITY.md](SECURITY.md) and the code, then do it the same way — briefly, with buttons, asking before anything irreversible.
