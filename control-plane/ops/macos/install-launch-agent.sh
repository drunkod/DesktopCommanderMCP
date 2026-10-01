#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.remote-mcp.local-stack"
DOMAIN="gui/$(id -u)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
RUNNER="$ROOT/ops/macos/run-local-stack.sh"
BASH_BIN="/run/current-system/sw/bin/bash"
NIX_BIN="/nix/var/nix/profiles/default/bin/nix"
RUNTIME_PROFILE="$ROOT/.data/launchd-dev-profile"
RUNTIME_ENV="$ROOT/.data/launchd-runtime.env"

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
  *) echo "usage: $0 [render|install|uninstall|status]" >&2; exit 2 ;;
esac
for required in "$RUNNER" "$BASH_BIN" "$NIX_BIN"; do
  [[ -e "$required" ]] || { echo "missing required path: $required" >&2; exit 1; }
done

mkdir -p "$ROOT/.data"
if [[ "$ACTION" == "install" ]]; then
  mkdir -p "$PLIST_DIR" "$HOME/Library/Logs"
  chmod +x "$RUNNER"
fi

echo "Resolving pinned runtime from the repository Nix dev shell..."
RUNTIME_LINES="$($NIX_BIN develop "$ROOT" --profile "$RUNTIME_PROFILE" --command bash -c \
  'printf "__NODE__=%s\n__PNPM__=%s\n__TAILSCALE__=%s\n" "$(command -v node)" "$(command -v pnpm)" "$(command -v tailscale)"')"
NODE_BIN="$(printf '%s\n' "$RUNTIME_LINES" | sed -n 's/^__NODE__=//p' | tail -n 1)"
PNPM_BIN="$(printf '%s\n' "$RUNTIME_LINES" | sed -n 's/^__PNPM__=//p' | tail -n 1)"
TAILSCALE_BIN="$(printf '%s\n' "$RUNTIME_LINES" | sed -n 's/^__TAILSCALE__=//p' | tail -n 1)"

[[ -x "$NODE_BIN" ]] || { echo "resolved node is not executable: $NODE_BIN" >&2; exit 1; }
[[ -x "$PNPM_BIN" ]] || { echo "resolved pnpm is not executable: $PNPM_BIN" >&2; exit 1; }
[[ -x "$TAILSCALE_BIN" ]] || { echo "resolved tailscale is not executable: $TAILSCALE_BIN" >&2; exit 1; }

cat >"$RUNTIME_ENV" <<EOF
NODE_BIN=$NODE_BIN
PNPM_BIN=$PNPM_BIN
TAILSCALE_BIN=$TAILSCALE_BIN
EOF
chmod 600 "$RUNTIME_ENV"
echo "Pinned runtime: $($NODE_BIN --version), pnpm $($PNPM_BIN --version), tailscale $($TAILSCALE_BIN version | head -n 1)"

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
  <key>StandardOutPath</key><string>$HOME/Library/Logs/remote-mcp-local-stack.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/remote-mcp-local-stack.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REMOTE_MCP_ROOT</key><string>$ROOT</string>
    <key>REMOTE_MCP_RUNTIME_ENV</key><string>$RUNTIME_ENV</string>
    <key>TAILSCALE_BIN</key><string>$TAILSCALE_BIN</string>
    <key>HOME</key><string>$HOME</string>
    <key>TERM_PROGRAM</key><string>remote-mcp-launchd</string>
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
echo "Logs:   $HOME/Library/Logs/remote-mcp-local-stack.log"
echo "Errors: $HOME/Library/Logs/remote-mcp-local-stack.error.log"
