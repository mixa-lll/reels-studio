# Setup (for the agent installing the bot)

You are setting this bot up for your user, who may not be technical. Do everything yourself; the only thing to ask for is the Telegram bot token. Never ask the user to edit files, run commands or open a terminal. Talk to the user in their language, one short line per step.

Works on macOS, Linux and Windows. Commands below are given per OS where they differ; on Windows use PowerShell.

1. **Folder.** If you are not inside a clone yet: `git clone https://github.com/fivol/reels-bot` into the user's home folder and work from there. Keep it a git clone (not a downloaded zip): the bot updates itself from it.
2. **Which agent you are.** `claude` for Claude Code, `codex` for Codex. Check that its CLI runs headless: `claude -p "say ok"` or `codex exec "say ok"`. Note its absolute path — macOS/Linux `command -v claude`, Windows `(Get-Command claude).Source` — the autostart will not have your shell's PATH. On Windows, Claude Code needs Git for Windows (it runs commands in Git Bash); if Codex runs inside WSL, install the whole bot inside WSL and follow the Linux steps.
3. **Tools.** Node 22+, npm, git, `uv` (beat detection, voice notes) and `ffmpeg` (loudness). Install what is missing:
   - macOS: `brew install node uv ffmpeg`
   - Linux (Debian/Ubuntu): `sudo apt install -y nodejs npm ffmpeg` (Node from NodeSource or nvm if the distro's is older than 22), `curl -LsSf https://astral.sh/uv/install.sh | sh`
   - Windows: `winget install OpenJS.NodeJS.LTS Gyan.FFmpeg astral-sh.uv Git.Git`, then open a new terminal so PATH picks them up.
   Ask before using `sudo`.
4. **Remotion.** In `template/`: `npm install`, then `npx remotion browser ensure`. Back in the repo root, a smoke render: `node scripts/render.mjs template data/smoke.mp4` must produce a file; delete it afterwards.
   - Linux: if Chromium fails on a missing `.so`, install its libraries: `sudo apt install -y libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2` (on Ubuntu 24.04 `libasound2t64`).
5. **Token.** Make up a ready name and username for the user: the name from their product or blog if you know it (e.g. «Рилсы Acme»), otherwise «Мои рилсы» / «My reels»; the username lowercase latin, ending in `_bot`, with a random tail so it is likely free (e.g. `acme_reels_7342_bot`). Send the steps in their language, as they are, with your two values filled in:
   > 1. Open Telegram and find **@BotFather** (blue tick), or open t.me/BotFather.
   > 2. Press **Start**, then send `/newbot`.
   > 3. Send the name: `<name>`
   > 4. Send the username: `<username>` (if BotFather says it is taken, add a digit).
   > 5. BotFather replies with a long message. Copy all of it and paste it here.
   >
   > You can pick any other name and username instead: the name is what people see, the username must end in `bot`.

   Avatar, description and the command menu are set by the bot itself on first start; do not ask the user to do them in BotFather.

   Extract the token with the pattern `\d{6,}:[A-Za-z0-9_-]{30,}`. Check it: `curl -s https://api.telegram.org/bot<TOKEN>/getMe` must return `"ok":true`; remember the `username`. If it fails, say what went wrong in one line and ask again. Never repeat the token back.
6. **Config.** Copy `.env.example` to `.env`; set `TELEGRAM_BOT_TOKEN`, `AGENT`, `AGENT_BIN` (absolute path from step 2), `BOT_LANG` (`ru` or `en`, the user's language) and `OWNER_CODE` — a random secret, e.g. `node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))"`. Only the person who opens the bot through `t.me/<username>?start=<OWNER_CODE>` becomes its owner; everyone else is turned away. Never commit `.env`.
6b. **Global settings (Claude Code only).** Ask the user, in their language: «Should the bot see your global Claude Code setup — plugins, connected services (MCP: mail, calendar, Figma…), hooks? Yes: the bot can use them. No: it works only with what it needs (choose this if unsure). Your global CLAUDE.md instructions are read either way.» Write the answer into `studio/settings.json` as `"agentGlobalSettings": true` or `false` (create `studio/` from `starter/` first if it does not exist). Codex always runs with its global configuration; skip the question for Codex.
7. **Autostart.** Create `data/` first (the log goes there). Replace `__ROOT__` with the repo's absolute path, `__NODE__` with node's absolute path and `__PATH__` with your current PATH.
   - macOS: fill `deploy/reels-bot.plist` into `~/Library/LaunchAgents/com.reels-bot.plist`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.reels-bot.plist`.
   - Linux: fill `deploy/reels-bot.service` into `~/.config/systemd/user/reels-bot.service`, then `systemctl --user daemon-reload && systemctl --user enable --now reels-bot`. So it keeps running after logout: `loginctl enable-linger $USER`. No systemd (e.g. some WSL setups): run `node bot/run.mjs` in the background from the shell profile instead.
   - Windows: fill `deploy/reels-bot.vbs` (backslashes in paths) into `"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\reels-bot.vbs"`, then start it now with `wscript "<that file>"`. It runs `bot/run.mjs` without a console window and restarts the bot if it stops.
   - Check: `data/bot.log` says `reels-bot up`.
8. **Hand over.** Give the user the personal link `https://t.me/<username>?start=<OWNER_CODE>` and tell them: «Open this link and press Start — it makes you the bot's owner; the bot answers no one else. Don't share the link until you have pressed Start. It will ask what your reels are about. You can type or send voice messages.» Mention that ideas arrive daily at 10:00 (just tell the bot another time to change it) and that `/stop` stops any running task.

Security note to pass on in one line: the bot runs the agent without permission prompts inside its folder, so it serves only its owner; keep the token private. If it ever leaks, send `/revoke` to @BotFather and give the new token to the agent.
