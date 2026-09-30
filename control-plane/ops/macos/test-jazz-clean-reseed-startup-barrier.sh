#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_RUNNER="${SCRIPT_DIR}/run-local-stack.sh"
SOURCE_BARRIER="${SCRIPT_DIR}/mark-jazz-clean-reseed-startup-attempted.sh"
SOURCE_APPLY="${SCRIPT_DIR}/apply-jazz-clean-authority-handoff.sh"
NODE_EXECUTABLE="$(command -v node)"
ROOTS=()

cleanup() {
  for root in "${ROOTS[@]:-}"; do rm -rf -- "${root}"; done
}
trap cleanup EXIT

new_fixture() {
  ROOT="$(mktemp -d /tmp/remote-mcp-jazz-startup-barrier.XXXXXX)"
  ROOTS+=("${ROOT}")
  CONTROL="${ROOT}/apps/control-plane"
  DATA="${ROOT}/.data"
  OPS="${ROOT}/ops/macos"
  LIVE="${DATA}/jazz"
  STAGE_DIR="${ROOT}/stage"
  STAGED="${STAGE_DIR}/authority"
  RECOVERY="${ROOT}/recovery"
  ROLLBACK="${RECOVERY}/pre-apply-authority-dir"
  JOURNAL="${DATA}/reseed-handoff-pending-validation.json"
  PNPM_LOG="${ROOT}/pnpm.log"
  RUNNER_LOG="${ROOT}/runner.log"
  FAKE_PNPM="${ROOT}/fake-pnpm"
  FAKE_TAILSCALE="${ROOT}/fake-tailscale"

  mkdir -p "${CONTROL}/.next" "${DATA}" "${OPS}" "${LIVE}" "${ROLLBACK}" "${RECOVERY}"
  cp "${SOURCE_RUNNER}" "${OPS}/run-local-stack.sh"
  cp "${SOURCE_BARRIER}" "${OPS}/mark-jazz-clean-reseed-startup-attempted.sh"
  cp "${SOURCE_APPLY}" "${OPS}/apply-jazz-clean-authority-handoff.sh"
  chmod +x "${OPS}/run-local-stack.sh" "${OPS}/mark-jazz-clean-reseed-startup-attempted.sh" "${OPS}/apply-jazz-clean-authority-handoff.sh"

  : >"${CONTROL}/.env.local"
  printf 'fixture\n' >"${CONTROL}/.next/BUILD_ID"
  printf '%s\n' new >"${LIVE}/sentinel.txt"
  printf '%s\n' old >"${ROLLBACK}/sentinel.txt"
  : >"${PNPM_LOG}"

  cat >"${FAKE_PNPM}" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_PNPM_LOG:?}"
case "${1:-}" in
  jazz:serve)
    exit 93
    ;;
  start)
    exit 94
    ;;
  *)
    exit 95
    ;;
esac
PNPM

  cat >"${FAKE_TAILSCALE}" <<'TAILSCALE'
#!/usr/bin/env bash
exit 96
TAILSCALE
  chmod +x "${FAKE_PNPM}" "${FAKE_TAILSCALE}"

  cat >"${DATA}/launchd-runtime.env" <<EOF
NODE_BIN=${NODE_EXECUTABLE}
PNPM_BIN=${FAKE_PNPM}
TAILSCALE_BIN=${FAKE_TAILSCALE}
EOF

  python3 - "${JOURNAL}" "${ROOT}" "${STAGE_DIR}" "${LIVE}" "${STAGED}" "${ROLLBACK}" "${RECOVERY}" <<'PY'
import json,sys
path,root,stage,live,staged,rollback,recovery=sys.argv[1:8]
with open(path,"w",encoding="utf-8") as f:
    json.dump({
      "version":1,
      "mode":"rehearsal",
      "gitSha":"rehearsal",
      "phase":"awaiting-validation",
      "stageDir":stage,
      "liveAuthorityDir":live,
      "stagedAuthorityDir":staged,
      "rollbackAuthorityDir":rollback,
      "recoveryDir":recovery,
      "recoveryManifest":None,
      "stageManifest":None,
      "startupAttempted":False,
      "servicesStartedAfterHandoff":False,
      "validationComplete":False,
    },f,indent=2,sort_keys=True)
    f.write("\n")
PY
  chmod 600 "${JOURNAL}"

  base=$((30000 + ($$ % 5000)))
  export JAZZ_PORT="${base}"
  export WEB_PORT="$((base + 1))"
}

# Startup attempt must be journaled before jazz:serve runs. Jazz then fails
# before opening a listener, and automatic recovery must still be refused.
new_fixture
set +e
REMOTE_MCP_TESTING=1 REMOTE_MCP_ROOT="${ROOT}" REMOTE_MCP_RUNTIME_ENV="${DATA}/launchd-runtime.env" FAKE_PNPM_LOG="${PNPM_LOG}" JAZZ_PORT="${JAZZ_PORT}" WEB_PORT="${WEB_PORT}"   "${OPS}/run-local-stack.sh" >"${RUNNER_LOG}" 2>&1
runner_rc=$?
set -e
[[ "${runner_rc}" -ne 0 ]]
if ! grep -Fxq 'jazz:serve' "${PNPM_LOG}"; then
  cat "${RUNNER_LOG}" >&2
  exit 1
fi
python3 - "${JOURNAL}" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
assert x["phase"]=="startup-attempted"
assert x["startupAttempted"] is True
assert x["servicesStartedAfterHandoff"] is False
assert x["validationComplete"] is False
assert x.get("startupAttemptedAt")
PY
[[ ! -e "${STAGED}" ]]
[[ "$(cat "${LIVE}/sentinel.txt")" == "new" ]]
[[ "$(cat "${ROLLBACK}/sentinel.txt")" == "old" ]]

set +e
DEVICE_RESEED_HANDOFF_PENDING_MARKER="${JOURNAL}"   "${OPS}/apply-jazz-clean-authority-handoff.sh" recover >/dev/null 2>&1
recover_rc=$?
set -e
[[ "${recover_rc}" -ne 0 ]]
[[ ! -e "${STAGED}" ]]
[[ "$(cat "${LIVE}/sentinel.txt")" == "new" ]]
[[ "$(cat "${ROLLBACK}/sentinel.txt")" == "old" ]]

# If the barrier itself cannot be persisted, the runner must fail before any
# service command is invoked.
new_fixture
set +e
REMOTE_MCP_TESTING=1 DEVICE_RESEED_STARTUP_BARRIER_TEST_FAIL=1 REMOTE_MCP_ROOT="${ROOT}" REMOTE_MCP_RUNTIME_ENV="${DATA}/launchd-runtime.env" FAKE_PNPM_LOG="${PNPM_LOG}" JAZZ_PORT="${JAZZ_PORT}" WEB_PORT="${WEB_PORT}"   "${OPS}/run-local-stack.sh" >"${RUNNER_LOG}" 2>&1
barrier_rc=$?
set -e
[[ "${barrier_rc}" -ne 0 ]]
[[ ! -s "${PNPM_LOG}" ]]
python3 - "${JOURNAL}" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
assert x["phase"]=="awaiting-validation"
assert x["startupAttempted"] is False
PY

printf '%s\n' 'jazz clean reseed startup barrier: ok'
