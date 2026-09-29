#!/usr/bin/env bash
set -euo pipefail
umask 077

MANIFEST="${1:-}"
[[ -n "${MANIFEST}" ]] || {
  printf '%s\n' 'usage: verify-jazz-clean-reseed-frozen-state.sh /absolute/path/recovery-manifest.json' >&2
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

[[ -x "${SQLITE}" && -x "${SHASUM}" && -x "${LSOF}" ]] || fail "sqlite3, shasum and lsof are required"
[[ -f "${MANIFEST}" ]] || fail "recovery manifest is missing"
REAL_MANIFEST="$(realpath_py "${MANIFEST}")"
MODE="$(python3 - "${REAL_MANIFEST}" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8")).get("mode",""))
PY
)"
[[ "${MODE}" == "rehearsal" || "${MODE}" == "production" ]] || fail "invalid recovery manifest mode"

if [[ "${MODE}" == "production" ]]; then
  "${SCRIPT_DIR}/independent-control-preflight.sh" check >/dev/null
  for marker in     "${ROOT}/.data/task-admission.frozen"     "${ROOT}/.data/effect-admission.frozen"     "${ROOT}/.data/public-ingress.frozen"; do
    [[ -f "${marker}" ]] || fail "frozen-state verification requires freeze marker: ${marker##*/}"
  done
  if launchctl print "gui/$(id -u)/com.remote-mcp.local-stack" >/dev/null 2>&1; then
    fail "launchd stack must be booted out for frozen-state verification"
  fi
  if "${LSOF}" -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then fail "port 3000 still has a listener"; fi
  if "${LSOF}" -nP -iTCP:1625 -sTCP:LISTEN >/dev/null 2>&1; then fail "port 1625 still has a listener"; fi
  RECOVERY_BASE="$(realpath_py "${ROOT}/.data/recovery-live")"
  case "${REAL_MANIFEST}" in "${RECOVERY_BASE}"/*/recovery-manifest.json) ;; *) fail "production manifest must be under .data/recovery-live" ;; esac
fi

eval "$(python3 - "${REAL_MANIFEST}" <<'PY'
import json,shlex,sys
m=json.load(open(sys.argv[1],encoding="utf-8"))
keys={
 "MANIFEST_GIT_SHA":m.get("gitSha",""),
 "AUTHORITY_DB":m.get("sourceAuthorityPath",""),
 "BACKEND_DB":m.get("sourceBackendPath",""),
 "AUTH_SNAPSHOT":m.get("authoritySnapshotPath",""),
 "BACKEND_SNAPSHOT":m.get("backendSnapshotPath",""),
 "AUTH_HASH":m.get("authoritySnapshotSha256",""),
 "BACKEND_HASH":m.get("backendSnapshotSha256",""),
 "AUTH_LOGICAL":m.get("liveAuthorityLogicalSha256",""),
 "BACKEND_LOGICAL":m.get("liveBackendLogicalSha256",""),
}
for k,v in keys.items():
    print(k+"="+shlex.quote(str(v)))
PY
)"

for value in MANIFEST_GIT_SHA AUTHORITY_DB BACKEND_DB AUTH_SNAPSHOT BACKEND_SNAPSHOT AUTH_HASH BACKEND_HASH AUTH_LOGICAL BACKEND_LOGICAL; do
  [[ -n "${!value}" ]] || fail "recovery manifest is missing ${value}"
done

if [[ "${MODE}" == "production" ]]; then
  CURRENT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  [[ "${CURRENT_SHA}" == "${MANIFEST_GIT_SHA}" ]] || fail "recovery manifest Git SHA does not match current checkout"
  [[ "$(realpath_py "${AUTHORITY_DB}")" == "$(realpath_py "${ROOT}/.data/jazz/jazz.sqlite")" ]] || fail "authority live path mismatch"
  [[ "$(realpath_py "${BACKEND_DB}")" == "$(realpath_py "${ROOT}/.data/jazz-backend-runtime.db")" ]] || fail "backend live path mismatch"
fi

[[ -f "${AUTHORITY_DB}" && -f "${BACKEND_DB}" ]] || fail "live database path is missing"
[[ -f "${AUTH_SNAPSHOT}" && -f "${BACKEND_SNAPSHOT}" ]] || fail "snapshot path is missing"
[[ "$("${SHASUM}" -a 256 "${AUTH_SNAPSHOT}" | awk '{print $1}')" == "${AUTH_HASH}" ]] || fail "authority snapshot hash mismatch"
[[ "$("${SHASUM}" -a 256 "${BACKEND_SNAPSHOT}" | awk '{print $1}')" == "${BACKEND_HASH}" ]] || fail "backend snapshot hash mismatch"
[[ "$("${SQLITE}" "${AUTH_SNAPSHOT}" 'PRAGMA quick_check;')" == "ok" ]] || fail "authority snapshot quick_check failed"
[[ "$("${SQLITE}" "${BACKEND_SNAPSHOT}" 'PRAGMA quick_check;')" == "ok" ]] || fail "backend snapshot quick_check failed"

VERIFY_DIR="$(mktemp -d /tmp/remote-mcp-jazz-frozen-verify.XXXXXX)"
cleanup() { rm -rf -- "${VERIFY_DIR}"; }
trap cleanup EXIT
CURRENT_AUTH="${VERIFY_DIR}/authority.sqlite"
CURRENT_BACKEND="${VERIFY_DIR}/backend.sqlite"
"${SQLITE}" "${AUTHORITY_DB}" ".backup '${CURRENT_AUTH}'"
"${SQLITE}" "${BACKEND_DB}" ".backup '${CURRENT_BACKEND}'"
[[ "$("${SQLITE}" "${CURRENT_AUTH}" 'PRAGMA quick_check;')" == "ok" ]] || fail "current authority logical backup quick_check failed"
[[ "$("${SQLITE}" "${CURRENT_BACKEND}" 'PRAGMA quick_check;')" == "ok" ]] || fail "current backend logical backup quick_check failed"
CURRENT_AUTH_HASH="$("${SHASUM}" -a 256 "${CURRENT_AUTH}" | awk '{print $1}')"
CURRENT_BACKEND_HASH="$("${SHASUM}" -a 256 "${CURRENT_BACKEND}" | awk '{print $1}')"
[[ "${CURRENT_AUTH_HASH}" == "${AUTH_LOGICAL}" ]] || fail "live authority changed since frozen snapshot"
[[ "${CURRENT_BACKEND_HASH}" == "${BACKEND_LOGICAL}" ]] || fail "live backend changed since frozen snapshot"

printf '%s\n' 'frozen state verification: PASS'
printf 'mode=%s\n' "${MODE}"
printf 'manifest=%s\n' "${REAL_MANIFEST}"
printf '%s\n' 'liveAuthorityUnchanged=true'
printf '%s\n' 'liveBackendUnchanged=true'
