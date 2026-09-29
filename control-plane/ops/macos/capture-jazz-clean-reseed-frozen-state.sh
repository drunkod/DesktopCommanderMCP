#!/usr/bin/env bash
set -euo pipefail
umask 077

MODE="${1:-}"
[[ "${MODE}" == "rehearsal" || "${MODE}" == "production" ]] || {
  printf '%s\n' 'usage: capture-jazz-clean-reseed-frozen-state.sh rehearsal|production' >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
REPO_ROOT="$(cd -- "${ROOT}/.." && pwd -P)"
APP_DIR="${ROOT}/apps/control-plane"
SQLITE=/usr/bin/sqlite3
SHASUM=/usr/bin/shasum
LSOF=/usr/sbin/lsof

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
realpath_py() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

[[ -x "${SQLITE}" && -x "${SHASUM}" && -x "${LSOF}" ]] || fail "sqlite3, shasum and lsof are required"

if [[ "${MODE}" == "production" ]]; then
  "${SCRIPT_DIR}/independent-control-preflight.sh" check >/dev/null
  for marker in     "${ROOT}/.data/task-admission.frozen"     "${ROOT}/.data/effect-admission.frozen"     "${ROOT}/.data/public-ingress.frozen"; do
    [[ -f "${marker}" ]] || fail "frozen snapshot requires freeze marker: ${marker##*/}"
  done
  if launchctl print "gui/$(id -u)/com.remote-mcp.local-stack" >/dev/null 2>&1; then
    fail "launchd stack must be booted out before frozen snapshot capture"
  fi
  if "${LSOF}" -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then fail "port 3000 still has a listener"; fi
  if "${LSOF}" -nP -iTCP:1625 -sTCP:LISTEN >/dev/null 2>&1; then fail "port 1625 still has a listener"; fi
  AUTHORITY_DB="${ROOT}/.data/jazz/jazz.sqlite"
  BACKEND_DB="${ROOT}/.data/jazz-backend-runtime.db"
  BASE="${ROOT}/.data/recovery-live"
  STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
  RECOVERY_DIR="${DEVICE_RESEED_LIVE_RECOVERY_DIR:-${BASE}/frozen-${STAMP}}"
else
  REHEARSAL_ROOT="${DEVICE_RESEED_FREEZE_REHEARSAL_ROOT:-}"
  [[ -n "${REHEARSAL_ROOT}" ]] || fail "DEVICE_RESEED_FREEZE_REHEARSAL_ROOT is required"
  REAL_TMP="$(realpath_py /tmp)"
  REAL_REHEARSAL_ROOT="$(realpath_py "${REHEARSAL_ROOT}")"
  case "${REAL_REHEARSAL_ROOT}" in "${REAL_TMP}"/remote-mcp-jazz-frozen.*) ;; *) fail "rehearsal root must be under the system temporary directory" ;; esac
  AUTHORITY_DB="${DEVICE_RESEED_FREEZE_AUTHORITY_DB:-}"
  BACKEND_DB="${DEVICE_RESEED_FREEZE_BACKEND_DB:-}"
  [[ -n "${AUTHORITY_DB}" && -n "${BACKEND_DB}" ]] || fail "rehearsal live database paths are required"
  RECOVERY_DIR="${DEVICE_RESEED_LIVE_RECOVERY_DIR:-${REAL_REHEARSAL_ROOT}/recovery}"
  BASE="${REAL_REHEARSAL_ROOT}"
  STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
fi

