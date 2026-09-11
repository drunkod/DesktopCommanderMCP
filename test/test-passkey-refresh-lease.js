/** Concurrent rotating-refresh serialization and native refresh-lease regression. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createRemoteIdentity } = await import('../dist/remote-device/remote-identity.js');
const { MemoryCredentialStore } = await import('../dist/remote-device/credential-store.js');
const { DeviceTokenManager } = await import('../dist/remote-device/token-manager.js');
const { installOAuthHttpTransportForTests, resetOAuthHttpTransportForTests } = await import('../dist/remote-device/oauth-http.js');

const identity = createRemoteIdentity({
  runtimeProfile: 'test',
  authorizationServerIssuer: 'https://auth.example.test',
  publicMcpResource: 'https://device.example.test/mcp',
  internalDeviceApiOrigin: 'http://127.0.0.1:3000',
});
const source = Object.freeze({
  version: 2,
  issuer: identity.authorizationServerIssuer,
  resource: identity.publicMcpResource,
  clientId: 'client-refresh-race',
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: Date.now() + 1_000,
  scope: 'device:sync offline_access',
  generation: 1,
});
const metadata = {
  issuer: identity.authorizationServerIssuer,
  authorization_endpoint: 'https://auth.example.test/authorize',
  registration_endpoint: 'https://auth.example.test/oauth2/register',
  device_authorization_endpoint: 'https://auth.example.test/oauth2/device-authorization',
  token_endpoint: 'https://auth.example.test/oauth2/token',
  jwks_uri: 'https://auth.example.test/jwks',
  revocation_endpoint: 'https://auth.example.test/oauth2/revoke',
  grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['mcp:tools', 'device:sync', 'offline_access'],
};
let refreshRequests = 0;
let revokeRequests = 0;
installOAuthHttpTransportForTests(async (url) => {
  const value = String(url);
  if (value.includes('/.well-known/oauth-authorization-server')) {
    return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (value.endsWith('/oauth2/token')) {
    refreshRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return new Response(JSON.stringify({
      access_token: 'winner-access', refresh_token: 'winner-refresh', expires_in: 300,
      scope: 'device:sync offline_access', token_type: 'Bearer',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (value.endsWith('/oauth2/revoke')) {
    revokeRequests += 1;
    return new Response(null, { status: 200 });
  }
  throw new Error(`unexpected OAuth URL ${value}`);
});
class CountingMemoryStore extends MemoryCredentialStore {
  refreshLeaseEntries = 0;
  async runRefreshExclusive(operation) {
    this.refreshLeaseEntries += 1;
    return super.runRefreshExclusive(operation);
  }
}
const singleFlightStore = new CountingMemoryStore(identity);
assert.equal(await singleFlightStore.runExclusive((locked) => locked.saveExpected({
  session: source, expectedClearGeneration: 0, expectedSessionGeneration: null,
})), true);
const singleManager = new DeviceTokenManager(singleFlightStore, identity);
const singleTokens = await Promise.all([
  singleManager.getAccessToken(), singleManager.getAccessToken(), singleManager.getAccessToken(),
]);
assert.deepEqual(singleTokens, ['winner-access', 'winner-access', 'winner-access']);
assert.equal(singleFlightStore.refreshLeaseEntries, 1, 'same-manager callers must share refreshInFlight');
assert.equal(refreshRequests, 1);
refreshRequests = 0;

const store = new MemoryCredentialStore(identity);
assert.equal(await store.runExclusive((locked) => locked.saveExpected({
  session: source,
  expectedClearGeneration: 0,
  expectedSessionGeneration: null,
})), true);
const managerA = new DeviceTokenManager(store, identity);
const managerB = new DeviceTokenManager(store, identity);
const [tokenA, tokenB] = await Promise.all([
  managerA.getAccessToken(),
  managerB.getAccessToken(),
]);
assert.equal(tokenA, 'winner-access');
assert.equal(tokenB, 'winner-access');
assert.equal(refreshRequests, 1, 'rotating refresh token must reach token endpoint exactly once');
assert.equal(revokeRequests, 0, 'waiter must never revoke the persisted winner');
const winner = await store.runExclusive((locked) => locked.load());
assert.equal(winner.session?.generation, 2);
assert.equal(winner.session?.refreshToken, 'winner-refresh');
assert.equal(winner.cleanupObligations.length, 0);
resetOAuthHttpTransportForTests();

const root = await mkdtemp(path.join(tmpdir(), 'dc-refresh-lease-'));
const lockPath = path.join(root, 'refresh.lock');
const releaseAPath = path.join(root, 'release-a');
const childScript = String.raw`
  import { existsSync } from 'node:fs';
  const { NativeCredentialStore } = await import('./dist/remote-device/native-credential-store.js');
  const { createRemoteIdentity } = await import('./dist/remote-device/remote-identity.js');
  const identity = createRemoteIdentity({ runtimeProfile: 'test', authorizationServerIssuer: 'https://auth.example.test', publicMcpResource: 'https://device.example.test/mcp', internalDeviceApiOrigin: 'http://127.0.0.1:3000' });
  const store = new NativeCredentialStore(identity);
  await store.runRefreshExclusive(async (lease) => {
    console.log(process.env.DC_TEST_ROLE + '_ACQUIRED');
    if (process.env.DC_TEST_ROLE === 'A') while (!existsSync(process.env.DC_TEST_RELEASE_A)) await new Promise((r) => setTimeout(r, 20));
    await lease.assertHeld();
  });
`;
function spawnLeaseChild(role) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: repoRoot,
    env: { ...process.env, DC_DEVICE_REFRESH_LOCK_PATH: lockPath, DC_TEST_RELEASE_A: releaseAPath, DC_TEST_ROLE: role },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, get stdout() { return stdout; }, get stderr() { return stderr; }, closed: new Promise((resolve) => child.once('close', resolve)) };
}
async function waitFor(proc, text, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!proc.stdout.includes(text) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(proc.stdout.includes(text), `timed out waiting for ${text}; stdout=${proc.stdout}; stderr=${proc.stderr}`);
}

const procA = spawnLeaseChild('A');
let procB;
try {
  await waitFor(procA, 'A_ACQUIRED');
  procB = spawnLeaseChild('B');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(procB.stdout.includes('B_ACQUIRED'), false, 'second process entered refresh critical section before release');
  await writeFile(releaseAPath, 'go');
  await waitFor(procB, 'B_ACQUIRED');
  assert.equal(await procA.closed, 0, procA.stderr);
  assert.equal(await procB.closed, 0, procB.stderr);
  console.log('✓ rotating refresh is single-flight and native refresh lease serializes processes');
} finally {
  if (procA.child.exitCode === null) procA.child.kill('SIGKILL');
  if (procB?.child.exitCode === null) procB.child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
