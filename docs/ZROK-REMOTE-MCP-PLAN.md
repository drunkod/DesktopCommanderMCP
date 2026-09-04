# zrok Remote MCP plan

Status: implementation in progress; real external acceptance is not yet complete — 2026-09-04.

This document specifies the **zrok-only** public transport for Desktop Commander Remote MCP. The provider boundary, reserved-name persistence, agent lifecycle, layered health model, CLI lifecycle, and opt-in test scaffolding are implemented; real zrok, ChatGPT OAuth, and Jazz acceptance remain gated work.

## Goal

Provide a CLI-first experience in which a user runs Desktop Commander locally, receives one stable HTTPS MCP URL backed by a reserved zrok name, adds that URL to ChatGPT once, and does not need to update the ChatGPT app after normal share or machine restarts.

Target UX:

```text
$ desktop-commander remote --tunnel zrok
...
Remote MCP ready
https://desktop-commander-alice.share.zrok.io/mcp
```

The local machine remains the application host. zrok supplies public HTTPS ingress through its hosted service; there is no user-operated VPS or traditional hosted application in this variant.

## Explicit scope

- zrok v2 public shares only; no Iroh.
- Use hosted zrok public infrastructure, not a self-hosted zrok controller/frontend.
- Preserve existing Better Auth/OAuth, MCP, Jazz call semantics, local Desktop Commander stdio child, Keychain persistence, reconnect, revoke and lifecycle behavior.
- This document tracks the implementation and the remaining external acceptance gates.
## Research findings that drive the design

zrok v2 uses the `zrok2` CLI. Its default public shares are **ephemeral**: stopping `zrok2 share` deletes the share token, and the next run receives a different public URL. That mode is unsuitable for a ChatGPT MCP app whose OAuth issuer/resource must remain stable.

The stable zrok primitive is a **reserved name in a namespace**. Example flow:

```bash
zrok2 list namespaces
zrok2 create name -n public desktop-commander-alice
zrok2 share public http://127.0.0.1:3000 \
  -n public:desktop-commander-alice
```

A reserved name persists when the share is not running and can be reused across later share sessions. For the hosted public namespace, the resulting endpoint is typically shaped like:

```text
https://desktop-commander-alice.share.zrok.io
```

The future CLI must derive and verify the actual frontend URL from `zrok2 list names`, agent state, or share output rather than hardcoding the hosted domain.

zrok v1 commands such as `zrok reserve` / `zrok share reserved` must not be used in a new implementation; v2 replaces them with namespaces and names.
## Proposed topology

```text
ChatGPT
  |
  | HTTPS + Better Auth OAuth
  v
https://<reserved-name>.<namespace-domain>/mcp
  |
zrok public frontend
  |
OpenZiti / zrok hosted transport
  |
zrok2 agent + named public share on the local computer
  |
  v
http://127.0.0.1:3000
  |
Better Auth + MCP control plane + existing Jazz-backed call router
```

The hosted zrok service is transport infrastructure, not the application authority. Desktop Commander tools must remain protected by the existing OAuth/resource checks at the local control plane.

## Full RemoteMCP-Jazz compatibility option

The current multi-device Jazz design may require a second externally reachable sync endpoint. Use a **separate reserved public name** for Jazz rather than overloading or rewriting the MCP name.

```text
<reserved-mcp-name>  -> http://127.0.0.1:3000
<reserved-jazz-name> -> http://127.0.0.1:1625
```

Do not adopt the Jazz mapping until zrok has been tested for the exact WebSocket/streaming behavior Jazz requires. For a same-machine first MVP, keep Jazz on localhost and expose only the control-plane/MCP origin.
## Stable identity rules

The reserved zrok name is the ChatGPT-facing configuration identity. It must be treated as durable application state.

- Never configure ChatGPT with a plain ephemeral `zrok2 share public` URL.
- Never delete/recreate the reserved name as an automatic recovery action.
- Never silently switch zrok account, namespace, or public frontend domain after ChatGPT setup.
- A stopped share may make the URL temporarily unavailable, but restarting the share with the same reserved name must restore the same URL.
- If the user explicitly deletes the reserved name, treat that as destructive configuration removal and require a new ChatGPT/OAuth setup.

## zrok agent and macOS lifecycle

The zrok agent is the preferred long-running manager. Named public shares delegated to the agent are automatically restarted after abnormal share exit or agent restart, and zrok v2 retries failures with backoff.

Current zrok documentation does **not** provide a native macOS agent service package. A future Desktop Commander integration therefore needs one of these approaches:

1. CLI-owned macOS LaunchAgent that runs `zrok2 agent start` at login/boot context; preferred for a polished native CLI.
2. Explicit foreground `zrok2 agent start` for the first manual spike only.
3. A documented third-party process manager as a temporary developer option.

