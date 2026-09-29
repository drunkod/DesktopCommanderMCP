#!/usr/bin/env bash
set -euo pipefail
umask 077

MODE="${1:-production}"
[[ "${MODE}" == "production" || "${MODE}" == "rehearsal" ]] || {
  printf '%s\n' 'usage: verify-jazz-clean-authority-post-handoff.sh [production|rehearsal]' >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
APP_DIR="${ROOT}/apps/control-plane"
LSOF=/usr/sbin/lsof

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
realpath_py() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

if [[ "${MODE}" == "production" ]]; then
  PENDING="${ROOT}/.data/reseed-handoff-pending-validation.json"
  "${SCRIPT_DIR}/independent-control-preflight.sh" check >/dev/null
  for marker in "${ROOT}/.data/task-admission.frozen" "${ROOT}/.data/effect-admission.frozen" "${ROOT}/.data/public-ingress.frozen"; do
    [[ -f "${marker}" ]] || fail "post-handoff validation requires freeze marker: ${marker##*/}"
  done
  launchctl print "gui/$(id -u)/com.remote-mcp.local-stack" >/dev/null 2>&1 || fail "launchd stack must be running for post-handoff validation"
  "${LSOF}" -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 || fail "port 3000 is not listening"
  "${LSOF}" -nP -iTCP:1625 -sTCP:LISTEN >/dev/null 2>&1 || fail "port 1625 is not listening"
else
  [[ "${REMOTE_MCP_TESTING:-}" == "1" ]] || fail "rehearsal mode is test-only"
  TEST_ROOT="${DEVICE_RESEED_POST_VERIFY_TEST_ROOT:-}"
  [[ -n "${TEST_ROOT}" ]] || fail "DEVICE_RESEED_POST_VERIFY_TEST_ROOT is required"
  REAL_TMP="$(realpath_py /tmp)"
  REAL_TEST_ROOT="$(realpath_py "${TEST_ROOT}")"
  case "${REAL_TEST_ROOT}" in "${REAL_TMP}"/remote-mcp-jazz-postverify.*) ;; *) fail "test root must be under the system temporary directory" ;; esac
  PENDING="${DEVICE_RESEED_HANDOFF_PENDING_MARKER:-${REAL_TEST_ROOT}/pending-validation.json}"
fi

[[ -f "${PENDING}" ]] || fail "handoff journal is missing"
eval "$(python3 - "${PENDING}" <<'PY'
import json,shlex,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
if x.get("validationComplete"):
    raise SystemExit("error: handoff is already marked validated")
for k,j in {
 "STAGE_DIR":"stageDir","ROLLBACK_AUTHORITY":"rollbackAuthorityDir","RECOVERY_DIR":"recoveryDir",
 "PHASE":"phase","SERVICES_STARTED":"servicesStartedAfterHandoff"
}.items():
    v=x.get(j,"")
    if isinstance(v,bool): v="true" if v else "false"
    print(k+"="+shlex.quote(str(v or "")))
PY
)"

[[ "${PHASE}" == "awaiting-validation" || "${PHASE}" == "validating" ]] || fail "handoff journal is not awaiting validation"
STAGE_MANIFEST="${STAGE_DIR}/stage-manifest.json"
[[ -f "${STAGE_MANIFEST}" ]] || fail "stage manifest is missing"
[[ -d "${ROLLBACK_AUTHORITY}" ]] || fail "rollback authority directory is missing"
mkdir -p "${RECOVERY_DIR}"

atomic_journal_update() {
  local phase="$1" services="$2" validated="$3" result_path="${4:-}"
  python3 - "${PENDING}" "${phase}" "${services}" "${validated}" "${result_path}" <<'PY'
import json,os,sys,tempfile,datetime
path,phase,services,validated,result=sys.argv[1:6]
x=json.load(open(path,encoding="utf-8"))
x["phase"]=phase
x["servicesStartedAfterHandoff"]=services=="true"
x["validationComplete"]=validated=="true"
x["updatedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
if result: x["validationResult"]=result
if validated=="true": x["validatedAt"]=x["updatedAt"]
directory=os.path.dirname(path)
fd,tmp=tempfile.mkstemp(prefix=".handoff-journal.",dir=directory)
try:
    with os.fdopen(fd,"w",encoding="utf-8") as f:
        json.dump(x,f,indent=2,sort_keys=True); f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp,0o600); os.replace(tmp,path)
    d=os.open(directory,os.O_RDONLY)
    try: os.fsync(d)
    finally: os.close(d)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
}

