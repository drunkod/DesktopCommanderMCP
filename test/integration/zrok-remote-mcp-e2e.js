/**
 * Opt-in zrok named-share smoke test. Use a provisioned test account/name,
 * isolated state path, and never a production identity.
 */
if (process.env.DC_TUNNEL_E2E !== '1') {
  throw new Error('Refusing zrok E2E: DC_TUNNEL_E2E=1 is required');
}
for (const variable of ['DC_ZROK_NAMESPACE', 'DC_ZROK_NAME', 'DC_ZROK_STATE_PATH']) {
  if (!process.env[variable]) throw new Error(`${variable} is required for zrok E2E`);
}
if (!/(?:e2e|test|disposable)/i.test(process.env.DC_ZROK_NAME) || !/(?:e2e|test|disposable)/i.test(process.env.DC_ZROK_STATE_PATH)) {
  throw new Error('Refusing zrok E2E: DC_ZROK_NAME and DC_ZROK_STATE_PATH must visibly identify a disposable test identity');
}

const { createTunnelProvider } = await import('../../dist/remote-device/tunnel/create-tunnel-provider.js');
const provider = createTunnelProvider('zrok', {
  localTarget: process.env.DC_TUNNEL_TARGET ?? 'http://127.0.0.1:3000',
  healthPath: process.env.DC_TUNNEL_HEALTH_PATH ?? '/.well-known/oauth-protected-resource/mcp',
  name: process.env.DC_ZROK_NAME,
  namespace: process.env.DC_ZROK_NAMESPACE,
  statePath: process.env.DC_ZROK_STATE_PATH,
});
try {
  const first = await provider.start();
  if (!first.transportHealthy || !first.publicMcpUrl) throw new Error('zrok provider did not return a connected stable MCP URL');
  await provider.restart();
  const second = await provider.status();
  if (!second.transportHealthy || second.publicMcpUrl !== first.publicMcpUrl) throw new Error('zrok repair changed or lost the stable URL');
  console.log(`✓ zrok named-share stable URL: ${first.publicMcpUrl}`);
} finally {
  // Keep the reserved identity for later test runs, but do not leave a test
  // share serving the local backend after the test exits.
  await provider.stop().catch(() => undefined);
}
