#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${REMOTE_MCP_ROOT:-$SCRIPT_ROOT}"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
ENV_FILE="${REMOTE_MCP_ENV_FILE:-$ROOT/apps/control-plane/.env.local}"
RUNTIME_ENV="${REMOTE_MCP_RUNTIME_ENV:-$ROOT/.data/launchd-runtime.env}"
OUTPUT="${REMOTE_MCP_DEVICE_ENV:-$ROOT/.data/device-agent.env}"
DEVICE_STATE_DIR="${REMOTE_MCP_DEVICE_STATE_DIR:-$ROOT/.data/device-agent}"
CONFIG_PATH="${DC_REMOTE_DEVICE_CONFIG_PATH:-$DEVICE_STATE_DIR/device.json}"
CREDENTIAL_SERVICE="${DC_DEVICE_CREDENTIAL_SERVICE:-com.desktopcommander.remote-mcp.local-jazz}"
CREDENTIAL_ACCOUNT="${DC_DEVICE_CREDENTIAL_ACCOUNT:-device-oauth-session}"
DPAPI_PATH="${DC_DEVICE_DPAPI_PATH:-$DEVICE_STATE_DIR/jazz-oauth.dpapi}"
VAULT_LOCK_PATH="${DC_DEVICE_VAULT_LOCK_PATH:-$DEVICE_STATE_DIR/locks/device-oauth.lock}"
PAIRING_LOCK_PATH="${DC_DEVICE_PAIRING_LOCK_PATH:-$DEVICE_STATE_DIR/locks/device-oauth-pairing.lock}"
REFRESH_LOCK_PATH="${DC_DEVICE_REFRESH_LOCK_PATH:-$DEVICE_STATE_DIR/locks/device-oauth-refresh.lock}"

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
identifier_regex='^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
[[ "$CREDENTIAL_SERVICE" =~ $identifier_regex ]] || { echo "DC_DEVICE_CREDENTIAL_SERVICE is invalid" >&2; exit 1; }
[[ "$CREDENTIAL_ACCOUNT" =~ $identifier_regex ]] || { echo "DC_DEVICE_CREDENTIAL_ACCOUNT is invalid" >&2; exit 1; }
for path_value in "$DPAPI_PATH" "$VAULT_LOCK_PATH" "$PAIRING_LOCK_PATH" "$REFRESH_LOCK_PATH"; do
  [[ "$path_value" = /* ]] || { echo "device credential paths must be absolute" >&2; exit 1; }
done

ISSUER="${APP_ORIGIN%/}/api/auth"
MCP_SERVER_URL="${MCP_SERVER_URL:-http://127.0.0.1:3000}"

mkdir -p "$DEVICE_STATE_DIR" "$(dirname "$OUTPUT")" "$(dirname "$CONFIG_PATH")" \
  "$(dirname "$DPAPI_PATH")" "$(dirname "$VAULT_LOCK_PATH")" "$(dirname "$PAIRING_LOCK_PATH")" "$(dirname "$REFRESH_LOCK_PATH")"
chmod 700 "$DEVICE_STATE_DIR"
tmp="$OUTPUT.tmp.$$"
{
  printf 'NODE_BIN=%q\n' "$NODE_BIN"
  printf 'DESKTOP_COMMANDER_REPO=%q\n' "$REPO_ROOT"
  printf 'DC_REMOTE_RUNTIME_PROFILE=%q\n' "production"
  printf 'DC_REMOTE_AUTH_ISSUER=%q\n' "$ISSUER"
  printf 'REMOTE_MCP_RESOURCE=%q\n' "$REMOTE_MCP_RESOURCE"
  printf 'MCP_SERVER_URL=%q\n' "$MCP_SERVER_URL"
  printf 'DC_REMOTE_DEVICE_CONFIG_PATH=%q\n' "$CONFIG_PATH"
  printf 'DC_DEVICE_CREDENTIAL_SERVICE=%q\n' "$CREDENTIAL_SERVICE"
  printf 'DC_DEVICE_CREDENTIAL_ACCOUNT=%q\n' "$CREDENTIAL_ACCOUNT"
  printf 'DC_DEVICE_DPAPI_PATH=%q\n' "$DPAPI_PATH"
  printf 'DC_DEVICE_VAULT_LOCK_PATH=%q\n' "$VAULT_LOCK_PATH"
  printf 'DC_DEVICE_PAIRING_LOCK_PATH=%q\n' "$PAIRING_LOCK_PATH"
  printf 'DC_DEVICE_REFRESH_LOCK_PATH=%q\n' "$REFRESH_LOCK_PATH"
} >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$OUTPUT"

echo "prepared public-only device environment: $OUTPUT"
echo "device config path: $CONFIG_PATH"