The public name must survive independently from the local agent process so restart recovery never changes ChatGPT settings.
## Proposed CLI behavior

Suggested future command:

```text
desktop-commander remote --tunnel zrok
```

First run should be idempotent and guided:

1. Verify the local MCP/control-plane health endpoint.
2. Verify `zrok2` is installed and use only the v2 command set.
3. Detect whether the local zrok environment/account is enabled without printing credentials.
4. If not enabled, open the normal zrok enrollment/account flow and accept the enable token through secure input; never echo it or persist it in repository files.
5. List available namespaces and select the hosted public namespace.
6. Choose a deterministic but collision-safe Desktop Commander name; let the user approve/change it before reservation.
7. Reuse an existing reserved name if it belongs to this installation; otherwise create it once.
8. Ensure the zrok agent is running, then start/delegate the public proxy share to `http://127.0.0.1:3000` using the reserved name.
9. Read the actual public frontend endpoint and verify `/mcp` OAuth discovery externally.
10. Print exactly one canonical ChatGPT URL ending in `/mcp`.

Subsequent runs must reuse the reserved name and existing environment. A routine `restart` operation repairs the local agent/share but never replaces the public name.

Suggested later operator surface: `remote tunnel status`, `remote tunnel doctor`, `remote tunnel restart`, `remote tunnel disable`, and an explicit destructive `remote tunnel delete-name` that requires confirmation.
## Recovery model

Treat these as independent failure classes:

```text
A. local MCP/control plane stopped
B. zrok named share stopped or errored
C. zrok agent stopped
D. zrok hosted service / local internet unavailable
```

Expected recovery:

- A: restart/supervise the local service; preserve the reserved name and public URL.
- B: let the agent retry or explicitly restart the existing named share; never create an ephemeral replacement.
- C: restart the agent, then confirm its named share is restored automatically.
- D: report offline and retry with bounded backoff; do not mutate the name/account/namespace.

On macOS reboot, an outer LaunchAgent/process supervisor must start the zrok agent because zrok does not currently ship a native macOS agent service package. Once the agent is back, named shares should be restored using the same reserved name.

The implementation must verify end-to-end public MCP health after recovery. An alive zrok agent is not sufficient evidence that `127.0.0.1:3000`, OAuth metadata, and `/mcp` are healthy.

## Provider dependency boundary

This variant removes a user-operated server, not all third-party infrastructure. It depends on the hosted zrok controller/frontends and OpenZiti fabric. Self-hosting zrok would reintroduce server operations and is outside this plan.
## Security requirements

A zrok public share makes the selected HTTP service reachable from the public internet, so the local application must remain the security boundary.

- `/mcp` must require the existing Better Auth OAuth flow and correct MCP resource audience.
- Do not replace application OAuth with zrok permission modes unless ChatGPT compatibility is separately proven; an extra zrok login page could block MCP/OAuth discovery.
- Keep OAuth refresh tokens, zrok enable tokens, Jazz secrets and device credentials out of CLI logs, argv, environment dumps and repository files.
- Do not expose arbitrary local ports; proxy only the explicitly configured control-plane/Jazz origins.
- Verify forwarded Host, Origin, Authorization and content-type behavior required by MCP/OAuth.
- Treat the hosted zrok frontend as a transport operator: TLS/public HTTP traffic traverses third-party infrastructure, so document this privacy boundary.
- Revocation and call authorization remain application-layer responsibilities.

## Transport compatibility gates

Official zrok docs describe public proxy shares for HTTP/HTTPS resources, but this plan must not assume every MCP streaming or Jazz transport detail is transparent.

Before adoption, explicitly test:

- Streamable HTTP MCP POST requests and response bodies.
- Long-running requests and request cancellation behavior.
- Required OAuth discovery paths, redirects, cookies and authorization headers.
- Request/response size limits relevant to Desktop Commander results.
- WebSocket upgrade, reconnect and idle behavior if Jazz is exposed through zrok.
- Multiple simultaneous ChatGPT MCP requests and duplicate-delivery safety.
## Acceptance matrix before adopting zrok

A zrok transport is acceptable only after all of these are proven with the real ChatGPT development app:

- Reserve one public name and complete ChatGPT OAuth at its `/mcp` URL.
- `list_devices`, `__control.ping`, and harmless `get_config` work through that URL.
- Stop and restart the named share: the exact same URL works without editing ChatGPT settings.
- Stop and restart the zrok agent: the named share returns at the same URL.
- Reboot macOS with the proposed LaunchAgent/process supervisor: the same URL returns automatically.
- Kill/restart the local MCP process while zrok remains healthy: public requests fail during the outage and recover at the same URL.
- Disconnect/reconnect Wi-Fi or change networks: the reserved URL remains unchanged.
- Restart the Desktop Commander remote-device process and verify Keychain credentials still avoid a new pairing.
- Revoke the device and prove old OAuth/Jazz credentials remain fail-closed through zrok.
- Exercise concurrent MCP calls, long-running responses, and representative result sizes.
- If the Jazz public share is used, prove WebSocket/sync reconnect and duplicate-delivery safety.
- Confirm no unauthenticated Desktop Commander tool call succeeds.
- Deliberately delete the reserved name only in a cleanup test and confirm this invalidates the old URL as expected.

