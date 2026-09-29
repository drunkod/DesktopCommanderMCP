#!/usr/bin/env bash
set -euo pipefail
umask 077

MODE="${1:-}"
[[ "${MODE}" == "rehearsal" || "${MODE}" == "apply" ]] || {
  printf '%s\n' 'usage: apply-jazz-clean-authority-handoff.sh rehearsal|apply' >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
REPO_ROOT="$(cd -- "${ROOT}/.." && pwd -P)"
SQLITE=/usr/bin/sqlite3
SHASUM=/usr/bin/shasum
LSOF=/usr/sbin/lsof

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

realpath_py() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

same_device() {
  local first second
  first="$(/usr/bin/stat -f '%d' "$1")"
  second="$(/usr/bin/stat -f '%d' "$2")"
  [[ "${first}" == "${second}" ]]
}

if [[ "${MODE}" == "rehearsal" ]]; then
  REHEARSAL_ROOT="${DEVICE_RESEED_HANDOFF_REHEARSAL_ROOT:-}"
  [[ -n "${REHEARSAL_ROOT}" ]] || fail "DEVICE_RESEED_HANDOFF_REHEARSAL_ROOT is required"
  REAL_REHEARSAL_ROOT="$(realpath_py "${REHEARSAL_ROOT}")"
  REAL_TMP="$(realpath_py /tmp)"
  case "${REAL_REHEARSAL_ROOT}" in "${REAL_TMP}"/remote-mcp-jazz-handoff.*) ;; *) fail "rehearsal root must be under the system temporary directory" ;; esac

  LIVE_AUTHORITY_DIR="${DEVICE_RESEED_HANDOFF_LIVE_AUTHORITY_DIR:-}"
  STAGED_AUTHORITY_DIR="${DEVICE_RESEED_HANDOFF_STAGED_AUTHORITY_DIR:-}"
  ROLLBACK_AUTHORITY_DIR="${DEVICE_RESEED_HANDOFF_ROLLBACK_AUTHORITY_DIR:-}"
  PENDING_MARKER="${DEVICE_RESEED_HANDOFF_PENDING_MARKER:-${REAL_REHEARSAL_ROOT}/pending-validation.json}"

  for path in "${LIVE_AUTHORITY_DIR}" "${STAGED_AUTHORITY_DIR}" "${ROLLBACK_AUTHORITY_DIR}" "${PENDING_MARKER}"; do
    [[ -n "${path}" ]] || fail "rehearsal handoff paths are required"
    parent="$(dirname "${path}")"
    mkdir -p "${parent}"
    real_parent="$(realpath_py "${parent}")"
    case "${real_parent}/" in "${REAL_REHEARSAL_ROOT}"/*|"${REAL_REHEARSAL_ROOT}/") ;; *) fail "rehearsal path escapes rehearsal root" ;; esac
  done
else
  [[ -x "${SQLITE}" && -x "${SHASUM}" ]] || fail "sqlite3 and shasum are required"
  "${SCRIPT_DIR}/independent-control-preflight.sh" check >/dev/null

  for marker in     "${ROOT}/.data/task-admission.frozen"     "${ROOT}/.data/effect-admission.frozen"     "${ROOT}/.data/public-ingress.frozen"; do
    [[ -f "${marker}" ]] || fail "handoff requires freeze marker: ${marker##*/}"
  done

  if launchctl print "gui/$(id -u)/com.remote-mcp.local-stack" >/dev/null 2>&1; then
    fail "launchd stack must be booted out before authority handoff"
  fi
  if "${LSOF}" -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then fail "port 3000 still has a listener"; fi
  if "${LSOF}" -nP -iTCP:1625 -sTCP:LISTEN >/dev/null 2>&1; then fail "port 1625 still has a listener"; fi

  STAGE_DIR="${DEVICE_RESEED_STAGE_DIR:-}"
  RECOVERY_DIR="${DEVICE_RESEED_LIVE_RECOVERY_DIR:-}"
  [[ -n "${STAGE_DIR}" && -n "${RECOVERY_DIR}" ]] || fail "DEVICE_RESEED_STAGE_DIR and DEVICE_RESEED_LIVE_RECOVERY_DIR are required"
  REAL_STAGE_DIR="$(realpath_py "${STAGE_DIR}")"
  REAL_RECOVERY_DIR="$(realpath_py "${RECOVERY_DIR}")"
  STAGE_BASE="$(realpath_py "${ROOT}/.data/recovery-stage")"
  RECOVERY_BASE="$(realpath_py "${ROOT}/.data/recovery-live")"
  case "${REAL_STAGE_DIR}/" in "${STAGE_BASE}"/production-*"/") ;; *) fail "production stage must be a production-* directory under .data/recovery-stage" ;; esac
  case "${REAL_RECOVERY_DIR}/" in "${RECOVERY_BASE}"/*"/") ;; *) fail "recovery directory must be under .data/recovery-live" ;; esac
  STAGE_MANIFEST="${REAL_STAGE_DIR}/stage-manifest.json"
  [[ -f "${STAGE_MANIFEST}" ]] || fail "stage manifest is missing"
  STAGED_AUTHORITY_DIR="${REAL_STAGE_DIR}/authority"
  LIVE_AUTHORITY_DIR="${ROOT}/.data/jazz"
  ROLLBACK_AUTHORITY_DIR="${REAL_RECOVERY_DIR}/pre-apply-authority-dir"
  PENDING_MARKER="${ROOT}/.data/reseed-handoff-pending-validation.json"

  [[ -d "${LIVE_AUTHORITY_DIR}" ]] || fail "live authority directory is missing"
  [[ -d "${STAGED_AUTHORITY_DIR}" ]] || fail "staged authority directory is missing"
  [[ ! -e "${ROLLBACK_AUTHORITY_DIR}" ]] || fail "rollback authority directory already exists"
  [[ ! -e "${PENDING_MARKER}" ]] || fail "pending-validation marker already exists"

  CURRENT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  python3 - "${STAGE_MANIFEST}" "${CURRENT_SHA}" "${REAL_RECOVERY_DIR}" <<'PY'
import json, os, sys
manifest=json.load(open(sys.argv[1],encoding="utf-8"))
current=sys.argv[2]
recovery=os.path.realpath(sys.argv[3])
def require(ok,msg):
    if not ok:
        raise SystemExit("error: "+msg)
require(manifest.get("mode")=="production","stage manifest is not production mode")
require(manifest.get("stageReady") is True,"stage is not ready")
require(manifest.get("productionApplyAuthorized") is False,"stage must not self-authorize production apply")
require(manifest.get("gitSha")==current,"stage Git SHA does not match current checkout")
require(manifest.get("returningBackendCacheCompatible") is True,"stage did not prove old backend cache compatibility")
require(manifest.get("postOldCacheFreshConvergence") is True,"stage did not prove post-cache fresh convergence")
for key in ("sourceAuthorityPath","sourceBackendPath"):
    value=os.path.realpath(manifest.get(key,""))
    require(value.startswith(recovery+os.sep),"stage source snapshots are not from the selected frozen recovery directory")
PY

  STAGE_DB="${STAGED_AUTHORITY_DIR}/jazz.sqlite"
  [[ -f "${STAGE_DB}" ]] || fail "staged authority SQLite file is missing"
  [[ "$("${SQLITE}" "${STAGE_DB}" 'PRAGMA quick_check;')" == "ok" ]] || fail "staged authority quick_check failed"
  EXPECTED_STAGE_HASH="$(python3 - "${STAGE_MANIFEST}" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8"))["stageAuthoritySqliteSha256"])
PY
)"
  ACTUAL_STAGE_HASH="$("${SHASUM}" -a 256 "${STAGE_DB}" | awk '{print $1}')"
  [[ "${ACTUAL_STAGE_HASH}" == "${EXPECTED_STAGE_HASH}" ]] || fail "staged authority hash does not match manifest"
fi

[[ -d "${LIVE_AUTHORITY_DIR}" ]] || fail "live authority directory does not exist"
[[ -d "${STAGED_AUTHORITY_DIR}" ]] || fail "staged authority directory does not exist"
[[ ! -e "${ROLLBACK_AUTHORITY_DIR}" ]] || fail "rollback destination already exists"
[[ ! -e "${PENDING_MARKER}" ]] || fail "pending marker already exists"

same_device "${LIVE_AUTHORITY_DIR}" "${STAGED_AUTHORITY_DIR}" || fail "live and staged authority directories are not on the same filesystem"
same_device "${LIVE_AUTHORITY_DIR}" "$(dirname "${ROLLBACK_AUTHORITY_DIR}")" || fail "rollback directory is not on the same filesystem"
HANDOFF_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
restore_needed=0
restore_on_failure() {
  local rc=$?
  if [[ "${restore_needed}" == "1" && ! -e "${LIVE_AUTHORITY_DIR}" && -d "${ROLLBACK_AUTHORITY_DIR}" ]]; then
    mv "${ROLLBACK_AUTHORITY_DIR}" "${LIVE_AUTHORITY_DIR}" || true
  fi
  exit "${rc}"
}
trap restore_on_failure ERR

mv "${LIVE_AUTHORITY_DIR}" "${ROLLBACK_AUTHORITY_DIR}"
restore_needed=1
mv "${STAGED_AUTHORITY_DIR}" "${LIVE_AUTHORITY_DIR}"
restore_needed=0
trap - ERR
sync

export HANDOFF_AT MODE LIVE_AUTHORITY_DIR ROLLBACK_AUTHORITY_DIR
if [[ "${MODE}" == "apply" ]]; then
  export STAGE_DIR REAL_RECOVERY_DIR CURRENT_SHA
else
  STAGE_DIR="$(dirname "${STAGED_AUTHORITY_DIR}")"
  REAL_RECOVERY_DIR="$(dirname "${ROLLBACK_AUTHORITY_DIR}")"
  CURRENT_SHA="rehearsal"
  export STAGE_DIR REAL_RECOVERY_DIR CURRENT_SHA
fi

python3 - "${PENDING_MARKER}" <<'PY'
import json, os, sys
payload={
  "handoffAt": os.environ["HANDOFF_AT"],
  "mode": os.environ["MODE"],
  "gitSha": os.environ["CURRENT_SHA"],
  "stageDir": os.environ["STAGE_DIR"],
  "liveAuthorityDir": os.environ["LIVE_AUTHORITY_DIR"],
  "rollbackAuthorityDir": os.environ["ROLLBACK_AUTHORITY_DIR"],
  "servicesStartedAfterHandoff": False,
  "validationComplete": False,
}
with open(sys.argv[1],"w",encoding="utf-8") as f:
    json.dump(payload,f,indent=2,sort_keys=True)
    f.write("\n")
PY
chmod 600 "${PENDING_MARKER}"

printf '%s\n' "authority handoff: COMPLETE"
printf 'mode=%s\n' "${MODE}"
printf 'rollbackAuthority=%s\n' "${ROLLBACK_AUTHORITY_DIR}"
printf 'pendingValidation=%s\n' "${PENDING_MARKER}"
printf '%s\n' "servicesStarted=false"