[[ -f "${AUTHORITY_DB}" && -f "${BACKEND_DB}" ]] || fail "live authority/backend database is missing"
case "${RECOVERY_DIR}" in /*) ;; *) fail "recovery directory must be absolute" ;; esac
mkdir -p "${BASE}"
REAL_BASE="$(realpath_py "${BASE}")"
PARENT="$(dirname "${RECOVERY_DIR}")"
mkdir -p "${PARENT}"
REAL_PARENT="$(realpath_py "${PARENT}")"
case "${REAL_PARENT}/" in "${REAL_BASE}"/*|"${REAL_BASE}/") ;; *) fail "recovery directory escapes recovery base" ;; esac
[[ ! -e "${RECOVERY_DIR}" ]] || fail "recovery directory already exists"
mkdir "${RECOVERY_DIR}"
chmod 700 "${RECOVERY_DIR}"

AUTH_SNAPSHOT="${RECOVERY_DIR}/source-authority.sqlite"
BACKEND_SNAPSHOT="${RECOVERY_DIR}/source-backend.sqlite"
"${SQLITE}" "${AUTHORITY_DB}" ".backup '${AUTH_SNAPSHOT}'"
"${SQLITE}" "${BACKEND_DB}" ".backup '${BACKEND_SNAPSHOT}'"
[[ "$("${SQLITE}" "${AUTH_SNAPSHOT}" 'PRAGMA quick_check;')" == "ok" ]] || fail "authority snapshot quick_check failed"
[[ "$("${SQLITE}" "${BACKEND_SNAPSHOT}" 'PRAGMA quick_check;')" == "ok" ]] || fail "backend snapshot quick_check failed"
AUTH_HASH="$("${SHASUM}" -a 256 "${AUTH_SNAPSHOT}" | awk '{print $1}')"
BACKEND_HASH="$("${SHASUM}" -a 256 "${BACKEND_SNAPSHOT}" | awk '{print $1}')"

BETTER_AUTH_PATH=""
BETTER_AUTH_HASH=""
if [[ "${MODE}" == "production" && -f "${APP_DIR}/.env.local" ]]; then
  BETTER_AUTH_PATH="$(cd "${APP_DIR}" && node --env-file=.env.local -e 'const p=require("path"); if(process.env.BETTER_AUTH_DB_PATH && process.env.BETTER_AUTH_DB_PATH!==":memory:") console.log(p.resolve(process.env.BETTER_AUTH_DB_PATH))' || true)"
  if [[ -n "${BETTER_AUTH_PATH}" && -f "${BETTER_AUTH_PATH}" ]]; then
    "${SQLITE}" "${BETTER_AUTH_PATH}" ".backup '${RECOVERY_DIR}/better-auth.sqlite'"
    [[ "$("${SQLITE}" "${RECOVERY_DIR}/better-auth.sqlite" 'PRAGMA quick_check;')" == "ok" ]] || fail "Better Auth snapshot quick_check failed"
    BETTER_AUTH_HASH="$("${SHASUM}" -a 256 "${RECOVERY_DIR}/better-auth.sqlite" | awk '{print $1}')"
    chmod 400 "${RECOVERY_DIR}/better-auth.sqlite"
  fi
  cp "${APP_DIR}/.env.local" "${RECOVERY_DIR}/control-plane.env.local"
  chmod 600 "${RECOVERY_DIR}/control-plane.env.local"
  [[ ! -f "${HOME}/Library/LaunchAgents/com.remote-mcp.local-stack.plist" ]] || cp "${HOME}/Library/LaunchAgents/com.remote-mcp.local-stack.plist" "${RECOVERY_DIR}/com.remote-mcp.local-stack.plist"
  [[ ! -f "${ROOT}/.data/launchd-runtime.env" ]] || cp "${ROOT}/.data/launchd-runtime.env" "${RECOVERY_DIR}/launchd-runtime.env"
  chmod 600 "${RECOVERY_DIR}/com.remote-mcp.local-stack.plist" "${RECOVERY_DIR}/launchd-runtime.env" 2>/dev/null || true
fi

GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
CAPTURED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
export MODE GIT_SHA CAPTURED_AT RECOVERY_DIR AUTHORITY_DB BACKEND_DB AUTH_SNAPSHOT BACKEND_SNAPSHOT AUTH_HASH BACKEND_HASH BETTER_AUTH_PATH BETTER_AUTH_HASH
python3 - <<'PY'
import hashlib, json, os

def sidecar(path):
    out={}
    for suffix,name in (("-wal","wal"),("-shm","shm")):
        p=path+suffix
        if os.path.exists(p):
            h=hashlib.sha256()
            with open(p,"rb") as f:
                for chunk in iter(lambda:f.read(1024*1024),b""):
                    h.update(chunk)
            out[name]={"present":True,"size":os.path.getsize(p),"sha256":h.hexdigest()}
        else:
            out[name]={"present":False,"size":0,"sha256":None}
    return out

manifest={
  "version":1,
  "mode":os.environ["MODE"],
  "capturedAt":os.environ["CAPTURED_AT"],
  "gitSha":os.environ["GIT_SHA"],
  "writersStopped":True,
  "freezeMarkersRequired": os.environ["MODE"]=="production",
  "logicalFingerprintMethod":"SQLite .backup SHA-256 from stopped database; committed WAL-visible state is included by SQLite backup",
  "sourceAuthorityPath":os.path.realpath(os.environ["AUTHORITY_DB"]),
  "sourceBackendPath":os.path.realpath(os.environ["BACKEND_DB"]),
  "authoritySnapshotPath":os.path.realpath(os.environ["AUTH_SNAPSHOT"]),
  "backendSnapshotPath":os.path.realpath(os.environ["BACKEND_SNAPSHOT"]),
  "authoritySnapshotSha256":os.environ["AUTH_HASH"],
  "backendSnapshotSha256":os.environ["BACKEND_HASH"],
  "liveAuthorityLogicalSha256":os.environ["AUTH_HASH"],
  "liveBackendLogicalSha256":os.environ["BACKEND_HASH"],
  "authorityQuickCheck":"ok",
  "backendQuickCheck":"ok",
  "authoritySidecarsAtCapture":sidecar(os.environ["AUTHORITY_DB"]),
  "backendSidecarsAtCapture":sidecar(os.environ["BACKEND_DB"]),
  "betterAuthPath":os.path.realpath(os.environ["BETTER_AUTH_PATH"]) if os.environ["BETTER_AUTH_PATH"] else None,
  "betterAuthSnapshotSha256":os.environ["BETTER_AUTH_HASH"] or None,
}
path=os.path.join(os.environ["RECOVERY_DIR"],"recovery-manifest.json")
tmp=path+".tmp"
with open(tmp,"w",encoding="utf-8") as f:
    json.dump(manifest,f,indent=2,sort_keys=True)
    f.write("\n")
    f.flush()
    os.fsync(f.fileno())
os.chmod(tmp,0o400)
os.replace(tmp,path)
d=os.open(os.environ["RECOVERY_DIR"],os.O_RDONLY)
try: os.fsync(d)
finally: os.close(d)
PY

chmod 400 "${AUTH_SNAPSHOT}" "${BACKEND_SNAPSHOT}"
printf 'recovery=%s\n' "${RECOVERY_DIR}"
printf 'manifest=%s\n' "${RECOVERY_DIR}/recovery-manifest.json"
printf '%s\n' 'frozenStateCaptured=true'
printf '%s\n' 'productionStateMutated=false'
