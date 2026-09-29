#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOTS=()
cleanup() {
  for root in "${ROOTS[@]:-}"; do rm -rf -- "${root}"; done
}
trap cleanup EXIT

new_case() {
  CASE_ROOT="$(mktemp -d /tmp/remote-mcp-jazz-handoff.XXXXXX)"
  ROOTS+=("${CASE_ROOT}")
  LIVE="${CASE_ROOT}/live"
  STAGE="${CASE_ROOT}/stage"
  ROLLBACK="${CASE_ROOT}/rollback/old-authority"
  JOURNAL="${CASE_ROOT}/pending-validation.json"
  RECOVERY="${CASE_ROOT}/recovery"
  mkdir -p "${LIVE}" "${STAGE}" "$(dirname "${ROLLBACK}")" "${RECOVERY}"
  printf '%s\n' old >"${LIVE}/sentinel.txt"
  printf '%s\n' new >"${STAGE}/sentinel.txt"
}

run_rehearsal() {
  DEVICE_RESEED_HANDOFF_REHEARSAL_ROOT="${CASE_ROOT}"   DEVICE_RESEED_HANDOFF_LIVE_AUTHORITY_DIR="${LIVE}"   DEVICE_RESEED_HANDOFF_STAGED_AUTHORITY_DIR="${STAGE}"   DEVICE_RESEED_HANDOFF_ROLLBACK_AUTHORITY_DIR="${ROLLBACK}"   DEVICE_RESEED_HANDOFF_PENDING_MARKER="${JOURNAL}"   DEVICE_RESEED_HANDOFF_RECOVERY_DIR="${RECOVERY}"   DEVICE_RESEED_HANDOFF_FAILPOINT="${1:-}"   DEVICE_RESEED_HANDOFF_HARD_FAILPOINT="${2:-}"     "${SCRIPT_DIR}/apply-jazz-clean-authority-handoff.sh" rehearsal
}

assert_old_live_new_stage() {
  [[ -f "${LIVE}/sentinel.txt" && "$(cat "${LIVE}/sentinel.txt")" == "old" ]]
  [[ -f "${STAGE}/sentinel.txt" && "$(cat "${STAGE}/sentinel.txt")" == "new" ]]
  [[ ! -e "${ROLLBACK}" ]]
}

# Happy path: journal exists before mutation and finishes awaiting validation.
new_case
run_rehearsal >/dev/null
[[ "$(cat "${LIVE}/sentinel.txt")" == "new" ]]
[[ "$(cat "${ROLLBACK}/sentinel.txt")" == "old" ]]
[[ ! -e "${STAGE}" ]]
python3 - "${JOURNAL}" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
assert x["mode"]=="rehearsal"
assert x["phase"]=="awaiting-validation"
assert x["servicesStartedAfterHandoff"] is False
assert x["validationComplete"] is False
PY

# Soft errors immediately after durable journal phases must restore both paths.
for point in after-journal-prepared after-journal-old-moved after-journal-new-live; do
  new_case
  set +e
  run_rehearsal "${point}" "" >/dev/null 2>&1
  rc=$?
  set -e
  [[ "${rc}" -ne 0 ]]
  assert_old_live_new_stage
  python3 - "${JOURNAL}" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
assert x["phase"]=="rolled-back-after-error"
PY
done

# Hard interruption after the first rename leaves a durable pre-rename journal;
# recover infers the directory state and restores the old authority.
new_case
set +e
run_rehearsal "" after-old-move-before-journal >/dev/null 2>&1
rc=$?
set -e
[[ "${rc}" -ne 0 ]]
[[ ! -e "${LIVE}" && -d "${ROLLBACK}" && -d "${STAGE}" ]]
python3 - "${JOURNAL}" <<'PY'
import json,sys
assert json.load(open(sys.argv[1],encoding="utf-8"))["phase"]=="prepared"
PY
DEVICE_RESEED_HANDOFF_PENDING_MARKER="${JOURNAL}" "${SCRIPT_DIR}/apply-jazz-clean-authority-handoff.sh" recover >/dev/null
assert_old_live_new_stage
[[ ! -e "${JOURNAL}" ]]
find "${RECOVERY}" -maxdepth 1 -type f -name 'handoff-journal-recovered-old-move-*.json' | grep -q .

# Hard interruption after the second rename leaves new live + old rollback.
# Recovery restores old live and puts the staged authority back in place.
new_case
set +e
run_rehearsal "" after-new-move-before-journal >/dev/null 2>&1
rc=$?
set -e
[[ "${rc}" -ne 0 ]]
[[ -d "${LIVE}" && ! -e "${STAGE}" && -d "${ROLLBACK}" ]]
[[ "$(cat "${LIVE}/sentinel.txt")" == "new" ]]
python3 - "${JOURNAL}" <<'PY'
import json,sys
assert json.load(open(sys.argv[1],encoding="utf-8"))["phase"]=="old-moved"
PY
DEVICE_RESEED_HANDOFF_PENDING_MARKER="${JOURNAL}" "${SCRIPT_DIR}/apply-jazz-clean-authority-handoff.sh" recover >/dev/null
assert_old_live_new_stage
[[ ! -e "${JOURNAL}" ]]
find "${RECOVERY}" -maxdepth 1 -type f -name 'handoff-journal-recovered-new-move-*.json' | grep -q .

# Invalid preconditions still fail before mutation.
new_case
rm -rf "${STAGE}"
set +e
run_rehearsal >/dev/null 2>&1
rc=$?
set -e
[[ "${rc}" -ne 0 ]]
[[ -f "${LIVE}/sentinel.txt" && "$(cat "${LIVE}/sentinel.txt")" == "old" ]]
[[ ! -e "${ROLLBACK}" ]]

printf '%s\n' 'jazz clean authority handoff journal/recovery: ok'
