/** Regression: verified OAuth sessions must not escape inside the refresh window. */
import assert from 'node:assert/strict';

const { MemoryCredentialStore } = await import('../dist/remote-device/credential-store.js');
const { DeviceTokenManager } = await import('../dist/remote-device/token-manager.js');
const { createRemoteIdentity } = await import('../dist/remote-device/remote-identity.js');
const { installOAuthHttpTransportForTests, resetOAuthHttpTransportForTests } = await import('../dist/remote-device/oauth-http.js');

const identity = createRemoteIdentity({
  runtimeProfile: 'test',
  authorizationServerIssuer: 'https://auth.example.test',
  publicMcpResource: 'https://device.example.test/mcp',
  internalDeviceApiOrigin: 'http://127.0.0.1:3000',
});

const baseSession = (overrides = {}) => Object.freeze({
  version: 2,
  issuer: identity.authorizationServerIssuer,
  resource: identity.publicMcpResource,
  clientId: 'client-1',
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
  expiresAt: Date.now() + 300_000,
  scope: 'device:sync offline_access',
  generation: 1,
  ...overrides,
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

let tokenResponses = [];
let tokenRequests = 0;
installOAuthHttpTransportForTests(async (url) => {
  if (String(url).includes('/.well-known/oauth-authorization-server')) {
    return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (String(url).endsWith('/oauth2/token')) {
    tokenRequests += 1;
    const body = tokenResponses.shift();
    assert.ok(body, 'unexpected extra token refresh request');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected OAuth URL ${url}`);
});
const tokenResponse = (accessToken, refreshToken) => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  expires_in: 300,
  scope: 'device:sync offline_access',
  token_type: 'Bearer',
});
const verified = (expiresAt) => ({
  expiresAt,
  issuer: identity.authorizationServerIssuer,
  audience: identity.publicMcpResource,
  scope: 'device:sync offline_access',
});
const saveInitial = async (store, value) => {
  assert.equal(await store.runExclusive((locked) => locked.saveExpected({
    session: value,
    expectedClearGeneration: 0,
    expectedSessionGeneration: null,
  })), true);
};

try {
  // Persisted expiry is initially long, but JWT verification narrows it below 60s.
  tokenRequests = 0;
  tokenResponses = [tokenResponse('persisted-refreshed', 'persisted-refresh-2')];
  const persistedStore = new MemoryCredentialStore(identity);
  await saveInitial(persistedStore, baseSession({ accessToken: 'persisted-old', refreshToken: 'persisted-refresh-1' }));  const persistedManager = new DeviceTokenManager(
    persistedStore,
    identity,
    { verifyAccessToken: async (candidate) => verified(Date.now() + (candidate.accessToken === 'persisted-old' ? 20_000 : 300_000)) },
    async () => { throw new Error('pairing should not run'); },
    async () => undefined,
  );
  const persistedResult = await persistedManager.initialize();
  assert.equal(persistedResult.accessToken, 'persisted-refreshed');
  assert.equal(persistedResult.generation, 2);
  assert.equal(tokenRequests, 1);

  // A rotated candidate can itself be JWT-narrowed below 60s; refresh again before use.
  tokenRequests = 0;
  tokenResponses = [
    tokenResponse('rotated-short', 'rotated-refresh-2'),
    tokenResponse('rotated-fresh', 'rotated-refresh-3'),
  ];
  const rotatedStore = new MemoryCredentialStore(identity);
  await saveInitial(rotatedStore, baseSession({ accessToken: 'rotated-old', refreshToken: 'rotated-refresh-1', expiresAt: Date.now() + 1_000 }));
  const rotatedManager = new DeviceTokenManager(
    rotatedStore,
    identity,
    { verifyAccessToken: async (candidate) => verified(Date.now() + (candidate.accessToken === 'rotated-short' ? 20_000 : 300_000)) },
    async () => { throw new Error('pairing should not run'); },
    async () => undefined,
  );  const rotatedResult = await rotatedManager.initialize();
  assert.equal(rotatedResult.accessToken, 'rotated-fresh');
  assert.equal(rotatedResult.generation, 3);
  assert.equal(tokenRequests, 2);

  // A fresh authorization narrowed below 60s should refresh immediately, not return or re-pair.
  tokenRequests = 0;
  tokenResponses = [tokenResponse('authorized-refreshed', 'authorized-refresh-2')];
  const authorizedStore = new MemoryCredentialStore(identity);
  let authorizationCalls = 0;
  const authorizedManager = new DeviceTokenManager(
    authorizedStore,
    identity,
    { verifyAccessToken: async (candidate) => verified(Date.now() + (candidate.accessToken === 'authorized-short' ? 20_000 : 300_000)) },
    async () => {
      authorizationCalls += 1;
      return baseSession({ accessToken: 'authorized-short', refreshToken: 'authorized-refresh-1' });
    },
    async () => undefined,
  );
  const authorizedResult = await authorizedManager.initialize();
  assert.equal(authorizedResult.accessToken, 'authorized-refreshed');
  assert.equal(authorizedResult.generation, 2);
  assert.equal(tokenRequests, 1);
  assert.equal(authorizationCalls, 1);
  assert.equal((await authorizedStore.runExclusive((locked) => locked.load())).session?.accessToken, 'authorized-refreshed');

  console.log('✓ JWT-narrowed sessions refresh before leaving the token manager');
} finally {
  resetOAuthHttpTransportForTests();
}