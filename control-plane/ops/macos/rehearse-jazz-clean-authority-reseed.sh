#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
REPO_ROOT="$(cd -- "${ROOT}/.." && pwd -P)"
APP_DIR="${ROOT}/apps/control-plane"
SQLITE=/usr/bin/sqlite3
SHASUM=/usr/bin/shasum

[[ -x "${SQLITE}" ]] || { printf '%s\n' 'error: /usr/bin/sqlite3 is required' >&2; exit 1; }
[[ -x "${SHASUM}" ]] || { printf '%s\n' 'error: /usr/bin/shasum is required' >&2; exit 1; }

AUTHORITY_DB="${REMOTE_MCP_RESEED_AUTHORITY_DB:-${ROOT}/.data/jazz/jazz.sqlite}"
BACKEND_DB="${REMOTE_MCP_RESEED_BACKEND_DB:-${ROOT}/.data/jazz-backend-runtime.db}"

for required_var in \
  DEVICE_RESEED_DEVICE_ID \
  DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID \
  DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID; do
  [[ -n "${!required_var:-}" ]] || { printf 'error: %s is required\n' "${required_var}" >&2; exit 1; }
done

[[ -f "${AUTHORITY_DB}" && -f "${BACKEND_DB}" ]] || {
  printf '%s\n' 'error: both production source database files must exist' >&2
  exit 1
}

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
EVIDENCE_BASE="${ROOT}/.data/recovery-evidence"
EVIDENCE_DIR="${REMOTE_MCP_RESEED_EVIDENCE_DIR:-${EVIDENCE_BASE}/clean-reseed-${STAMP}}"
case "${EVIDENCE_DIR}" in
  /*) ;;
  *) printf '%s\n' 'error: evidence directory must be absolute' >&2; exit 1 ;;
esac
case "${EVIDENCE_DIR}" in
  "${EVIDENCE_BASE}"/*) ;;
  *) printf '%s\n' 'error: evidence directory must be under control-plane/.data/recovery-evidence' >&2; exit 1 ;;
esac

mkdir -p -- "${EVIDENCE_DIR}"
chmod 700 "${EVIDENCE_DIR}"
AUTH_SNAPSHOT="${EVIDENCE_DIR}/source-authority.sqlite"
BACKEND_SNAPSHOT="${EVIDENCE_DIR}/source-backend.sqlite"
[[ ! -e "${AUTH_SNAPSHOT}" && ! -e "${BACKEND_SNAPSHOT}" ]] || {
  printf '%s\n' 'error: evidence snapshot already exists' >&2
  exit 1
}

"${SQLITE}" "${AUTHORITY_DB}" ".backup '${AUTH_SNAPSHOT}'"
"${SQLITE}" "${BACKEND_DB}" ".backup '${BACKEND_SNAPSHOT}'"
TMP_ROOT="${TMPDIR:-/tmp}"
VERIFY_DIR="$(mktemp -d "${TMP_ROOT%/}/remote-mcp-jazz-clean-reseed-verify.XXXXXX")"
cp -- "${AUTH_SNAPSHOT}" "${VERIFY_DIR}/authority.sqlite"
cp -- "${BACKEND_SNAPSHOT}" "${VERIFY_DIR}/backend.sqlite"
AUTH_CHECK="$("${SQLITE}" "${VERIFY_DIR}/authority.sqlite" 'PRAGMA quick_check;')"
BACKEND_CHECK="$("${SQLITE}" "${VERIFY_DIR}/backend.sqlite" 'PRAGMA quick_check;')"
rm -rf -- "${VERIFY_DIR}"
[[ "${AUTH_CHECK}" == "ok" && "${BACKEND_CHECK}" == "ok" ]] || {
  printf '%s\n' 'error: snapshot quick_check failed' >&2
  exit 1
}
[[ ! -e "${AUTH_SNAPSHOT}-wal" && ! -e "${AUTH_SNAPSHOT}-shm" && ! -e "${BACKEND_SNAPSHOT}-wal" && ! -e "${BACKEND_SNAPSHOT}-shm" ]] || {
  printf '%s\n' 'error: evidence snapshot sidecars were created' >&2
  exit 1
}
AUTH_HASH_BEFORE="$("${SHASUM}" -a 256 "${AUTH_SNAPSHOT}" | awk '{print $1}')"
BACKEND_HASH_BEFORE="$("${SHASUM}" -a 256 "${BACKEND_SNAPSHOT}" | awk '{print $1}')"
chmod 400 "${AUTH_SNAPSHOT}" "${BACKEND_SNAPSHOT}"

CAPTURED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
export CAPTURED_AT GIT_SHA AUTHORITY_DB BACKEND_DB AUTH_HASH_BEFORE BACKEND_HASH_BEFORE
export AUTH_SNAPSHOT BACKEND_SNAPSHOT EVIDENCE_DIR
python3 - <<'PY'
import json, os
manifest = {
    "capturedAt": os.environ["CAPTURED_AT"],
    "gitSha": os.environ["GIT_SHA"],
    "sourceAuthorityPath": os.environ["AUTHORITY_DB"],
    "sourceBackendPath": os.environ["BACKEND_DB"],
    "authoritySnapshot": os.path.basename(os.environ["AUTH_SNAPSHOT"]),
    "backendSnapshot": os.path.basename(os.environ["BACKEND_SNAPSHOT"]),
    "authoritySnapshotSha256": os.environ["AUTH_HASH_BEFORE"],
    "backendSnapshotSha256": os.environ["BACKEND_HASH_BEFORE"],
    "authorityQuickCheck": "ok",
    "backendQuickCheck": "ok",
    "deviceId": os.environ["DEVICE_RESEED_DEVICE_ID"],
    "expectedBackendStableId": os.environ["DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID"],
    "expectedCanonicalStableId": os.environ["DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID"],
    "sourceSnapshotMethod": "sqlite .backup",
    "sourceAuthorityRunMode": "working-copy-only; immutable snapshot never opened by Jazz server",
    "deviceJazzPersistence": "memory-only",
}
with open(os.path.join(os.environ["EVIDENCE_DIR"], "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, sort_keys=True)
    f.write("\n")
PY
chmod 400 "${EVIDENCE_DIR}/manifest.json"

TEMP_DIR="$(mktemp -d "${TMP_ROOT%/}/remote-mcp-jazz-clean-reseed.XXXXXX")"
cleanup() { rm -rf -- "${TEMP_DIR}"; }
trap cleanup EXIT
cp -- "${AUTH_SNAPSHOT}" "${TEMP_DIR}/source-authority.sqlite"
cp -- "${BACKEND_SNAPSHOT}" "${TEMP_DIR}/source-backend.sqlite"
chmod 600 "${TEMP_DIR}/source-authority.sqlite" "${TEMP_DIR}/source-backend.sqlite"

RESULT="${EVIDENCE_DIR}/result.json"
RAW_STDOUT="${EVIDENCE_DIR}/rehearsal.stdout.log"
STDERR_LOG="${EVIDENCE_DIR}/rehearsal.stderr.log"
TIMEOUT_MARKER="${TEMP_DIR}/timeout"

(
  cd -- "${APP_DIR}"
  exec env \
    DEVICE_RESEED_SOURCE_AUTHORITY_DB="${TEMP_DIR}/source-authority.sqlite" \
    DEVICE_RESEED_SOURCE_BACKEND_DB="${TEMP_DIR}/source-backend.sqlite" \
    DEVICE_RESEED_LIVE_AUTHORITY_DB="${AUTHORITY_DB}" \
    DEVICE_RESEED_LIVE_BACKEND_DB="${BACKEND_DB}" \
    DEVICE_RESEED_DEVICE_ID="${DEVICE_RESEED_DEVICE_ID}" \
    DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID="${DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID}" \
    DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID="${DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID}" \
    NODE_ENV=production \
      node --env-file=.env.local --import tsx ./scripts/rehearse-clean-authority-reseed.ts
) >"${RAW_STDOUT}" 2>"${STDERR_LOG}" &
rehearsal_pid=$!

(
  sleep 300
  if kill -0 "${rehearsal_pid}" 2>/dev/null; then
    : >"${TIMEOUT_MARKER}"
    kill -TERM "${rehearsal_pid}" 2>/dev/null || true
    sleep 2
    kill -KILL "${rehearsal_pid}" 2>/dev/null || true
  fi
) &
watchdog_pid=$!

set +e
wait "${rehearsal_pid}"
rehearsal_rc=$?
set -e
kill "${watchdog_pid}" 2>/dev/null || true
wait "${watchdog_pid}" 2>/dev/null || true

if [[ -e "${TIMEOUT_MARKER}" ]]; then
  printf '%s\n' '{"phase":"timeout","rehearsalAccepted":false,"productionMigrationAuthorized":false}' >"${RESULT}"
  rehearsal_rc=2
else
  python3 - "${RAW_STDOUT}" "${RESULT}" <<'PYRESULT'
import json, sys
source, destination = sys.argv[1], sys.argv[2]
selected = None
with open(source, encoding="utf-8", errors="replace") as f:
    for line in f:
        try:
            value = json.loads(line)
        except Exception:
            continue
        if isinstance(value, dict) and "phase" in value:
            selected = value
if selected is None:
    selected = {
        "phase": "invalid-result",
        "rehearsalAccepted": False,
        "productionMigrationAuthorized": False,
    }
with open(destination, "w", encoding="utf-8") as f:
    json.dump(selected, f, sort_keys=True)
    f.write("\n")
PYRESULT
fi

AUTH_HASH_AFTER="$("${SHASUM}" -a 256 "${AUTH_SNAPSHOT}" | awk '{print $1}')"
BACKEND_HASH_AFTER="$("${SHASUM}" -a 256 "${BACKEND_SNAPSHOT}" | awk '{print $1}')"
[[ "${AUTH_HASH_AFTER}" == "${AUTH_HASH_BEFORE}" && "${BACKEND_HASH_AFTER}" == "${BACKEND_HASH_BEFORE}" ]] || {
  printf '%s\n' 'error: immutable evidence snapshot hash changed' >&2
  exit 1
}
cp -- "${AUTH_SNAPSHOT}" "${TEMP_DIR}/final-verify-authority.sqlite"
cp -- "${BACKEND_SNAPSHOT}" "${TEMP_DIR}/final-verify-backend.sqlite"
[[ "$("${SQLITE}" "${TEMP_DIR}/final-verify-authority.sqlite" 'PRAGMA quick_check;')" == "ok" ]] || exit 1
[[ "$("${SQLITE}" "${TEMP_DIR}/final-verify-backend.sqlite" 'PRAGMA quick_check;')" == "ok" ]] || exit 1
[[ ! -e "${AUTH_SNAPSHOT}-wal" && ! -e "${AUTH_SNAPSHOT}-shm" && ! -e "${BACKEND_SNAPSHOT}-wal" && ! -e "${BACKEND_SNAPSHOT}-shm" ]] || {
  printf '%s\n' 'error: evidence snapshot sidecars were created' >&2
  exit 1
}

{
  printf 'authority_before=%s\n' "${AUTH_HASH_BEFORE}"
  printf 'authority_after=%s\n' "${AUTH_HASH_AFTER}"
  printf 'backend_before=%s\n' "${BACKEND_HASH_BEFORE}"
  printf 'backend_after=%s\n' "${BACKEND_HASH_AFTER}"
} >"${EVIDENCE_DIR}/final-hashes.txt"
chmod 400 "${EVIDENCE_DIR}/final-hashes.txt" "${RESULT}" "${RAW_STDOUT}" "${STDERR_LOG}"

printf 'evidence=%s\n' "${EVIDENCE_DIR}"
python3 - "${RESULT}" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        result = json.load(f)
    print("phase=" + str(result.get("phase")))
    print("rehearsalAccepted=" + str(bool(result.get("rehearsalAccepted"))).lower())
    print("productionMigrationAuthorized=" + str(bool(result.get("productionMigrationAuthorized"))).lower())
except Exception:
    print("phase=invalid-result")
    print("rehearsalAccepted=false")
    print("productionMigrationAuthorized=false")
PY
printf 'exitCode=%s\n' "${rehearsal_rc}"
exit "${rehearsal_rc}"
