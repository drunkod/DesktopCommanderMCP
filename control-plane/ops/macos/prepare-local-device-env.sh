#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${REMOTE_MCP_ROOT:-$SCRIPT_ROOT}"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
ENV_FILE="${REMOTE_MCP_ENV_FILE:-$ROOT/apps/control-plane/.env.local}"
RUNTIME_ENV="${REMOTE_MCP_RUNTIME_ENV:-$ROOT/.data/launchd-runtime.env}"
OUTPUT="${REMOTE_MCP_DEVICE_ENV:-$ROOT/.data/device-agent.env}"
CONFIG_PATH="${DC_REMOTE_DEVICE_CONFIG_PATH:-$ROOT/.data/device-agent/device.json}"

[[ -f "$ENV_FILE" ]] || { echo "missing control-plane environment: $ENV_FILE" >&2; exit 1; }
[[ -f "$RUNTIME_ENV" ]] || { echo "missing runtime environment: $RUNTIME_ENV" >&2; exit 1; }

# Load the full server environment only inside this preparation process. The
# generated device environment below contains public routing values only.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
# shellcheck disable=SC1090
source "$RUNTIME_ENV"

: "${APP_ORIGIN:?APP_ORIGIN is required}"
: "${REMOTE_MCP_RESOURCE:?REMOTE_MCP_RESOURCE is required}"
: "${NODE_BIN:?NODE_BIN is required}"
[[ -x "$NODE_BIN" ]] || { echo "NODE_BIN is not executable: $NODE_BIN" >&2; exit 1; }
[[ "$CONFIG_PATH" = /* ]] || { echo "device config path must be absolute" >&2; exit 1; }

ISSUER="${APP_ORIGIN%/}/api/auth"
MCP_SERVER_URL="${MCP_SERVER_URL:-http://127.0.0.1:3000}"

mkdir -p "$(dirname "$OUTPUT")" "$(dirname "$CONFIG_PATH")"
tmp="$OUTPUT.tmp.$$"
{
  printf 'NODE_BIN=%q\n' "$NODE_BIN"
  printf 'DESKTOP_COMMANDER_REPO=%q\n' "$REPO_ROOT"
  printf 'DC_REMOTE_RUNTIME_PROFILE=%q\n' "production"
  printf 'DC_REMOTE_AUTH_ISSUER=%q\n' "$ISSUER"
  printf 'REMOTE_MCP_RESOURCE=%q\n' "$REMOTE_MCP_RESOURCE"
  printf 'MCP_SERVER_URL=%q\n' "$MCP_SERVER_URL"
  printf 'DC_REMOTE_DEVICE_CONFIG_PATH=%q\n' "$CONFIG_PATH"
} >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$OUTPUT"

echo "prepared public-only device environment: $OUTPUT"
echo "device config path: $CONFIG_PATH"