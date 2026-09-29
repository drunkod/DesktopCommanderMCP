#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
APP_DIR="${ROOT}/apps/control-plane"

SQLITE=/usr/bin/sqlite3
if [[ ! -x "${SQLITE}" ]]; then
  printf '%s\n' 'error: /usr/bin/sqlite3 is required' >&2
  exit 1
fi

AUTHORITY_DB="${REMOTE_MCP_REHEARSAL_AUTHORITY_DB:-${ROOT}/.data/jazz/jazz.sqlite}"
BACKEND_DB="${REMOTE_MCP_REHEARSAL_BACKEND_DB:-${ROOT}/.data/jazz-backend-runtime.db}"

for required_var in \
  DEVICE_REHEARSAL_DEVICE_ID \
  DEVICE_REHEARSAL_EXPECTED_BACKEND_STABLE_ID \
  DEVICE_REHEARSAL_EXPECTED_CANONICAL_STABLE_ID; do
  if [[ -z "${!required_var:-}" ]]; then
    printf 'error: %s is required\n' "${required_var}" >&2
    exit 1
  fi
done

if [[ ! -f "${AUTHORITY_DB}" || ! -f "${BACKEND_DB}" ]]; then
  printf '%s\n' 'error: both source database files must exist' >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d /tmp/remote-mcp-jazz-repair-rehearsal.XXXXXX)"
trap 'rm -rf -- "${TEMP_DIR}"' EXIT

for operation in backend-update backend-upsert admin-upsert; do
  OP_DIR="${TEMP_DIR}/${operation}"
  mkdir -p -- "${OP_DIR}/authority"
  "${SQLITE}" "${AUTHORITY_DB}" ".backup '${OP_DIR}/authority/jazz.sqlite'"
  "${SQLITE}" "${BACKEND_DB}" ".backup '${OP_DIR}/backend.db'"

  TIMEOUT_MARKER="${OP_DIR}/candidate-timeout"
  (
    cd -- "${APP_DIR}"
    exec env \
    DEVICE_REHEARSAL_OPERATION="${operation}" \
    DEVICE_REHEARSAL_AUTHORITY_DIR="${OP_DIR}/authority" \
    DEVICE_REHEARSAL_BACKEND_DATA_PATH="${OP_DIR}/backend.db" \
    DEVICE_REHEARSAL_LIVE_AUTHORITY_DB="${AUTHORITY_DB}" \
    DEVICE_REHEARSAL_LIVE_BACKEND_DB="${BACKEND_DB}" \
    DEVICE_REHEARSAL_DEVICE_ID="${DEVICE_REHEARSAL_DEVICE_ID}" \
    DEVICE_REHEARSAL_EXPECTED_BACKEND_STABLE_ID="${DEVICE_REHEARSAL_EXPECTED_BACKEND_STABLE_ID}" \
    DEVICE_REHEARSAL_EXPECTED_CANONICAL_STABLE_ID="${DEVICE_REHEARSAL_EXPECTED_CANONICAL_STABLE_ID}" \
    NODE_ENV=production \
      node --env-file=.env.local --import tsx ./scripts/rehearse-device-branch-repair-copy.ts
  ) &
  candidate_pid=$!

  (
    sleep 30
    if kill -0 "${candidate_pid}" 2>/dev/null; then
      : >"${TIMEOUT_MARKER}"
      kill -TERM "${candidate_pid}" 2>/dev/null || true
      sleep 1
      if kill -0 "${candidate_pid}" 2>/dev/null; then
        kill -KILL "${candidate_pid}" 2>/dev/null || true
      fi
    fi
  ) &
  watchdog_pid=$!

  set +e
  wait "${candidate_pid}"
  candidate_rc=$?
  set -e

  kill "${watchdog_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || true

  if [[ -e "${TIMEOUT_MARKER}" ]]; then
    printf '{"operation":"%s","candidateSucceeded":false,"candidateError":"candidate process timed out after 30s","before":null,"immediateAfter":null,"afterRestartFreshBackend":null,"durableCanonical":false}\n' "${operation}"
    continue
  fi
  if [[ "${candidate_rc}" -ne 0 ]]; then
    exit "${candidate_rc}"
  fi
done
