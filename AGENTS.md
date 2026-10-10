# reels-bot

A Telegram bot that makes short vertical videos (reels) with a coding agent: it pitches ideas, edits the picked ones in Remotion and revises them from the owner's replies.

- **Not installed yet** (no `.env`, or the owner asked to set it up): follow [SETUP.md](SETUP.md).
- **Installed, and the user asks you to change, fix, stop, update, move or remove it:** follow [MANAGE.md](MANAGE.md).
- **Running as the bot** (the prompt says so, or `REELS_BOT=1` is set): follow [REELS.md](REELS.md). Your final reply goes to the owner in Telegram.
- **Changing the bot itself:** the code is `bot/` (plain Node 22 ES modules, no dependencies), `template/` (Remotion starter), `scripts/`. Keep it small; owner material lives in `projects/` (one folder per project; `bot/projects.mjs`) and `data/`, both gitignored.
  - After a change, without being asked: commit it, then, if the bot runs from this folder (`data/bot.pid` is a live process), restart it so it picks the change up. First wait until it is idle: no `pending` and an empty `queue` in `data/state.json` (a restart mid-task redoes the task on the new code). Restart with the autostart command in [MANAGE.md](MANAGE.md) (macOS: `launchctl kickstart -k gui/$(id -u)/com.reels-bot`) and check the tail of `data/bot.log`. Not when you are running as the bot yourself: there REELS.md applies.
