#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="${REMOTE_MCP_ROOT:-$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)}"
JOURNAL="${DEVICE_RESEED_HANDOFF_PENDING_MARKER:-${ROOT}/.data/reseed-handoff-pending-validation.json}"
NODE="${NODE_BIN:-$(command -v node || true)}"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

[[ -e "${JOURNAL}" ]] || exit 0
[[ -f "${JOURNAL}" ]] || fail "handoff startup barrier path is not a regular file"
[[ -n "${NODE}" && -x "${NODE}" ]] || fail "Node runtime is required for handoff startup barrier"

if [[ "${REMOTE_MCP_TESTING:-}" == "1" && "${DEVICE_RESEED_STARTUP_BARRIER_TEST_FAIL:-}" == "1" ]]; then
  fail "injected startup barrier failure"
fi

JOURNAL="${JOURNAL}" ROOT="${ROOT}" REMOTE_MCP_TESTING="${REMOTE_MCP_TESTING:-}" "${NODE}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const journal = process.env.JOURNAL;
const root = fs.realpathSync(process.env.ROOT);
const payload = JSON.parse(fs.readFileSync(journal, "utf8"));

function requireCondition(ok, message) {
  if (!ok) {
    process.stderr.write("error: " + message + "\n");
    process.exit(1);
  }
}

const mode = payload.mode;
if (mode === "rehearsal") {
  requireCondition(process.env.REMOTE_MCP_TESTING === "1", "rehearsal handoff journal is test-only");
} else {
  requireCondition(mode === "apply", "handoff journal mode must be apply");
}

const expectedLive = fs.realpathSync(path.join(root, ".data", "jazz"));
requireCondition(
  fs.realpathSync(payload.liveAuthorityDir || "") === expectedLive,
  "handoff journal live authority does not match this stack",
);

const phase = payload.phase;
const startupAttempted = payload.startupAttempted === true;
const validationComplete = payload.validationComplete === true;

if (phase === "validating" || phase === "validated") {
  requireCondition(startupAttempted, "post-startup handoff phase is missing startupAttempted barrier");
  process.exit(0);
}
if (phase === "startup-attempted") {
  requireCondition(startupAttempted, "startup-attempted phase is missing startupAttempted=true");
  process.exit(0);
}

requireCondition(phase === "awaiting-validation", "handoff journal is not safe to start");
requireCondition(!validationComplete, "validated handoff cannot be awaiting validation");
requireCondition(!startupAttempted, "awaiting-validation journal already records startup attempt");

const now = new Date().toISOString();
payload.phase = "startup-attempted";
payload.startupAttempted = true;
payload.startupAttemptedAt = now;
payload.updatedAt = now;

const directory = path.dirname(journal);
const tmp = path.join(directory, ".handoff-journal." + process.pid + "." + Date.now());
let fd;
try {
  fd = fs.openSync(tmp, "wx", 0o600);
  fs.writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.renameSync(tmp, journal);
  const dfd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(dfd);
  } finally {
    fs.closeSync(dfd);
  }
} finally {
  if (fd !== undefined) {
    try { fs.closeSync(fd); } catch {}
  }
  if (fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
NODE
