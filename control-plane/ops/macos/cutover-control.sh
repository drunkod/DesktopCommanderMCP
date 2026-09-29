#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${REMOTE_MCP_ROOT:-$SCRIPT_ROOT}"
RUNTIME_ENV="${REMOTE_MCP_RUNTIME_ENV:-$ROOT/.data/launchd-runtime.env}"
TASK_FREEZE_FILE="${REMOTE_MCP_TASK_ADMISSION_FREEZE_FILE:-$ROOT/.data/task-admission.frozen}"
EFFECT_FREEZE_FILE="${REMOTE_MCP_EFFECT_ADMISSION_FREEZE_FILE:-$ROOT/.data/effect-admission.frozen}"
INGRESS_FREEZE_FILE="${REMOTE_MCP_PUBLIC_INGRESS_FREEZE_FILE:-$ROOT/.data/public-ingress.frozen}"
WEB_PORT="${WEB_PORT:-3000}"
TARGET="http://127.0.0.1:$WEB_PORT"
PREFLIGHT="${REMOTE_MCP_INDEPENDENT_PREFLIGHT:-$ROOT/ops/macos/independent-control-preflight.sh}"
mkdir -p "$ROOT/.data"

usage() {
  printf 'Usage: %s {task-freeze|task-open|effect-freeze|effect-open|ingress-freeze|ingress-enforce-frozen|ingress-open|status}\n' "$0" >&2
}

atomic_freeze() {
  local marker="$1"
  local temporary
  temporary="$(mktemp "${marker}.tmp.XXXXXX")"
  printf 'frozen_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$marker"
}

funnel_ownership() {
  local funnel_json
  funnel_json="$("$TAILSCALE_BIN" funnel status --json)" || return 2
  "$NODE_BIN" -e '
const data = JSON.parse(process.argv[1]);
const expected = process.argv[2];
const allow = data.AllowFunnel || data.allowFunnel || {};
const web = data.Web || data.web || {};
const activeHosts = Object.entries(allow).filter(([hostPort, value]) => value === true && hostPort.endsWith(":443"));
if (activeHosts.length === 0) process.exit(3);
let target;
try {
  target = new URL(expected).toString().replace(/\/$/, "");
} catch {
  process.exit(4);
}
for (const [hostPort] of activeHosts) {
  const entry = web[hostPort];
  const handlers = entry && (entry.Handlers || entry.handlers);
  if (!handlers || typeof handlers !== "object") process.exit(4);
  const proxies = Object.values(handlers).map((handler) => handler && (handler.Proxy || handler.proxy)).filter((proxy) => typeof proxy === "string");
  if (proxies.length === 0) process.exit(4);
  for (const proxy of proxies) {
    let normalized;
    try {
      normalized = new URL(proxy).toString().replace(/\/$/, "");
    } catch {
      process.exit(4);
    }
    if (normalized !== target) process.exit(4);
  }
}
' "$funnel_json" "$TARGET"
}

if [[ ! -f "$RUNTIME_ENV" ]]; then
  printf 'runtime env is missing: %s\n' "$RUNTIME_ENV" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$RUNTIME_ENV"
: "${NODE_BIN:?NODE_BIN missing from runtime env}"
: "${TAILSCALE_BIN:?TAILSCALE_BIN missing from runtime env}"
[[ -x "$NODE_BIN" ]] || { printf 'NODE_BIN is not executable: %s\n' "$NODE_BIN" >&2; exit 1; }
[[ -x "$TAILSCALE_BIN" ]] || { printf 'TAILSCALE_BIN is not executable: %s\n' "$TAILSCALE_BIN" >&2; exit 1; }

command_name="${1:-}"
if [[ "$#" -ne 1 ]]; then
  usage
  exit 2
fi

case "$command_name" in
  task-freeze)
    atomic_freeze "$TASK_FREEZE_FILE"
    printf 'Task admission frozen; worker completion tools remain available.\n'
    ;;
  task-open)
    rm -f "$TASK_FREEZE_FILE"
    ;;
  effect-freeze)
    atomic_freeze "$EFFECT_FREEZE_FILE"
    printf 'Device effect admission frozen.\n'
    ;;
  effect-open)
    rm -f "$EFFECT_FREEZE_FILE"
    ;;
  ingress-freeze)
    "$PREFLIGHT" check
    atomic_freeze "$INGRESS_FREEZE_FILE"
    if funnel_ownership; then
      ownership_result=0
    else
      ownership_result=$?
    fi
    case "$ownership_result" in
      3) ;;
      0) "$TAILSCALE_BIN" funnel reset ;;
      *) printf 'Funnel ownership is unknown or foreign; refusing to reset.\n' >&2; exit 1 ;;
    esac
    ;;
  ingress-enforce-frozen)
    atomic_freeze "$INGRESS_FREEZE_FILE"
    if funnel_ownership; then
      ownership_result=0
    else
      ownership_result=$?
    fi
    case "$ownership_result" in
      3) ;;
      0) "$TAILSCALE_BIN" funnel reset ;;
      *) printf 'Funnel ownership is unknown or foreign; refusing to reset.\n' >&2; exit 1 ;;
    esac
    ;;
  ingress-open)
    "$PREFLIGHT" check
    "$TAILSCALE_BIN" funnel --bg --yes "$WEB_PORT"
    "$TAILSCALE_BIN" funnel status
    rm -f "$INGRESS_FREEZE_FILE"
    ;;
  status)
    if [[ -e "$TASK_FREEZE_FILE" ]]; then printf 'task_admission=frozen\n'; else printf 'task_admission=open\n'; fi
    if [[ -e "$EFFECT_FREEZE_FILE" ]]; then printf 'effect_admission=frozen\n'; else printf 'effect_admission=open\n'; fi
    if [[ -e "$INGRESS_FREEZE_FILE" ]]; then printf 'public_ingress=frozen\n'; else printf 'public_ingress=open\n'; fi
    "$TAILSCALE_BIN" funnel status
    ;;
  *)
    usage
    exit 2
    ;;
esac
