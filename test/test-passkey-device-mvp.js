/** Focused regression coverage for the DesktopCommanderMCP passkey device MVP. */
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';

const { createRemoteIdentity, loadRemoteIdentityFromEnv } = await import('../dist/remote-device/remote-identity.js');
const { MemoryCredentialStore } = await import('../dist/remote-device/credential-store.js');
const { recoverCorruptCredentialGeneration, parsePersistedCredentialPayload } = await import('../dist/remote-device/native-credential-store.js');
const { HttpDeviceControlPlaneClient } = await import('../dist/remote-device/control-plane-client.js');
const { installOAuthHttpTransportForTests, resetOAuthHttpTransportForTests } = await import('../dist/remote-device/oauth-http.js');
const { DeviceTokenManager } = await import('../dist/remote-device/token-manager.js');
const { parseDeviceOAuthSession } = await import('../dist/remote-device/device-oauth-session.js');
const {
  fetchAuthorizationServerMetadata,
  JwksProviderTokenVerifier,
  OAuthProtocolError,
  RejectedOAuthTokenResponseError,
  pairDevice,
  readBoundedJsonObject,
  registerDeviceClient,
} = await import('../dist/remote-device/device-oauth.js');

const fetchBackedTestTransport = async (url, init) => globalThis.fetch(url, init);
installOAuthHttpTransportForTests(fetchBackedTestTransport);

const identity = createRemoteIdentity({
  runtimeProfile: 'test',
  authorizationServerIssuer: 'https://auth.example.test',
  publicMcpResource: 'https://device.example.test/mcp',
  internalDeviceApiOrigin: 'http://127.0.0.1:3000',
});

const session = Object.freeze({
  version: 2,
  issuer: identity.authorizationServerIssuer,
  resource: identity.publicMcpResource,
  clientId: 'client-1',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 300_000,
  scope: 'device:sync offline_access',
  generation: 1,
});

assert.throws(
  () => createRemoteIdentity({ ...identity, publicMcpResource: 'https://device.example.test/mcp/' }),
  /exact \/mcp path/,
);
assert.throws(
  () => createRemoteIdentity({ ...identity, authorizationServerIssuer: 'http://auth.example.test' }),
  /must use HTTPS/,
);
assert.throws(
  () => loadRemoteIdentityFromEnv('production', {
    REMOTE_MCP_RESOURCE: undefined,
    DC_REMOTE_AUTH_ISSUER: 'https://auth.example.test',
    MCP_SERVER_URL: 'http://127.0.0.1:3000',
  }),
  /REMOTE_MCP_RESOURCE is required in production/,
);

assert.deepEqual(parseDeviceOAuthSession(session, identity), session);
assert.equal(parseDeviceOAuthSession({ ...session, issuer: 'https://other.example.test' }, identity), null);
assert.equal(parseDeviceOAuthSession({ ...session, version: 1 }, identity), null);
assert.equal(parseDeviceOAuthSession({ ...session, scope: 'offline_access' }, identity), null);
assert.equal(parseDeviceOAuthSession({ ...session, scope: 'device:sync offline_access mcp:tools' }, identity), null);

const developmentIdentity = createRemoteIdentity({ ...identity, runtimeProfile: 'development' });
assert.throws(
  () => new DeviceTokenManager(new MemoryCredentialStore(developmentIdentity), developmentIdentity),
  /provider token verifier is required/,
);
await assert.rejects(
  () => registerDeviceClient(developmentIdentity),
  /control-plane bootstrap boundary/,
);

