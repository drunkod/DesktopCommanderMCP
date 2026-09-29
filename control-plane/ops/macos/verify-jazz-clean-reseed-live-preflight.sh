#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
REPO_ROOT="$(cd -- "${ROOT}/.." && pwd -P)"
APP_DIR="${ROOT}/apps/control-plane"
EVIDENCE_BASE="${ROOT}/.data/recovery-evidence"
EVIDENCE_DIR="${DEVICE_RESEED_ACCEPTED_EVIDENCE_DIR:-}"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

[[ -n "${EVIDENCE_DIR}" ]] || fail "DEVICE_RESEED_ACCEPTED_EVIDENCE_DIR is required"
case "${EVIDENCE_DIR}" in
  /*) ;;
  *) fail "accepted evidence directory must be absolute" ;;
esac

REAL_BASE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${EVIDENCE_BASE}")"
REAL_EVIDENCE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${EVIDENCE_DIR}")"
case "${REAL_EVIDENCE}" in
  "${REAL_BASE}"/*) ;;
  *) fail "accepted evidence directory must be under control-plane/.data/recovery-evidence" ;;
esac
MANIFEST="${REAL_EVIDENCE}/manifest.json"
RESULT="${REAL_EVIDENCE}/result.json"
FINAL_HASHES="${REAL_EVIDENCE}/final-hashes.txt"
AUTH_SNAPSHOT="${REAL_EVIDENCE}/source-authority.sqlite"
BACKEND_SNAPSHOT="${REAL_EVIDENCE}/source-backend.sqlite"

for file in "${MANIFEST}" "${RESULT}" "${FINAL_HASHES}" "${AUTH_SNAPSHOT}" "${BACKEND_SNAPSHOT}"; do
  [[ -f "${file}" ]] || fail "required evidence file is missing: ${file##*/}"
done

[[ -x /usr/bin/sqlite3 ]] || fail "/usr/bin/sqlite3 is required"
[[ -x /usr/bin/shasum ]] || fail "/usr/bin/shasum is required"

# This is the operational boundary: the live preflight may pass only after a
# human has attested an already-open independent Terminal/SSH session.
"${SCRIPT_DIR}/independent-control-preflight.sh" check >/dev/null

[[ -z "$(git -C "${REPO_ROOT}" status --porcelain)" ]] || fail "repository working tree must be clean"
HEAD_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
EVIDENCE_SHA="$(python3 - "${MANIFEST}" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["gitSha"])
PY
)"

git -C "${REPO_ROOT}" merge-base --is-ancestor "${EVIDENCE_SHA}" "${HEAD_SHA}"   || fail "accepted evidence Git SHA is not an ancestor of current HEAD"
RECOVERY_PATHS=(
  "control-plane/packages/protocol/src/application-schema.ts"
  "control-plane/apps/control-plane/schema.ts"
  "control-plane/apps/control-plane/permissions.ts"
  "control-plane/apps/control-plane/lib/jazz-capability.ts"
  "control-plane/apps/control-plane/lib/reseed-recovery.ts"
  "control-plane/apps/control-plane/scripts/rehearse-clean-authority-reseed.ts"
  "control-plane/apps/control-plane/scripts/stage-clean-authority-reseed.ts"
  "control-plane/apps/control-plane/scripts/verify-clean-authority-post-handoff.ts"
  "control-plane/ops/macos/rehearse-jazz-clean-authority-reseed.sh"
  "control-plane/ops/macos/verify-jazz-clean-reseed-live-preflight.sh"
  "control-plane/ops/macos/independent-control-preflight.sh"
  "control-plane/ops/macos/cutover-control.sh"
  "control-plane/ops/macos/capture-jazz-clean-reseed-frozen-state.sh"
  "control-plane/ops/macos/verify-jazz-clean-reseed-frozen-state.sh"
  "control-plane/ops/macos/stage-jazz-clean-authority-reseed.sh"
  "control-plane/ops/macos/apply-jazz-clean-authority-handoff.sh"
  "control-plane/ops/macos/verify-jazz-clean-authority-post-handoff.sh"
  "control-plane/apps/control-plane/package.json"
  "control-plane/pnpm-lock.yaml"
)

git -C "${REPO_ROOT}" diff --quiet "${EVIDENCE_SHA}..${HEAD_SHA}" -- "${RECOVERY_PATHS[@]}"   || fail "recovery implementation changed after accepted evidence; rerun copy-only rehearsal"

python3 - "${MANIFEST}" "${RESULT}" "${FINAL_HASHES}" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
result = json.load(open(sys.argv[2], encoding="utf-8"))

