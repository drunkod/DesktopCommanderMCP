#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_RUNNER="$SCRIPT_DIR/run-local-stack.sh"
SOURCE_CUTOVER="$SCRIPT_DIR/cutover-control.sh"
NODE_EXECUTABLE="$(command -v node)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  printf 'run-local-stack maintenance integration: %s\n' "$1" >&2
  exit 1
}

wait_for_text() {
  local file="$1" text="$2" deadline=$((SECONDS + 15))
  until [[ -f "$file" ]] && grep -Fq -- "$text" "$file"; do
    if (( SECONDS >= deadline )); then
      [[ -f "$file" ]] && cat "$file" >&2
      fail "timed out waiting for '$text' in $file"
    fi
    sleep 0.1
  done
}
choose_ports() {
  local base=$((20000 + ($$ % 10000)))
  JAZZ_PORT="$base"
  WEB_PORT=$((base + 1))
  while /usr/bin/nc -z 127.0.0.1 "$JAZZ_PORT" >/dev/null 2>&1 \
    || /usr/bin/nc -z 127.0.0.1 "$WEB_PORT" >/dev/null 2>&1; do
    JAZZ_PORT=$((JAZZ_PORT + 2))
    WEB_PORT=$((WEB_PORT + 2))
  done
  export JAZZ_PORT WEB_PORT
}

run_case() {
  local mode="$1"
  local root="$TMP_DIR/$mode"
  local control="$root/apps/control-plane"
  local data="$root/.data"
  local ops="$root/ops/macos"
  local fake_pnpm="$root/fake-pnpm"
  local fake_tailscale="$root/fake-tailscale"
  local tailscale_log="$root/tailscale.log"
  local runner_log="$root/runner.log"
  local marker="$data/public-ingress.frozen"

  mkdir -p "$control/.next" "$data" "$ops"
  cp "$SOURCE_RUNNER" "$ops/run-local-stack.sh"
  cp "$SOURCE_CUTOVER" "$ops/cutover-control.sh"
  chmod +x "$ops/run-local-stack.sh" "$ops/cutover-control.sh"
  : >"$control/.env.local"
  printf 'fixture\n' >"$control/.next/BUILD_ID"
  : >"$tailscale_log"

  cat >"$fake_pnpm" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  jazz:serve)
    export FIXTURE_PORT="${JAZZ_PORT:?}"
    ;;
  start)
    export FIXTURE_PORT="${WEB_PORT:?}"
    ;;
  *)
    exit 91
    ;;
esac
exec "${FAKE_NODE_BIN:?}" -e '
const net = require("node:net");
const server = net.createServer((socket) => socket.end());
server.listen(Number(process.env.FIXTURE_PORT), "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
'
PNPM

  cat >"$fake_tailscale" <<'TAILSCALE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_TAILSCALE_LOG:?}"
case "$*" in
  'funnel status --json')
    printf '%s\n' '{"AllowFunnel":{},"Web":{}}'
    ;;
  'funnel status')
    ;;
  "funnel --bg --yes ${WEB_PORT:?}")
    ;;
  *)
    printf 'unsupported fake tailscale argv: %s\n' "$*" >&2
    exit 92
    ;;
esac
TAILSCALE

  chmod +x "$fake_pnpm" "$fake_tailscale"
  cat >"$data/launchd-runtime.env" <<EOF
NODE_BIN=$NODE_EXECUTABLE
PNPM_BIN=$fake_pnpm
TAILSCALE_BIN=$fake_tailscale
EOF

  if [[ "$mode" == frozen ]]; then
    printf 'frozen_at=test\n' >"$marker"
  fi

  choose_ports
  env \
    REMOTE_MCP_ROOT="$root" \
    REMOTE_MCP_RUNTIME_ENV="$data/launchd-runtime.env" \
    REMOTE_MCP_PUBLIC_INGRESS_FREEZE_FILE="$marker" \
    FAKE_NODE_BIN="$NODE_EXECUTABLE" \
    FAKE_TAILSCALE_LOG="$tailscale_log" \
    JAZZ_PORT="$JAZZ_PORT" \
    WEB_PORT="$WEB_PORT" \
    "$ops/run-local-stack.sh" >"$runner_log" 2>&1 &
  local runner_pid=$!

  if [[ "$mode" == frozen ]]; then
    wait_for_text "$tailscale_log" 'funnel status --json'
    if grep -Fq -- 'funnel --bg' "$tailscale_log"; then
      kill -TERM "$runner_pid" 2>/dev/null || true
      wait "$runner_pid" 2>/dev/null || true
      fail 'maintenance restart reopened Funnel'
    fi
    [[ -f "$marker" ]] || fail 'maintenance marker disappeared during restart'
  else
    wait_for_text "$tailscale_log" "funnel --bg --yes $WEB_PORT"
  fi

  wait_for_text "$runner_log" 'stack is healthy; monitoring child processes'
  kill -TERM "$runner_pid"
  wait "$runner_pid"
}

run_case frozen
run_case open

printf '%s\n' 'run-local-stack maintenance integration: ok (frozen restart stays closed; normal restart opens Funnel)'
