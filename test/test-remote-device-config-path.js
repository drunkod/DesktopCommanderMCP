import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const { MCPDevice } = await import('../dist/remote-device/device.js');

const identity = {
  runtimeProfile: 'test',
  authorizationServerIssuer: 'http://127.0.0.1:3000/api/auth',
  publicMcpResource: 'http://127.0.0.1:3000/mcp',
  internalDeviceApiOrigin: 'http://127.0.0.1:3000',
};

const original = process.env.DC_REMOTE_DEVICE_CONFIG_PATH;

try {
  delete process.env.DC_REMOTE_DEVICE_CONFIG_PATH;
  const defaultDevice = new MCPDevice({ persistSession: false, identity });
  assert.equal(
    defaultDevice.configPath,
    path.join(os.homedir(), '.desktop-commander-device', 'device.json'),
  );

  const envPath = path.join(os.tmpdir(), 'desktop-commander-jazz-env-device.json');
  process.env.DC_REMOTE_DEVICE_CONFIG_PATH = envPath;
  const envDevice = new MCPDevice({ persistSession: false, identity });
  assert.equal(envDevice.configPath, envPath);

  const optionPath = path.join(os.tmpdir(), 'desktop-commander-jazz-option-device.json');
  const optionDevice = new MCPDevice({
    persistSession: false,
    identity,
    configPath: optionPath,
  });
  assert.equal(optionDevice.configPath, optionPath);

  process.env.DC_REMOTE_DEVICE_CONFIG_PATH = 'relative/device.json';
  assert.throws(
    () => new MCPDevice({ persistSession: false, identity }),
    /DC_REMOTE_DEVICE_CONFIG_PATH must be an absolute path/,
  );

  console.log('remote device config path isolation: ok');
} finally {
  if (original === undefined) delete process.env.DC_REMOTE_DEVICE_CONFIG_PATH;
  else process.env.DC_REMOTE_DEVICE_CONFIG_PATH = original;
}
