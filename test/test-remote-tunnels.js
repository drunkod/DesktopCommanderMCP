/** Behavioral coverage for the optional Tailscale Funnel and zrok tunnel sidecars. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { parseRemoteOptions } = await import('../dist/npm-scripts/remote-options.js');
const { CommandRunner, redactSensitive, redactArgs, safeCommandResult } = await import('../dist/remote-device/tunnel/command-runner.js');
const { TailscaleCli, parseTailscaleStatus } = await import('../dist/remote-device/tunnel/tailscale-cli.js');
const { ZrokCli, parseZrokAgentStatus } = await import('../dist/remote-device/tunnel/zrok-cli.js');
const { TailscaleTunnelProvider } = await import('../dist/remote-device/tunnel/tailscale-tunnel-provider.js');
const { TailscaleIdentityStore } = await import('../dist/remote-device/tunnel/tailscale-identity-store.js');
const { ZrokTunnelProvider } = await import('../dist/remote-device/tunnel/zrok-tunnel-provider.js');
const { ZrokNameStore } = await import('../dist/remote-device/tunnel/zrok-name-store.js');
const { TunnelSupervisor } = await import('../dist/remote-device/tunnel/tunnel-supervisor.js');
const { MacosLaunchAgent } = await import('../dist/remote-device/tunnel/macos-launch-agent.js');
const { publicMcpUrl } = await import('../dist/remote-device/tunnel/tunnel-health.js');
const { registerDeviceClient, pairDevice, refreshDeviceSession } = await import('../dist/remote-device/device-oauth.js');

const healthPath = '/.well-known/oauth-protected-resource/mcp';
const publicOrigin = 'https://alice.tailnet.ts.net';

function fakeRunner(responses = []) {
  const calls = [];
  return {
    calls,
    async run(command, args = []) {
      calls.push([command, args]);
      const response = responses.shift() ?? { stdout: '', stderr: '', code: 0 };
      if (response instanceof Error) throw response;
      return {
        command,
        args,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
        safeStdout: response.stdout ?? '',
        safeStderr: response.stderr ?? '',
        code: response.code ?? 0,
      };
    },
    async runDetached(command, args = []) {
      calls.push([command, args]);
      return 1234;
    },
  };
}

function publicMetadataResponse(url) {
  const origin = new URL(url).origin;
  if (url.includes('/.well-known/oauth-protected-resource/')) {
    return new Response(JSON.stringify({
      resource: `${origin}/mcp`,
      authorization_servers: [`${origin}/api/auth`],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/api/auth/.well-known/oauth-authorization-server')) {
    const endpoint = `${origin}/api/auth`;
    return new Response(JSON.stringify({
      issuer: endpoint,
      authorization_endpoint: `${endpoint}/authorize`,
      registration_endpoint: `${endpoint}/oauth2/register`,
      device_authorization_endpoint: `${endpoint}/oauth2/device-authorization`,
      token_endpoint: `${endpoint}/oauth2/token`,
      jwks_uri: `${endpoint}/jwks`,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('', { status: 200 });
}

assert.deepEqual(parseRemoteOptions([
  '--tunnel', 'tailscale', '--tunnel-target', 'http://127.0.0.1:4000',
  '--no-persist-session', '--debug', '--disable-no-sleep',
]), {
  tunnel: 'tailscale',
  tunnelCommand: 'run',
  tunnelTarget: 'http://127.0.0.1:4000',
  tunnelTargetExplicit: true,
  tunnelName: undefined,
  tunnelNamespace: undefined,
  tunnelHealthPath: healthPath,
  installTunnelAgent: false,
  disableNoSleep: true,
  debug: true,
  persistSession: false,
  confirm: false,
  force: false,
});
assert.equal(parseRemoteOptions(['tunnel', 'zrok', 'doctor', '--tunnel-health-path=/ready']).tunnelCommand, 'doctor');
assert.equal(parseRemoteOptions(['tunnel', 'zrok', 'restart']).tunnelCommand, 'restart');
assert.equal(parseRemoteOptions(['tunnel', 'zrok', 'delete-name', '--confirm']).confirm, true);
assert.throws(() => parseRemoteOptions(['--tunnel', 'other']), /Unknown tunnel provider/);
assert.throws(() => parseRemoteOptions(['--tunnel-healt-path', '/ready']), /Unknown remote option/);
assert.throws(() => parseRemoteOptions(['tunnel']), /requires a provider or operator command/);
assert.throws(() => parseRemoteOptions(['--tunnel-target', '--debug']), /requires a value/);

assert.equal(redactSensitive('Authorization: Bearer super-secret'), 'Authorization: Bearer [REDACTED]');
assert.equal(redactSensitive('https://example.test/?token=super-secret&api_key=another-secret'), 'https://example.test/?token=[REDACTED]&api_key=[REDACTED]');
assert.equal(redactSensitive('refresh_token=refresh-secret api-key: key-secret'), 'refresh_token=[REDACTED] api-key: [REDACTED]');
assert.equal(redactSensitive('{"authorization":"Bearer json-secret","api_key":"json-key"}'), '{"authorization":"Bearer [REDACTED]","api_key":"[REDACTED]"}');
assert.deepEqual(redactArgs(['agent', 'enroll', '--token', 'argv-secret', '--api-key=key-secret', '--TOKEN=upper-secret']), ['agent', 'enroll', '--token', '[REDACTED]', '--api-key=[REDACTED]', '--TOKEN=[REDACTED]']);
const rawResult = { command: 'zrok2', args: ['--token', 'argv-secret'], stdout: 'Authorization: Bearer stdout-secret', stderr: 'token=stderr-secret', safeStdout: 'Authorization: Bearer [REDACTED]', safeStderr: 'token=[REDACTED]', code: 1 };
const safeResult = safeCommandResult(rawResult);
assert.equal(JSON.stringify(safeResult).includes('secret'), false, 'serialized command results must not retain secrets');

const commandRunner = new CommandRunner();
assert.equal((await commandRunner.run(process.execPath, ['-e', 'process.stdout.write("ok")'])).stdout, 'ok');
await assert.rejects(
  () => commandRunner.run(process.execPath, ['-e', 'console.error("Authorization: Bearer process-secret"); process.exit(3)']),
  (error) => {
    assert.equal(JSON.stringify(error).includes('process-secret'), false);
    assert.match(error.message, /Bearer \[REDACTED\]/);
    return true;
  },
);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => publicMetadataResponse(String(url));

// Tailscale adapter: machine parsing, preflight/status command shapes, and
// provider health are tested separately from the provider fake below.
assert.deepEqual(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'alice.tailnet.ts.net.' } })), {
  online: true,
  dnsName: 'alice.tailnet.ts.net',
  backendState: 'Running',
  raw: { BackendState: 'Running', Self: { Online: true, DNSName: 'alice.tailnet.ts.net.' } },
});
const tailscaleRunner = fakeRunner([
  { stdout: '1.60.0\n' },
  { stdout: JSON.stringify({ Services: {} }) },
  { stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'alice.tailnet.ts.net' } }) },
  { stdout: JSON.stringify({ Services: {} }) },
  { stdout: '' },
  { stdout: JSON.stringify({ Services: { 'https:443': { Handler: 'http://127.0.0.1:3000' } } }) },
]);
const tailscaleCli = new TailscaleCli(tailscaleRunner, 'tailscale');
await tailscaleCli.preflight();
const oldTailscaleMin = process.env.DC_TAILSCALE_MIN_VERSION;
process.env.DC_TAILSCALE_MIN_VERSION = '1.34.0';
const unsupportedTailscale = new TailscaleCli(fakeRunner([{ stdout: '1.40.0\n' }]), 'tailscale');
await assert.rejects(() => unsupportedTailscale.preflight(), /1.52.0 or newer/);
if (oldTailscaleMin === undefined) delete process.env.DC_TAILSCALE_MIN_VERSION;
else process.env.DC_TAILSCALE_MIN_VERSION = oldTailscaleMin;
assert.equal((await tailscaleCli.status()).dnsName, 'alice.tailnet.ts.net');
assert.equal((await tailscaleCli.funnelStatus()).enabled, false);
await tailscaleCli.enableFunnel('http://127.0.0.1:3000');
assert.deepEqual(tailscaleRunner.calls.at(-1), ['tailscale', ['funnel', '--bg', '--https=443', 'http://127.0.0.1:3000']]);
await tailscaleCli.funnelStatus();
await tailscaleCli.disableFunnel();
assert.deepEqual(tailscaleRunner.calls.at(-1), ['tailscale', ['funnel', '--https=443', 'off']]);

const zrokMachineRunner = fakeRunner([
  { stdout: JSON.stringify({ namespaces: [{ name: 'ns' }] }) },
  { stdout: JSON.stringify({ names: [{ namespace: 'ns', name: 'machine-name', publicUrl: 'https://machine-name.share.zrok.io', reserved: true }] }) },
  { stdout: JSON.stringify({ running: true, shares: [{ namespace: 'ns', name: 'machine-name', target: 'http://127.0.0.1:3000', publicUrl: 'https://machine-name.share.zrok.io' }] }) },
  { stdout: 'Name created\n' },
  { stdout: JSON.stringify({ names: [{ namespace: 'ns', name: 'created-name', reserved: true }] }) },
]);
const zrokCliAdapter = new ZrokCli(zrokMachineRunner, 'zrok2');
assert.equal((await zrokCliAdapter.listNamespaces()).length, 1);
assert.equal((await zrokCliAdapter.findName('ns', 'machine-name')).publicUrl, 'https://machine-name.share.zrok.io');
assert.equal((await zrokCliAdapter.agentStatus()).running, true);
const createdName = await zrokCliAdapter.createName('ns', 'created-name');
assert.deepEqual({ namespace: createdName.namespace, name: createdName.name }, { namespace: 'ns', name: 'created-name' });
assert.deepEqual(zrokMachineRunner.calls.at(-2), ['zrok2', ['create', 'name', '-n', 'ns', 'created-name']]);

let funnelEnabled = false;
let disableCalls = 0;
const tailscaleCliFake = {
  async preflight() {},
  async status() { return { online: true, dnsName: 'alice.tailnet.ts.net', backendState: 'Running', raw: {} }; },
  async funnelStatus() { return { enabled: funnelEnabled, targetMatches: true, raw: {}, output: '' }; },
  async enableFunnel(target) { assert.equal(target, 'http://127.0.0.1:3000'); funnelEnabled = true; return { command: 'tailscale', args: [], stdout: '', stderr: '', safeStdout: '', safeStderr: '', code: 0 }; },
  async disableFunnel() { disableCalls++; funnelEnabled = false; },
  async console() { return 'funnel status'; },
};
const tailscaleIdentityPath = path.join(os.tmpdir(), `desktop-commander-tailscale-${process.pid}.json`);
const tailscale = new TailscaleTunnelProvider(
  { localTarget: 'http://127.0.0.1:3000', healthPath },
  tailscaleCliFake,
  new TailscaleIdentityStore(tailscaleIdentityPath),
);
const tailscaleState = await tailscale.start();
assert.equal(tailscaleState.publicMcpUrl, `${publicOrigin}/mcp`);
assert.equal(tailscaleState.status, 'online');
assert.equal(tailscaleState.healthy, true);
assert.equal(tailscaleState.transportHealthy, true);
assert.equal(tailscaleState.backendHealthy, true);
assert.equal(tailscaleState.publicHealthy, true);
await tailscale.rollbackStartup();
assert.equal(disableCalls, 1, 'rollback removes Funnel created by this startup');

// A pre-existing Funnel is never removed by startup rollback.
funnelEnabled = true;
disableCalls = 0;
const preexistingTailscale = new TailscaleTunnelProvider({ localTarget: 'http://127.0.0.1:3000', healthPath }, tailscaleCliFake);
await preexistingTailscale.start();
await preexistingTailscale.rollbackStartup();
assert.equal(disableCalls, 0, 'rollback preserves pre-existing Funnel');

// A Tailscale DNS/name change is critical identity drift, not a new URL.
const tailscaleDriftCli = {
  async preflight() {},
  async status() { return { online: true, dnsName: 'renamed.tailnet.ts.net', backendState: 'Running', raw: {} }; },
  async funnelStatus() { return { enabled: true, targetMatches: true, raw: {}, output: '' }; },
};
const tailscaleDrift = new TailscaleTunnelProvider(
  { localTarget: 'http://127.0.0.1:3000', healthPath },
  tailscaleDriftCli,
  new TailscaleIdentityStore(tailscaleIdentityPath),
);
const tailscaleDriftState = await tailscaleDrift.status();
assert.equal(tailscaleDriftState.identityDrift, true);
assert.equal(tailscaleDriftState.publicBaseUrl, publicOrigin);
assert.equal(tailscaleDriftState.observedPublicBaseUrl, 'https://renamed.tailnet.ts.net');
assert.equal(tailscaleDriftState.publicMcpUrl, `${publicOrigin}/mcp`);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-tunnel-'));
const identityPath = path.join(tempDir, 'zrok.json');
const zrokStore = new ZrokNameStore(identityPath);
const zrokCalls = [];
let agentRunning = false;
let reservedName = false;
let shares = [];
const zrokCli = {
  async findName(namespace, name) {
    zrokCalls.push(['find-name', namespace, name]);
    return reservedName ? { namespace, name, publicUrl: `https://${name}.share.zrok.io`, reserved: true } : null;
  },
  async createName(namespace, name) {
    zrokCalls.push(['create', namespace, name]);
    reservedName = true;
    return { namespace, name, publicUrl: undefined, reserved: true };
  },
  async agentStatus() { zrokCalls.push(['status']); return { running: agentRunning, shares, raw: {} }; },
  async startAgent() { zrokCalls.push(['agent-start']); agentRunning = true; return 123; },
  async sharePublic(target, namespace, name) {
    zrokCalls.push(['share', target, namespace, name]);
    shares = [{ namespace, name, target, publicUrl: `https://${name}.share.zrok.io` }];
    return { result: {}, publicUrl: `https://${name}.share.zrok.io` };
  },
  async unshare(namespace, name) { zrokCalls.push(['unshare', namespace, name]); shares = shares.filter((share) => share.namespace !== namespace || share.name !== name); },
  async deleteName(namespace, name) { zrokCalls.push(['delete-name', namespace, name]); },
  async console() { return 'zrok console'; },
};
const zrok = new ZrokTunnelProvider({ localTarget: 'http://127.0.0.1:3000', healthPath, name: 'dc-test', namespace: 'ns' }, zrokCli, zrokStore);
const zrokState = await zrok.start();
assert.equal(zrokState.publicMcpUrl, 'https://dc-test.share.zrok.io/mcp');
assert.equal(zrokState.healthy, true);
assert.equal((await zrokStore.load()).name, 'dc-test');
assert.equal(zrokCalls.filter(([name]) => name === 'create').length, 1);
await zrok.restart();
assert.equal(zrokCalls.filter(([name]) => name === 'unshare').length, 1, 'zrok restart must mutate the runtime share');
assert.equal(zrokCalls.filter(([name]) => name === 'share').length, 2, 'zrok restart must reapply the share');
const zrokStateAgain = await zrok.status();
assert.equal(zrokStateAgain.publicMcpUrl, zrokState.publicMcpUrl);
assert.equal(zrokStateAgain.transportHealthy, true);

// A failed Funnel command that mutated state before timing out is still owned
// by this startup and is removed by rollback.
let partialDisableCalls = 0;
let partialFunnelEnabled = false;
const partialTailscaleCli = {
  async preflight() {},
  async status() { return { online: true, dnsName: 'partial.tailnet.ts.net', backendState: 'Running', raw: {} }; },
  async funnelStatus() { return { enabled: partialFunnelEnabled, targetMatches: partialFunnelEnabled, raw: {}, output: '' }; },
  async enableFunnel() { partialFunnelEnabled = true; throw new Error('enable response lost'); },
  async disableFunnel() { partialDisableCalls++; partialFunnelEnabled = false; },
  async console() { return ''; },
};
const partialProvider = new TailscaleTunnelProvider(
  { localTarget: 'http://127.0.0.1:3000', healthPath },
  partialTailscaleCli,
  new TailscaleIdentityStore(path.join(tempDir, 'partial-tailscale.json')),
);
await assert.rejects(() => partialProvider.start(), /enable response lost/);
await partialProvider.rollbackStartup();
assert.equal(partialDisableCalls, 1, 'rollback removes a partially successful Funnel mutation');

// Explicit stop fails closed for an unrelated mapping, unless --force is used.
let mismatchedDisableCalls = 0;
const mismatchedTailscaleCli = {
  async funnelStatus() { return { enabled: true, targetMatches: false, raw: {}, output: '' }; },
  async disableFunnel() { mismatchedDisableCalls++; },
};
const mismatchedProvider = new TailscaleTunnelProvider(
  { localTarget: 'http://127.0.0.1:3000', healthPath },
  mismatchedTailscaleCli,
  new TailscaleIdentityStore(path.join(tempDir, 'mismatched-tailscale.json')),
);
await assert.rejects(() => mismatchedProvider.stop(), /Refusing to disable/);
assert.equal(mismatchedDisableCalls, 0);
const forcedProvider = new TailscaleTunnelProvider(
  { localTarget: 'http://127.0.0.1:3000', healthPath, force: true },
  mismatchedTailscaleCli,
  new TailscaleIdentityStore(path.join(tempDir, 'forced-tailscale.json')),
);
await forcedProvider.stop();
assert.equal(mismatchedDisableCalls, 1);

// State-directory permissions are enforced even when the directory existed.
const insecureDir = path.join(tempDir, 'insecure');
await fs.mkdir(insecureDir, { mode: 0o755 });
const permissionStore = new ZrokNameStore(path.join(insecureDir, 'identity.json'));
await permissionStore.save({ provider: 'zrok', namespace: 'ns', name: 'permission-test', localTarget: 'http://127.0.0.1:3000' });
assert.equal((await fs.stat(insecureDir)).mode & 0o777, 0o700);

// A persisted non-default target wins over today's default target when the
// user did not explicitly override it.
const persistedTargetStore = new ZrokNameStore(path.join(tempDir, 'persisted-target.json'));
await persistedTargetStore.save({ provider: 'zrok', namespace: 'ns', name: 'persisted-target', localTarget: 'http://127.0.0.1:4000', publicBaseUrl: 'https://persisted-target.share.zrok.io' });
let persistedShareCalls = 0;
const persistedTargetCli = {
  async agentStatus() { return { running: true, shares: [{ namespace: 'ns', name: 'persisted-target', target: 'http://127.0.0.1:4000', publicUrl: 'https://persisted-target.share.zrok.io' }], raw: {} }; },
  async sharePublic() { persistedShareCalls++; throw new Error('must not create a replacement share'); },
  async findName(namespace, name) { return { namespace, name, reserved: true, publicUrl: 'https://persisted-target.share.zrok.io' }; },
  async startAgent() { return 1; }, async unshare() {}, async console() { return ''; },
};
const persistedTargetProvider = new ZrokTunnelProvider({ localTarget: 'http://127.0.0.1:3000', localTargetExplicit: false, healthPath }, persistedTargetCli, persistedTargetStore);
const persistedTargetState = await persistedTargetProvider.start();
assert.equal(persistedTargetState.localTarget, 'http://127.0.0.1:4000');
assert.equal(persistedShareCalls, 0);
const explicitMismatchProvider = new ZrokTunnelProvider({ localTarget: 'http://127.0.0.1:3000', localTargetExplicit: true, healthPath }, persistedTargetCli, persistedTargetStore);
await assert.rejects(() => explicitMismatchProvider.start(), /conflicts with persisted target/);

// Metadata loss recovers an existing reserved name instead of creating one.
const discoveredStore = new ZrokNameStore(path.join(tempDir, 'discovered.json'));
let discoveredCreateCalls = 0;
let discoveredAgentRunning = true;
const discoveredCli = {
  async findName(namespace, name) { return { namespace, name, publicUrl: 'https://recovered.share.zrok.io', reserved: true }; },
  async createName() { discoveredCreateCalls++; throw new Error('must not create a duplicate name'); },
  async agentStatus() { return { running: discoveredAgentRunning, shares: [{ namespace: 'ns', name: 'recovered', target: 'http://127.0.0.1:3000', publicUrl: 'https://recovered.share.zrok.io' }], raw: {} }; },
  async startAgent() { discoveredAgentRunning = true; return 1; },
  async sharePublic() { throw new Error('must reuse existing share'); },
  async unshare() {},
  async console() { return ''; },
};
const discovered = new ZrokTunnelProvider({ localTarget: 'http://127.0.0.1:3000', healthPath, name: 'recovered', namespace: 'ns' }, discoveredCli, discoveredStore);
assert.equal((await discovered.start()).identity, 'ns:recovered');
assert.equal(discoveredCreateCalls, 0);

// An unknown reservation state fails closed; it is not treated as durable.
const unknownReservationCli = {
  async findName(namespace, name) { return { namespace, name }; },
};
const unknownReservation = new ZrokTunnelProvider({ localTarget: 'http://127.0.0.1:3000', healthPath, name: 'unknown', namespace: 'ns' }, unknownReservationCli, new ZrokNameStore(path.join(tempDir, 'unknown-reservation.json')));
await assert.rejects(() => unknownReservation.start(), /reserved status cannot be proven/);

// A changed public URL is identity drift, never a new accepted URL.
const driftStore = new ZrokNameStore(path.join(tempDir, 'drift.json'));
await driftStore.save({ provider: 'zrok', namespace: 'ns', name: 'stable', localTarget: 'http://127.0.0.1:3000', publicBaseUrl: 'https://old.share.zrok.io' });
const driftCli = {
  async agentStatus() { return { running: true, shares: [{ namespace: 'ns', name: 'stable', target: 'http://127.0.0.1:3000', publicUrl: 'https://new.share.zrok.io' }], raw: {} }; },
};
const driftProvider = new ZrokTunnelProvider({ localTarget: 'http://127.0.0.1:3000', healthPath }, driftCli, driftStore);
const driftState = await driftProvider.status();
assert.equal(driftState.identityDrift, true);
assert.equal(driftState.publicBaseUrl, 'https://old.share.zrok.io');
assert.equal(driftState.publicMcpUrl, 'https://old.share.zrok.io/mcp');
assert.match(driftState.detail, /identity drift/i);

// The exact namespace is part of the share identity; a same-name share in a
// different namespace must not be selected.
let wrongNamespaceShareCalls = 0;
const wrongNamespaceCli = {
  async findName(namespace, name) { return { namespace, name, publicUrl: 'https://exact.share.zrok.io', reserved: true }; },
  async agentStatus() { return { running: true, shares: [{ namespace: 'other', name: 'exact', target: 'http://127.0.0.1:3000', publicUrl: 'https://wrong.share.zrok.io' }], raw: {} }; },
  async startAgent() { return 1; },
  async sharePublic(target, namespace, name) { wrongNamespaceShareCalls++; return { result: {}, publicUrl: `https://${name}.share.zrok.io` }; },
  async unshare() {},
  async console() { return ''; },
};
const exactStore = new ZrokNameStore(path.join(tempDir, 'exact.json'));
const exact = new ZrokTunnelProvider({ localTarget: 'http://127.0.0.1:3000', healthPath, name: 'exact', namespace: 'ns' }, wrongNamespaceCli, exactStore);
await assert.rejects(() => exact.start(), /named share did not reappear/);
assert.equal(wrongNamespaceShareCalls, 1, 'same-name share from another namespace must not be reused');

// Existing identity with a wrong target fails closed and requires explicit repair.
const wrongTargetStore = new ZrokNameStore(path.join(tempDir, 'wrong-target.json'));
await wrongTargetStore.save({ provider: 'zrok', namespace: 'ns', name: 'wrong-target', localTarget: 'http://127.0.0.1:3000', publicBaseUrl: 'https://wrong-target.share.zrok.io' });
const wrongTargetCli = {
  async agentStatus() { return { running: true, shares: [{ namespace: 'ns', name: 'wrong-target', target: 'http://127.0.0.1:9999', publicUrl: 'https://wrong-target.share.zrok.io' }], raw: {} }; },
  async startAgent() { return 1; },
  async unshare() {}, async sharePublic() { throw new Error('repair belongs to explicit restart'); }, async console() { return ''; },
};
const wrongTarget = new ZrokTunnelProvider({ localTarget: 'http://127.0.0.1:3000', healthPath }, wrongTargetCli, wrongTargetStore);
await assert.rejects(() => wrongTarget.start(), /points at http:\/\/127.0.0.1:9999/);

// A running provider with a dead backend is degraded, not restarted.
let providerStarts = 0;
const supervisor = new TunnelSupervisor({
  name: 'zrok',
  async start() { providerStarts++; return { provider: 'zrok', status: 'online', healthy: true, transportHealthy: true, backendHealthy: true, publicHealthy: true, localTarget: 'http://127.0.0.1:1' }; },
  async status() { return { provider: 'zrok', status: 'degraded', healthy: false, transportHealthy: true, backendHealthy: false, publicHealthy: false, localTarget: 'http://127.0.0.1:1' }; },
  async restart() {}, async stop() {}, async doctor() { return { provider: 'zrok', ok: false, checks: [] }; }, async console() { return ''; },
}, { monitorIntervalMs: 10 });
await supervisor.start();
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(providerStarts, 1, 'backend degradation must not reconfigure the tunnel');
await supervisor.close();

// Closing a backoff wakes recovery as a normal cancellation, not a rejected
// detached promise.
let recoveryAttempts = 0;
const cancellingSupervisor = new TunnelSupervisor({
  name: 'zrok',
  async start() { recoveryAttempts++; throw new Error('offline'); },
  async status() { throw new Error('offline'); },
  async restart() {}, async stop() {}, async doctor() { return { provider: 'zrok', ok: false, checks: [] }; },
}, { baseBackoffMs: 5_000, maxBackoffMs: 5_000, jitterRatio: 0 });
const recovery = cancellingSupervisor.requestRecovery('test shutdown');
await new Promise((resolve) => setTimeout(resolve, 20));
await cancellingSupervisor.close();
await recovery;
assert.equal(recoveryAttempts, 1);

const launchPath = path.join(tempDir, 'agent.plist');
const launchRunner = fakeRunner();
const launchAgent = new MacosLaunchAgent(launchPath, launchRunner);
if (process.platform === 'darwin') {
  await launchAgent.install(process.execPath);
  const plist = await fs.readFile(launchPath, 'utf8');
  assert.match(plist, /io\.desktop-commander\.zrok-agent/);
  assert.match(plist, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(plist, /Library\\?\/Logs\\?\/DesktopCommander/);
  assert.doesNotMatch(plist, /\/tmp\/desktop-commander-zrok-agent/);
  assert.deepEqual(launchRunner.calls.at(-2)?.[1].slice(0, 1), ['bootout']);
  assert.deepEqual(launchRunner.calls.at(-1)?.[1].slice(0, 1), ['bootstrap']);
  await launchAgent.uninstall();
}

// OAuth discovery and token registration use localhost for HTTP transport,
// while the issuer/resource identity remains public.
const savedOAuthEnv = {
  MCP_SERVER_URL: process.env.MCP_SERVER_URL,
  APP_ORIGIN: process.env.APP_ORIGIN,
  REMOTE_MCP_RESOURCE: process.env.REMOTE_MCP_RESOURCE,
};
process.env.MCP_SERVER_URL = 'http://127.0.0.1:3000';
process.env.APP_ORIGIN = 'https://public.example.test';
process.env.REMOTE_MCP_RESOURCE = 'https://public.example.test/mcp';
const oauthCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const value = String(url);
  oauthCalls.push({ url: value, body: init.body?.toString() });
  if (value === 'http://127.0.0.1:3000/api/auth/.well-known/oauth-authorization-server') {
    return new Response(JSON.stringify({
      issuer: 'https://public.example.test/api/auth',
      registration_endpoint: 'https://public.example.test/api/auth/oauth2/register',
      device_authorization_endpoint: 'https://public.example.test/api/auth/oauth2/device-authorization',
      token_endpoint: 'https://public.example.test/api/auth/oauth2/token',
      jwks_uri: 'https://public.example.test/api/auth/jwks',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (value === 'http://127.0.0.1:3000/api/auth/oauth2/register') {
    return new Response(JSON.stringify({ client_id: 'device-client-test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Unexpected OAuth request ${value}`);
};
assert.equal(await registerDeviceClient(), 'device-client-test');
assert.deepEqual(oauthCalls.map(({ url }) => url), [
  'http://127.0.0.1:3000/api/auth/.well-known/oauth-authorization-server',
  'http://127.0.0.1:3000/api/auth/oauth2/register',
]);
assert.deepEqual(JSON.parse(oauthCalls[1].body).resources, ['https://public.example.test/mcp']);
const flowCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const value = String(url);
  flowCalls.push({ url: value, body: init.body?.toString() ?? '' });
  if (value === 'http://127.0.0.1:3000/api/auth/.well-known/oauth-authorization-server') {
    return new Response(JSON.stringify({
      issuer: 'https://public.example.test/api/auth',
      registration_endpoint: 'https://public.example.test/api/auth/oauth2/register',
      device_authorization_endpoint: 'https://public.example.test/api/auth/oauth2/device-authorization',
      token_endpoint: 'https://public.example.test/api/auth/oauth2/token',
      jwks_uri: 'https://public.example.test/api/auth/jwks',
    }), { status: 200 });
  }
  if (value === 'http://127.0.0.1:3000/api/auth/oauth2/device-authorization') {
    return new Response(JSON.stringify({ device_code: 'device-code', user_code: 'ABCD', verification_uri: 'https://public.example.test/device', expires_in: 30, interval: 0 }), { status: 200 });
  }
  if (value === 'http://127.0.0.1:3000/api/auth/oauth2/token') {
    return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 300, scope: 'device:sync offline_access', token_type: 'Bearer' }), { status: 200 });
  }
  throw new Error(`Unexpected OAuth flow request ${value}`);
};
const oldNoBrowser = process.env.DC_DEVICE_NO_BROWSER;
process.env.DC_DEVICE_NO_BROWSER = '1';
const session = await pairDevice('device-client-test');
await refreshDeviceSession(session);
assert.deepEqual(flowCalls.map(({ url }) => url), [
  'http://127.0.0.1:3000/api/auth/.well-known/oauth-authorization-server',
  'http://127.0.0.1:3000/api/auth/oauth2/device-authorization',
  'http://127.0.0.1:3000/api/auth/oauth2/token',
  'http://127.0.0.1:3000/api/auth/.well-known/oauth-authorization-server',
  'http://127.0.0.1:3000/api/auth/oauth2/token',
]);
for (const call of flowCalls.filter(({ body }) => body)) assert.match(call.body, /public\.example\.test%2Fmcp|public\.example\.test\/mcp/);
if (oldNoBrowser === undefined) delete process.env.DC_DEVICE_NO_BROWSER;
else process.env.DC_DEVICE_NO_BROWSER = oldNoBrowser;

globalThis.fetch = async () => new Response(JSON.stringify({
  issuer: 'https://evil.example.test/api/auth',
  registration_endpoint: 'https://evil.example.test/register',
  device_authorization_endpoint: 'https://evil.example.test/device',
  token_endpoint: 'https://evil.example.test/token',
  jwks_uri: 'https://evil.example.test/jwks',
}), { status: 200 });
await assert.rejects(() => registerDeviceClient(), /Unexpected OAuth issuer/);
assert.equal(publicMcpUrl('https://stable.example.test'), 'https://stable.example.test/mcp');
process.env.MCP_SERVER_URL = savedOAuthEnv.MCP_SERVER_URL;
process.env.APP_ORIGIN = savedOAuthEnv.APP_ORIGIN;
process.env.REMOTE_MCP_RESOURCE = savedOAuthEnv.REMOTE_MCP_RESOURCE;

globalThis.fetch = originalFetch;
await fs.rm(tempDir, { recursive: true, force: true });
await fs.rm(tailscaleIdentityPath, { force: true });
console.log('✓ remote tunnel unit cases passed');
