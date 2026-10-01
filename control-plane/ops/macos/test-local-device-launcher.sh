#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PREPARE="$SCRIPT_DIR/prepare-local-device-env.sh"
SOURCE_RUNNER="$SCRIPT_DIR/run-local-device.sh"
NODE_EXECUTABLE="$(command -v node)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

REPO="$TMP_DIR/repo"
ROOT="$REPO/control-plane"
mkdir -p "$ROOT/apps/control-plane" "$ROOT/.data" "$ROOT/ops/macos" "$REPO/dist"
cp "$SOURCE_PREPARE" "$ROOT/ops/macos/prepare-local-device-env.sh"
cp "$SOURCE_RUNNER" "$ROOT/ops/macos/run-local-device.sh"
chmod +x "$ROOT/ops/macos/prepare-local-device-env.sh" "$ROOT/ops/macos/run-local-device.sh"

cat >"$ROOT/apps/control-plane/.env.local" <<'EOF'
APP_ORIGIN=https://example.test
REMOTE_MCP_RESOURCE=https://example.test/mcp
JAZZ_APP_ID=fixture-app-id
JAZZ_SERVER_URL=http://127.0.0.1:1625
SECRET_SHOULD_NOT_LEAK=fixture-secret
EOF
printf 'NODE_BIN=%q\n' "$NODE_EXECUTABLE" >"$ROOT/.data/launchd-runtime.env"
chmod 600 "$ROOT/.data/launchd-runtime.env"

REMOTE_MCP_ROOT="$ROOT" "$ROOT/ops/macos/prepare-local-device-env.sh" >/dev/null
DEVICE_ENV="$ROOT/.data/device-agent.env"
CONFIG="$ROOT/.data/device-agent/device.json"

[[ -f "$DEVICE_ENV" ]] || { echo "device env was not created" >&2; exit 1; }
[[ "$(/usr/bin/stat -f '%Lp' "$DEVICE_ENV")" == "600" ]] || { echo "device env mode is not 0600" >&2; exit 1; }
grep -Fq 'DC_REMOTE_RUNTIME_PROFILE=production' "$DEVICE_ENV"
grep -Fq 'DC_REMOTE_AUTH_ISSUER=https://example.test/api/auth' "$DEVICE_ENV"
grep -Fq 'REMOTE_MCP_RESOURCE=https://example.test/mcp' "$DEVICE_ENV"
grep -Fq 'JAZZ_APP_ID=fixture-app-id' "$DEVICE_ENV"
grep -Fq 'JAZZ_SERVER_URL=http://127.0.0.1:1625' "$DEVICE_ENV"
grep -Fq 'MCP_SERVER_URL=http://127.0.0.1:3000' "$DEVICE_ENV"
grep -Fq 'DC_DEVICE_CREDENTIAL_SERVICE=com.desktopcommander.remote-mcp.local-jazz' "$DEVICE_ENV"
grep -Fq 'DC_DEVICE_CREDENTIAL_ACCOUNT=device-oauth-session' "$DEVICE_ENV"
if grep -Fq 'SECRET_SHOULD_NOT_LEAK' "$DEVICE_ENV" || grep -Fq 'fixture-secret' "$DEVICE_ENV"; then
  echo "server secret leaked into device environment" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$DEVICE_ENV"
