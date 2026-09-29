#!/usr/bin/env bash
set -euo pipefail
umask 077

MODE="${1:-}"
[[ "${MODE}" == "rehearsal" || "${MODE}" == "apply" || "${MODE}" == "recover" ]] || {
  printf '%s\n' 'usage: apply-jazz-clean-authority-handoff.sh rehearsal|apply|recover' >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
REPO_ROOT="$(cd -- "${ROOT}/.." && pwd -P)"
SQLITE=/usr/bin/sqlite3
SHASUM=/usr/bin/shasum
LSOF=/usr/sbin/lsof

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
realpath_py() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
same_device() {
  [[ "$(/usr/bin/stat -f '%d' "$1")" == "$(/usr/bin/stat -f '%d' "$2")" ]]
}

durable_journal_write() {
  local phase="$1"
  export JOURNAL phase HANDOFF_MODE CURRENT_SHA STAGE_DIR LIVE_AUTHORITY_DIR STAGED_AUTHORITY_DIR ROLLBACK_AUTHORITY_DIR RECOVERY_DIR RECOVERY_MANIFEST STAGE_MANIFEST
  python3 - <<'PY'
import json,os,tempfile,datetime
path=os.environ["JOURNAL"]; phase=os.environ["phase"]
if os.path.exists(path):
    payload=json.load(open(path,encoding="utf-8"))
else:
    payload={
      "version":1,
      "mode":os.environ["HANDOFF_MODE"],
      "gitSha":os.environ["CURRENT_SHA"],
      "stageDir":os.environ["STAGE_DIR"],
      "liveAuthorityDir":os.environ["LIVE_AUTHORITY_DIR"],
      "stagedAuthorityDir":os.environ["STAGED_AUTHORITY_DIR"],
      "rollbackAuthorityDir":os.environ["ROLLBACK_AUTHORITY_DIR"],
      "recoveryDir":os.environ["RECOVERY_DIR"],
      "recoveryManifest":os.environ["RECOVERY_MANIFEST"] or None,
      "stageManifest":os.environ["STAGE_MANIFEST"] or None,
      "servicesStartedAfterHandoff":False,
      "validationComplete":False,
    }
payload["phase"]=phase
payload["updatedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
if "createdAt" not in payload: payload["createdAt"]=payload["updatedAt"]
directory=os.path.dirname(path)
fd,tmp=tempfile.mkstemp(prefix=".handoff-journal.",dir=directory)
try:
    with os.fdopen(fd,"w",encoding="utf-8") as f:
        json.dump(payload,f,indent=2,sort_keys=True); f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp,0o600)
    os.replace(tmp,path)
    d=os.open(directory,os.O_RDONLY)
    try: os.fsync(d)
    finally: os.close(d)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
}

inject_soft_failure() {
  local point="$1"
  if [[ "${DEVICE_RESEED_HANDOFF_FAILPOINT:-}" == "${point}" ]]; then
    [[ "${HANDOFF_MODE}" == "rehearsal" ]] || fail "handoff failpoints are rehearsal-only"
    printf 'injected failure: %s\n' "${point}" >&2
    return 97
  fi
}

inject_hard_failure() {
  local point="$1"
  if [[ "${DEVICE_RESEED_HANDOFF_HARD_FAILPOINT:-}" == "${point}" ]]; then
    [[ "${HANDOFF_MODE}" == "rehearsal" ]] || fail "hard handoff failpoints are rehearsal-only"
    kill -KILL "$$"
  fi
}

archive_journal() {
  local terminal_phase="$1"
  durable_journal_write "${terminal_phase}"
  local stamp archive_dir archive
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  archive_dir="${RECOVERY_DIR}"
  mkdir -p "${archive_dir}"
  archive="${archive_dir}/handoff-journal-${terminal_phase}-${stamp}.json"
  mv "${JOURNAL}" "${archive}"
  printf 'journalArchive=%s\n' "${archive}"
}

if [[ "${MODE}" == "recover" ]]; then
  JOURNAL="${DEVICE_RESEED_HANDOFF_PENDING_MARKER:-${ROOT}/.data/reseed-handoff-pending-validation.json}"
  [[ -f "${JOURNAL}" ]] || fail "handoff journal is missing"
  eval "$(python3 - "${JOURNAL}" <<'PY'
import json,shlex,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
for k,j in {
 "HANDOFF_MODE":"mode","CURRENT_SHA":"gitSha","STAGE_DIR":"stageDir",
 "LIVE_AUTHORITY_DIR":"liveAuthorityDir","STAGED_AUTHORITY_DIR":"stagedAuthorityDir",
 "ROLLBACK_AUTHORITY_DIR":"rollbackAuthorityDir","RECOVERY_DIR":"recoveryDir",
 "RECOVERY_MANIFEST":"recoveryManifest","STAGE_MANIFEST":"stageManifest",
 "SERVICES_STARTED":"servicesStartedAfterHandoff","VALIDATION_COMPLETE":"validationComplete",
}.items():
    v=x.get(j,"")
    if isinstance(v,bool): v="true" if v else "false"
    print(k+"="+shlex.quote(str(v or "")))
PY
)"
  [[ "${SERVICES_STARTED}" != "true" && "${VALIDATION_COMPLETE}" != "true" ]] || fail "automatic recovery is forbidden after services start or validation completes"
  if [[ "${HANDOFF_MODE}" == "apply" ]]; then
    "${SCRIPT_DIR}/independent-control-preflight.sh" check >/dev/null
    for marker in "${ROOT}/.data/task-admission.frozen" "${ROOT}/.data/effect-admission.frozen" "${ROOT}/.data/public-ingress.frozen"; do
      [[ -f "${marker}" ]] || fail "handoff recovery requires freeze marker: ${marker##*/}"
    done
    ! launchctl print "gui/$(id -u)/com.remote-mcp.local-stack" >/dev/null 2>&1 || fail "launchd stack must be stopped before automatic handoff recovery"
    ! "${LSOF}" -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 || fail "port 3000 still has a listener"
    ! "${LSOF}" -nP -iTCP:1625 -sTCP:LISTEN >/dev/null 2>&1 || fail "port 1625 still has a listener"
  fi
  if [[ -d "${LIVE_AUTHORITY_DIR}" && -d "${STAGED_AUTHORITY_DIR}" && ! -e "${ROLLBACK_AUTHORITY_DIR}" ]]; then
    archive_journal "recovered-no-mutation"
    printf '%s\n' 'handoffRecovery=NO_MUTATION'
    exit 0
  fi
  if [[ ! -e "${LIVE_AUTHORITY_DIR}" && -d "${STAGED_AUTHORITY_DIR}" && -d "${ROLLBACK_AUTHORITY_DIR}" ]]; then
    mv "${ROLLBACK_AUTHORITY_DIR}" "${LIVE_AUTHORITY_DIR}"
    sync
    archive_journal "recovered-old-move"
    printf '%s\n' 'handoffRecovery=OLD_RESTORED'
    exit 0
  fi
  if [[ -d "${LIVE_AUTHORITY_DIR}" && ! -e "${STAGED_AUTHORITY_DIR}" && -d "${ROLLBACK_AUTHORITY_DIR}" ]]; then
    mv "${LIVE_AUTHORITY_DIR}" "${STAGED_AUTHORITY_DIR}"
    mv "${ROLLBACK_AUTHORITY_DIR}" "${LIVE_AUTHORITY_DIR}"
    sync
    archive_journal "recovered-new-move"
    printf '%s\n' 'handoffRecovery=OLD_RESTORED_STAGE_PRESERVED'
    exit 0
  fi
  fail "handoff directory state is ambiguous; manual recovery required"
