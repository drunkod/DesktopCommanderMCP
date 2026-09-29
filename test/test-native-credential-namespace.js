import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { resolveNativeCredentialConfig } from "../dist/remote-device/native-credential-store.js";

const home = path.join(path.parse(os.tmpdir()).root, "synthetic-device-home");
const defaults = resolveNativeCredentialConfig({}, home);
const customRoot = path.join(home, "custom");
const localAppData = path.join(home, "local-app-data");
assert.equal(defaults.service, "com.desktopcommander.remote-mcp");
assert.equal(defaults.account, "device-oauth-session");
assert.equal(defaults.vaultLockPath, path.join(home, ".desktop-commander-device", "device-oauth.lock"));
assert.equal(defaults.pairingLockPath, path.join(home, ".desktop-commander-device", "device-oauth-pairing.lock"));
assert.equal(defaults.refreshLockPath, path.join(home, ".desktop-commander-device", "device-oauth-refresh.lock"));
assert.equal(defaults.dpapiPath, path.join(home, "DesktopCommander", "jazz-oauth.dpapi"));

const custom = resolveNativeCredentialConfig({
  DC_DEVICE_CREDENTIAL_SERVICE: "com.example-device.local",
  DC_DEVICE_CREDENTIAL_ACCOUNT: "device-session:local",
  DC_DEVICE_DPAPI_PATH: path.join(customRoot, "custom.dpapi"),
  DC_DEVICE_VAULT_LOCK_PATH: path.join(customRoot, "vault.lock"),
  DC_DEVICE_PAIRING_LOCK_PATH: path.join(customRoot, "pairing.lock"),
  DC_DEVICE_REFRESH_LOCK_PATH: path.join(customRoot, "refresh.lock"),
}, home);
assert.equal(custom.service, "com.example-device.local");
assert.equal(custom.account, "device-session:local");
assert.equal(custom.dpapiPath, path.join(customRoot, "custom.dpapi"));
assert.equal(custom.vaultLockPath, path.join(customRoot, "vault.lock"));
assert.equal(custom.pairingLockPath, path.join(customRoot, "pairing.lock"));
assert.equal(custom.refreshLockPath, path.join(customRoot, "refresh.lock"));

assert.equal(
  resolveNativeCredentialConfig({ LOCALAPPDATA: localAppData }, home).dpapiPath,
  path.join(localAppData, "DesktopCommander", "jazz-oauth.dpapi"),
);
assert.equal(
  resolveNativeCredentialConfig({ LOCALAPPDATA: "   " }, home).dpapiPath,
  path.join(home, "DesktopCommander", "jazz-oauth.dpapi"),
);

for (const env of [
  { DC_DEVICE_CREDENTIAL_SERVICE: "" },
  { DC_DEVICE_CREDENTIAL_SERVICE: "bad service" },
  { DC_DEVICE_CREDENTIAL_SERVICE: "bad/service" },
  { DC_DEVICE_CREDENTIAL_ACCOUNT: "" },
  { DC_DEVICE_CREDENTIAL_ACCOUNT: "bad account" },
  { DC_DEVICE_CREDENTIAL_ACCOUNT: "bad/account" },
  { DC_DEVICE_DPAPI_PATH: "relative.dpapi" },
  { DC_DEVICE_VAULT_LOCK_PATH: "relative-vault.lock" },
  { DC_DEVICE_PAIRING_LOCK_PATH: "relative-pairing.lock" },
  { DC_DEVICE_REFRESH_LOCK_PATH: "relative-refresh.lock" },
]) {
  assert.throws(() => resolveNativeCredentialConfig(env, home), /invalid|absolute path/);
}

console.log("native credential namespace isolation: ok");
