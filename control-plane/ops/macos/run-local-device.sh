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
: "${JAZZ_APP_ID:?JAZZ_APP_ID is required}"
: "${JAZZ_SERVER_URL:?JAZZ_SERVER_URL is required}"
: "${MCP_SERVER_URL:?MCP_SERVER_URL is required}"
: "${DC_REMOTE_DEVICE_CONFIG_PATH:?DC_REMOTE_DEVICE_CONFIG_PATH is required}"
: "${DC_DEVICE_CREDENTIAL_SERVICE:?DC_DEVICE_CREDENTIAL_SERVICE is required}"
: "${DC_DEVICE_CREDENTIAL_ACCOUNT:?DC_DEVICE_CREDENTIAL_ACCOUNT is required}"
: "${DC_DEVICE_DPAPI_PATH:?DC_DEVICE_DPAPI_PATH is required}"
: "${DC_DEVICE_VAULT_LOCK_PATH:?DC_DEVICE_VAULT_LOCK_PATH is required}"
: "${DC_DEVICE_PAIRING_LOCK_PATH:?DC_DEVICE_PAIRING_LOCK_PATH is required}"
: "${DC_DEVICE_REFRESH_LOCK_PATH:?DC_DEVICE_REFRESH_LOCK_PATH is required}"

[[ -x "$NODE_BIN" ]] || { echo "NODE_BIN is not executable: $NODE_BIN" >&2; exit 1; }
[[ "$DC_REMOTE_RUNTIME_PROFILE" == "production" ]] || { echo "device runtime profile must be production" >&2; exit 1; }
[[ "$MCP_SERVER_URL" == "http://127.0.0.1:3000" ]] || { echo "device API origin must be the production loopback control plane" >&2; exit 1; }
[[ "$DC_REMOTE_DEVICE_CONFIG_PATH" = /* ]] || { echo "device config path must be absolute" >&2; exit 1; }
if [[ "$DC_DEVICE_CREDENTIAL_SERVICE" == "com.desktopcommander.remote-mcp" && "$DC_DEVICE_CREDENTIAL_ACCOUNT" == "device-oauth-session" ]]; then
  echo "refusing to use shared default credential namespace" >&2
  exit 1
fi
for path_value in "$DC_DEVICE_DPAPI_PATH" "$DC_DEVICE_VAULT_LOCK_PATH" "$DC_DEVICE_PAIRING_LOCK_PATH" "$DC_DEVICE_REFRESH_LOCK_PATH"; do
  [[ "$path_value" = /* ]] || { echo "device credential paths must be absolute" >&2; exit 1; }
done
legacy_state_path="$HOME/.desktop-commander-device"
for path_value in "$DC_REMOTE_DEVICE_CONFIG_PATH" "$DC_DEVICE_DPAPI_PATH" "$DC_DEVICE_VAULT_LOCK_PATH" "$DC_DEVICE_PAIRING_LOCK_PATH" "$DC_DEVICE_REFRESH_LOCK_PATH"; do
  if [[ "$path_value" == "$legacy_state_path" || "$path_value" == "$legacy_state_path/"* ]]; then
    echo "refusing legacy device state path" >&2
    exit 1
  fi
done
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
export JAZZ_APP_ID
export JAZZ_SERVER_URL
export MCP_SERVER_URL
export DC_REMOTE_DEVICE_CONFIG_PATH
export DC_DEVICE_CREDENTIAL_SERVICE
export DC_DEVICE_CREDENTIAL_ACCOUNT
export DC_DEVICE_DPAPI_PATH
export DC_DEVICE_VAULT_LOCK_PATH
export DC_DEVICE_PAIRING_LOCK_PATH
export DC_DEVICE_REFRESH_LOCK_PATH

READY_URL="${REMOTE_MCP_DEVICE_READY_URL:-${MCP_SERVER_URL%/}/.well-known/oauth-authorization-server/api/auth}"
READY_TIMEOUT_SECONDS="${REMOTE_MCP_DEVICE_READY_TIMEOUT_SECONDS:-45}"
[[ "$READY_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || { echo "device readiness timeout must be an integer" >&2; exit 1; }

wait_for_control_plane() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  while :; do
    if "$NODE_BIN" -e '
const [url, expectedIssuer] = process.argv.slice(1);
fetch(url, { signal: AbortSignal.timeout(1500) })
  .then(async (response) => {
    if (!response.ok) process.exit(1);
    const metadata = await response.json();
    if (!metadata || metadata.issuer !== expectedIssuer) process.exit(1);
  })
  .catch(() => process.exit(1));
' "$READY_URL" "$DC_REMOTE_AUTH_ISSUER"; then
      echo "local control plane is ready for device OAuth"
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "timed out waiting for local control plane OAuth metadata: $READY_URL" >&2
      return 1
    fi
    sleep 0.5
  done
}

wait_for_control_plane
exec "$NODE_BIN" "$DESKTOP_COMMANDER_REPO/dist/index.js" remote --tunnel none --disable-no-sleep
