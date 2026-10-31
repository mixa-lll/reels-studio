#!/bin/sh
# Studio on your own computer, reachable from a phone and from Telegram: a tunnel to the local
# studio, no account needed. TUNNEL=lhr (default) — localhost.run over SSH; TUNNEL=cloudflare —
# a Cloudflare quick tunnel (some networks and VPNs block its connection). The link changes on
# every start, and localhost.run may change it while running, so each new link is written into
# .env as MINIAPP_URL and the bot is restarted to put it on the mini app button.
# Autostart: deploy/reels-tunnel.plist (macOS, label com.reels-tunnel). Log: data/tunnel.log.
cd "$(dirname "$0")/.." || exit 1
PORT="${PORT:-8080}"
LOG=data/tunnel.log
mkdir -p data
: > "$LOG.url"

if [ "${TUNNEL:-lhr}" = cloudflare ]; then
  # The SRV lookup cloudflared uses to find Cloudflare's edge breaks on some networks; the plain
  # addresses still resolve, so give them directly.
  EDGE=""
  for h in region1.v2.argotunnel.com region2.v2.argotunnel.com; do
    for ip in $(dig +short "$h" 2>/dev/null | head -2); do EDGE="$EDGE --edge $ip:7844"; done
  done
  run() { cloudflared tunnel --no-autoupdate --protocol http2 $EDGE --url "http://127.0.0.1:$PORT" 2>&1; }
  pattern='https://[a-z0-9-]*\.trycloudflare\.com'
else
  run() { ssh -T -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R "80:127.0.0.1:$PORT" nokey@localhost.run 2>&1; }
  pattern='https://[a-z0-9-]*\.lhr\.life'
fi

run | while IFS= read -r line; do
  echo "$line"
  url=$(printf '%s' "$line" | grep -o "$pattern" | head -1)
  if [ -n "$url" ] && [ "$url" != "$(cat "$LOG.url")" ]; then
    echo "$url" > "$LOG.url"
    if grep -q '^MINIAPP_URL=' .env; then
      sed -i '' "s#^MINIAPP_URL=.*#MINIAPP_URL=$url/app#" .env
    else
      echo "MINIAPP_URL=$url/app" >> .env
    fi
    echo "studio link: $url (mini app: $url/app)"
    launchctl kickstart -k "gui/$(id -u)/com.reels-bot" 2>/dev/null
  fi
done