## Implementation phases and acceptance history

1. Manual zrok v2 transport spike with one reserved name and localhost MCP.
2. Prove stable-name behavior across share restart, agent restart and Mac reboot.
3. Prove ChatGPT MCP/OAuth transport compatibility and headers/streaming.
4. Design the macOS zrok-agent supervisor and explicit lifecycle ownership.
5. Add a tunnel-provider abstraction only after the spike is green.
6. Add secure enrollment/name persistence and status/doctor/restart commands.
7. Run the complete RemoteMCP-Jazz failure/security matrix.
8. Only then advertise zrok as a supported CLI tunnel provider.
## Research sources

- https://netfoundry.io/docs/zrok/category/shares/
- https://netfoundry.io/docs/zrok/concepts/public-shares/
- https://netfoundry.io/docs/zrok/concepts/sharing-reserved/
- https://netfoundry.io/docs/zrok/how-tos/shares/manage-reserved-names/
- https://netfoundry.io/docs/zrok/concepts/agent/
- https://netfoundry.io/docs/zrok/get-started/set-up-agent/
- https://netfoundry.io/docs/zrok/how-tos/agent/manage-shares/
- https://netfoundry.io/docs/zrok/how-tos/migrate-v1-to-v2/

## Decision checkpoint

For the stable ChatGPT UX, **reserved-name + agent** is the only zrok mode in scope. A plain ephemeral public share is useful for a throwaway transport smoke test but must never become the persisted ChatGPT MCP endpoint.

The main unresolved technical gate is not URL stability; zrok v2 explicitly provides that. The unresolved gate is transport compatibility under real MCP/OAuth load and, if required, Jazz WebSocket/sync traffic. That must be proven before implementation is merged.

## Agent integration update — mapped to this codebase

This section incorporates the zrok v2 agent how-to and agent-overview material verified through the user's working Helium/WebMCP setup on 2026-09-04. It refines the earlier agent lifecycle guidance without changing any code.

The key architectural point is that the zrok agent should become the **transport process manager**, not part of Desktop Commander's authorization or tool-execution authority. zrok documents the agent as one persistent background process: while it is running, normal `zrok2 share` and `zrok2 access` commands automatically delegate to it. Named public shares are restored after an agent restart; unnamed ephemeral shares are not.

For this project, that maps cleanly to:

```text
desktop-commander remote --tunnel zrok
  |
  +-- runRemote()                         orchestration owner
  |    +-- MCPDevice                     OAuth/Jazz/device lifecycle
  |    +-- local control plane           127.0.0.1:3000
  |    +-- future ZrokTunnelSupervisor   transport lifecycle only
  |         +-- ensure zrok2 agent is running
  |         +-- ensure reserved namespace:name exists
  |         +-- start named public share -> 127.0.0.1:3000
  |         +-- read `zrok2 agent status`
  |         +-- run agent HTTP health checks
  |
ChatGPT -> https://<reserved-name>.<frontend>/mcp
```

The existing `src/npm-scripts/remote.ts` is the orchestration boundary: it parses remote-mode flags, owns process-level setup such as `caffeinate`, constructs `MCPDevice`, and supervises the tunnel beside it rather than inside individual tool execution.
### Keep `MCPDevice` transport-agnostic

`src/remote-device/device.ts` already has its own responsibilities: device OAuth/token persistence, Jazz registration/channel health, local Desktop Commander child recovery, duplicate-call suppression, and control operations such as reconnect/shutdown. zrok lifecycle logic should not be inserted into `handleNewToolCall()` or the Jazz channel.

The implemented sidecar abstraction is:

```text
TunnelProvider
  start(): Promise<TunnelState>
  status(): Promise<TunnelState>
  doctor(): Promise<DoctorResult>
  restart(): Promise<void>
  stop(): Promise<void>

ZrokTunnelProvider implements TunnelProvider
TunnelSupervisor owns restart/backoff and process lifecycle
```

The implementation lives in `src/remote-device/tunnel/`, including `tunnel-provider.ts`, `zrok-tunnel-provider.ts`, `tunnel-supervisor.ts`, and the `zrok-cli.ts` adapter.

The existing `ReconnectSupervisor` provides a useful behavioral pattern: single in-flight recovery, bounded exponential backoff and jitter. A zrok supervisor should follow that pattern, but must not fight the zrok agent's own restart behavior. Observe agent/share state first; repair only when the agent has not recovered the named share itself.

