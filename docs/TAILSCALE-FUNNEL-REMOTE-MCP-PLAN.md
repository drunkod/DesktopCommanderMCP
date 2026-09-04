# Tailscale Funnel Remote MCP plan

Status: implementation in progress; real external acceptance is not yet complete — 2026-09-04.

This document specifies the **Tailscale Funnel-only** public transport for Desktop Commander Remote MCP. The provider boundary, local/public origin split, CLI lifecycle, layered health model, and opt-in test scaffolding are implemented; real Tailscale, ChatGPT OAuth, and Jazz acceptance remain gated work.

## Goal

Provide a CLI-first experience in which a user runs Desktop Commander locally, receives one stable HTTPS MCP URL, adds that URL to ChatGPT once, and does not need to update the ChatGPT app after normal reboots or network changes.

Target UX:

```text
$ desktop-commander remote --tunnel tailscale
...
Remote MCP ready
https://tests-macbook-air.example-tailnet.ts.net/mcp
```

The local machine remains the application host. Tailscale supplies public ingress and TLS; there is no user-operated VPS or traditional hosted web application.

## Explicit scope

- Tailscale Funnel only; no Iroh.
- Preserve the existing Better Auth/OAuth, MCP, Jazz call semantics, local Desktop Commander stdio child, Keychain credential persistence, reconnect controls, revocation and lifecycle behavior.
- Keep local application state on the controlled machine.
- Do not treat Tailscale as an authorization layer for MCP tools; the public origin still requires application-level OAuth.
- This document tracks the implementation and the remaining external acceptance gates.
## Research findings that drive the design

As of 2026-09-04, Tailscale documents Funnel as a public HTTPS reverse proxy to a local service. Funnel uses a predictable `device.tailnet.ts.net` DNS name and is intended to remain the same URL across normal Funnel restarts.

Important documented behavior:

- `tailscale funnel --bg ...` persists its configuration and automatically resumes after device reboot or `tailscale down` / `tailscale up`.
- Funnel is public internet ingress; it does not create a direct internet-to-device socket. Tailscale relay infrastructure terminates/forwards the public connection.
- Funnel requires MagicDNS, HTTPS certificates, and the `funnel` node attribute.
- Public Funnel listeners are restricted to ports 443, 8443, and 10000.
- Funnel currently has non-configurable bandwidth limits and is still documented as beta.
- Tailscale's macOS documentation has differing scope notes for package variants. Because this adapter proxies an HTTP port rather than files, the implementation uses a version and runtime Funnel capability preflight instead of hard-coding a package restriction.

The stable-URL property is the reason to prefer Funnel over an ephemeral tunnel for ChatGPT. The URL should be treated as the MCP resource identity and must not change during ordinary restart recovery.

## Proposed topology

```text
ChatGPT
  |
  | HTTPS + OAuth
  v
https://<device>.<tailnet>.ts.net/mcp
  |
Tailscale Funnel :443
  |
  v
http://127.0.0.1:3000
  |
Better Auth + MCP control plane + existing Jazz-backed call router
```
## Full RemoteMCP-Jazz compatibility option

For the current Jazz architecture, ChatGPT needs the control-plane origin and the device may also need a public Jazz sync origin. Funnel can expose more than one allowed TLS port on the same stable Tailscale DNS name.

Proposed mapping for a full multi-device test:

```text
https://<device>.<tailnet>.ts.net/mcp       -> Funnel 443  -> 127.0.0.1:3000
https://<device>.<tailnet>.ts.net:8443     -> Funnel 8443 -> 127.0.0.1:1625
```

Then conceptually:

```text
APP_ORIGIN=https://<device>.<tailnet>.ts.net
REMOTE_MCP_RESOURCE=https://<device>.<tailnet>.ts.net/mcp
JAZZ_SERVER_URL=https://<device>.<tailnet>.ts.net:8443
```

This second mapping must not be assumed to work until Jazz sync/WebSocket behavior is tested through Funnel. If the first MVP controls only the same machine, Jazz can remain localhost-only and only port 443 needs public ingress.

## Stable identity rules

The ChatGPT MCP URL must be considered configuration identity, not a disposable runtime value.

Do not automatically rename the Tailscale node after ChatGPT setup. Do not switch tailnets or reset/re-register the Tailscale machine silently. A node-name or tailnet-domain change changes the public URL and therefore the OAuth issuer/resource identity.

