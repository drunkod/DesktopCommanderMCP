#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUTOVER_CONTROL="$SCRIPT_DIR/cutover-control.sh"
INDEPENDENT_PREFLIGHT="$SCRIPT_DIR/independent-control-preflight.sh"
NODE_EXECUTABLE="$(command -v node)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  printf 'cutover control integration: %s\n' "$1" >&2
  exit 1
}

assert_status() {
  local expected="$1" actual="$2" context="$3"
  [[ "$actual" -eq "$expected" ]] || fail "$context (expected exit $expected, got $actual)"
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file to exist: $1"
}

assert_absent() {
  [[ ! -e "$1" ]] || fail "expected file to be absent: $1"
}

assert_contains() {
  local file="$1" text="$2"
  rg -Fq -- "$text" "$file" || fail "expected '$text' in $file"
}

assert_not_contains() {
  local file="$1" text="$2"
  if rg -Fq -- "$text" "$file"; then
    fail "did not expect '$text' in $file"
  fi
}

RUNTIME_ROOT="$TMP_DIR/runtime"
mkdir -p "$RUNTIME_ROOT/.data"
RUNTIME_ENV="$RUNTIME_ROOT/runtime.env"
TASK_MARKER="$TMP_DIR/task-admission.frozen"
INGRESS_MARKER="$TMP_DIR/public-ingress.frozen"
EFFECT_MARKER="$TMP_DIR/effect-admission.frozen"
ATTESTATION="$TMP_DIR/independent-control.attestation"
TAILSCALE_FAKE="$TMP_DIR/tailscale"
PREFLIGHT_PASS="$TMP_DIR/preflight-pass"
PREFLIGHT_FAIL="$TMP_DIR/preflight-fail"
TAILSCALE_LOG="$TMP_DIR/tailscale.log"
PREFLIGHT_LOG="$TMP_DIR/preflight.log"
TAILSCALE_JSON="$TMP_DIR/tailscale.json"

cat >"$RUNTIME_ENV" <<EOF
NODE_BIN=$NODE_EXECUTABLE
TAILSCALE_BIN=$TAILSCALE_FAKE
EOF

cat >"$TAILSCALE_FAKE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_TAILSCALE_LOG"
case "$*" in
  'funnel status --json') cat "$FAKE_TAILSCALE_JSON" ;;
  'funnel status') exit 0 ;;
  'funnel reset') exit 0 ;;
  'funnel --bg --yes 3000') exit 0 ;;
  *) printf 'unsupported fake tailscale argv: %s\n' "$*" >&2; exit 90 ;;
esac
EOF

cat >"$PREFLIGHT_PASS" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 1 && "$1" == check ]] || exit 91
printf 'check\n' >>"$FAKE_PREFLIGHT_LOG"
EOF

cat >"$PREFLIGHT_FAIL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 1 && "$1" == check ]] || exit 91
printf 'check\n' >>"$FAKE_PREFLIGHT_LOG"
exit 17
EOF
chmod +x "$TAILSCALE_FAKE" "$PREFLIGHT_PASS" "$PREFLIGHT_FAIL"

run_cutover() {
  env \
    REMOTE_MCP_ROOT="$RUNTIME_ROOT" \
    REMOTE_MCP_RUNTIME_ENV="$RUNTIME_ENV" \
    REMOTE_MCP_TASK_ADMISSION_FREEZE_FILE="$TASK_MARKER" \
    REMOTE_MCP_EFFECT_ADMISSION_FREEZE_FILE="$EFFECT_MARKER" \
    REMOTE_MCP_PUBLIC_INGRESS_FREEZE_FILE="$INGRESS_MARKER" \
    REMOTE_MCP_INDEPENDENT_PREFLIGHT="$ACTIVE_PREFLIGHT" \
    REMOTE_MCP_INDEPENDENT_CONTROL_ATTESTATION="$ATTESTATION" \
    FAKE_TAILSCALE_LOG="$TAILSCALE_LOG" \
    FAKE_TAILSCALE_JSON="$TAILSCALE_JSON" \
    FAKE_PREFLIGHT_LOG="$PREFLIGHT_LOG" \
    "$CUTOVER_CONTROL" "$1"
}

set_active_funnel() {
  cat >"$TAILSCALE_JSON" <<EOF
{"AllowFunnel":{"example.ts.net:443":true},"Web":{"example.ts.net:443":{"Handlers":{"/":{"Proxy":"$1"}}}}}
EOF
}

