/** Real multi-process ownership test for the native pairing lease. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(tmpdir(), 'dc-passkey-lease-'));
const lockPath = path.join(root, 'pairing.lock');
const continuePath = path.join(root, 'continue');
const childScript = String.raw`
  import { existsSync } from 'node:fs';
  const { NativeCredentialStore } = await import('./dist/remote-device/native-credential-store.js');
  const { createRemoteIdentity } = await import('./dist/remote-device/remote-identity.js');
  const identity = createRemoteIdentity({
    runtimeProfile: 'test',
    authorizationServerIssuer: 'https://auth.example.test',
    publicMcpResource: 'https://device.example.test/mcp',
    internalDeviceApiOrigin: 'http://127.0.0.1:3000',
  });
  const store = new NativeCredentialStore(identity);
  await store.runPairingExclusive(async (lease) => {
    console.log('ACQUIRED');
    while (!existsSync(process.env.DC_TEST_CONTINUE)) await new Promise((r) => setTimeout(r, 20));
    try { await lease.assertHeld(); console.log('HELD'); }
    catch { console.log('LOST'); }
  });
  console.log('DONE');
`;
const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
  cwd: repoRoot,
  env: {
    ...process.env,
    DC_DEVICE_PAIRING_LOCK_PATH: lockPath,
    DC_TEST_CONTINUE: continuePath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childClosed = new Promise((resolve) => child.once('close', resolve));
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

async function waitFor(text, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!stdout.includes(text) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(stdout.includes(text), `timed out waiting for ${text}; stdout=${stdout}; stderr=${stderr}`);
}

try {
  await waitFor('ACQUIRED');
  const original = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.match(original.nonce, /^[0-9a-f]{32}$/);
  await rm(lockPath);
  const replacement = {
    nonce: 'f'.repeat(32),
    pid: process.pid,
    revision: 99,
    expiresAt: Date.now() + 60_000,
  };
  await writeFile(lockPath, JSON.stringify(replacement), { mode: 0o600 });
  await writeFile(continuePath, 'go');
  await waitFor('LOST');

  const exitCode = await childClosed;
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /DONE/);
  const surviving = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(surviving.nonce, replacement.nonce);
  assert.equal(surviving.revision, 99);
  console.log('✓ native pairing lease rejects ownership replacement without deleting the winner');
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