### Agent capabilities the CLI should use directly

- `zrok2 agent start`: launch the persistent agent when no background service is installed.
- `zrok2 agent status`: source of active share/access state for `remote tunnel status`.
- `zrok2 agent console`: operator-only diagnostics UI for a future `remote tunnel console` helper.
- `zrok2 share public ... -n <namespace>:<name>`: create/use the durable public share; when the agent is running, the command delegates to it automatically.
- `zrok2 agent share http-healthcheck <share-token> GET <path> 200`: verify that the agent can actually reach the configured HTTP backend.
### Health model for this project

The agent gives Desktop Commander a better diagnostic surface than process-liveness checks alone. The future `remote tunnel doctor` should layer checks in this order:

1. Direct local check against the control plane on `127.0.0.1:3000`.
2. `zrok2 agent status` confirms that the expected **reserved** share is registered with the agent and points at the expected backend.
3. Agent HTTP health check confirms that the proxy backend is reachable from the share process.
4. External HTTPS check confirms that the stable public origin and OAuth/MCP metadata are reachable from outside the machine.

The zrok HTTP health-check command expects an HTTP verb, path, and expected response code. Do **not** hard-code `GET /mcp -> 200`: this MCP endpoint is POST-oriented in the current RemoteMCP-Jazz control plane. Use a dedicated known-200 health/readiness route when available, or another explicitly configured metadata endpoint whose response semantics are stable.

Failure classification then becomes actionable:

```text
local check fails
  -> repair local control plane; do not mutate zrok identity/share
local check passes + agent healthcheck fails
  -> inspect/restart named share or agent
agent/backend checks pass + public HTTPS fails
  -> zrok/frontend/network incident
agent process absent
  -> restart agent; wait for named share auto-restore
```

The CLI should report the stable public URL independently from current health. "offline" must never imply "generate a new URL".

### Separate internal and public origins

Current `MCPDevice` derives its control-plane API origin from `MCP_SERVER_URL`, defaulting to `http://127.0.0.1:3000`. In a same-machine zrok deployment, keep that internal device traffic on localhost. The public zrok URL is the browser/ChatGPT-facing application and MCP resource origin.

A future integration therefore needs an explicit distinction between **internal control-plane origin** and **public MCP/OAuth origin**. Do not route the local device's registration, heartbeat, claim, or completion calls through the public zrok frontend merely because ChatGPT uses that frontend.
### Agent restart semantics become the primary recovery primitive

The zrok agent overview explicitly distinguishes named and ephemeral shares. A named public share created with `zrok2 share public -n <namespace>:<name>` is automatically restarted after an agent restart. An unnamed public share is not. That means Desktop Commander should treat the reserved name plus agent state as durable tunnel configuration, while the running share process is disposable runtime state.

Recommended recovery ownership:

```text
share child exits, agent alive
  -> let agent restart it first
agent exits
  -> outer macOS supervisor restarts `zrok2 agent start`
  -> agent restores the named share
Desktop Commander restarts
  -> inspect existing agent/share; reuse, do not recreate identity
Mac reboots
  -> LaunchAgent starts zrok agent
  -> named share returns under the same reserved URL
```

The future macOS LaunchAgent should supervise only the zrok agent process. It should not contain zrok enrollment tokens, OAuth credentials, or reserved-name deletion logic. Desktop Commander can own installation/removal of that LaunchAgent as an explicit setup feature, but the stable reserved name must remain independent of whether the LaunchAgent is currently loaded.

Normal `desktop-commander remote` shutdown also must not delete the reserved zrok name. Whether it stops the currently running share should be an explicit product decision; deleting the name is always a separate destructive action requiring confirmation.

### Agent remoting is optional phase 2, not MVP

The zrok agent how-to documents secure, opt-in remoting. `zrok2 agent enroll` authorizes the configured controller (for the hosted example, `https://api-v2.zrok.io`) to send remote agent commands after the agent restarts. The controller API then exposes operations equivalent to share, status, unshare, access/unaccess and HTTP health checks.

Do **not** enroll remoting by default. The local Desktop Commander CLI already has direct access to `zrok2`, so remoting adds no requirement for first-run tunnel creation and introduces a second remote-control credential/surface.
Remoting becomes interesting only as a later **out-of-band repair/control plane**. If the ChatGPT-facing zrok path is broken, an independently authorized service could still ask the zrok controller for `/agent/status`, create/restart/unshare a share, or call `/agent/share/http-healthcheck` without going through the broken MCP endpoint. That can be useful operationally, but it is a separate authority from Desktop Commander MCP.

Requirements if this phase is ever enabled:

- explicit setup command/flag and confirmation; never implicit enrollment;
- keep the agent-remoting credential in OS-protected storage, never repository files;
- never expose the remoting `X-TOKEN`, environment Ziti ID or enrollment material as ChatGPT tool arguments, logs or debug dumps;
- use remoting only for tunnel lifecycle, never as a replacement for Better Auth/OAuth tool authorization;
- support `zrok2 agent unenroll` as the explicit revocation path;
- verify hosted `api-v2.zrok.io` remoting behavior in the actual user account before promising this feature. The controller-identity configuration shown in the zrok how-to applies to controller administration/self-hosting and must not be assumed to be user-configurable on the hosted service.

### Revised CLI lifecycle using the agent

A future first run should converge on state rather than blindly run commands:

1. Confirm the local control plane is healthy.
2. Confirm `zrok2` is available and compatible.
3. Confirm the zrok environment is enabled.
4. Ensure the intended namespace and reserved name exist.
5. Ensure the agent process is running; on macOS, foreground mode is acceptable for the initial spike and a LaunchAgent is the production target.
6. Inspect `zrok2 agent status` before creating anything.
7. If the reserved named share is absent, run the named `zrok2 share public` command and allow automatic delegation to the agent.
8. Capture the actual frontend endpoint and share token/state without logging enrollment secrets.
9. Run local + agent-backend + external public checks.
10. Print the single canonical `https://.../mcp` URL only after all required checks pass.

Later `status`, `doctor`, `restart` and `console` commands should map onto agent status, layered health checks, bounded recovery, and `zrok2 agent console` respectively. Routine repair must never delete/re-reserve the public name.
### Additional acceptance tests specifically for agent integration

Add these tests to the earlier acceptance matrix before implementing the provider:

- Start agent in foreground, create the reserved named public share, then verify `zrok2 agent status` reports it as reserved and points to the expected local backend.
- Kill only the named share child while leaving the agent alive; verify the agent restores the same named share and the exact public URL returns.
- Restart the entire zrok agent; verify the named public share is rehydrated automatically without issuing a create-name operation and without changing ChatGPT settings.
- Kill the local control plane; verify agent HTTP health check reports backend failure while the reserved identity remains unchanged. Restart the control plane and verify health returns without re-reserving.
- Simultaneously restart Desktop Commander and the zrok agent; prove there is still one logical named share and no competing restart loop or duplicate tunnel identity.
- Reboot macOS with the proposed LaunchAgent; prove agent startup plus named-share restoration is automatic.
- Verify `remote tunnel status` can distinguish agent running/share absent/backend unhealthy/public frontend unreachable.
- Verify normal Desktop Commander shutdown/restart does not delete the reserved name.
- If optional agent remoting is prototyped, test it on a secondary throwaway share first: enroll, query `/agent/status`, run remote HTTP health check, remove the test share, unenroll, and confirm remote control no longer works.

### Revised implementation order

1. Manual foreground `zrok2 agent start` + reserved public share spike.
2. Prove agent delegation and automatic named-share restart semantics.
3. Add layered local/agent/public health diagnostics to the spike.
4. Prove ChatGPT OAuth + Streamable HTTP MCP through the stable reserved endpoint.
5. Design macOS LaunchAgent ownership for the agent process and test reboot recovery.
6. Only then design the `TunnelProvider` / `ZrokTunnelProvider` / supervisor code boundary around `runRemote()`.
7. Keep optional zrok agent remoting as an isolated phase-2 experiment after the local-agent implementation is green.
8. Run the full RemoteMCP-Jazz security/failure matrix before advertising zrok support.
### WebMCP / Helium research record

This update was researched through the user's working `webmcp` CLI connected to Helium/Chrome DevTools MCP. `webmcp status` confirmed the daemon is running with page-ID routing and the experimental WebMCP category enabled. The zrok documentation itself exposed no page-level WebMCP tools, so the research correctly fell back through `webmcp raw` to Chrome DevTools page snapshots/evaluation while staying inside the WebMCP-first workflow.

Pages verified in-browser:

- https://netfoundry.io/docs/zrok/how-tos/agent/
- https://netfoundry.io/docs/zrok/concepts/agent/
- https://netfoundry.io/docs/zrok/how-tos/agent/manage-shares/
- https://netfoundry.io/docs/zrok/how-tos/agent/enable-agent-remoting/
- https://netfoundry.io/docs/zrok/how-tos/agent/configure-http-healthcheck/

Key source-derived facts used above are: one persistent agent process, automatic CLI delegation while the agent runs, automatic restart of **named** shares but not ephemeral shares, `zrok2 agent status`, `zrok2 agent console`, proxy-backend HTTP health checks, and explicit opt-in agent remoting with enroll/unenroll lifecycle.

For the first Desktop Commander implementation, the decision remains: **local agent + reserved named public share is MVP; agent remoting is optional later infrastructure.**
## Detailed execution backlog — tasks, subtasks, files, and snippets