const validMetadata = {
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
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify(validMetadata), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
await fetchAuthorizationServerMetadata(identity);
for (const field of ['authorization_endpoint', 'revocation_endpoint', 'response_types_supported', 'code_challenge_methods_supported', 'scopes_supported']) {
  const incomplete = { ...validMetadata };
  delete incomplete[field];
  globalThis.fetch = async () => new Response(JSON.stringify(incomplete), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(() => fetchAuthorizationServerMetadata(identity), /metadata|advertise|required|invalid/);
}
for (const requiredScope of ['mcp:tools', 'device:sync', 'offline_access']) {
  const incomplete = { ...validMetadata, scopes_supported: validMetadata.scopes_supported.filter((scope) => scope !== requiredScope) };
  globalThis.fetch = async () => new Response(JSON.stringify(incomplete), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    () => fetchAuthorizationServerMetadata(identity),
    new RegExp(`missing required scope ${requiredScope.replace(':', '\\:')}`),
  );
}
globalThis.fetch = async (url) => {
  if (String(url).includes('/.well-known/oauth-authorization-server')) {
    return new Response(JSON.stringify(validMetadata), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    device_code: 'device-code',
    user_code: 'ABCD',
    verification_uri: 'https://auth.example.test/device',
    verification_uri_complete: 'https://auth.example.test/device?user_code=WRONG',
    expires_in: 30,
    interval: 1,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const oldNoBrowser = process.env.DC_DEVICE_NO_BROWSER;
process.env.DC_DEVICE_NO_BROWSER = '1';
await assert.rejects(() => pairDevice(identity, 'client-1'), /verification_uri_complete is not trusted/);
if (oldNoBrowser === undefined) delete process.env.DC_DEVICE_NO_BROWSER;
else process.env.DC_DEVICE_NO_BROWSER = oldNoBrowser;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
const base64url = (value) => Buffer.from(value).toString('base64url');
const signToken = (claims, key = privateKey, header = { alg: 'RS256', kid: 'test-key', typ: 'JWT' }) => {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaims = base64url(JSON.stringify(claims));
  const input = `${encodedHeader}.${encodedClaims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(key).toString('base64url')}`;
};
const verifier = new JwksProviderTokenVerifier();
const validClaims = {
  iss: identity.authorizationServerIssuer,
  aud: identity.publicMcpResource,
  exp: Math.floor(Date.now() / 1000) + 300,
  scope: 'device:sync offline_access',
};
const verifierFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/jwks')) return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(validMetadata), { status: 200, headers: { 'content-type': 'application/json' } });
};
await verifier.verifyAccessToken({ ...session, accessToken: signToken(validClaims) }, identity);
for (const claims of [
  { ...validClaims, iss: 'https://other.example.test' },
  { ...validClaims, aud: [identity.publicMcpResource, 'https://other.example.test'] },
  { ...validClaims, aud: 'https://other.example.test' },
  { ...validClaims, exp: Math.floor(Date.now() / 1000) - 1 },
  { ...validClaims, scope: 'device:sync offline_access mcp:tools' },
]) {
  await assert.rejects(() => verifier.verifyAccessToken({ ...session, accessToken: signToken(claims) }, identity));
}
const validToken = signToken(validClaims);
const tokenParts = validToken.split('.');
const invalidSignature = `${tokenParts[0]}.${tokenParts[1]}.${(tokenParts[2][0] === 'A' ? 'B' : 'A')}${tokenParts[2].slice(1)}`;
await assert.rejects(() => verifier.verifyAccessToken({ ...session, accessToken: invalidSignature }, identity));
await assert.rejects(() => verifier.verifyAccessToken({ ...session, accessToken: signToken(validClaims, privateKey, { alg: 'none', kid: 'test-key', typ: 'JWT' }) }, identity));
globalThis.fetch = verifierFetch;

assert.equal(recoverCorruptCredentialGeneration(JSON.stringify({ clearGeneration: 4 })), 5);
assert.throws(() => recoverCorruptCredentialGeneration('not-json'), /explicit repair/);
const controlPlane = new HttpDeviceControlPlaneClient('http://127.0.0.1:3000', 'test');
globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'attacker-secret-and-invalid-code' }), {
  status: 403,
  headers: { 'content-type': 'application/json' },
});
await assert.rejects(
  () => controlPlane.heartbeat('access', { deviceId: 'device', status: 'online' }),
  (error) => {
    assert.match(error.message, /remote_error/);
    assert.equal(error.message.includes('attacker-secret'), false);
    return true;
  },
);
globalThis.fetch = async () => new Response(JSON.stringify({
  ok: true,
  calls: [{
    id: '11111111-1111-4111-8111-111111111111',
    toolName: 'get_config',
    toolArgs: { origin: 'llm' },
    metadata: { source: 'test' },
    expiresAt: '2026-10-01T11:00:00.000Z',
  }],
}), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
assert.deepEqual(
  await controlPlane.listPendingCalls('access', { deviceId: 'device' }),
  [{
    id: '11111111-1111-4111-8111-111111111111',
    toolName: 'get_config',
    toolArgs: { origin: 'llm' },
    metadata: { source: 'test' },
    expiresAt: '2026-10-01T11:00:00.000Z',
  }],
);
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, calls: 'invalid' }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
await assert.rejects(
  () => controlPlane.listPendingCalls('access', { deviceId: 'device' }),
  /invalid calls/,
);
globalThis.fetch = originalFetch;

const store = new MemoryCredentialStore(identity);
const obligation = { ...session, refreshToken: 'obligation-refresh' };
await store.runExclusive((locked) => locked.addCleanupObligation(obligation));
assert.equal((await store.runExclusive((locked) => locked.load())).cleanupObligations.length, 1);
assert.equal(await store.runExclusive((locked) => locked.removeCleanupObligation(obligation)), true);
assert.equal((await store.runExclusive((locked) => locked.load())).cleanupObligations.length, 0);
const firstSave = await store.runExclusive((locked) => locked.saveExpected({
  session,
  expectedClearGeneration: 0,
  expectedSessionGeneration: null,
}));
assert.equal(firstSave, true);
const beforeClear = await store.runExclusive((locked) => locked.load());
assert.equal(beforeClear.session?.generation, 1);
const clearGeneration = await store.runExclusive((locked) => locked.clearExplicitly());
assert.equal(clearGeneration, 1);
const staleSave = await store.runExclusive((locked) => locked.saveExpected({
  session: { ...session, generation: 2, accessToken: 'stale-access' },
  expectedClearGeneration: beforeClear.clearGeneration,
  expectedSessionGeneration: 1,
}));
assert.equal(staleSave, false);
const afterClear = await store.runExclusive((locked) => locked.load());
assert.deepEqual(afterClear, { clearGeneration: 1, session: null, cleanupObligations: [] });

let resolveAuthorization;
let signalAuthorizationStarted;
const authorizationStarted = new Promise((resolve) => { signalAuthorizationStarted = resolve; });
const cleanupStore = new MemoryCredentialStore(identity);
const cleanupCandidate = { ...session, refreshToken: 'cleanup-refresh' };
const cleanupManager = new DeviceTokenManager(
  cleanupStore,
  identity,
  undefined,
  () => {
    signalAuthorizationStarted();
    return new Promise((resolve) => { resolveAuthorization = () => resolve(cleanupCandidate); });
  },
  async (candidate) => { assert.equal(candidate.refreshToken, 'cleanup-refresh'); },
);
const pairing = cleanupManager.getAccessToken();
await authorizationStarted;
await cleanupManager.clearExplicitly();
resolveAuthorization();
await assert.rejects(pairing, /authorization was cleared|cleanup failed|authorization changed/);

let failAuthorizationStarted;
let resolveFailedAuthorization;
const failStarted = new Promise((resolve) => { failAuthorizationStarted = resolve; });
const durableCleanupStore = new MemoryCredentialStore(identity);
const failingManager = new DeviceTokenManager(
  durableCleanupStore,
  identity,
  undefined,
  () => {
    failAuthorizationStarted();
    return new Promise((resolve) => { resolveFailedAuthorization = () => resolve(cleanupCandidate); });
  },
  async () => { throw new Error('revocation unavailable'); },
);
const failedPairing = failingManager.getAccessToken();
await failStarted;
await failingManager.clearExplicitly();
resolveFailedAuthorization();
await assert.rejects(failedPairing, /cleanup failed/);
assert.equal((await durableCleanupStore.runExclusive((locked) => locked.load())).cleanupObligations.length, 1);
let retriedCleanup = 0;
const retryManager = new DeviceTokenManager(
  durableCleanupStore,
  identity,
  undefined,
  () => Promise.resolve(cleanupCandidate),
  async () => { retriedCleanup += 1; },
);
assert.equal((await retryManager.getAccessToken()), 'access-1');
assert.equal(retriedCleanup, 1);
assert.equal((await durableCleanupStore.runExclusive((locked) => locked.load())).cleanupObligations.length, 0);

await assert.rejects(
  () => readBoundedJsonObject(new Response('{"ok":', { headers: { 'content-type': 'application/json' } }), { maxBytes: 100 }),
  /not valid JSON/,
);
await assert.rejects(
  () => readBoundedJsonObject(new Response('{}'), { maxBytes: 100 }),
  /not JSON/,
);
await assert.rejects(
  () => readBoundedJsonObject(new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), { maxBytes: 100 }),
  /identity content encoding/,
);
await assert.rejects(
  () => readBoundedJsonObject(new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }), { maxBytes: 100 }),
  /not valid UTF-8/,
);
await assert.rejects(
  () => readBoundedJsonObject(new Response('x'.repeat(101), { headers: { 'content-type': 'application/json' } }), { maxBytes: 100 }),
  /too large/,
);
await assert.rejects(
  () => readBoundedJsonObject(new Response('[]', { headers: { 'content-type': 'application/json' } }), { maxBytes: 100 }),
  /must be a JSON object/,
);


