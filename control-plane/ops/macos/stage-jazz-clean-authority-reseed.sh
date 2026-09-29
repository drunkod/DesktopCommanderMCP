#!/usr/bin/env bash
set -euo pipefail
umask 077

MODE="${1:-}"
[[ "${MODE}" == "rehearsal" || "${MODE}" == "production" ]] || {
  printf '%s\n' 'usage: stage-jazz-clean-authority-reseed.sh rehearsal|production' >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
REPO_ROOT="$(cd -- "${ROOT}/.." && pwd -P)"
APP_DIR="${ROOT}/apps/control-plane"
SQLITE=/usr/bin/sqlite3
SHASUM=/usr/bin/shasum
LSOF=/usr/sbin/lsof

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

[[ -x "${SQLITE}" ]] || fail "/usr/bin/sqlite3 is required"
[[ -x "${SHASUM}" ]] || fail "/usr/bin/shasum is required"

for required_var in   DEVICE_RESEED_DEVICE_ID   DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID   DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID; do
  [[ -n "${!required_var:-}" ]] || fail "${required_var} is required"
done

LIVE_AUTHORITY_DB="${ROOT}/.data/jazz/jazz.sqlite"
LIVE_BACKEND_DB="${ROOT}/.data/jazz-backend-runtime.db"
[[ -f "${LIVE_AUTHORITY_DB}" && -f "${LIVE_BACKEND_DB}" ]] || fail "live Jazz database paths are missing"

SOURCE_AUTHORITY_DB="${DEVICE_RESEED_STAGE_SOURCE_AUTHORITY_DB:-}"
SOURCE_BACKEND_DB="${DEVICE_RESEED_STAGE_SOURCE_BACKEND_DB:-}"
[[ -n "${SOURCE_AUTHORITY_DB}" && -n "${SOURCE_BACKEND_DB}" ]] || fail "stage source authority/backend snapshots are required"
[[ -f "${SOURCE_AUTHORITY_DB}" && -f "${SOURCE_BACKEND_DB}" ]] || fail "stage source snapshot file is missing"

realpath_py() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

REAL_SOURCE_AUTHORITY="$(realpath_py "${SOURCE_AUTHORITY_DB}")"
REAL_SOURCE_BACKEND="$(realpath_py "${SOURCE_BACKEND_DB}")"
REAL_ROOT="$(realpath_py "${ROOT}")"
if [[ "${MODE}" == "production" ]]; then
  "${SCRIPT_DIR}/independent-control-preflight.sh" check >/dev/null

  for marker in     "${ROOT}/.data/task-admission.frozen"     "${ROOT}/.data/effect-admission.frozen"     "${ROOT}/.data/public-ingress.frozen"; do
    [[ -f "${marker}" ]] || fail "production staging requires freeze marker: ${marker##*/}"
  done

  if launchctl print "gui/$(id -u)/com.remote-mcp.local-stack" >/dev/null 2>&1; then
    fail "production launchd stack must be booted out before staging"
  fi
  if "${LSOF}" -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port 3000 still has a listener"
  fi
  if "${LSOF}" -nP -iTCP:1625 -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port 1625 still has a listener"
  fi

  RECOVERY_LIVE_BASE="${ROOT}/.data/recovery-live"
  REAL_RECOVERY_LIVE_BASE="$(realpath_py "${RECOVERY_LIVE_BASE}")"
  case "${REAL_SOURCE_AUTHORITY}" in "${REAL_RECOVERY_LIVE_BASE}"/*) ;; *) fail "production authority snapshot must be under .data/recovery-live" ;; esac
  case "${REAL_SOURCE_BACKEND}" in "${REAL_RECOVERY_LIVE_BASE}"/*) ;; *) fail "production backend snapshot must be under .data/recovery-live" ;; esac
  RECOVERY_MANIFEST="${DEVICE_RESEED_LIVE_RECOVERY_MANIFEST:-$(dirname "${REAL_SOURCE_AUTHORITY}")/recovery-manifest.json}"
  [[ -f "${RECOVERY_MANIFEST}" ]] || fail "production recovery manifest is required"
  REAL_RECOVERY_MANIFEST="$(realpath_py "${RECOVERY_MANIFEST}")"
  "${SCRIPT_DIR}/verify-jazz-clean-reseed-frozen-state.sh" "${REAL_RECOVERY_MANIFEST}" >/dev/null
  python3 - "${REAL_RECOVERY_MANIFEST}" "${REAL_SOURCE_AUTHORITY}" "${REAL_SOURCE_BACKEND}" <<'PY'
import hashlib,json,os,sys
m=json.load(open(sys.argv[1],encoding="utf-8"))
a=os.path.realpath(sys.argv[2]); b=os.path.realpath(sys.argv[3])
def sha(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for c in iter(lambda:f.read(1024*1024),b""): h.update(c)
    return h.hexdigest()
def require(ok,msg):
    if not ok: raise SystemExit("error: "+msg)
require(os.path.realpath(m.get("authoritySnapshotPath",""))==a,"authority snapshot is not the manifest snapshot")
require(os.path.realpath(m.get("backendSnapshotPath",""))==b,"backend snapshot is not the manifest snapshot")
require(sha(a)==m.get("authoritySnapshotSha256"),"authority snapshot hash does not match recovery manifest")
require(sha(b)==m.get("backendSnapshotSha256"),"backend snapshot hash does not match recovery manifest")
PY
  RECOVERY_MANIFEST_HASH="$("${SHASUM}" -a 256 "${REAL_RECOVERY_MANIFEST}" | awk '{print $1}')"
else
  REAL_RECOVERY_MANIFEST=""
  RECOVERY_MANIFEST_HASH=""
  EVIDENCE_BASE="${ROOT}/.data/recovery-evidence"
  REAL_EVIDENCE_BASE="$(realpath_py "${EVIDENCE_BASE}")"
  case "${REAL_SOURCE_AUTHORITY}" in "${REAL_EVIDENCE_BASE}"/*) ;; *) fail "rehearsal authority snapshot must be under .data/recovery-evidence" ;; esac
  case "${REAL_SOURCE_BACKEND}" in "${REAL_EVIDENCE_BASE}"/*) ;; *) fail "rehearsal backend snapshot must be under .data/recovery-evidence" ;; esac
fi

[[ "$("${SQLITE}" "${REAL_SOURCE_AUTHORITY}" 'PRAGMA quick_check;')" == "ok" ]] || fail "source authority snapshot quick_check failed"
[[ "$("${SQLITE}" "${REAL_SOURCE_BACKEND}" 'PRAGMA quick_check;')" == "ok" ]] || fail "source backend snapshot quick_check failed"

SOURCE_AUTHORITY_HASH="$("${SHASUM}" -a 256 "${REAL_SOURCE_AUTHORITY}" | awk '{print $1}')"
SOURCE_BACKEND_HASH="$("${SHASUM}" -a 256 "${REAL_SOURCE_BACKEND}" | awk '{print $1}')"

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
STAGE_BASE="${ROOT}/.data/recovery-stage"
STAGE_DIR="${DEVICE_RESEED_STAGE_DIR:-${STAGE_BASE}/${MODE}-${STAMP}}"
case "${STAGE_DIR}" in /*) ;; *) fail "stage directory must be absolute" ;; esac

mkdir -p "${STAGE_BASE}"
REAL_STAGE_BASE="$(realpath_py "${STAGE_BASE}")"
STAGE_PARENT="$(dirname "${STAGE_DIR}")"
mkdir -p "${STAGE_PARENT}"
REAL_STAGE_PARENT="$(realpath_py "${STAGE_PARENT}")"
case "${REAL_STAGE_PARENT}/" in "${REAL_STAGE_BASE}"/*) ;; *) fail "stage directory must be under control-plane/.data/recovery-stage" ;; esac
[[ ! -e "${STAGE_DIR}" ]] || fail "stage directory already exists"
mkdir "${STAGE_DIR}"
chmod 700 "${STAGE_DIR}"
STAGE_AUTHORITY_DIR="${STAGE_DIR}/authority"
RESULT="${STAGE_DIR}/stage-result.json"
STDERR_LOG="${STAGE_DIR}/stage.stderr.log"

set +e
if [[ "${MODE}" == "rehearsal" && "${REMOTE_MCP_TESTING:-}" == "1" && -n "${DEVICE_RESEED_STAGE_TEST_OUTPUT:-}" ]]; then
  (
    printf '%s\n' "${DEVICE_RESEED_STAGE_TEST_OUTPUT}"
    exit "${DEVICE_RESEED_STAGE_TEST_EXIT:-0}"
  ) >"${RESULT}" 2>"${STDERR_LOG}" &
else
  (
    cd "${APP_DIR}"
    exec env     DEVICE_RESEED_STAGE_SOURCE_AUTHORITY_DB="${REAL_SOURCE_AUTHORITY}"     DEVICE_RESEED_STAGE_SOURCE_BACKEND_DB="${REAL_SOURCE_BACKEND}"     DEVICE_RESEED_LIVE_AUTHORITY_DB="${LIVE_AUTHORITY_DB}"     DEVICE_RESEED_LIVE_BACKEND_DB="${LIVE_BACKEND_DB}"     DEVICE_RESEED_STAGE_AUTHORITY_DIR="${STAGE_AUTHORITY_DIR}"     DEVICE_RESEED_STAGE_MODE="${MODE}"     DEVICE_RESEED_DEVICE_ID="${DEVICE_RESEED_DEVICE_ID}"     DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID="${DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID}"     DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID="${DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID}"     NODE_ENV=production       node --env-file=.env.local --import tsx ./scripts/stage-clean-authority-reseed.ts
  ) >"${RESULT}" 2>"${STDERR_LOG}" &
fi
stage_pid=$!

(
  sleep 300
  if kill -0 "${stage_pid}" 2>/dev/null; then
    kill -TERM "${stage_pid}" 2>/dev/null || true
    sleep 2
    kill -KILL "${stage_pid}" 2>/dev/null || true
  fi
) &
watchdog_pid=$!

wait "${stage_pid}"
stage_rc=$?
kill "${watchdog_pid}" 2>/dev/null || true
wait "${watchdog_pid}" 2>/dev/null || true
set -e

STAGE_READY="$(python3 - "${RESULT}" <<'PY'
import json,sys
try:
    x=json.load(open(sys.argv[1],encoding="utf-8"))
    print("true" if x.get("stageReady") is True else "false")
except Exception:
    print("false")
PY
)"

if [[ "${stage_rc}" -ne 0 || "${STAGE_READY}" != "true" ]]; then
  chmod 400 "${RESULT}" "${STDERR_LOG}" 2>/dev/null || true
  failure_rc="${stage_rc}"
  [[ "${failure_rc}" -ne 0 ]] || failure_rc=2
  printf 'stage=%s\n' "${STAGE_DIR}"
  printf 'stageReady=false\n'
  printf 'exitCode=%s\n' "${failure_rc}"
  exit "${failure_rc}"
fi

STAGE_DB="${STAGE_AUTHORITY_DIR}/jazz.sqlite"
[[ -f "${STAGE_DB}" ]] || fail "staged authority database is missing"
[[ "$("${SQLITE}" "${STAGE_DB}" 'PRAGMA quick_check;')" == "ok" ]] || fail "staged authority quick_check failed"
STAGE_DB_HASH="$("${SHASUM}" -a 256 "${STAGE_DB}" | awk '{print $1}')"
GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
export MODE STAMP STAGE_DIR STAGE_DB_HASH GIT_SHA SOURCE_AUTHORITY_HASH SOURCE_BACKEND_HASH
export REAL_SOURCE_AUTHORITY REAL_SOURCE_BACKEND REAL_RECOVERY_MANIFEST RECOVERY_MANIFEST_HASH RESULT
python3 - <<'PY'
import json, os
result=json.load(open(os.environ["RESULT"],encoding="utf-8"))
manifest={
  "createdAt": os.environ["STAMP"],
  "gitSha": os.environ["GIT_SHA"],
  "mode": os.environ["MODE"],
  "stageReady": result.get("stageReady") is True,
  "productionApplyAuthorized": False,
  "sourceAuthorityPath": os.environ["REAL_SOURCE_AUTHORITY"],
  "sourceBackendPath": os.environ["REAL_SOURCE_BACKEND"],
  "sourceAuthoritySha256": os.environ["SOURCE_AUTHORITY_HASH"],
  "sourceBackendSha256": os.environ["SOURCE_BACKEND_HASH"],
  "recoveryManifestPath": os.environ["REAL_RECOVERY_MANIFEST"] or None,
  "recoveryManifestSha256": os.environ["RECOVERY_MANIFEST_HASH"] or None,
  "stageAuthoritySqliteSha256": os.environ["STAGE_DB_HASH"],
  "stageAuthorityQuickCheck": "ok",
  "deviceId": os.environ["DEVICE_RESEED_DEVICE_ID"],
  "expectedBackendStableId": os.environ["DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID"],
  "expectedCanonicalStableId": os.environ["DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID"],
  "returningBackendCacheCompatible": bool((result.get("returningBackendCache") or {}).get("compatible")),
  "postOldCacheFreshConvergence": bool(result.get("postOldCacheFreshConvergence")),
  "expectedPrincipalViews": result.get("expectedPrincipalViews"),
  "canonicalTarget": result.get("canonicalTarget"),
  "deviceJazzPersistence": result.get("deviceJazzPersistence"),
}
with open(os.path.join(os.environ["STAGE_DIR"],"stage-manifest.json"),"w",encoding="utf-8") as f:
    json.dump(manifest,f,indent=2,sort_keys=True)
    f.write("\n")
PY

chmod 400 "${RESULT}" "${STDERR_LOG}" "${STAGE_DIR}/stage-manifest.json"
chmod 700 "${STAGE_AUTHORITY_DIR}"
chmod 600 "${STAGE_DB}"

printf 'stage=%s\n' "${STAGE_DIR}"
printf 'stageReady=true\n'
printf 'productionApplyAuthorized=false\n'
printf 'exitCode=0\n'
