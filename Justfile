set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
  @just --list

bootstrap:
  npm ci

check:
  npm run build

remote-safety: check
  node test/test-remote-jazz-safety.js

supervision: check
  node test/test-spawn-error-no-crash.js
  node test/test-remote-device-supervision.js

remote-gate: remote-safety supervision
  @echo "Remote Jazz migration gate passed"

test:
  npm test

full-gate: remote-gate test
  @echo "DesktopCommanderMCP full gate passed"

integration:
  npm run test:integration

validate-tools:
  npm run validate:tools

device:
  npm run device:start

status:
  git status --short