const oldIdentitySession = {
  ...session,
  issuer: 'https://old-auth.example.test',
  resource: 'https://old-device.example.test/mcp',
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
};
const structurallyParsed = parsePersistedCredentialPayload(JSON.stringify({
  version: 1,
  clearGeneration: 7,
  session: oldIdentitySession,
  cleanupObligations: [{ ...oldIdentitySession, refreshToken: 'old-cleanup-refresh' }],
}));
assert.equal(structurallyParsed.needsEnvelopeMigration, false);
assert.equal(structurallyParsed.snapshot.session?.issuer, 'https://old-auth.example.test');
assert.equal(structurallyParsed.snapshot.cleanupObligations[0]?.refreshToken, 'old-cleanup-refresh');
assert.throws(
  () => parsePersistedCredentialPayload(JSON.stringify({
    version: 1,
    clearGeneration: 7,
    session: oldIdentitySession,
    cleanupObligations: [{ malformed: true }],
  })),
  /malformed cleanup obligation.*preserved/,
);
const rawV2Migration = parsePersistedCredentialPayload(JSON.stringify(session));
assert.equal(rawV2Migration.needsEnvelopeMigration, true);
assert.equal(rawV2Migration.snapshot.session?.refreshToken, 'refresh-1');

const narrowedExpiryStore = new MemoryCredentialStore(identity);
const longExpirySession = { ...session, accessToken: 'long-expiry-access', refreshToken: 'long-expiry-refresh', expiresAt: Date.now() + 300_000 };
assert.equal(await narrowedExpiryStore.runExclusive((locked) => locked.saveExpected({
  session: longExpirySession,
  expectedClearGeneration: 0,
  expectedSessionGeneration: null,
})), true);
const jwtExpiry = Date.now() + 90_000;
const narrowingManager = new DeviceTokenManager(
  narrowedExpiryStore,
  identity,
  { verifyAccessToken: async () => ({ expiresAt: jwtExpiry, issuer: identity.authorizationServerIssuer, audience: identity.publicMcpResource, scope: 'device:sync offline_access' }) },
  async () => { throw new Error('pairing should not run'); },
  async () => undefined,
);
const narrowedSession = await narrowingManager.initialize();
assert.ok(narrowedSession.expiresAt <= jwtExpiry);
assert.ok(narrowedSession.expiresAt < longExpirySession.expiresAt);
assert.equal((await narrowedExpiryStore.runExclusive((locked) => locked.load())).session?.expiresAt, narrowedSession.expiresAt);

