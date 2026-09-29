#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
APP_DIR="${ROOT}/apps/control-plane"
LSOF=/usr/sbin/lsof
PENDING="${ROOT}/.data/reseed-handoff-pending-validation.json"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

"${SCRIPT_DIR}/independent-control-preflight.sh" check >/dev/null

for marker in   "${ROOT}/.data/task-admission.frozen"   "${ROOT}/.data/effect-admission.frozen"   "${ROOT}/.data/public-ingress.frozen"; do
  [[ -f "${marker}" ]] || fail "post-handoff validation requires freeze marker: ${marker##*/}"
done

[[ -f "${PENDING}" ]] || fail "pending-validation marker is missing"

if ! launchctl print "gui/$(id -u)/com.remote-mcp.local-stack" >/dev/null 2>&1; then
  fail "launchd stack must be running for post-handoff validation"
fi
if ! "${LSOF}" -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then fail "port 3000 is not listening"; fi
if ! "${LSOF}" -nP -iTCP:1625 -sTCP:LISTEN >/dev/null 2>&1; then fail "port 1625 is not listening"; fi

STAGE_DIR="$(python3 - "${PENDING}" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
if x.get("validationComplete"):
    raise SystemExit("error: handoff is already marked validated")
print(x["stageDir"])
PY
)"
ROLLBACK_AUTHORITY="$(python3 - "${PENDING}" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
print(x["rollbackAuthorityDir"])
PY
)"
STAGE_MANIFEST="${STAGE_DIR}/stage-manifest.json"
[[ -f "${STAGE_MANIFEST}" ]] || fail "stage manifest is missing"
[[ -d "${ROLLBACK_AUTHORITY}" ]] || fail "rollback authority directory is missing"

RECOVERY_DIR="$(dirname "${ROLLBACK_AUTHORITY}")"
RESULT="${RECOVERY_DIR}/post-handoff-validation.json"
STDERR_LOG="${RECOVERY_DIR}/post-handoff-validation.stderr.log"
[[ ! -e "${RESULT}" ]] || fail "post-handoff validation result already exists"

set +e
(
  cd "${APP_DIR}"
  DEVICE_RESEED_STAGE_MANIFEST="${STAGE_MANIFEST}"   NODE_ENV=production     node --env-file=.env.local --import tsx ./scripts/verify-clean-authority-post-handoff.ts
) >"${RESULT}" 2>"${STDERR_LOG}"
rc=$?
set -e
chmod 400 "${RESULT}" "${STDERR_LOG}"

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
  printf 'validationResult=%s\n' "${RESULT}"
  printf 'liveValidationAccepted=false\n'
  printf 'exitCode=%s\n' "${rc}"
  exit "${rc}"
fi

VALIDATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
python3 - "${PENDING}" "${RESULT}" "${VALIDATED_AT}" <<'PY'
import json,sys,tempfile,os
path,result,validated_at=sys.argv[1:4]
x=json.load(open(path,encoding="utf-8"))
x["servicesStartedAfterHandoff"]=True
x["validationComplete"]=True
x["validatedAt"]=validated_at
x["validationResult"]=result
fd,tmp=tempfile.mkstemp(prefix=".pending.",dir=os.path.dirname(path))
with os.fdopen(fd,"w",encoding="utf-8") as f:
    json.dump(x,f,indent=2,sort_keys=True)
    f.write("\n")
os.chmod(tmp,0o600)
os.replace(tmp,path)
PY

printf 'validationResult=%s\n' "${RESULT}"
printf '%s\n' 'liveValidationAccepted=true'
printf '%s\n' 'admissionsReopenAuthorized=false'
printf '%s\n' 'publicIngressReopenAuthorized=false'
printf 'exitCode=0\n'