# The real preflight must reject non-interactive attestation without creating a file.
set +e
env \
  REMOTE_MCP_ROOT="$RUNTIME_ROOT" \
  REMOTE_MCP_INDEPENDENT_CONTROL_ATTESTATION="$ATTESTATION" \
  "$INDEPENDENT_PREFLIGHT" attest </dev/null >"$TMP_DIR/attest.stdout" 2>"$TMP_DIR/attest.stderr"
status=$?
set -e
assert_status 1 "$status" 'non-interactive preflight attest'
assert_absent "$ATTESTATION"
assert_contains "$TMP_DIR/attest.stderr" 'independent control attestation requires an interactive TTY'

# A failing preflight stops ingress freeze before marker creation or Tailscale calls.
ACTIVE_PREFLIGHT="$PREFLIGHT_FAIL"
: >"$PREFLIGHT_LOG"
: >"$TAILSCALE_LOG"
set +e
run_cutover ingress-freeze
status=$?
set -e
assert_status 17 "$status" 'ingress-freeze with failing preflight'
assert_contains "$PREFLIGHT_LOG" 'check'
assert_absent "$INGRESS_MARKER"
[[ ! -s "$TAILSCALE_LOG" ]] || fail 'Tailscale was called after failing preflight'

# Freeze checks ownership and resets only the active funnel owned by this service.
ACTIVE_PREFLIGHT="$PREFLIGHT_PASS"
: >"$PREFLIGHT_LOG"
: >"$TAILSCALE_LOG"
set_active_funnel 'http://127.0.0.1:3000'
run_cutover ingress-freeze
assert_contains "$PREFLIGHT_LOG" 'check'
assert_file "$INGRESS_MARKER"
assert_contains "$TAILSCALE_LOG" 'funnel status --json'
assert_contains "$TAILSCALE_LOG" 'funnel reset'

# Enforcing a frozen state with no active funnel preserves the marker and skips preflight/reset.
: >"$PREFLIGHT_LOG"
: >"$TAILSCALE_LOG"
printf '{"AllowFunnel":{},"Web":{}}\n' >"$TAILSCALE_JSON"
run_cutover ingress-enforce-frozen
assert_file "$INGRESS_MARKER"
[[ ! -s "$PREFLIGHT_LOG" ]] || fail 'preflight was called by ingress-enforce-frozen'
assert_contains "$TAILSCALE_LOG" 'funnel status --json'
assert_not_contains "$TAILSCALE_LOG" 'funnel reset'

# A foreign active funnel is rejected and never reset.
: >"$TAILSCALE_LOG"
set_active_funnel 'http://127.0.0.1:9999'
set +e
run_cutover ingress-enforce-frozen
status=$?
set -e
assert_status 1 "$status" 'ingress-enforce-frozen with foreign funnel'
assert_file "$INGRESS_MARKER"
assert_not_contains "$TAILSCALE_LOG" 'funnel reset'

# A failing preflight keeps ingress closed without contacting Tailscale.
ACTIVE_PREFLIGHT="$PREFLIGHT_FAIL"
: >"$PREFLIGHT_LOG"
: >"$TAILSCALE_LOG"
set +e
run_cutover ingress-open
status=$?
set -e
assert_status 17 "$status" 'ingress-open with failing preflight'
assert_file "$INGRESS_MARKER"
assert_contains "$PREFLIGHT_LOG" 'check'
[[ ! -s "$TAILSCALE_LOG" ]] || fail 'Tailscale was called after failing ingress-open preflight'

# A passing preflight opens Funnel and removes the marker after both calls succeed.
ACTIVE_PREFLIGHT="$PREFLIGHT_PASS"
: >"$PREFLIGHT_LOG"
: >"$TAILSCALE_LOG"
printf '{"AllowFunnel":{},"Web":{}}\n' >"$TAILSCALE_JSON"
run_cutover ingress-open
assert_contains "$PREFLIGHT_LOG" 'check'
assert_contains "$TAILSCALE_LOG" 'funnel --bg --yes 3000'
assert_contains "$TAILSCALE_LOG" 'funnel status'
assert_absent "$INGRESS_MARKER"

# Task admission markers are independent of preflight and Funnel.
: >"$PREFLIGHT_LOG"
: >"$TAILSCALE_LOG"
run_cutover task-freeze
assert_file "$TASK_MARKER"
run_cutover task-open
assert_absent "$TASK_MARKER"
run_cutover effect-freeze
assert_file "$EFFECT_MARKER"
run_cutover effect-open
assert_absent "$EFFECT_MARKER"
[[ ! -s "$PREFLIGHT_LOG" ]] || fail 'preflight was called by task admission commands'
[[ ! -s "$TAILSCALE_LOG" ]] || fail 'Tailscale was called by task admission commands'

printf '%s\n' 'cutover control integration: ok (preflight, ownership, persistence, reopen)'