const rejectedPersistedStore = new MemoryCredentialStore(identity);
const rejectedPersistedSession = { ...session, accessToken: 'persisted-reject-access', refreshToken: 'persisted-reject-refresh' };
assert.equal(await rejectedPersistedStore.runExclusive((locked) => locked.saveExpected({
  session: rejectedPersistedSession,
  expectedClearGeneration: 0,
  expectedSessionGeneration: null,
})), true);
const rejectedDisposed = [];
const rejectedPersistedManager = new DeviceTokenManager(
  rejectedPersistedStore,
  identity,
  { verifyAccessToken: async () => { throw new OAuthProtocolError('invalid_token'); } },
  async () => { throw new Error('pairing intentionally stopped after cleanup'); },
  async (candidate) => { rejectedDisposed.push(candidate.refreshToken); },
);
await assert.rejects(() => rejectedPersistedManager.initialize(), /pairing intentionally stopped/);
assert.deepEqual(rejectedDisposed, ['persisted-reject-refresh']);
assert.equal((await rejectedPersistedStore.runExclusive((locked) => locked.load())).session, null);

const rejectedObligationStore = new MemoryCredentialStore(identity);
assert.equal(await rejectedObligationStore.runExclusive((locked) => locked.saveExpected({
  session: rejectedPersistedSession,
  expectedClearGeneration: 0,
  expectedSessionGeneration: null,
})), true);
const rejectedObligationManager = new DeviceTokenManager(
  rejectedObligationStore,
  identity,
  { verifyAccessToken: async () => { throw new OAuthProtocolError('invalid_token'); } },
  async () => { throw new Error('pairing should not run while cleanup is unresolved'); },
  async () => { throw new Error('revocation unavailable'); },
);
await assert.rejects(() => rejectedObligationManager.initialize(), /cleanup failed/);
assert.equal((await rejectedObligationStore.runExclusive((locked) => locked.load())).cleanupObligations[0]?.refreshToken, 'persisted-reject-refresh');

