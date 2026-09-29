#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(mktemp -d /tmp/remote-mcp-jazz-handoff.XXXXXX)"
trap 'rm -rf -- "${ROOT}"' EXIT

LIVE="${ROOT}/live"
STAGE="${ROOT}/stage"
ROLLBACK="${ROOT}/rollback/old-authority"
PENDING="${ROOT}/pending-validation.json"

mkdir -p "${LIVE}" "${STAGE}" "$(dirname "${ROLLBACK}")"
printf '%s\n' old >"${LIVE}/sentinel.txt"
printf '%s\n' new >"${STAGE}/sentinel.txt"

DEVICE_RESEED_HANDOFF_REHEARSAL_ROOT="${ROOT}" DEVICE_RESEED_HANDOFF_LIVE_AUTHORITY_DIR="${LIVE}" DEVICE_RESEED_HANDOFF_STAGED_AUTHORITY_DIR="${STAGE}" DEVICE_RESEED_HANDOFF_ROLLBACK_AUTHORITY_DIR="${ROLLBACK}" DEVICE_RESEED_HANDOFF_PENDING_MARKER="${PENDING}"   "${SCRIPT_DIR}/apply-jazz-clean-authority-handoff.sh" rehearsal >/dev/null

[[ "$(cat "${LIVE}/sentinel.txt")" == "new" ]]
[[ "$(cat "${ROLLBACK}/sentinel.txt")" == "old" ]]
[[ -f "${PENDING}" ]]
python3 - "${PENDING}" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
assert x["mode"]=="rehearsal"
assert x["servicesStartedAfterHandoff"] is False
assert x["validationComplete"] is False
PY

FAIL_ROOT="$(mktemp -d /tmp/remote-mcp-jazz-handoff.XXXXXX)"
LIVE2="${FAIL_ROOT}/live"
MISSING_STAGE="${FAIL_ROOT}/missing-stage"
ROLLBACK2="${FAIL_ROOT}/rollback/old-authority"
mkdir -p "${LIVE2}" "$(dirname "${ROLLBACK2}")"
printf '%s\n' old2 >"${LIVE2}/sentinel.txt"

set +e
DEVICE_RESEED_HANDOFF_REHEARSAL_ROOT="${FAIL_ROOT}" DEVICE_RESEED_HANDOFF_LIVE_AUTHORITY_DIR="${LIVE2}" DEVICE_RESEED_HANDOFF_STAGED_AUTHORITY_DIR="${MISSING_STAGE}" DEVICE_RESEED_HANDOFF_ROLLBACK_AUTHORITY_DIR="${ROLLBACK2}"   "${SCRIPT_DIR}/apply-jazz-clean-authority-handoff.sh" rehearsal >/dev/null 2>&1
rc=$?
set -e
[[ "${rc}" -ne 0 ]]
[[ -f "${LIVE2}/sentinel.txt" ]]
[[ "$(cat "${LIVE2}/sentinel.txt")" == "old2" ]]
[[ ! -e "${ROLLBACK2}" ]]
rm -rf -- "${FAIL_ROOT}"

printf '%s\n' 'jazz clean authority handoff rehearsal: ok'
