# What this bot does on your computer

Written for the owner and for the agent that installs the bot: everything the code does, so it can be checked rather than trusted. The bot is ~2,100 lines of plain JavaScript in `bot/` and `scripts/`, with no npm dependencies; read them before installing.

## Who controls it

- **Only the owner.** The installer makes a secret link `t.me/<bot>?start=<OWNER_CODE>`; whoever opens it first becomes the owner (`bot/bot.mjs`, `onMessage`). Messages from anyone else are answered with one line and never reach the agent. Private chats only: added to a group, the bot leaves.
- **The agent acts only on the owner's behalf.** A turn of the agent starts only from: an owner's message or button tap, the daily batch of ideas at the time the owner set (`ideasAt`, can be turned off), or an update the owner approved. Nothing else, no remote commands.
- **No remote control by the author.** The repo cannot push code to your machine: the bot only *checks* for a new version and installs it after the owner taps «⬆️ Update» (`bot/update.mjs`). Checks can be turned off (`updateChecks: false`).
- **Stop at any time.** «⏹ Stop» or `/stop` kills the agent with every process it started, including background renders.

## Network

The bot itself talks to:

| Where | Why | Code |
|---|---|---|
| `api.telegram.org` | receive the owner's messages, send replies and files | `bot/telegram.mjs`, `bot/profile.mjs` |
| this repo on GitHub | every 6 hours: is there a new version (`git fetch`, or `api.github.com` when installed from an archive); the new version's code (`git pull` or `codeload.github.com`) only after the owner taps «Update» | `bot/update.mjs` |

Tools it starts may download what they need:

| Tool | Downloads | When |
|---|---|---|
| `npm install` | Remotion and React from the npm registry | setup; an approved update that changes `template/package*.json` |
| Remotion | headless Chromium; Google Fonts while rendering | setup; renders |
| `uv` installer (`astral.sh`) | `uv` itself, into `~/.local/bin`, no sudo, PATH untouched | the first voice message, if `uv` is missing |
| `uvx whisper-ctranslate2` | the speech-to-text package (PyPI) and model (Hugging Face) | the first voice message |

The agent (Claude Code or Codex) talks to its own provider and, while making a reel, may open web pages and download music the owner's request needs — the same as when you use it yourself.

**No telemetry, no analytics, no other endpoints.** Check: `grep -rn "http" bot scripts`.

## Processes

| Program | Why | Code |
|---|---|---|
| the agent CLI (`claude -p` / `codex exec`) | one turn per owner message, prompt on stdin | `bot/agents.mjs` |
| `git` (only in a git clone) / `tar` | update check and approved updates | `bot/update.mjs` |
| `npm` | template dependencies after an approved update | `bot/update.mjs` |
| `uv` installer, `uvx` | local speech-to-text (installed on first use) | `bot/stt.mjs` |
| `ffmpeg` / `ffprobe` | fit files into Telegram's limits, loudness | `bot/media.mjs`, `scripts/loudnorm.mjs` |
| `ps` / `taskkill` | find and stop the agent's processes on «Stop» | `bot/agents.mjs` |
| `node` | the bot, its supervisor, renders | `bot/run.mjs`, `scripts/render.mjs` |

## Files

- Written by the bot: `data/` (state, logs, files the owner sent, menus, render jobs, backups of bot files you edited before an update replaced them), `studio/` (brief, ideas, playbook, reels), `template/node_modules`; on an approved update, the bot's own files in this folder.
- In your home folder, only if a voice message arrives and `uv` is missing: `~/.local/bin/uv`, `~/.local/bin/uvx` and their caches.
- Outside the folder, once at setup: one autostart entry — `~/Library/LaunchAgents/com.reels-bot.plist` (macOS), `~/.config/systemd/user/reels-bot.service` (Linux) or `reels-bot.vbs` in the Startup folder (Windows).
- Secrets: the bot token and `OWNER_CODE` live only in `.env` (gitignored, never printed, never sent anywhere but Telegram).

## What the agent may do

The agent runs headless, so it cannot show permission prompts: it starts with them turned off (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`). Its limits are the rules in [REELS.md](REELS.md), which it follows as instructions:

- work inside the bot's folder; read other folders only when the owner named them or approved access with a button (remembered in `studio/settings.json`, `allowedPaths`);
- never publish, post or email anything; never edit the owner's product code;
- with Claude Code, use the owner's global plugins and MCP connections only if the owner said yes at setup (`agentGlobalSettings`).

This is a rule set, not an operating-system sandbox: the agent has the permissions of your user account, as it does in your terminal. That is why only the owner can talk to it. For hard isolation, run the bot under a separate OS user or in a container.

## Removing it

Delete the autostart entry, then the folder; send `/revoke` to @BotFather to kill the token.