const rejectedTokenResponseStore = new MemoryCredentialStore(identity);
const rejectedTokenResponseDisposed = [];
const cleanupOnlySession = Object.freeze({ ...session, accessToken: 'rejected-scope-access', refreshToken: 'rejected-scope-refresh' });
const rejectedTokenResponseManager = new DeviceTokenManager(
  rejectedTokenResponseStore,
  identity,
  { verifyAccessToken: async () => ({ expiresAt: Date.now() + 300_000, issuer: identity.authorizationServerIssuer, audience: identity.publicMcpResource, scope: 'device:sync offline_access' }) },
  async () => { throw new RejectedOAuthTokenResponseError('invalid_target', 'scope mismatch', cleanupOnlySession); },
  async (candidate) => { rejectedTokenResponseDisposed.push(candidate.refreshToken); },
);
await assert.rejects(() => rejectedTokenResponseManager.initialize(), /scope mismatch/);
assert.deepEqual(rejectedTokenResponseDisposed, ['rejected-scope-refresh']);
assert.equal((await rejectedTokenResponseStore.runExclusive((locked) => locked.load())).session, null);

const refreshRejectStore = new MemoryCredentialStore(identity);
const refreshSource = { ...session, accessToken: 'refresh-source-access', refreshToken: 'refresh-source-token', expiresAt: Date.now() + 1000 };
assert.equal(await refreshRejectStore.runExclusive((locked) => locked.saveExpected({
  session: refreshSource,
  expectedClearGeneration: 0,
  expectedSessionGeneration: null,
})), true);
const refreshDisposed = [];
globalThis.fetch = async (url) => {
  const value = String(url);
  if (value.includes('/.well-known/oauth-authorization-server')) {
    return new Response(JSON.stringify(validMetadata), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (value.endsWith('/oauth2/token')) {
    return new Response(JSON.stringify({
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
      expires_in: 300,
      scope: 'device:sync offline_access',
      token_type: 'Bearer',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected refresh test URL ${value}`);
};
const refreshRejectManager = new DeviceTokenManager(
  refreshRejectStore,
  identity,
  { verifyAccessToken: async (candidate) => {
    if (candidate.accessToken === 'rotated-access') throw new OAuthProtocolError('invalid_token');
    return { expiresAt: Date.now() + 300_000, issuer: identity.authorizationServerIssuer, audience: identity.publicMcpResource, scope: 'device:sync offline_access' };
  } },
  async () => { throw new Error('pairing intentionally stopped after refresh cleanup'); },
  async (candidate) => { refreshDisposed.push(candidate.refreshToken); },
);
await assert.rejects(() => refreshRejectManager.initialize(), /pairing intentionally stopped/);
assert.deepEqual(refreshDisposed, ['rotated-refresh']);
assert.equal((await refreshRejectStore.runExclusive((locked) => locked.load())).session, null);
globalThis.fetch = originalFetch;

const cleanupRaceStore = new MemoryCredentialStore(identity);
const cleanupRaceSource = { ...session, accessToken: 'cleanup-race-old', refreshToken: 'cleanup-race-old-refresh' };
assert.equal(await cleanupRaceStore.runExclusive((locked) => locked.saveExpected({
  session: cleanupRaceSource,
  expectedClearGeneration: 0,
  expectedSessionGeneration: null,
})), true);
let cleanupRaceStarted;
let releaseCleanupRace;
const cleanupStartedPromise = new Promise((resolve) => { cleanupRaceStarted = resolve; });
const cleanupReleasePromise = new Promise((resolve) => { releaseCleanupRace = resolve; });
const cleanupRaceManager = new DeviceTokenManager(
  cleanupRaceStore,
  identity,
  { verifyAccessToken: async (candidate) => {
    if (candidate.accessToken === 'cleanup-race-old') throw new OAuthProtocolError('invalid_token');
    return { expiresAt: Date.now() + 300_000, issuer: identity.authorizationServerIssuer, audience: identity.publicMcpResource, scope: 'device:sync offline_access' };
  } },
  async () => { throw new Error('pairing should not run because winner exists'); },
  async () => { cleanupRaceStarted(); await cleanupReleasePromise; },
);
const cleanupRaceInitialize = cleanupRaceManager.initialize();
await cleanupStartedPromise;
const afterRejectedClear = await cleanupRaceStore.runExclusive((locked) => locked.load());
const raceWinner = { ...session, generation: 2, accessToken: 'cleanup-race-winner', refreshToken: 'cleanup-race-winner-refresh' };
assert.equal(await cleanupRaceStore.runExclusive((locked) => locked.saveExpected({
  session: raceWinner,
  expectedClearGeneration: afterRejectedClear.clearGeneration,
  expectedSessionGeneration: null,
})), true);
releaseCleanupRace();
assert.equal((await cleanupRaceInitialize).accessToken, 'cleanup-race-winner');
assert.equal((await cleanupRaceStore.runExclusive((locked) => locked.load())).session?.accessToken, 'cleanup-race-winner');

resetOAuthHttpTransportForTests();
console.log('✓ passkey device MVP contract cases passed');
