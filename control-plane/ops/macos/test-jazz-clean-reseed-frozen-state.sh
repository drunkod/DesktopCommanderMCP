#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOTS=()
cleanup() { for root in "${ROOTS[@]:-}"; do rm -rf -- "${root}"; done; }
trap cleanup EXIT

make_case() {
  ROOT="$(mktemp -d /tmp/remote-mcp-jazz-frozen.XXXXXX)"
  ROOTS+=("${ROOT}")
  AUTH="${ROOT}/authority.sqlite"
  BACK="${ROOT}/backend.sqlite"
  /usr/bin/sqlite3 "${AUTH}" 'CREATE TABLE state(id TEXT PRIMARY KEY, value TEXT); INSERT INTO state VALUES("a","one");'
  /usr/bin/sqlite3 "${BACK}" 'CREATE TABLE state(id TEXT PRIMARY KEY, value TEXT); INSERT INTO state VALUES("b","two");'
  DEVICE_RESEED_FREEZE_REHEARSAL_ROOT="${ROOT}"   DEVICE_RESEED_FREEZE_AUTHORITY_DB="${AUTH}"   DEVICE_RESEED_FREEZE_BACKEND_DB="${BACK}"     "${SCRIPT_DIR}/capture-jazz-clean-reseed-frozen-state.sh" rehearsal >/dev/null
  MANIFEST="${ROOT}/recovery/recovery-manifest.json"
  [[ -f "${MANIFEST}" ]]
}

make_case
"${SCRIPT_DIR}/verify-jazz-clean-reseed-frozen-state.sh" "${MANIFEST}" >/dev/null
python3 - "${MANIFEST}" <<'PY'
import json,sys
m=json.load(open(sys.argv[1],encoding="utf-8"))
assert m["mode"]=="rehearsal"
assert m["writersStopped"] is True
assert "WAL-visible state" in m["logicalFingerprintMethod"]
assert m["authoritySnapshotSha256"]==m["liveAuthorityLogicalSha256"]
assert m["backendSnapshotSha256"]==m["liveBackendLogicalSha256"]
PY

/usr/bin/sqlite3 "${AUTH}" 'UPDATE state SET value="changed" WHERE id="a";'
set +e
"${SCRIPT_DIR}/verify-jazz-clean-reseed-frozen-state.sh" "${MANIFEST}" >/dev/null 2>&1
rc=$?
set -e
[[ "${rc}" -ne 0 ]]

make_case
/usr/bin/sqlite3 "${BACK}" 'INSERT INTO state VALUES("c","newer");'
set +e
"${SCRIPT_DIR}/verify-jazz-clean-reseed-frozen-state.sh" "${MANIFEST}" >/dev/null 2>&1
rc=$?
set -e
[[ "${rc}" -ne 0 ]]

printf '%s\n' 'jazz clean reseed frozen-state fingerprints: ok'
