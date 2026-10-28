#!/bin/sh
# One-time server setup: the staging studio gets its own Telegram bot (the test bot from
# /home/staging/env, never the production one), so invites on staging carry a t.me link.
# Run from a Mac with the ssh alias: ssh reels-server 'sh -s' < deploy/server-stage-bot.sh
set -e
D=/home/staging/reels-studio/data
# The owner is the same person as on production: copy only who it is, nothing else.
if [ ! -f $D/state.json ]; then
  python3 - <<EOF
import json
p = json.load(open('/home/reels/reels-bot/data/state.json'))
json.dump({k: p[k] for k in ('ownerId', 'ownerName', 'chatId') if k in p}, open('$D/state.json', 'w'))
EOF
fi
# Staging follows main through reels-stage-update; the bot does not offer its own updates.
[ -f $D/settings.json ] || echo '{"updateChecks": false}' > $D/settings.json
chown staging:staging $D/state.json $D/settings.json
chmod 600 $D/state.json
cat > /etc/systemd/system/reels-stage-bot.service <<EOF
[Unit]
Description=Reels Studio staging Telegram bot (test bot, staging data)
After=network-online.target reels-stage.service
[Service]
User=staging
WorkingDirectory=/home/staging/reels-studio
EnvironmentFile=/home/staging/env
Environment=MINIAPP_URL=https://stage-reels.mygudauri.org/app
Environment=REELS_BOT_SUPERVISED=1
Environment=DISABLE_AUTOUPDATER=1
ExecStartPre=/bin/rm -f /home/staging/reels-studio/data/bot.pid
ExecStart=/usr/bin/node /home/staging/reels-studio/bot/bot.mjs
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
# A staging update restarts the bot together with the studio.
grep -q reels-stage-bot /usr/local/bin/reels-stage-update || sed -i 's|^systemctl restart reels-stage$|systemctl restart reels-stage reels-stage-bot|' /usr/local/bin/reels-stage-update
systemctl daemon-reload
systemctl enable --now reels-stage-bot
sleep 8
systemctl is-active reels-stage-bot
cat /home/staging/reels-studio/data/shared/bot.json 2>/dev/null || echo "bot.json not written yet: journalctl -u reels-stage-bot -n 30"
echo
echo "staging bot on"
