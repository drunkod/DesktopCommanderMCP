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

remote-tunnel-unit: check
  node test/test-remote-tunnels.js

remote-tunnel-e2e-tailscale: check
  test "$${DC_TUNNEL_E2E:-}" = "1" || { echo "DC_TUNNEL_E2E=1 is required"; exit 2; }
  test "$${DC_TAILSCALE_E2E_ALLOW_MUTATION:-}" = "1" || { echo "DC_TAILSCALE_E2E_ALLOW_MUTATION=1 is required"; exit 2; }
  test -n "$${DC_TAILSCALE_STATE_PATH:-}" || { echo "DC_TAILSCALE_STATE_PATH is required"; exit 2; }
  case "$${DC_TAILSCALE_STATE_PATH}" in *e2e*|*test*|*disposable*) ;; *) echo "DC_TAILSCALE_STATE_PATH must identify disposable test state"; exit 2 ;; esac
  node test/integration/tailscale-funnel-e2e.js

remote-tunnel-e2e-zrok: check
  test "$${DC_TUNNEL_E2E:-}" = "1" || { echo "DC_TUNNEL_E2E=1 is required"; exit 2; }
  test -n "$${DC_ZROK_NAMESPACE:-}" || { echo "DC_ZROK_NAMESPACE is required"; exit 2; }
  test -n "$${DC_ZROK_NAME:-}" || { echo "DC_ZROK_NAME is required"; exit 2; }
  test -n "$${DC_ZROK_STATE_PATH:-}" || { echo "DC_ZROK_STATE_PATH is required"; exit 2; }
  node test/integration/zrok-remote-mcp-e2e.js

remote-tunnel-e2e: remote-tunnel-e2e-tailscale remote-tunnel-e2e-zrok

remote-tunnels: remote-tunnel-unit

remote-gate: remote-safety supervision remote-tunnels
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

tested-build-capture:
  node scripts/capture-tested-build-state.mjs

tested-build-verify:
  node scripts/capture-tested-build-state.mjs --verify

status:
  git status --short
