#!/bin/zsh
# Installs the BrowserLink hub as a login agent and registers it with Claude Code.
set -euo pipefail

ROOT=${0:A:h:h}
LABEL=com.jp.browserlink
PLIST=~/Library/LaunchAgents/$LABEL.plist
NODE=$(command -v node)
LOGDIR=~/Library/Logs/browserlink

cd "$ROOT" && npm install --omit=dev --silent
mkdir -p "$LOGDIR" ~/Library/LaunchAgents

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$ROOT/hub/server.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/hub.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/hub.log</string>
</dict>
</plist>
EOF

launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"

for i in {1..20}; do curl -sf http://127.0.0.1:47821/health >/dev/null && break; sleep 0.25; done
curl -sf http://127.0.0.1:47821/health >/dev/null || { echo "hub did not start; see $LOGDIR/hub.log"; exit 1; }

TOKEN=$(cat ~/.config/browserlink/token)
claude mcp remove --scope user browserlink >/dev/null 2>&1 || true
claude mcp add --scope user --transport http browserlink http://127.0.0.1:47821/mcp --header "Authorization: Bearer $TOKEN"

echo
echo "Hub running. Now load the extension in each Chrome profile:"
echo "  chrome://extensions → Developer mode → Load unpacked → $ROOT/extension"
