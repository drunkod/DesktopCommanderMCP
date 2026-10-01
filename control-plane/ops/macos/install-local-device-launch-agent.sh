#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.remote-mcp.local-device"
DOMAIN="gui/$(id -u)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
RUNNER="$ROOT/ops/macos/run-local-device.sh"
BASH_BIN="/run/current-system/sw/bin/bash"
DEVICE_ENV="$ROOT/.data/device-agent.env"

bootstrap_launch_agent() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "$DOMAIN" "$PLIST"; then
      return 0
    fi
    if (( attempt == 5 )); then
      echo "launchd bootstrap failed after $attempt attempts: $LABEL" >&2
      return 1
    fi
    echo "launchd bootstrap attempt $attempt failed; clearing partial state and retrying..." >&2
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    sleep "$attempt"
  done
}

ACTION="${1:-install}"
case "$ACTION" in
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
    exit 0
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL"
    exit $?
    ;;
  render|install) ;;
  *)
    echo "usage: $0 [render|install|uninstall|status]" >&2
    exit 2
    ;;
esac

for required in "$RUNNER" "$BASH_BIN" "$DEVICE_ENV"; do
  [[ -e "$required" ]] || { echo "missing required path: $required" >&2; exit 1; }
done

if [[ "$ACTION" == "install" ]]; then
  mkdir -p "$PLIST_DIR" "$HOME/Library/Logs"
  chmod +x "$RUNNER"
fi

if [[ "$ACTION" == "render" ]]; then
  TARGET_PLIST="$ROOT/.data/$LABEL.plist.rendered"
else
  TARGET_PLIST="$PLIST"
fi

TMP="$TARGET_PLIST.tmp.$$"
cat >"$TMP" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BASH_BIN</string>
    <string>$RUNNER</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/remote-mcp-local-device.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/remote-mcp-local-device.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REMOTE_MCP_ROOT</key><string>$ROOT</string>
    <key>HOME</key><string>$HOME</string>
    <key>TERM_PROGRAM</key><string>remote-mcp-local-device-launchd</string>
  </dict>
</dict>
</plist>
EOF

/usr/bin/plutil -lint "$TMP"
mv "$TMP" "$TARGET_PLIST"
chmod 600 "$TARGET_PLIST"

if [[ "$ACTION" == "render" ]]; then
  echo "Rendered $TARGET_PLIST"
  echo "No launchd service was modified."
  exit 0
fi

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
bootstrap_launch_agent
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed and started $LABEL"
echo "Status: $0 status"
echo "Logs:   $HOME/Library/Logs/remote-mcp-local-device.log"
echo "Errors: $HOME/Library/Logs/remote-mcp-local-device.error.log"
