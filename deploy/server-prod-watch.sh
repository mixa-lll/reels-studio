#!/bin/sh
# One-time server setup: production follows the GitHub `prod` branch.
# Run from a Mac with the ssh alias: ssh reels-server 'sh -s' < deploy/server-prod-watch.sh
set -e
F=/usr/local/bin/reels-deploy
sed -i 's|from GitHub main\. Run as root|from the GitHub prod branch. Run as root|; s|git fetch -q origin main|git fetch -q origin prod|; s|git reset -q --hard origin/main|git reset -q --hard origin/prod|' $F
cat > /usr/local/bin/reels-prod-watch <<'EOF'
#!/bin/sh
# Deploys production when the GitHub prod branch moves.
cd /home/reels/reels-bot || exit 1
sudo -u reels git fetch -q origin prod || exit 0
[ "$(sudo -u reels git rev-parse HEAD)" = "$(sudo -u reels git rev-parse origin/prod)" ] && exit 0
# A deploy restarts the studio and kills its children: wait while Claude or a render works.
if pgrep -u webdemo -f 'remotion-cli|scripts/render.mjs|claude -p|/claude ' >/dev/null; then
  echo "prod waiting: Claude or a render is working in the studio, next try in 2 min"
  exit 0
fi
/usr/local/bin/reels-deploy
EOF
chmod 755 /usr/local/bin/reels-prod-watch
cat > /etc/systemd/system/reels-prod-watch.service <<EOF
[Unit]
Description=Deploy production when the GitHub prod branch moves
[Service]
Type=oneshot
ExecStart=/usr/local/bin/reels-prod-watch
EOF
cat > /etc/systemd/system/reels-prod-watch.timer <<EOF
[Unit]
Description=Check the GitHub prod branch every 2 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF
# Manual deploys wait too, unless REELS_DEPLOY_FORCE=1.
grep -q REELS_DEPLOY_FORCE $F || sed -i 's|^set -e$|set -e\nif [ "$REELS_DEPLOY_FORCE" != 1 ] \&\& pgrep -u webdemo -f "remotion-cli\\|scripts/render.mjs\\|claude -p\\|/claude " >/dev/null; then\n  echo "Claude or a render is working in the studio — not restarting it now. Try later, or REELS_DEPLOY_FORCE=1 reels-deploy"\n  exit 3\nfi|' $F
systemctl daemon-reload
systemctl enable --now reels-prod-watch.timer
grep -n "origin" $F
echo "prod watch on"