fi

HANDOFF_MODE="${MODE}"
if [[ "${HANDOFF_MODE}" == "rehearsal" ]]; then
  REHEARSAL_ROOT="${DEVICE_RESEED_HANDOFF_REHEARSAL_ROOT:-}"
  [[ -n "${REHEARSAL_ROOT}" ]] || fail "DEVICE_RESEED_HANDOFF_REHEARSAL_ROOT is required"
  REAL_TMP="$(realpath_py /tmp)"
  REAL_REHEARSAL_ROOT="$(realpath_py "${REHEARSAL_ROOT}")"
  case "${REAL_REHEARSAL_ROOT}" in "${REAL_TMP}"/remote-mcp-jazz-handoff.*) ;; *) fail "rehearsal root must be under the system temporary directory" ;; esac
  LIVE_AUTHORITY_DIR="${DEVICE_RESEED_HANDOFF_LIVE_AUTHORITY_DIR:-}"
  STAGED_AUTHORITY_DIR="${DEVICE_RESEED_HANDOFF_STAGED_AUTHORITY_DIR:-}"
  ROLLBACK_AUTHORITY_DIR="${DEVICE_RESEED_HANDOFF_ROLLBACK_AUTHORITY_DIR:-}"
  JOURNAL="${DEVICE_RESEED_HANDOFF_PENDING_MARKER:-${REAL_REHEARSAL_ROOT}/pending-validation.json}"
  RECOVERY_DIR="${DEVICE_RESEED_HANDOFF_RECOVERY_DIR:-${REAL_REHEARSAL_ROOT}/recovery}"
  STAGE_DIR="$(dirname "${STAGED_AUTHORITY_DIR}")"
  RECOVERY_MANIFEST=""
  STAGE_MANIFEST=""
  CURRENT_SHA="rehearsal"
  for path in "${LIVE_AUTHORITY_DIR}" "${STAGED_AUTHORITY_DIR}" "${ROLLBACK_AUTHORITY_DIR}" "${JOURNAL}" "${RECOVERY_DIR}"; do
    [[ -n "${path}" ]] || fail "rehearsal handoff paths are required"
    mkdir -p "$(dirname "${path}")"
    parent="$(realpath_py "$(dirname "${path}")")"
    case "${parent}/" in "${REAL_REHEARSAL_ROOT}"/*|"${REAL_REHEARSAL_ROOT}/") ;; *) fail "rehearsal path escapes rehearsal root" ;; esac
  done
else
  [[ -x "${SQLITE}" && -x "${SHASUM}" ]] || fail "sqlite3 and shasum are required"
  "${SCRIPT_DIR}/independent-control-preflight.sh" check >/dev/null
  for marker in "${ROOT}/.data/task-admission.frozen" "${ROOT}/.data/effect-admission.frozen" "${ROOT}/.data/public-ingress.frozen"; do
    [[ -f "${marker}" ]] || fail "handoff requires freeze marker: ${marker##*/}"
  done
  ! launchctl print "gui/$(id -u)/com.remote-mcp.local-stack" >/dev/null 2>&1 || fail "launchd stack must be booted out before authority handoff"
  ! "${LSOF}" -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 || fail "port 3000 still has a listener"
  ! "${LSOF}" -nP -iTCP:1625 -sTCP:LISTEN >/dev/null 2>&1 || fail "port 1625 still has a listener"

  STAGE_DIR="${DEVICE_RESEED_STAGE_DIR:-}"
  RECOVERY_DIR="${DEVICE_RESEED_LIVE_RECOVERY_DIR:-}"
  [[ -n "${STAGE_DIR}" && -n "${RECOVERY_DIR}" ]] || fail "DEVICE_RESEED_STAGE_DIR and DEVICE_RESEED_LIVE_RECOVERY_DIR are required"
  REAL_STAGE_DIR="$(realpath_py "${STAGE_DIR}")"
  REAL_RECOVERY_DIR="$(realpath_py "${RECOVERY_DIR}")"
  STAGE_BASE="$(realpath_py "${ROOT}/.data/recovery-stage")"
  RECOVERY_BASE="$(realpath_py "${ROOT}/.data/recovery-live")"
  case "${REAL_STAGE_DIR}/" in "${STAGE_BASE}"/production-*"/") ;; *) fail "production stage must be a production-* directory under .data/recovery-stage" ;; esac
  case "${REAL_RECOVERY_DIR}/" in "${RECOVERY_BASE}"/*"/") ;; *) fail "recovery directory must be under .data/recovery-live" ;; esac
  STAGE_DIR="${REAL_STAGE_DIR}"; RECOVERY_DIR="${REAL_RECOVERY_DIR}"
  STAGE_MANIFEST="${STAGE_DIR}/stage-manifest.json"
  RECOVERY_MANIFEST="${RECOVERY_DIR}/recovery-manifest.json"
  [[ -f "${STAGE_MANIFEST}" && -f "${RECOVERY_MANIFEST}" ]] || fail "stage/recovery manifest is missing"
  "${SCRIPT_DIR}/verify-jazz-clean-reseed-frozen-state.sh" "${RECOVERY_MANIFEST}" >/dev/null

  STAGED_AUTHORITY_DIR="${STAGE_DIR}/authority"
  LIVE_AUTHORITY_DIR="${ROOT}/.data/jazz"
  ROLLBACK_AUTHORITY_DIR="${RECOVERY_DIR}/pre-apply-authority-dir"
  JOURNAL="${ROOT}/.data/reseed-handoff-pending-validation.json"
  CURRENT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  STAGE_MANIFEST_HASH="$("${SHASUM}" -a 256 "${STAGE_MANIFEST}" | awk '{print $1}')"
  RECOVERY_MANIFEST_HASH="$("${SHASUM}" -a 256 "${RECOVERY_MANIFEST}" | awk '{print $1}')"
  python3 - "${STAGE_MANIFEST}" "${RECOVERY_MANIFEST}" "${CURRENT_SHA}" "${STAGE_MANIFEST_HASH}" "${RECOVERY_MANIFEST_HASH}" <<'PY'
import hashlib,json,os,sys
s=json.load(open(sys.argv[1],encoding="utf-8")); r=json.load(open(sys.argv[2],encoding="utf-8"))
current,stage_hash,recovery_hash=sys.argv[3:6]
def require(ok,msg):
    if not ok: raise SystemExit("error: "+msg)
require(s.get("mode")=="production","stage manifest is not production mode")
require(s.get("stageReady") is True,"stage is not ready")
require(s.get("productionApplyAuthorized") is False,"stage must not self-authorize apply")
require(s.get("gitSha")==current,"stage Git SHA does not match current checkout")
require(r.get("gitSha")==current,"recovery manifest Git SHA does not match current checkout")
require(s.get("returningBackendCacheCompatible") is True,"stage did not prove backend cache compatibility")
require(s.get("postOldCacheFreshConvergence") is True,"stage did not prove post-cache fresh convergence")
require(os.path.realpath(s.get("recoveryManifestPath",""))==os.path.realpath(sys.argv[2]),"stage is bound to a different recovery manifest")
require(s.get("recoveryManifestSha256")==recovery_hash,"stage recovery-manifest hash mismatch")
require(s.get("sourceAuthoritySha256")==r.get("authoritySnapshotSha256"),"stage authority source hash differs from recovery manifest")
require(s.get("sourceBackendSha256")==r.get("backendSnapshotSha256"),"stage backend source hash differs from recovery manifest")
PY
  STAGE_DB="${STAGED_AUTHORITY_DIR}/jazz.sqlite"
  [[ -f "${STAGE_DB}" ]] || fail "staged authority SQLite file is missing"
  [[ "$("${SQLITE}" "${STAGE_DB}" 'PRAGMA quick_check;')" == "ok" ]] || fail "staged authority quick_check failed"
  EXPECTED_STAGE_HASH="$(python3 - "${STAGE_MANIFEST}" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8"))["stageAuthoritySqliteSha256"])
PY
)"
  [[ "$("${SHASUM}" -a 256 "${STAGE_DB}" | awk '{print $1}')" == "${EXPECTED_STAGE_HASH}" ]] || fail "staged authority hash does not match manifest"
fi

[[ -d "${LIVE_AUTHORITY_DIR}" && -d "${STAGED_AUTHORITY_DIR}" ]] || fail "live/staged authority directory is missing"
[[ ! -e "${ROLLBACK_AUTHORITY_DIR}" ]] || fail "rollback authority directory already exists"
[[ ! -e "${JOURNAL}" ]] || fail "handoff journal already exists"
same_device "${LIVE_AUTHORITY_DIR}" "${STAGED_AUTHORITY_DIR}" || fail "live and staged authority directories are not on the same filesystem"
same_device "${LIVE_AUTHORITY_DIR}" "$(dirname "${ROLLBACK_AUTHORITY_DIR}")" || fail "rollback directory is not on the same filesystem"

old_moved=0
new_moved=0
rollback_on_error() {
  local rc=$?
  set +e
  if [[ "${new_moved}" == "1" && -d "${LIVE_AUTHORITY_DIR}" && ! -e "${STAGED_AUTHORITY_DIR}" && -d "${ROLLBACK_AUTHORITY_DIR}" ]]; then
    mv "${LIVE_AUTHORITY_DIR}" "${STAGED_AUTHORITY_DIR}"
    mv "${ROLLBACK_AUTHORITY_DIR}" "${LIVE_AUTHORITY_DIR}"
  elif [[ "${old_moved}" == "1" && ! -e "${LIVE_AUTHORITY_DIR}" && -d "${ROLLBACK_AUTHORITY_DIR}" ]]; then
    mv "${ROLLBACK_AUTHORITY_DIR}" "${LIVE_AUTHORITY_DIR}"
  fi
  sync
  durable_journal_write "rolled-back-after-error" 2>/dev/null || true
  exit "${rc}"
}
trap rollback_on_error ERR INT TERM HUP

durable_journal_write "prepared"
inject_soft_failure "after-journal-prepared"
mv "${LIVE_AUTHORITY_DIR}" "${ROLLBACK_AUTHORITY_DIR}"
old_moved=1
inject_hard_failure "after-old-move-before-journal"
durable_journal_write "old-moved"
inject_soft_failure "after-journal-old-moved"
mv "${STAGED_AUTHORITY_DIR}" "${LIVE_AUTHORITY_DIR}"
new_moved=1
inject_hard_failure "after-new-move-before-journal"
durable_journal_write "new-live"
inject_soft_failure "after-journal-new-live"
sync
durable_journal_write "awaiting-validation"
trap - ERR INT TERM HUP

printf '%s\n' 'authority handoff: COMPLETE'
printf 'mode=%s\n' "${HANDOFF_MODE}"
printf 'rollbackAuthority=%s\n' "${ROLLBACK_AUTHORITY_DIR}"
printf 'pendingValidation=%s\n' "${JOURNAL}"
printf '%s\n' 'servicesStarted=false'