This backlog is the implementation companion to the zrok research above. It assumes the common `TunnelProvider` contract from the Tailscale plan so both transports share orchestration, tests, status shape, and lifecycle semantics.

### Task Z1 — establish common tunnel primitives first

**Status: implemented.**

**Files shared with both providers:** `src/remote-device/tunnel/types.ts`, `tunnel-provider.ts`, `tunnel-supervisor.ts`, `command-runner.ts`, `src/npm-scripts/remote-options.ts`.

Subtasks:

- Z1.1 Implement the common `TunnelProvider` interface before any zrok-specific logic.
- Z1.2 Keep provider state serializable and non-secret: provider name, stable public URL, health, last error, local target.
- Z1.3 Copy the single-flight/backoff pattern from `reconnect-supervisor.ts` rather than inventing another concurrency model.
- Z1.4 Add `test/test-tunnel-provider-contract.js` and make both Tailscale and zrok providers satisfy the same behavioral tests.
- Z1.5 Do not add tunnel dependencies to `MCPDevice.handleNewToolCall()`.

Example shared state:

```ts
export type TunnelState = {
  provider: 'tailscale' | 'zrok';
  publicMcpUrl: string;
  healthy: boolean;
  localTarget: string;
  detail?: string;
};
```
### Task Z2 — implement a zrok v2 CLI adapter

**Status: implemented; live CLI output compatibility remains acceptance-gated.**

**Files:** new `src/remote-device/tunnel/zrok-cli.ts`, shared `command-runner.ts`, new `test/test-zrok-cli.js`.

Subtasks:

- Z2.1 Verify `zrok2` exists and reject legacy `zrok` v1 command paths.
- Z2.2 Add structured wrappers for `list namespaces`, `list names`, `create name`, `agent status`, `agent start`, and named `share public`.
- Z2.3 Parse machine-readable output where available; isolate human-output parsing behind one adapter method.
- Z2.4 Never pass enable/enrollment tokens through debug logs or persisted repo configuration.
- Z2.5 Add command timeouts and safe stderr redaction.

Example adapter surface:

```ts
export class ZrokCli {
  listNamespaces(): Promise<NamespaceInfo[]>;
  listNames(): Promise<ReservedNameInfo[]>;
  createName(namespace: string, name: string): Promise<void>;
  agentStatus(): Promise<AgentStatus>;
  startAgent(): Promise<ManagedProcess>;
  sharePublic(target: string, reserved: string): Promise<ShareInfo>;
}
```

Unit-test rule: all zrok commands are stubbed; no test may reserve/delete a real public name unless `DC_TUNNEL_E2E=1`.
### Task Z3 — reserve and persist one stable public name

**Status: implemented.**

**Files:** new `src/remote-device/tunnel/zrok-name-store.ts`, `zrok-tunnel-provider.ts`, new `test/test-zrok-name-store.js`.

Subtasks:

- Z3.1 Pick a deterministic local installation identifier but let the user approve/change the public name before first reservation.
- Z3.2 Reuse an existing namespace/name when it is already bound to this installation.
- Z3.3 Persist only non-secret identity metadata: namespace, reserved name, discovered public base URL, and local target.
- Z3.4 Store metadata under a user-owned config directory, not the repository; enforce mode `0600` for the file and `0700` for its directory.
- Z3.5 Never delete/recreate the name during `start()`, `restart()`, agent recovery, or normal shutdown.
- Z3.6 Put destructive deletion behind `remote tunnel delete-name --confirm` and separate tests.

Example metadata:

```json
{
  "provider": "zrok",
  "namespace": "public",
  "name": "desktop-commander-tests-mba",
  "publicBaseUrl": "https://desktop-commander-tests-mba.share.zrok.io",
  "localTarget": "http://127.0.0.1:3000"
}
```

Acceptance: restarting Desktop Commander ten times must never invoke `create name` more than once for the same installation.
### Task Z4 — implement `ZrokTunnelProvider` around the agent

**Status: implemented; live agent/share recovery remains acceptance-gated.**

**Files:** new `src/remote-device/tunnel/zrok-tunnel-provider.ts`, new `test/test-zrok-tunnel-provider.js`.

Subtasks:

- Z4.1 `start()` must first verify `http://127.0.0.1:3000` is healthy.
- Z4.2 Ensure the reserved name exists before starting/delegating the share.
- Z4.3 Ensure the agent is running; inspect `zrok2 agent status` before creating another share.
- Z4.4 Start only the named share `http://127.0.0.1:3000 -> <namespace>:<name>` and capture the actual frontend URL.
- Z4.5 `status()` must classify agent-down, share-absent, backend-unhealthy, public-frontend-unreachable, and healthy.
- Z4.6 `restart()` must prefer agent/share recovery and never delete/re-reserve the name.
- Z4.7 `stop()` must not delete the reserved name; whether it stops the share is an explicit provider option.