def require(condition, message):
    if not condition:
        raise SystemExit("error: " + message)

require(manifest.get("authorityQuickCheck") == "ok", "authority snapshot quick_check evidence is not ok")
require(manifest.get("backendQuickCheck") == "ok", "backend snapshot quick_check evidence is not ok")
require(manifest.get("sourceSnapshotMethod") == "sqlite .backup", "unsupported snapshot method")
require(result.get("rehearsalAccepted") is True, "copy-only rehearsal was not accepted")
require(result.get("productionMigrationAuthorized") is False, "rehearsal must not authorize production migration")
require(result.get("provenanceSupported") is True, "source provenance was not accepted")
require(result.get("postOldCacheFreshConvergence") is True, "post-reconnect fresh-cache convergence failed")
require(result.get("backendCacheRetirementRequired") is False, "backend cache retirement is unexpectedly required")
require(result.get("deviceJazzPersistence") == "memory-only", "unexpected device Jazz persistence mode")

returning = result.get("returningBackendCache") or {}
require(returning.get("syncEquivalent") is True, "returning backend cache did not synchronize exactly")
require(returning.get("writeAcknowledged") is True, "returning backend cache write was not acknowledged")
require(returning.get("compatible") is True, "returning backend cache was not compatible")

pairs = {}
for line in open(sys.argv[3], encoding="utf-8"):
    key, value = line.strip().split("=", 1)
    pairs[key] = value
require(pairs.get("authority_before") == pairs.get("authority_after"), "authority evidence hash changed")
require(pairs.get("backend_before") == pairs.get("backend_after"), "backend evidence hash changed")
require(pairs.get("authority_before") == manifest.get("authoritySnapshotSha256"), "authority manifest hash mismatch")
require(pairs.get("backend_before") == manifest.get("backendSnapshotSha256"), "backend manifest hash mismatch")
PY
AUTH_EXPECTED="$(python3 - "${MANIFEST}" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["authoritySnapshotSha256"])
PY
)"
BACKEND_EXPECTED="$(python3 - "${MANIFEST}" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["backendSnapshotSha256"])
PY
)"
AUTH_ACTUAL="$(/usr/bin/shasum -a 256 "${AUTH_SNAPSHOT}" | awk '{print $1}')"
BACKEND_ACTUAL="$(/usr/bin/shasum -a 256 "${BACKEND_SNAPSHOT}" | awk '{print $1}')"
[[ "${AUTH_ACTUAL}" == "${AUTH_EXPECTED}" ]] || fail "authority evidence snapshot hash mismatch"
[[ "${BACKEND_ACTUAL}" == "${BACKEND_EXPECTED}" ]] || fail "backend evidence snapshot hash mismatch"

VERIFY_DIR="$(mktemp -d /tmp/remote-mcp-reseed-live-preflight.XXXXXX)"
cleanup() { rm -rf -- "${VERIFY_DIR}"; }
trap cleanup EXIT
cp -- "${AUTH_SNAPSHOT}" "${VERIFY_DIR}/authority.sqlite"
cp -- "${BACKEND_SNAPSHOT}" "${VERIFY_DIR}/backend.sqlite"
[[ "$(/usr/bin/sqlite3 "${VERIFY_DIR}/authority.sqlite" 'PRAGMA quick_check;')" == "ok" ]]   || fail "authority evidence snapshot quick_check failed"
[[ "$(/usr/bin/sqlite3 "${VERIFY_DIR}/backend.sqlite" 'PRAGMA quick_check;')" == "ok" ]]   || fail "backend evidence snapshot quick_check failed"

[[ -f "${ROOT}/.data/jazz/jazz.sqlite" ]] || fail "live authority database is missing"
[[ -f "${ROOT}/.data/jazz-backend-runtime.db" ]] || fail "live backend database is missing"
[[ -f "${APP_DIR}/.env.local" ]] || fail "production .env.local is missing"
for marker in   "${ROOT}/.data/task-admission.frozen"   "${ROOT}/.data/effect-admission.frozen"   "${ROOT}/.data/public-ingress.frozen"; do
  [[ ! -e "${marker}" ]] || fail "preflight expects NORMAL state before freeze: ${marker##*/} exists"
done

printf '%s\n' "live clean-reseed preflight: PASS"
printf 'evidence_git_sha=%s\n' "${EVIDENCE_SHA}"
printf 'current_git_sha=%s\n' "${HEAD_SHA}"
printf '%s\n' "independent_control=verified"
printf '%s\n' "production_state_mutated=false"
