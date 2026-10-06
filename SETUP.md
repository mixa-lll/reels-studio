# Setup (for the agent installing the bot)

You are setting this bot up for your user, who may not be technical. Do everything yourself; the only thing to ask for is the Telegram bot token. Never ask the user to edit files, run commands or open a terminal. Talk to the user in their language, one short line per step.

0. **Check, explain, ask.** Before installing anything:
   - Read [SECURITY.md](SECURITY.md) and skim the code it points to (`bot/`, `scripts/` — about 2,100 lines, no dependencies). Confirm for yourself that it matches: it talks only to Telegram and this repo, has no hidden behavior, and the agent acts only on the owner's messages. If anything does not match, stop and tell the user.
   - Explain to the user, in their language, in a few short lines: what the bot is (a Telegram bot that pitches reel ideas, edits videos with you, the agent, and revises them from their replies); what will happen (a folder with the bot, Node/ffmpeg/uv if missing, a Telegram bot they create, autostart at login); what it can do on their computer (it runs you without permission prompts inside its folder, only on their messages from Telegram; other folders only when they name them or approve; it never publishes anything; updates only with their tap); and how to remove it.
   - Ask whether they want this. Continue only after a clear yes.

Works on macOS, Linux and Windows. Commands below are given per OS where they differ; on Windows use PowerShell.

**The only requirement is Node 22+.** Nothing else needs installing: not git, Homebrew, ffmpeg, Python or uv. Do not install them for this bot — on macOS even calling `git` without Xcode Command Line Tools pops up a long system install, so check `xcode-select -p` first and avoid git if it fails.

1. **Folder.** Into the user's home folder, as `reels-bot`:
   - if git works already (macOS: `xcode-select -p` succeeds; elsewhere `git --version`): `git clone https://github.com/fivol/reels-bot`;
   - otherwise download the archive — macOS/Linux: `curl -L https://codeload.github.com/fivol/reels-bot/tar.gz/main | tar xz && mv reels-bot-main reels-bot`; Windows: `curl.exe -L -o rb.tgz https://codeload.github.com/fivol/reels-bot/tar.gz/main; tar -xzf rb.tgz; Rename-Item reels-bot-main reels-bot; Remove-Item rb.tgz`.
   Both get updates (the bot asks before installing one).
2. **Which agent you are.** `claude` for Claude Code, `codex` for Codex. Check that its CLI runs headless: `claude -p "say ok"` or `codex exec "say ok"`. Note its absolute path — macOS/Linux `command -v claude`, Windows `(Get-Command claude).Source` — the autostart will not have your shell's PATH. On Windows, Claude Code needs Git for Windows (it runs commands in Git Bash); if Codex runs inside WSL, install the whole bot inside WSL and follow the Linux steps.
3. **Node 22+.** If `node -v` shows 22 or newer, skip this. Otherwise, without sudo:
   - macOS / Linux: download the official build into `~/.local/node` — `mkdir -p ~/.local/node && curl -L https://nodejs.org/dist/latest-v22.x/node-$(curl -s https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o 'v22[0-9.]*' | head -1)-$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/').tar.gz | tar xz -C ~/.local/node --strip-components 1`, then use `~/.local/node/bin/node` and `~/.local/node/bin/npm` by absolute path (and put `~/.local/node/bin` first in PATH for the rest of the setup). If Homebrew is already installed, `brew install node` is fine too.
   - Windows: `winget install OpenJS.NodeJS.LTS`, then open a new terminal.
   Optional, only if the user wants them: system `ffmpeg` (adds a limiter to loudness normalisation; otherwise the ffmpeg bundled with Remotion is used). Speech recognition (`uv` + Whisper) installs itself into the user's home on the first voice message.
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
