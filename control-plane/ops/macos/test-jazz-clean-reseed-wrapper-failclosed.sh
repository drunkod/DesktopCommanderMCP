#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
EVIDENCE_ROOT="${ROOT}/.data/recovery-evidence/wrapper-test-$$"
STAGE_ROOT="${ROOT}/.data/recovery-stage/wrapper-test-$$"
mkdir -p "${EVIDENCE_ROOT}"
cleanup() { rm -rf -- "${EVIDENCE_ROOT}" "${STAGE_ROOT}" "${POST_ROOTS[@]:-}"; }
trap cleanup EXIT

AUTH="${EVIDENCE_ROOT}/authority.sqlite"
BACK="${EVIDENCE_ROOT}/backend.sqlite"
/usr/bin/sqlite3 "${AUTH}" 'CREATE TABLE t(id INTEGER PRIMARY KEY);'
/usr/bin/sqlite3 "${BACK}" 'CREATE TABLE t(id INTEGER PRIMARY KEY);'

run_stage_case() {
  local suffix="$1" output="$2"
  set +e
  REMOTE_MCP_TESTING=1   DEVICE_RESEED_STAGE_TEST_OUTPUT="${output}"   DEVICE_RESEED_STAGE_TEST_EXIT=0   DEVICE_RESEED_STAGE_SOURCE_AUTHORITY_DB="${AUTH}"   DEVICE_RESEED_STAGE_SOURCE_BACKEND_DB="${BACK}"   DEVICE_RESEED_STAGE_DIR="${STAGE_ROOT}-${suffix}"   DEVICE_RESEED_DEVICE_ID='test-device'   DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID='stale'   DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID='canonical'     "${SCRIPT_DIR}/stage-jazz-clean-authority-reseed.sh" rehearsal >/dev/null 2>&1
  rc=$?
  set -e
  [[ "${rc}" -eq 2 ]]
  rm -rf -- "${STAGE_ROOT}-${suffix}"
}

run_stage_case rejected '{}'
run_stage_case malformed '{not-json'

POST_ROOTS=()
run_post_case() {
  local suffix="$1" output="$2"
  local test_root
  test_root="$(mktemp -d /tmp/remote-mcp-jazz-postverify.XXXXXX)"
  POST_ROOTS+=("${test_root}")
  local stage="${test_root}/stage"
  local rollback="${test_root}/rollback/old-authority"
  local recovery="${test_root}/recovery"
  local journal="${test_root}/pending-validation.json"
  mkdir -p "${stage}" "${rollback}" "${recovery}"
  printf '%s\n' '{}' >"${stage}/stage-manifest.json"
  python3 - "${journal}" "${stage}" "${rollback}" "${recovery}" <<'PY'
import json,sys
path,stage,rollback,recovery=sys.argv[1:5]
json.dump({
  "mode":"rehearsal",
  "phase":"startup-attempted",
  "stageDir":stage,
  "rollbackAuthorityDir":rollback,
  "recoveryDir":recovery,
  "startupAttempted":True,
  "servicesStartedAfterHandoff":False,
  "validationComplete":False,
},open(path,"w"))
PY
  set +e
  REMOTE_MCP_TESTING=1   DEVICE_RESEED_POST_VERIFY_TEST_ROOT="${test_root}"   DEVICE_RESEED_HANDOFF_PENDING_MARKER="${journal}"   DEVICE_RESEED_POST_VERIFY_TEST_OUTPUT="${output}"   DEVICE_RESEED_POST_VERIFY_TEST_EXIT=0     "${SCRIPT_DIR}/verify-jazz-clean-authority-post-handoff.sh" rehearsal >/dev/null 2>&1
  rc=$?
  set -e
  [[ "${rc}" -eq 2 ]]
  python3 - "${journal}" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x["phase"]=="validating"
assert x["startupAttempted"] is True
assert x["servicesStartedAfterHandoff"] is True
assert x["validationComplete"] is False
PY
}

run_post_case rejected '{}'
run_post_case malformed '{not-json'

printf '%s\n' 'jazz clean reseed wrappers fail closed: ok'
