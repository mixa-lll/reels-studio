# reels-bot

A Telegram bot that makes short vertical videos (reels) with a coding agent: it pitches ideas, edits the picked ones in Remotion and revises them from the owner's replies.

- **Not installed yet** (no `.env`, or the owner asked to set it up): follow [SETUP.md](SETUP.md).
- **Installed, and the user asks you to change, fix, stop, update, move or remove it:** follow [MANAGE.md](MANAGE.md).
- **Strategy and plan** (platforms, rubrics, rhythm, calendar): follow [STRATEGY.md](STRATEGY.md).
- **Making a post in the web studio** (the chat is about a post): follow [POSTS.md](POSTS.md).
- **Running as the bot** (the prompt says so, or `REELS_BOT=1` is set): follow [REELS.md](REELS.md). Your final reply goes to the owner in Telegram.
- **Developing the product (a team member's task, an issue, a pull request):** read [handbook/README.md](handbook/README.md) first — product, roadmap, workflow, architecture and decisions — and follow [handbook/WORKFLOW.md](handbook/WORKFLOW.md): one issue, one branch, one pull request. Partners (Misha, Kensingtonnn) merge without review and ship to production by moving the `prod` branch to `main` ("выложи main на прод": `git push origin main:prod` after a fetch; rollback = push the previous commit to `prod`). Never log in to the server or touch the running bot by hand.
- **Changing the bot itself:** the code is `bot/` (plain Node 22 ES modules, no dependencies), `template/` (Remotion starter), `scripts/`. Keep it small; owner material lives in `projects/` (one folder per project; `bot/projects.mjs`) and `data/`, both gitignored.
  - After a change, without being asked: commit it, then, if the bot runs from this folder (`data/bot.pid` is a live process), restart it so it picks the change up. First wait until it is idle: no `pending` and an empty `queue` in `data/state.json` (a restart mid-task redoes the task on the new code). Restart with the autostart command in [MANAGE.md](MANAGE.md) (macOS: `launchctl kickstart -k gui/$(id -u)/com.reels-bot`) and check the tail of `data/bot.log`. Not when you are running as the bot yourself: there REELS.md applies.
