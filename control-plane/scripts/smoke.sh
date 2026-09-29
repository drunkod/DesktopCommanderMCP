#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/control-plane/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Run: just env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

echo "[1/4] Jazz TCP/HTTP endpoint"
curl --silent --show-error --max-time 3 \
  --output /dev/null "$JAZZ_SERVER_URL/"
echo "  reachable: $JAZZ_SERVER_URL"

echo "[2/4] Control-plane home"
curl --fail --silent --show-error --max-time 3 \
  --output /dev/null "$APP_ORIGIN/"
echo "  reachable: $APP_ORIGIN"
echo "[3/4] Better Auth JWKS"
curl --fail --silent --show-error --max-time 3 \
  "$JAZZ_JWKS_URL" | jq -e '.keys | length > 0' >/dev/null
echo "  JWKS published"

echo "[4/4] MCP endpoint requires authentication"
status="$(curl --silent --output /tmp/remote-mcp-jazz-smoke.$$ \
  --write-out '%{http_code}' --max-time 3 \
  -X POST "$REMOTE_MCP_RESOURCE" || true)"
rm -f /tmp/remote-mcp-jazz-smoke.$$
if [[ "$status" != "401" && "$status" != "403" ]]; then
  echo "Expected MCP auth challenge, got HTTP $status" >&2
  exit 1
fi
echo "  MCP correctly challenged unauthenticated request: HTTP $status"
echo "Smoke checks passed."
