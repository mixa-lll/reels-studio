# Setup (for the agent installing the bot)

You are setting this bot up for your user, who may not be technical. Do everything yourself; the only thing to ask for is the Telegram bot token. Never ask the user to edit files, run commands or open a terminal.

**How to talk:** in the user's language, briefly. Each message is 1–2 short lines: what is happening and what comes next; a choice always comes as buttons. No walls of text, no lists of commands or files, no progress reports for every small step — details only when the user taps «Tell me more» or asks.

**Asking the user.** Every decision below goes through your harness's question tool with buttons when you have one (Claude Code: AskUserQuestion; a plain question otherwise). The user's explicit answer is what authorises each step; never install or start anything they have not approved.

The user is probably not technical and should get a working bot by tapping the first button every time: put the recommended answer first and mark it «(recommended)», in their language. Plain words only — no «MCP», «npm», «autostart», «token», «repo»; say «Telegram key» for the token, «start with the computer» for autostart. There are only four moments that need the user: «Install?», creating the Telegram bot, the global-settings question (Claude Code only) and «Start now?».

0. **Check, explain, ask.** Before installing anything:
   - Read [SECURITY.md](SECURITY.md) and skim the code it points to (`bot/`, `scripts/` — about 2,600 lines, no dependencies). Confirm for yourself that it matches: it talks only to Telegram and this repo, has no hidden behavior, and the agent acts only on the owner's messages. If anything does not match, stop and tell the user.
   - Tell the user in 3–4 short lines, no more: what it is (a Telegram bot that pitches reel ideas and edits videos with you, the agent, from their replies); what gets installed (the bot, Remotion for video, about 450 MB, nothing system-wide); that it acts only on their messages and never publishes anything. Keep the rest — downloads, versions, permissions (you run without prompts inside the bot's folder, other folders only with their consent, updates only on their tap), removal — for «Tell me more».
   - Ask: **«Install the reels bot?»** — options `Yes, install (recommended)`, `Tell me more first` (answer their questions briefly, then ask again), `No`. Continue only on yes.
   - If your harness still blocks a step (e.g. a package install), do not look for a way around it: show the user the exact command and why it is needed, and ask them to approve it — or to run it themselves.

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
   Optional, only if the user wants them: system `ffmpeg` (adds a limiter to loudness normalisation; otherwise the ffmpeg bundled with Remotion is used). Speech recognition (`uv` + Whisper) sets itself up inside the bot's folder on the first voice message.
4. **Remotion.** In `template/`: `npm ci --ignore-scripts` (exact versions from the lockfile, no install scripts), then `npx remotion browser ensure`. Back in the repo root, a smoke render: `node scripts/render.mjs template data/smoke.mp4` must produce a file; delete it afterwards.
   - Linux: if Chromium fails on a missing `.so`, install its libraries: `sudo apt install -y libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2` (on Ubuntu 24.04 `libasound2t64`).
5. **Telegram bot.** Suggest the name «Reelser» and a username `reelser_<4 random digits>_bot` (likely free), and say they can make up any others. Send the steps in their language, as they are, with your username filled in:
   > 1. Open Telegram and find **@BotFather** (blue tick), or open t.me/BotFather.
   > 2. Press **Start**, then send `/newbot`.
   > 3. Send the name: `Reelser`
   > 4. Send the username: `<username>` (if BotFather says it is taken, change the digits).
   > 5. BotFather replies with a long message. Copy all of it and paste it here.
   >
   > Any other name and username work too: the name is what people see, the username must end in `bot`.

   This is the one step the user does by hand; keep the instructions exactly this short.

   Avatar, description and the command menu are set by the bot itself on first start; do not ask the user to do them in BotFather.

   Extract the token with the pattern `\d{6,}:[A-Za-z0-9_-]{30,}`. Check it: `curl -s https://api.telegram.org/bot<TOKEN>/getMe` must return `"ok":true`; remember the `username`. If it fails, say what went wrong in one line and ask again. Never repeat the token back.
6. **Config.** Copy `.env.example` to `.env`; set `TELEGRAM_BOT_TOKEN`, `AGENT`, `AGENT_BIN` (absolute path from step 2), `BOT_LANG` (`ru` or `en`, the user's language) and `OWNER_CODE`: make one up yourself right here — 10 random letters and digits — and write that same value into `.env` (never read it back from the file). Never print the token or commit `.env`.
6b. **Global settings (Claude Code only).** Ask with the question tool, in plain words: **«Should the bot be able to use your other Claude connections (mail, calendar, Figma and the like) and your add-ons?»** — options `No, keep it separate (recommended)` and `Yes, let it use them`. Write the answer into `studio/settings.json` as `"agentGlobalSettings": false` or `true` (create `studio/` from `starter/` first if it does not exist); it can be changed later in the bot's `/settings`. Codex always runs with its global configuration; skip the question for Codex.
7. **Start.** First ask: **«Start the bot now?»** — options `Yes, and start it with the computer (recommended)` (autostart as below), `Only now` (run `node bot/run.mjs` in the background, no autostart), `Not now` (stop here; when they later ask you to start the reels bot, do this step and step 8).
   For autostart, create `data/` first (the log goes there). Replace `__ROOT__` with the repo's absolute path, `__NODE__` with node's absolute path and `__PATH__` with your current PATH.
   - macOS: fill `deploy/reels-bot.plist` into `~/Library/LaunchAgents/com.reels-bot.plist`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.reels-bot.plist`.
   - Linux: fill `deploy/reels-bot.service` into `~/.config/systemd/user/reels-bot.service`, then `systemctl --user daemon-reload && systemctl --user enable --now reels-bot`. So it keeps running after logout: `loginctl enable-linger $USER`. No systemd (e.g. some WSL setups): run `node bot/run.mjs` in the background from the shell profile instead.
   - Windows: fill `deploy/reels-bot.vbs` (backslashes in paths) into `"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\reels-bot.vbs"`, then start it now with `wscript "<that file>"`. It runs `bot/run.mjs` without a console window and restarts the bot if it stops.
   - Check: `data/bot.log` says `reels-bot up`.
8. **Owner.** Send the link `https://t.me/<username>?start=<OWNER_CODE>` (the code you made up in step 6) with one line: «Open it and press Start — this makes the bot yours». Then run `node bot/claim.mjs --wait-owner 900`: it returns as soon as they have pressed Start (prints their name). If it times out, say in one line «tell me when you've opened it» and wait again. Anyone else is turned away.
   If your harness will not let you show that link, use the confirmation instead: set `OWNER_CODE=` empty, restart the bot, send the plain `https://t.me/<username>`, run `node bot/claim.mjs --wait 600` (prints who pressed Start), ask **«<Name> (@<username>) pressed Start in the bot. Is that you?»** — `Yes, it's me (recommended)` / `No` — and run `node bot/claim.mjs --approve` or `--reject`.
9. **Done, and sleep.** As soon as the owner is connected: congratulate them in one line — the bot is theirs and already asked them in Telegram what the reels are about. Then one line: the bot works while this computer is on and awake (during a task it keeps the computer awake by itself). Ask: **«Keep the computer from falling asleep while it's on the charger?»** — `Yes (recommended)` / `No`. On yes, set `"keepAwake": true` in `studio/settings.json` yourself: the bot holds a «stay awake» request while on the charger (no system settings changed, no admin rights, undone when the bot stops) and picks it up within half a minute. Add, only for laptops: a closed lid still puts it to sleep. Then: type or dictate to the bot; ideas come every morning (time, days and sleep in `/settings`); `/stop` stops any task. Last line: if they ever want to change, stop, move or remove the bot, they can just write to you here (you will follow [MANAGE.md](MANAGE.md)).

Security note to pass on in one line: the bot runs the agent without permission prompts inside its folder, so it serves only its owner; keep the token private. If it ever leaks, send `/revoke` to @BotFather and give the new token to the agent.
