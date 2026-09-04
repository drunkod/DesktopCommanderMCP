/**
 * Opt-in Tailscale Funnel smoke test. It exercises the provider only; ChatGPT
 * OAuth/Jazz acceptance remains a human-operated step documented in
 * docs/TAILSCALE-FUNNEL-CHATGPT-RUNBOOK.md.
 */
if (process.env.DC_TUNNEL_E2E !== '1') {
  throw new Error('Refusing Tailscale E2E: set DC_TUNNEL_E2E=1 explicitly');
}
if (process.env.DC_TAILSCALE_E2E_ALLOW_MUTATION !== '1') {
  throw new Error('Refusing to modify real Tailscale Funnel state. Set DC_TAILSCALE_E2E_ALLOW_MUTATION=1 on a disposable/test machine.');
}
if (!process.env.DC_TAILSCALE_STATE_PATH || !/(?:e2e|test|disposable)/i.test(process.env.DC_TAILSCALE_STATE_PATH)) {
  throw new Error('Refusing Tailscale E2E: DC_TAILSCALE_STATE_PATH must explicitly identify an isolated test state path');
}

const { createTunnelProvider } = await import('../../dist/remote-device/tunnel/create-tunnel-provider.js');
const { TailscaleCli } = await import('../../dist/remote-device/tunnel/tailscale-cli.js');
const localTarget = process.env.DC_TUNNEL_TARGET ?? 'http://127.0.0.1:3000';
const provider = createTunnelProvider('tailscale', {
  localTarget,
  healthPath: process.env.DC_TUNNEL_HEALTH_PATH ?? '/.well-known/oauth-protected-resource/mcp',
  statePath: process.env.DC_TAILSCALE_STATE_PATH,
});
const cli = new TailscaleCli();
const before = await cli.funnelStatus(localTarget);
try {
  const first = await provider.start();
  if (!first.transportHealthy || !first.publicMcpUrl) throw new Error('Tailscale provider did not return a connected stable MCP URL');
  await provider.restart();
  const second = await provider.status();
  if (!second.transportHealthy || second.publicMcpUrl !== first.publicMcpUrl) throw new Error('Tailscale repair changed or lost the stable URL');
  console.log(`✓ Tailscale Funnel stable URL: ${first.publicMcpUrl}`);
} finally {
  // Restore the pre-test runtime state. A pre-existing Funnel mapping for this
  // target was only reapplied; a test-created mapping is disabled here.
  if (!before.enabled) await cli.disableFunnel().catch(() => undefined);
}