Normal reboot, network change, `tailscale down/up`, or Funnel process recovery must reuse the same DNS name and the same ChatGPT URL.
## Proposed CLI behavior

The future CLI should hide Tailscale setup complexity and behave idempotently.

Suggested command shape:

```text
desktop-commander remote --tunnel tailscale
```

First run:

1. Verify the local MCP/control-plane health endpoint before touching Funnel.
2. Verify `tailscale` is installed and meets the minimum supported version.
3. Verify the installed macOS variant actually supports Funnel; stop with an actionable message if not.
4. Run/read `tailscale status --json` to determine authentication state, node DNS name, and tailnet identity.
5. If unauthenticated, launch the standard Tailscale login flow and wait for completion.
6. Enable Funnel if required; the first enable flow may open Tailscale's approval UI.
7. Configure port 443 as a background reverse proxy to `http://127.0.0.1:3000`.
8. If full Jazz multi-device mode is selected, configure 8443 to the Jazz local endpoint only after its transport test passes.
9. Verify public HTTPS reachability and OAuth metadata before printing success.
10. Print exactly one canonical ChatGPT URL ending in `/mcp`.

Subsequent runs should inspect current state and reuse it. They must not reset Funnel, rename the node, or create a second public identity when the existing configuration is healthy.

Suggested operator commands for a later implementation: `remote tunnel status`, `remote tunnel doctor`, `remote tunnel restart`, and `remote tunnel disable`. `restart` should repair the running connection while preserving the DNS name.
## Recovery model

The implementation must distinguish four failures instead of treating all failures as "the tunnel is down":

```text
A. local MCP/control plane stopped
B. Funnel configuration missing or disabled
C. Tailscale daemon/session disconnected
D. internet path unavailable
```

Expected recovery:

- A: restart/supervise the local service; do not change the public URL.
- B: re-apply the saved Funnel mapping with `--bg`; do not reset the Tailscale identity.
- C: let Tailscale reconnect; if necessary run the supported reconnect/login flow, preserving the existing node identity.
- D: report offline and retry with bounded backoff; no configuration mutation.

On boot, the local service and Tailscale may start in either order. The supervisor should wait until both become healthy, then confirm the existing Funnel mapping and public endpoint. It should never generate a replacement URL as an automatic recovery action.

## Security requirements

Funnel makes the selected HTTP service reachable from the public internet. The exposed origin must therefore fail closed when unauthenticated.

- `/mcp` must return the expected OAuth challenge/metadata, not anonymous Desktop Commander tools.
- Better Auth issuer, protected-resource metadata and MCP resource audience must use the stable Funnel origin.
- Dashboard/device mutation routes must remain authenticated and CSRF-protected.
- Never put Tailscale auth keys, OAuth refresh tokens, Jazz secrets or Keychain contents in CLI output, logs, process arguments, or repository files.
- Do not add a second Tailscale authentication gate in front of ChatGPT OAuth; Funnel is public by design.
## Acceptance matrix before adopting Funnel

A Funnel transport is acceptable only after all of these are proven against the real ChatGPT development app:

- First setup yields a public `https://...ts.net/mcp` URL and OAuth completes.
- `list_devices`, `__control.ping`, and harmless `get_config` work through that URL.
- Reboot the Mac: the same exact URL works again without editing ChatGPT settings.
- Run `tailscale down`, then `tailscale up`: the same exact URL recovers when Funnel was configured with `--bg`.
- Kill/restart the local MCP process while Tailscale remains connected: public requests fail during the outage and recover at the same URL.
- Disconnect/reconnect Wi-Fi and change networks: the URL remains unchanged.
- Restart only the remote Desktop Commander device process: Keychain session reuse still avoids a new pairing.
- Revoke the device: old OAuth/Jazz credentials remain fail-closed through the public Funnel path.
- If port 8443 is used for Jazz, prove WebSocket/sync reconnect and duplicate-delivery safety through that path.
- Confirm no unauthenticated public tool call succeeds.

## Implementation phases for a future code change