Example core path:

```ts
async start() {
  await assertLocalControlPlane(this.localTarget);
  const identity = await this.names.ensureReservedName();
  await this.ensureAgentRunning();
  const current = await this.cli.agentStatus();
  if (!hasNamedShare(current, identity)) await this.cli.sharePublic(this.localTarget, `${identity.namespace}:${identity.name}`);
  const publicBaseUrl = await this.discoverPublicUrl(identity);
  return { provider: 'zrok', publicMcpUrl: `${publicBaseUrl}/mcp`, healthy: true, localTarget: this.localTarget };
}
```
### Task Z5 — add layered doctor/status diagnostics

**Status: implemented.**

**Files:** new `src/remote-device/tunnel/tunnel-health.ts`, `zrok-tunnel-provider.ts`, new `test/test-zrok-doctor.js`.

Subtasks:

- Z5.1 Check local control-plane reachability first.
- Z5.2 Read `zrok2 agent status` and verify the expected reserved share exists.
- Z5.3 Run the agent HTTP health check against a known-200 readiness/metadata path, not `GET /mcp`.
- Z5.4 Probe the external public OAuth/resource metadata endpoint over HTTPS.
- Z5.5 Return structured checks so CLI output can distinguish local, agent, share-backend, and public-front-end failures.

Example doctor result:

```json
{
  "ok": false,
  "checks": [
    { "name": "local-control-plane", "ok": true },
    { "name": "zrok-agent", "ok": true },
    { "name": "named-share", "ok": true },
    { "name": "share-backend", "ok": false, "detail": "HTTP health check failed" },
    { "name": "public-oauth-metadata", "ok": false }
  ]
}
```

CLI rule: `remote tunnel status` is observational; `remote tunnel doctor` may probe, but neither command may reserve/delete names or enroll remoting.
### Task Z6 — macOS agent supervision and ownership

**Status: implemented for the runtime-generated plist; live launchd behavior remains acceptance-gated.**

**Files:** `src/remote-device/tunnel/macos-launch-agent.ts`; the runtime-generated plist is the single source of truth. The old unused template was removed.

Subtasks:

- Z6.1 Treat `zrok2 agent start` as the one long-lived process the LaunchAgent supervises.
- Z6.2 Install the plist only through an explicit setup action; do not silently modify login services during a normal remote run.
- Z6.3 Keep enrollment tokens, OAuth secrets, and reserved-name deletion commands out of the plist.
- Z6.4 On unload/remove, stop only the agent service; preserve the reserved public name unless the user separately requests destructive cleanup.
- Z6.5 After agent restart, wait for the named share to reappear before declaring the tunnel healthy.
- Z6.6 Test idempotent install/update/remove behavior without requiring a real zrok account.

Example template shape:

```xml
<key>Label</key><string>io.desktopcommander.zrok-agent</string>
<key>ProgramArguments</key>
<array><string>/absolute/path/to/zrok2</string><string>agent</string><string>start</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
```

Acceptance: reboot/login restores the agent and the same named share without any create-name operation.
### Task Z7 — expose operator CLI commands and compose them with remote mode

**Status: implemented.**

**Files:** `src/npm-scripts/remote.ts`, `src/npm-scripts/remote-options.ts`, new `src/remote-device/tunnel/create-tunnel-provider.ts`, optionally new `src/npm-scripts/remote-tunnel.ts`, new `test/test-zrok-remote-cli.js`.

Subtasks:

- Z7.1 Support `desktop-commander remote --tunnel zrok` without changing existing remote behavior when the flag is absent.
- Z7.2 Add non-destructive operator verbs: `remote tunnel status`, `doctor`, `restart`, `console`, and `disable`.
- Z7.3 Keep destructive `delete-name` separate, explicit, and confirmation-gated.
- Z7.4 Parse arguments once in `remote-options.ts`; providers must receive typed options instead of inspecting `process.argv`.
- Z7.5 Print exactly one canonical ChatGPT MCP URL after the provider is healthy.
- Z7.6 On provider startup failure, do not start or advertise an externally reachable remote mode as healthy.

Example factory/composition:

```ts
export function createTunnelProvider(name: 'tailscale' | 'zrok'): TunnelProvider {
  if (name === 'zrok') return new ZrokTunnelProvider();
  return new TailscaleTunnelProvider();
}

const opts = parseRemoteOptions();
const tunnel = opts.tunnel ? createTunnelProvider(opts.tunnel) : undefined;
const state = tunnel ? await tunnel.start() : undefined;
const device = new MCPDevice({ persistSession: opts.persistSession });
await device.start();
if (state) console.log(`ChatGPT MCP URL: ${state.publicMcpUrl}`);
```
### Task Z8 — provider tests, Nix gate, and real ChatGPT acceptance

