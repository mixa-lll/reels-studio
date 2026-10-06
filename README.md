# reels-bot

A Telegram bot that makes reels with **your own coding agent** — Claude Code or Codex. Runs on macOS, Linux and Windows.

Every morning it pitches 4 ideas. You tap the ones you like; it picks a look and music with you, edits the video in [Remotion](https://www.remotion.dev) and sends it to the chat. After each version it sends its own review with suggested edits as buttons; tap one, open **🎛 Настроить подробнее** for a settings menu, or reply with your own edits by text or voice, and it renders the next version. Tap **✅ Принять и получить файл** for the full-quality file.

## Install in one message

Send this to your agent (Claude Code, Codex, …):

> Install a reels bot for me: https://github.com/fivol/reels-bot — follow SETUP.md.

It installs everything and asks you for one thing: to create a bot in [@BotFather](https://t.me/BotFather) and paste its reply. No files to edit, no terminal.

Manual install: the same steps, by hand, are in [SETUP.md](SETUP.md).

## How it works

- **You choose, it does the rest.** For ideas, look, music and edits the bot offers its own options as buttons, and anything you write instead wins: your idea, a track link, a reference video.
- **Fast or step by step.** After you pick an idea, choose «🚀 make it now» (the agent decides everything) or «🎛 set up step by step» (look, music and the key choices as button menus; «do the rest yourself» on every step).
- **Live progress.** One message shows what it is doing in plain words (🎵 picking music, 🖼 render 40%) and how long it has been at it, with **⏹ Stop** and **⚡ Take it now** buttons. Messages sent mid-task are queued (👀) and go in together; «take it now» interrupts the agent and hands them over at once.
- **Talk by voice.** Dictate ideas, answers and edits as voice messages; they are transcribed locally with Whisper, no API keys.
- **Memory in files, not in the chat.** Your brief, ideas backlog, taste playbook and every reel's history live in `studio/`. The agent session is just a cache: when it grows too big, too long or goes stale, the agent writes a handoff note and a fresh session continues from it. `/new` does the same on demand.
- **Updates itself.** Every 6 hours the bot checks this repo for new versions and, when idle, pulls them, restarts and tells you what changed. Your material in `studio/` is never touched; if you changed the bot locally, the agent merges. Say «don't update yourself» to turn it off.
- **It learns your taste.** General feedback («hook shorter than 4 s», «no shaking camera») goes into `studio/PLAYBOOK.md` and applies to every next reel.

Commands: `/ideas` — ideas now, `/unfinished` — get back to an unfinished reel, `/stop` — stop the current task, `/new` — fresh agent session.

## Layout

```
bot/          Telegram ↔ agent bridge (Node 22, no dependencies)
REELS.md      the workflow the agent follows
template/     Remotion starter copied into every reel
scripts/      new reel, render with progress, loudness, beat grid (Node, cross-platform)
starter/      seeds studio/ on first run
studio/       yours: brief, ideas, playbook, reels/  (gitignored)
data/         bot state, inbox, logs                 (gitignored)
```

Change settings by asking the bot («send ideas at 9», «stop sending ideas»). Technical settings — agent, model, session limits, speech model — are written by the installing agent into `.env` (see [.env.example](.env.example)).

## Good to know

- **Safety.** The bot runs your agent without permission prompts in this folder. Only the first person who writes to the bot (the owner) is served; keep the token private. It never publishes anything — posting is up to you.
- **Cost.** It uses your agent's subscription or API account. A reel with a few revisions is a handful of long agent turns.
- **Remotion license.** Free for individuals and companies of up to 3 people; larger companies need a [company license](https://www.remotion.dev/license).
- **Music.** The agent suggests royalty-free tracks (e.g. Mixkit). Check the license of anything you bring yourself.

MIT License.
