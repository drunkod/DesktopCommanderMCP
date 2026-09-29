#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${REMOTE_MCP_ROOT:-$SCRIPT_ROOT}"
DEVICE_ENV="${REMOTE_MCP_DEVICE_ENV:-$ROOT/.data/device-agent.env}"

[[ -f "$DEVICE_ENV" ]] || { echo "missing device environment: $DEVICE_ENV" >&2; exit 1; }
# shellcheck disable=SC1090
source "$DEVICE_ENV"

: "${NODE_BIN:?NODE_BIN is required}"
: "${DESKTOP_COMMANDER_REPO:?DESKTOP_COMMANDER_REPO is required}"
: "${DC_REMOTE_RUNTIME_PROFILE:?DC_REMOTE_RUNTIME_PROFILE is required}"
: "${DC_REMOTE_AUTH_ISSUER:?DC_REMOTE_AUTH_ISSUER is required}"
: "${REMOTE_MCP_RESOURCE:?REMOTE_MCP_RESOURCE is required}"
: "${MCP_SERVER_URL:?MCP_SERVER_URL is required}"
: "${DC_REMOTE_DEVICE_CONFIG_PATH:?DC_REMOTE_DEVICE_CONFIG_PATH is required}"

[[ -x "$NODE_BIN" ]] || { echo "NODE_BIN is not executable: $NODE_BIN" >&2; exit 1; }
[[ "$DC_REMOTE_RUNTIME_PROFILE" == "production" ]] || { echo "device runtime profile must be production" >&2; exit 1; }
[[ "$MCP_SERVER_URL" == "http://127.0.0.1:3000" ]] || { echo "device API origin must be the production loopback control plane" >&2; exit 1; }
[[ "$DC_REMOTE_DEVICE_CONFIG_PATH" = /* ]] || { echo "device config path must be absolute" >&2; exit 1; }
[[ "$DC_REMOTE_DEVICE_CONFIG_PATH" != "$HOME/.desktop-commander-device/device.json" ]] || {
  echo "refusing to use the legacy/default device config path" >&2
  exit 1
}
[[ -f "$DC_REMOTE_DEVICE_CONFIG_PATH" ]] || {
  echo "isolated device config is missing; reconcile/create it before starting the device" >&2
  exit 1
}
[[ -f "$DESKTOP_COMMANDER_REPO/dist/index.js" ]] || {
  echo "Desktop Commander build is missing: $DESKTOP_COMMANDER_REPO/dist/index.js" >&2
  exit 1
}

"$NODE_BIN" -e '
const fs = require("node:fs");
const path = process.argv[1];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1
    || typeof value.stableId !== "string"
    || value.stableId.length === 0) process.exit(1);
' "$DC_REMOTE_DEVICE_CONFIG_PATH" || {
  echo "isolated device config must contain only a non-empty stableId" >&2
  exit 1
}

export DC_REMOTE_RUNTIME_PROFILE
export DC_REMOTE_AUTH_ISSUER
export REMOTE_MCP_RESOURCE
export MCP_SERVER_URL
export DC_REMOTE_DEVICE_CONFIG_PATH

exec "$NODE_BIN" "$DESKTOP_COMMANDER_REPO/dist/index.js" remote --tunnel none --disable-no-sleep