1. Transport spike outside production CLI: manual Funnel + local control plane + ChatGPT.
2. Prove reboot/stable-URL behavior before writing integration code.
3. Add a tunnel-provider abstraction only after the spike is green.
4. Add Tailscale preflight/status/setup helpers with no secret logging.
5. Add boot/recovery supervision while preserving the node identity.
6. Add ChatGPT-facing doctor checks for OAuth metadata and `/mcp`.
7. Add the full RemoteMCP-Jazz acceptance matrix and security smoke.
8. Only then make Tailscale an advertised CLI option.

## Research sources

- https://tailscale.com/docs/features/tailscale-funnel
- https://tailscale.com/docs/reference/tailscale-cli/funnel
- https://tailscale.com/docs/reference/examples/funnel
- https://tailscale.com/docs/concepts/macos-variants
- https://tailscale.com/docs/how-to/set-up-https-certificates

## Detailed execution backlog — tasks, subtasks, files, and snippets

The backlog below turns the research plan into an implementation sequence. Every task is expected to be completed red → green under `nix develop`; do not merge provider code before the preceding acceptance gate is green.

### Task T1 — freeze the tunnel provider contract

**Status: implemented.**

**Goal:** add one transport abstraction without moving OAuth, Jazz, or tool execution out of `MCPDevice`.

Subtasks:

- T1.1 Create `src/remote-device/tunnel/types.ts` for stable public URL, provider health, and doctor output types.
- T1.2 Create `src/remote-device/tunnel/tunnel-provider.ts` with the minimal provider interface.
- T1.3 Create `src/remote-device/tunnel/tunnel-supervisor.ts` for single-flight restart/backoff, modeled after `reconnect-supervisor.ts`.
- T1.4 Create `test/test-tunnel-provider-contract.js` before implementations.
- T1.5 Keep `src/remote-device/device.ts` unchanged except for imports only if later lifecycle composition requires them.

Example interface:

```ts
export type TunnelState = { provider: 'tailscale' | 'zrok'; publicMcpUrl: string; healthy: boolean };

export interface TunnelProvider {
  start(): Promise<TunnelState>;
  status(): Promise<TunnelState>;
  doctor(): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> }>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}
```
### Task T2 — parse remote tunnel CLI options in one place

**Status: implemented.**

**Files:** `src/npm-scripts/remote.ts`, new `src/npm-scripts/remote-options.ts`, new `test/test-remote-tunnel-cli.js`.

Subtasks:

- T2.1 Parse `--tunnel tailscale`, `--tunnel none`, and future operator subcommands without changing existing `--debug`, `--disable-no-sleep`, or persistence flags.
- T2.2 Reject unknown providers before starting `MCPDevice`.
- T2.3 Keep default behavior unchanged when `--tunnel` is absent.
- T2.4 Add a structured options object so provider code never reads `process.argv` directly.

Example:

```ts
export type RemoteOptions = {
  tunnel?: 'tailscale' | 'zrok';
  debug: boolean;
  disableNoSleep: boolean;
  persistSession: boolean;
};

export function parseRemoteOptions(argv = process.argv.slice(3)): RemoteOptions {
  const i = argv.indexOf('--tunnel');
  const tunnel = i >= 0 ? argv[i + 1] : undefined;
  if (tunnel && tunnel !== 'tailscale' && tunnel !== 'zrok') throw new Error(`Unknown tunnel: ${tunnel}`);
  return { tunnel, debug: argv.includes('--debug'), disableNoSleep: argv.includes('--disable-no-sleep'), persistSession: !argv.includes('--no-persist-session') };
}
```
### Task T3 — implement a safe Tailscale CLI adapter

**Status: implemented; external capability validation remains acceptance-gated.**

**Files:** new `src/remote-device/tunnel/command-runner.ts`, new `src/remote-device/tunnel/tailscale-cli.ts`, new `test/test-tailscale-cli.js`.

Subtasks:

- T3.1 Wrap child-process execution so stdout/stderr, exit code, and timeout are structured.
- T3.2 Add `tailscale version`, `tailscale status --json`, and Funnel status/config readers.
- T3.3 Parse JSON instead of scraping human output where JSON is available.
- T3.4 Redact auth URLs/keys or other secret-looking values before debug logging.
- T3.5 Detect unsupported macOS variants and fail before changing Funnel state.

Example adapter shape:

```ts
export class TailscaleCli {
  async status() {
    const r = await runCommand('tailscale', ['status', '--json'], { timeoutMs: 10_000 });
    if (r.code !== 0) throw new Error(`tailscale status failed: ${r.safeStderr}`);
    return JSON.parse(r.stdout);
  }

  async enableFunnel(target = 'http://127.0.0.1:3000') {
    return runCommand('tailscale', ['funnel', '--bg', '--https=443', target], { timeoutMs: 30_000 });
  }
}
```
### Task T4 — implement `TailscaleTunnelProvider`

**Status: implemented; real Funnel recovery acceptance remains pending.**

**Files:** new `src/remote-device/tunnel/tailscale-tunnel-provider.ts`, new `test/test-tailscale-tunnel-provider.js`.

Subtasks:

- T4.1 `start()` must preflight local control-plane health before mutating Funnel.
- T4.2 Derive the stable DNS name from Tailscale state; never invent or cache a second hostname.
- T4.3 Configure only the required mapping `443 -> http://127.0.0.1:3000` for MVP.
- T4.4 `status()` must distinguish daemon offline, Funnel absent, backend unhealthy, and public endpoint unhealthy.
- T4.5 `restart()` re-applies the same Funnel mapping and must never rename/reset the node.
- T4.6 `stop()` should disable only the owned Funnel mapping; node logout/reset is out of scope.

Example provider fragment:

```ts
const localOrigin = 'http://127.0.0.1:3000';
const publicMcpUrl = `https://${dnsName}/mcp`;

async start() {
  await assertLocalControlPlane(localOrigin);
  const status = await this.cli.status();
  const dnsName = requireStableDnsName(status);
  await this.cli.enableFunnel(localOrigin);
  await assertPublicOAuthMetadata(`https://${dnsName}`);
  return { provider: 'tailscale', publicMcpUrl: `https://${dnsName}/mcp`, healthy: true };
}
```
### Task T5 — separate local origin from public OAuth/MCP origin

**Status: implemented in the device and tunnel boundary; the deployed control plane must still be configured and externally verified.**

**Files:** `src/npm-scripts/remote.ts`; likely control-plane env/config in the sibling RemoteMCP-Jazz implementation; new documentation test fixture only in this repository.

Subtasks:

- T5.1 Keep `MCP_SERVER_URL=http://127.0.0.1:3000` for the local device process.
- T5.2 Use the control plane's `APP_ORIGIN` and `REMOTE_MCP_RESOURCE` as the browser/ChatGPT-facing issuer and MCP resource; Desktop Commander must not pretend to reconfigure that separate process.
- T5.3 Verify `/.well-known/oauth-protected-resource/mcp`, authorization-server metadata, redirects, and resource audience all use the Funnel origin.
- T5.4 Never make the local device registration/heartbeat/call-completion path depend on the public Funnel route.
- T5.5 Add a startup assertion that public and local origins cannot silently overwrite each other.

Example desired runtime split:

```text
# RemoteMCP-Jazz control plane (configured before it starts)
APP_ORIGIN=https://tests-macbook-air.example-tailnet.ts.net
REMOTE_MCP_RESOURCE=https://tests-macbook-air.example-tailnet.ts.net/mcp

# Desktop Commander device transport
MCP_SERVER_URL=http://127.0.0.1:3000
JAZZ_SERVER_URL=http://127.0.0.1:1625   # MVP
```

Acceptance: killing Funnel must not break the already-running device's localhost control-plane requests; killing the local control plane must make both local and public checks fail closed.
### Task T6 — compose tunnel and device lifecycles in `runRemote()`

**Status: implemented.**

**Files:** `src/npm-scripts/remote.ts`, new `src/remote-device/tunnel/create-tunnel-provider.ts`.

Subtasks:

- T6.1 Parse remote options once.
- T6.2 Start the selected tunnel before printing a ChatGPT URL, but keep `MCPDevice` initialization independent.
- T6.3 If tunnel startup fails, shut down any partially started provider and fail before claiming remote readiness.
- T6.4 On SIGINT/SIGTERM, let existing `MCPDevice` shutdown semantics run and stop only provider runtime state that is safe to stop.
- T6.5 Never run Tailscale logout/reset on normal process exit.

Example composition:

```ts
const options = parseRemoteOptions();
const tunnel = options.tunnel ? createTunnelProvider(options.tunnel) : undefined;
const tunnelState = tunnel ? await tunnel.start() : undefined;

const device = new MCPDevice({ persistSession: options.persistSession });
try {
  await device.start();
  if (tunnelState) console.log(`Remote MCP ready\n${tunnelState.publicMcpUrl}`);
} catch (error) {
  await tunnel?.rollbackStartup?.().catch(() => undefined);
  throw error;
}
```

The implementation now distinguishes startup rollback from operator stop: a failed startup may undo only a mapping/share proven to have been created by that attempt, while normal operator commands preserve durable identity.
### Task T7 — add provider tests and Nix development gates

**Status: implemented for unit/gate scaffolding; real external acceptance remains pending.**

**Files:** `test/test-tunnel-provider-contract.js`, `test/test-tailscale-cli.js`, `test/test-tailscale-tunnel-provider.js`, `test/test-remote-tunnel-cli.js`, `Justfile`, optionally `flake.nix`.

Subtasks:

- T7.1 Stub the command runner; unit tests must not mutate the developer's real tailnet.
- T7.2 Test idempotent second start: no node rename, logout, or identity reset command may be issued.
- T7.3 Test startup failure after partial configuration and verify cleanup preserves identity.
- T7.4 Test `restart()` reuses the same DNS name.
- T7.5 Test secret redaction in debug/error output.
- T7.6 Add a manual integration gate that is skipped unless `DC_TUNNEL_E2E=1`.
- T7.7 Run all repository regression tests after the provider-specific suite.

Example `Justfile` targets:

```make
remote-tunnel-unit: check
  node test/test-tunnel-provider-contract.js
  node test/test-remote-tunnel-cli.js
  node test/test-tailscale-cli.js
  node test/test-tailscale-tunnel-provider.js

remote-tunnel-e2e: check
  test "$${DC_TUNNEL_E2E:-}" = 1
  node test/integration/tailscale-funnel-e2e.js
```
### Task T8 — real Tailscale + ChatGPT acceptance

**Status: pending manual acceptance.**

**Files:** new `test/integration/tailscale-funnel-e2e.js`, new `docs/TAILSCALE-FUNNEL-CHATGPT-RUNBOOK.md`, optional `scripts/tunnel-smoke.sh`.

Subtasks:

- T8.1 Start RemoteMCP-Jazz locally and confirm the control plane, OAuth metadata, and device are healthy.
- T8.2 Run the future CLI once and record the exact stable `https://...ts.net/mcp` URL.
- T8.3 Configure the ChatGPT development app once; complete OAuth.
- T8.4 From ChatGPT run `list_devices`, `__control.ping`, `get_config`, and a harmless `start_process` command such as `printf 'tailscale-funnel-ok\n'`.
- T8.5 Restart Funnel, run `tailscale down/up`, restart Desktop Commander, reboot macOS, and change networks; the URL must remain byte-for-byte identical.
- T8.6 Revoke device/session access and prove old authorization cannot execute a local side effect.
- T8.7 Run concurrent and long-running MCP calls before considering Funnel supported.

Example repository gate:

```bash
nix develop -c sh -lc '
  npm run build &&
  node test/test-tunnel-provider-contract.js &&
  node test/test-remote-tunnel-cli.js &&
  node test/test-tailscale-cli.js &&
  node test/test-tailscale-tunnel-provider.js &&
  node test/test-remote-jazz-safety.js &&
  node test/test-remote-device-supervision.js &&
  npm test
'
```
## Proposed implementation file map and dependency order

Expected files after implementation (illustrative; create them only when the corresponding task begins):

```text
src/npm-scripts/remote.ts
src/npm-scripts/remote-options.ts
src/remote-device/tunnel/
  types.ts
  tunnel-provider.ts
  tunnel-supervisor.ts
  command-runner.ts
  create-tunnel-provider.ts
  tailscale-cli.ts
  tailscale-tunnel-provider.ts
test/
  test-tunnel-provider-contract.js
  test-remote-tunnel-cli.js
  test-tailscale-cli.js
  test-tailscale-tunnel-provider.js
  integration/tailscale-funnel-e2e.js
docs/TAILSCALE-FUNNEL-CHATGPT-RUNBOOK.md
```

Dependency order: **T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8**. T1–T4 must stay unit-testable without a real tailnet; T8 is the first task allowed to require the real external Funnel/ChatGPT environment.