# Once the web/Jazz stack is confirmed running, automatic filesystem rollback is
# no longer safe. Persist that boundary before opening any verifier client.
atomic_journal_update "validating" "true" "false"

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
RESULT="${RECOVERY_DIR}/post-handoff-validation-${STAMP}.json"
STDERR_LOG="${RECOVERY_DIR}/post-handoff-validation-${STAMP}.stderr.log"
VERIFY_BACKEND_DB="${RECOVERY_DIR}/post-handoff-verifier-backend-${STAMP}.db"
TIMEOUT_MARKER="${RECOVERY_DIR}/.post-handoff-validation-${STAMP}.timeout"
[[ ! -e "${RESULT}" && ! -e "${VERIFY_BACKEND_DB}" ]] || fail "post-handoff validation output already exists"

set +e
if [[ "${MODE}" == "rehearsal" && -n "${DEVICE_RESEED_POST_VERIFY_TEST_OUTPUT:-}" ]]; then
  (
    printf '%s\n' "${DEVICE_RESEED_POST_VERIFY_TEST_OUTPUT}"
    exit "${DEVICE_RESEED_POST_VERIFY_TEST_EXIT:-0}"
  ) >"${RESULT}" 2>"${STDERR_LOG}" &
else
  (
    cd "${APP_DIR}"
    DEVICE_RESEED_STAGE_MANIFEST="${STAGE_MANIFEST}"     DEVICE_RESEED_VERIFY_BACKEND_DB="${VERIFY_BACKEND_DB}"     NODE_ENV=production       node --env-file=.env.local --import tsx ./scripts/verify-clean-authority-post-handoff.ts
  ) >"${RESULT}" 2>"${STDERR_LOG}" &
fi
child_pid=$!
(
  sleep 90
  if kill -0 "${child_pid}" 2>/dev/null; then
    : >"${TIMEOUT_MARKER}"
    kill -TERM "${child_pid}" 2>/dev/null || true
    sleep 2
    kill -KILL "${child_pid}" 2>/dev/null || true
  fi
) &
watchdog_pid=$!
wait "${child_pid}"
rc=$?
kill "${watchdog_pid}" 2>/dev/null || true
wait "${watchdog_pid}" 2>/dev/null || true
set -e

if [[ -e "${TIMEOUT_MARKER}" ]]; then
  rc=2
  rm -f "${TIMEOUT_MARKER}"
fi
chmod 400 "${RESULT}" "${STDERR_LOG}" 2>/dev/null || true

accepted="$(python3 - "${RESULT}" <<'PY'
import json,sys
try:
    x=json.load(open(sys.argv[1],encoding="utf-8"))
    print("true" if x.get("liveValidationAccepted") is True else "false")
except Exception:
    print("false")
PY
)"

if [[ "${rc}" -ne 0 || "${accepted}" != "true" ]]; then
  failure_rc="${rc}"
  [[ "${failure_rc}" -ne 0 ]] || failure_rc=2
  printf 'validationResult=%s\n' "${RESULT}"
  printf 'liveValidationAccepted=false\n'
  printf 'exitCode=%s\n' "${failure_rc}"
  exit "${failure_rc}"
fi

atomic_journal_update "validated" "true" "true" "${RESULT}"
printf 'validationResult=%s\n' "${RESULT}"
printf '%s\n' 'liveValidationAccepted=true'
printf '%s\n' 'admissionsReopenAuthorized=false'
printf '%s\n' 'publicIngressReopenAuthorized=false'
printf 'exitCode=0\n'