GENERATED_DPAPI_PATH="$DC_DEVICE_DPAPI_PATH"
GENERATED_VAULT_LOCK_PATH="$DC_DEVICE_VAULT_LOCK_PATH"
GENERATED_PAIRING_LOCK_PATH="$DC_DEVICE_PAIRING_LOCK_PATH"
GENERATED_REFRESH_LOCK_PATH="$DC_DEVICE_REFRESH_LOCK_PATH"
for generated_path in "$GENERATED_DPAPI_PATH" "$GENERATED_VAULT_LOCK_PATH" "$GENERATED_PAIRING_LOCK_PATH" "$GENERATED_REFRESH_LOCK_PATH"; do
  [[ "$generated_path" = /* && "$generated_path" == "$ROOT/.data/device-agent/"* ]] || {
    echo "generated credential path is not absolute and isolated: $generated_path" >&2
    exit 1
  }
done

set +e
REMOTE_MCP_ROOT="$ROOT" REMOTE_MCP_DEVICE_ENV="$DEVICE_ENV"   "$ROOT/ops/macos/run-local-device.sh" >/dev/null 2>"$TMP_DIR/missing-config.err"
missing_rc=$?
set -e
[[ "$missing_rc" -ne 0 ]]
grep -Fq 'isolated device config is missing' "$TMP_DIR/missing-config.err"

printf '{\n  "stableId": "stable-fixture-0001"\n}\n' >"$CONFIG"
chmod 600 "$CONFIG"

cat >"$REPO/dist/index.js" <<'EOF'
import fs from "node:fs";
const output = process.env.DEVICE_LAUNCH_TEST_OUTPUT;
const result = {
  argv: process.argv.slice(2),
  profile: process.env.DC_REMOTE_RUNTIME_PROFILE,
  issuer: process.env.DC_REMOTE_AUTH_ISSUER,
  resource: process.env.REMOTE_MCP_RESOURCE,
  jazzAppId: process.env.JAZZ_APP_ID,
  jazzServer: process.env.JAZZ_SERVER_URL,
  server: process.env.MCP_SERVER_URL,
  config: process.env.DC_REMOTE_DEVICE_CONFIG_PATH,
  service: process.env.DC_DEVICE_CREDENTIAL_SERVICE,
  account: process.env.DC_DEVICE_CREDENTIAL_ACCOUNT,
  dpapiPath: process.env.DC_DEVICE_DPAPI_PATH,
  vaultLockPath: process.env.DC_DEVICE_VAULT_LOCK_PATH,
  pairingLockPath: process.env.DC_DEVICE_PAIRING_LOCK_PATH,
  refreshLockPath: process.env.DC_DEVICE_REFRESH_LOCK_PATH,
  leaked: process.env.SECRET_SHOULD_NOT_LEAK ?? null,
};
fs.writeFileSync(output, JSON.stringify(result));
EOF

OUTPUT="$TMP_DIR/device-launch.json"
DEVICE_LAUNCH_TEST_OUTPUT="$OUTPUT" REMOTE_MCP_ROOT="$ROOT" REMOTE_MCP_DEVICE_ENV="$DEVICE_ENV"   "$ROOT/ops/macos/run-local-device.sh"

"$NODE_EXECUTABLE" - "$OUTPUT" "$CONFIG" "$GENERATED_DPAPI_PATH" "$GENERATED_VAULT_LOCK_PATH" "$GENERATED_PAIRING_LOCK_PATH" "$GENERATED_REFRESH_LOCK_PATH" <<'NODE'
const fs = require("node:fs");
const [output, config, dpapiPath, vaultLockPath, pairingLockPath, refreshLockPath] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(output, "utf8"));
const expectedArgv = ["remote", "--tunnel", "none", "--disable-no-sleep"];
if (JSON.stringify(result.argv) !== JSON.stringify(expectedArgv)) throw new Error("unexpected device CLI arguments");
if (result.profile !== "production") throw new Error("unexpected runtime profile");
if (result.issuer !== "https://example.test/api/auth") throw new Error("unexpected issuer");
if (result.resource !== "https://example.test/mcp") throw new Error("unexpected resource");
if (result.jazzAppId !== "fixture-app-id") throw new Error("unexpected Jazz app id");
if (result.jazzServer !== "http://127.0.0.1:1625") throw new Error("unexpected Jazz server");
if (result.server !== "http://127.0.0.1:3000") throw new Error("unexpected loopback server");
if (result.config !== config) throw new Error("unexpected device config path");
if (result.service !== "com.desktopcommander.remote-mcp.local-jazz") throw new Error("unexpected credential service");
if (result.account !== "device-oauth-session") throw new Error("unexpected credential account");
if (result.dpapiPath !== dpapiPath) throw new Error("unexpected DPAPI path");
if (result.vaultLockPath !== vaultLockPath) throw new Error("unexpected vault lock path");
if (result.pairingLockPath !== pairingLockPath) throw new Error("unexpected pairing lock path");
if (result.refreshLockPath !== refreshLockPath) throw new Error("unexpected refresh lock path");
if (result.leaked !== null) throw new Error("server secret leaked into device process");
NODE

cp "$DEVICE_ENV" "$TMP_DIR/shared-default.env"
"$NODE_EXECUTABLE" - "$TMP_DIR/shared-default.env" <<'NODE'
const fs = require('fs');
const filePath = process.argv[2];
const oldLine = 'DC_DEVICE_CREDENTIAL_SERVICE=com.desktopcommander.remote-mcp.local-jazz';
const newLine = 'DC_DEVICE_CREDENTIAL_SERVICE=com.desktopcommander.remote-mcp';
const contents = fs.readFileSync(filePath, 'utf8');
const index = contents.indexOf(oldLine);
if (index === -1) {
  throw new Error(`Required line not found in ${filePath}`);
}
fs.writeFileSync(filePath, contents.slice(0, index) + newLine + contents.slice(index + oldLine.length), 'utf8');
NODE
set +e
REMOTE_MCP_ROOT="$ROOT" REMOTE_MCP_DEVICE_ENV="$TMP_DIR/shared-default.env" \
  "$ROOT/ops/macos/run-local-device.sh" >/dev/null 2>"$TMP_DIR/shared-default.err"
shared_default_rc=$?
set -e
[[ "$shared_default_rc" -ne 0 ]]
grep -Fq 'refusing to use shared default credential namespace' "$TMP_DIR/shared-default.err"

echo "local device launcher integration: ok (public-only env, isolated config, no tunnel ownership)"