**Status: unit/gate scaffolding implemented; real external acceptance is pending.**

**Files:** new `test/test-zrok-cli.js`, `test/test-zrok-name-store.js`, `test/test-zrok-tunnel-provider.js`, `test/test-zrok-doctor.js`, `test/test-zrok-launch-agent.js`, new `test/integration/zrok-remote-mcp-e2e.js`, new `docs/ZROK-CHATGPT-RUNBOOK.md`, `Justfile`.

Subtasks:

- Z8.1 Unit-test every provider path with a stubbed command runner; unit tests must not mutate a real zrok account.
- Z8.2 Test idempotent start/restart and assert the same reserved name/public URL is reused.
- Z8.3 Test agent death, named-share death, backend death, public-network failure, and simultaneous recovery without duplicate shares.
- Z8.4 Run provider tests together with `test-remote-jazz-safety.js` and `test-remote-device-supervision.js` under `nix develop`.
- Z8.5 Gate real external tests behind `DC_TUNNEL_E2E=1` and require an explicitly provisioned test name/account.
- Z8.6 Configure ChatGPT once with the stable zrok `/mcp` URL and run `list_devices`, `__control.ping`, `get_config`, and `printf 'zrok-agent-ok\n'` through `start_process`.
- Z8.7 Restart the named share, kill/restart the agent, reboot macOS, and change networks; the ChatGPT URL must remain unchanged.
- Z8.8 Revoke OAuth/device access and prove the old session cannot cause a local side effect.

Example Nix gate:

```bash
nix develop -c sh -lc '
  npm run build &&
  node test/test-tunnel-provider-contract.js &&
  node test/test-zrok-cli.js && node test/test-zrok-name-store.js &&
  node test/test-zrok-tunnel-provider.js && node test/test-zrok-doctor.js &&
  node test/test-zrok-launch-agent.js &&
  node test/test-remote-jazz-safety.js && node test/test-remote-device-supervision.js &&
  npm test
'
```
### Task Z9 — optional zrok agent remoting as phase 2

**Status: deferred; intentionally not shipped in the MVP.**

**Files (future phase 2 only):** `src/remote-device/tunnel/zrok-remoting.ts`, `test/test-zrok-remoting.js`, and `docs/ZROK-AGENT-REMOTING-SECURITY.md`. None is shipped by the MVP.

Subtasks:

- Z9.1 Keep remoting disabled by default and completely unnecessary for the MVP public MCP path.
- Z9.2 Add explicit `remote tunnel remoting enroll` / `unenroll` commands only after Z1–Z8 are accepted.
- Z9.3 Store remoting credentials in the OS credential vault or another dedicated secret store, never in the reserved-name metadata file.
- Z9.4 Restrict remoting operations to tunnel repair/status; do not expose arbitrary Desktop Commander tool execution through the remoting credential.
- Z9.5 Treat remoting as a separate authority from ChatGPT OAuth/Jazz device authorization and document its revocation path independently.
- Z9.6 Test enrollment, controller-unreachable failure, credential revocation, unenrollment, and local fallback without leaking tokens.
- Z9.7 Add audit events for enroll/unenroll/remote repair while redacting credential material.

Example boundary:

```ts
export interface ZrokRemotingControl {
  enroll(): Promise<void>;
  status(): Promise<{ enrolled: boolean; reachable: boolean }>;
  restartNamedShare(): Promise<void>; // repair only
  unenroll(): Promise<void>;
}
```

Explicit non-goal: `ZrokRemotingControl` must never contain `callTool`, `runCommand`, `readFile`, or another general-purpose local execution method.
## Proposed implementation file map and dependency order

Expected provider-specific files after implementation (shared files are listed in Z1):

```text
src/npm-scripts/remote.ts
src/npm-scripts/remote-options.ts
src/remote-device/tunnel/
  zrok-cli.ts
  zrok-name-store.ts
  zrok-tunnel-provider.ts
  tunnel-health.ts
  macos-launch-agent.ts
  # zrok agent remoting is deferred until phase 2 security work
test/
  test-zrok-cli.js
  test-zrok-name-store.js
  test-zrok-tunnel-provider.js
  test-zrok-doctor.js
  test-zrok-launch-agent.js
  # test-zrok-remoting.js is deferred with phase 2 remoting
  integration/zrok-remote-mcp-e2e.js
docs/ZROK-CHATGPT-RUNBOOK.md
docs/ZROK-AGENT-REMOTING-SECURITY.md
```

Dependency order: **Z1 → Z2 → Z3 → Z4 → Z5 → Z6 → Z7 → Z8**, then optional **Z9**. Do not make agent remoting a prerequisite for ChatGPT MCP or for stable named-share recovery.
