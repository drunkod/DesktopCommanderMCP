# Static tunnel -> ChatGPT -> home-laptop MCP architecture options

Status: corrected research and architecture suggestions only; no implementation contract

Date: 2026-09-08

Scope: expose Desktop Commander from one home laptop to ChatGPT through one durable HTTPS MCP URL, while minimizing recurring infrastructure cost and avoiding unnecessary hosted application infrastructure. This revision incorporates a second CodeGraph audit and a second external-source verification pass and focuses only on the user-selected public-tunnel alternatives.

## Executive recommendation

For the one-owner, one-home-laptop journey, do **not** reproduce the full Jazz/device-routing architecture unless multi-device routing, offline queuing, central presence, or centralized revocation is a real requirement.

The preferred proof architecture is:

```text
ChatGPT custom MCP app
        -> one durable HTTPS hostname
        -> public outbound tunnel
        -> authenticated loopback-only MCP HTTP adapter
        -> explicit remote tool/policy gate
        -> existing Desktop Commander stdio MCP child
        -> local filesystem/process/tool execution
```

The first proof should use **Method A: an authenticated Streamable HTTP-to-stdio MCP adapter**. CodeGraph confirms that this checkout has a mature stdio MCP path and an existing MCP-client-to-stdio-child bridge pattern, but no production MCP Streamable HTTP listener was found in the indexed source. A sidecar therefore minimizes initial code disruption while still requiring real MCP transport handling; it must not be a raw HTTP wrapper around stdin/stdout.

Before selecting a tunnel, make two decisions:

1. **ChatGPT capability gate.** Current ChatGPT documentation says full custom MCP including write/modify actions is available to Business and Enterprise/Edu; Pro custom MCP access is currently read/fetch. Workspace permissions also govern app creation and deployment. Verify the actual account/workspace first.
2. **Hostname ownership gate.** If “configure ChatGPT once and keep exactly the same URL for years, even if the tunnel provider changes” is a hard requirement, use a domain/hostname you control from day one. A provider-assigned Tailscale, zrok, or ngrok hostname can be stable across laptop restarts but does not give provider-independent URL ownership.

For the lowest-cost provider choices:

- **Tailscale Funnel:** strong first experiment because provider code already exists in this checkout. Current Tailscale docs say Funnel is available on all plans; Personal is $0 for non-commercial home use. Funnel is public, beta, uses the tailnet `*.ts.net` identity, supports only 443/8443/10000, and has non-configurable bandwidth limits.
- **zrok v2:** credible $0 alternative when using a **reserved name**; reserved names persist across share sessions. The hosted free tier has bandwidth/request limits and custom-domain entitlement is separate.
- **ngrok Free:** legitimate low-volume alternative; each account gets a stable auto-assigned development hostname. Its browser warning is documented as not affecting programmatic API traffic, though browser-based OAuth must still be tested.
- **Cloudflare Named Tunnel + owned domain:** strongest choice when long-term hostname ownership matters. Named-tunnel DNS remains configured while the origin is offline. For a low-cost setup, the normal path is to place the domain on Cloudflare authoritative DNS; partial/CNAME zone setup is a Business/Enterprise feature.

A static address is not static availability. If the Mac sleeps, shuts down, loses connectivity, or the local gateway is stopped, the same URL can remain configured but calls cannot execute until the laptop is reachable again.

## Desired user journey

1. The home laptop starts the loopback MCP gateway and Desktop Commander child.
2. The tunnel daemon reconnects outbound using saved provider identity.
3. The same public hostname becomes reachable again.
4. The user configures the ChatGPT custom MCP app once with `https://fixed-host.example/mcp`.
5. The user completes the selected standards-compatible authentication flow.
6. ChatGPT sends authenticated MCP calls to the same hostname.
7. The tunnel forwards only to the loopback gateway; no router port-forward or public home IP is required.
8. The gateway authenticates the caller, enforces the remote tool/policy profile, then invokes Desktop Commander.
9. Tool execution and source files remain on the laptop, but **selected tool arguments and results can leave the laptop and be sent to ChatGPT**. Tunnel-provider visibility depends on the provider/TLS termination model.
10. Wi-Fi, NAT, and public-IP changes do not require ChatGPT reconfiguration while the selected public identity is preserved.

Offline queued remote execution is a different product requirement. It requires an external durable relay/queue and reintroduces hosted coordination plus claim/replay semantics.

## Architecture diagrams

The diagrams are stored separately in `docs/architecture/`:

- `STATIC-TUNNEL-DIRECT-MCP.mmd`
- `STATIC-TUNNEL-STDIO-SIDECAR.mmd`
- `STATIC-TUNNEL-CLOUDFLARE.mmd`
- `STATIC-TUNNEL-TAILSCALE-ZROK.mmd`
- `STATIC-TUNNEL-IMPLEMENTATION-CHOICES.mmd`
- `STATIC-TUNNEL-BOOT-AND-CALL-SEQUENCE.mmd`

## CodeGraph findings

### Current index

The current DesktopCommanderMCP CodeGraph index was up to date during this revision: **245 files, 4,065 nodes, and 11,564 edges**.

### Existing local execution path

`src/index.ts` is the canonical local entry point. Outside the `remote` subcommand it creates `FilteredStdioServerTransport` and calls `server.connect(transport)`.

```text
local MCP client
  -> stdio
  -> src/index.ts
  -> FilteredStdioServerTransport
  -> src/server.ts handlers/tools
  -> local OS/filesystem/processes
```

No production symbol named `StreamableHTTP` and no production MCP HTTP listener were found in the indexed checkout. This is a scoped CodeGraph absence finding, not proof about generated code or another repository.

### Existing stdio bridge pattern

`src/remote-device/desktop-commander-integration.ts` is useful precedent, not a ready-made sidecar. It creates an MCP `Client`, uses `StdioClientTransport`, starts the local build or a globally installed `desktop-commander`, proxies tool listing/calls, and supervises child disconnect/restart.

Important qualifications:

- it does not provide HTTP authentication, HTTP session/principal isolation, or Streamable HTTP cancellation mapping;
- its global fallback may execute a globally installed version rather than this checkout;
- debug logging currently includes a serialized argument preview for tool calls.

### Existing remote delivery path

The current remote architecture is:

```text
ChatGPT-facing control plane -> Jazz pending call -> RemoteChannel -> MCPDevice
    -> central claim -> local stdio Desktop Commander child -> central completion
```

`src/remote-device/control-plane-client.ts` exposes `register`, `getJazzToken`, `heartbeat`, `claim`, and `complete`. Those operations are useful for cross-network device routing, presence, durable coordination, and duplicate-execution control. They are not intrinsically necessary when one authenticated HTTP request terminates on the same single laptop that is the sole executor.

### Control-plane ownership is a separate workspace

Method C must not be described as functionality already contained in this repository. The current ownership split is:

| Responsibility | Current location |
| --- | --- |
| Desktop Commander stdio server/tools | this `DesktopCommanderMCP` repository |
| Device OAuth client and device credential handling | this repository |
| Tunnel providers and OAuth metadata **health checks** | this repository |
| Better Auth authority and passkey configuration | separate `implementation/apps/control-plane` workspace |
| Authorization database | separate control-plane workspace |
| Protected-resource metadata response | separate control-plane workspace |
| Protected MCP HTTP handler | separate control-plane workspace |
| Jazz call routing/pending-call orchestration | separate control-plane workspace + this device runtime |

The verified control-plane handler is under `app/api/mcp/route.ts`; the inspected source alone does not establish how a deployment maps a public `/mcp` path to it. Direct local dispatch without Jazz is **proposed refactoring across workspaces**, not a current mode.

### Existing tunnel providers are not drop-in transport-only adapters

The Tailscale/zrok provider code is valuable, but its current health profile is coupled to the existing remote OAuth/device model. The provider health path defaults to `/.well-known/oauth-protected-resource/mcp`, and public health requires protected-resource and authorization-server metadata. The current checker expects the exact configured resource/issuer and the scope profile including `mcp:tools` and `device:sync`.

A simpler single-owner sidecar without `device:sync` can therefore be healthy as a tunnel while failing the current application health profile. Reuse requires one of:

- satisfy the existing OAuth/device profile; or
- separate **transport health** from **application/OAuth health** before reusing provider orchestration.

### Existing local policy is not a remote sandbox

The current tool server contains useful safety controls, but the second CodeGraph audit did not establish an immutable remote authorization boundary or a per-call human approval gate inside the stdio dispatch path.

Material issues for remote exposure include:

- allowed-directory policy can be configured broadly;
- process execution has capabilities outside filesystem-path policy;
- `set_config_value` can mutate editable policy fields such as allowed directories and blocked commands;
- a new sidecar becomes the MCP client, so host-side confirmations from another local MCP host are not automatically inherited.

For remote mode, define an explicit **remote tool allowlist** and keep security-policy administration local-only. If shell/process confinement is required, use OS/process isolation rather than treating a command blocklist as a sandbox.

### Existing logging/history needs a remote-mode audit

“Sanitize HTTP logs” is insufficient. Current code paths can retain or emit sensitive payloads:

- `ToolHistory.addCall()` stores arguments and outputs and queues them for disk;
- output size capping is not content redaction;
- `DesktopCommanderIntegration` logs an argument preview in debug mode;
- configuration/debug/console paths can emit data beyond the sidecar's access logs.

The remote design must audit child history, debug output, stderr, telemetry/capture, and forwarded MCP notifications—not only tunnel/HTTP logging.

## MCP transport compatibility

The latest MCP specification is **2026-07-28**. Its transport model distinguishes:

- stdio: newline-delimited MCP messages over a client-launched subprocess;
- Streamable HTTP: each MCP message is an HTTP POST to a single MCP endpoint, with a JSON reply or request-scoped SSE stream;
- cancellation: transport-specific abandonment semantics differ between stdio and HTTP.

The 2026-07-28 protocol also moves toward per-request metadata/stateless handling, while older protocol revisions use connection/session behavior. Therefore Method A must use a real MCP SDK/transport adapter, inspect the protocol version actually negotiated by ChatGPT, and implement the required backward-compatibility behavior. Do not translate requests by treating stdin/stdout as an arbitrary HTTP body stream.

## Implementation method A — authenticated HTTP-to-stdio MCP sidecar

**Recommended first proof.**

```text
ChatGPT
  -> stable public tunnel
  -> loopback Streamable HTTP MCP sidecar
  -> authentication + remote tool allowlist/policy gate
  -> MCP Client + StdioClientTransport
  -> existing Desktop Commander child
```

Advantages:

- least disruption to the mature stdio tool server;
- uses a bridge pattern already demonstrated in this codebase;
- isolates the experiment from the existing remote/Jazz pipeline;
- easy to discard if ChatGPT/tunnel compatibility fails.

Required work before exposing powerful tools:

- implement standards-correct Streamable HTTP behavior and version negotiation;
- authenticate before tool discovery/invocation;
- define a remote-safe tool allowlist;
- block remote mutation of security-policy settings unless explicitly designed;
- decide whether shell/process tools are remotely available;
- audit child history/logging/notifications;
- map HTTP cancellation/disconnect to stdio semantics without unsafe retries;
- pin/verify which Desktop Commander executable is spawned.

The existing stdio server may remain behaviorally unchanged for an initial **harmless-tool transport spike**, but “unchanged child” is not evidence that production remote-security requirements are satisfied.

## Implementation method B — native Streamable HTTP adapter

**Recommended long-term runtime if remote access becomes a first-class mode.**

```text
ChatGPT -> tunnel -> authenticated Streamable HTTP adapter -> shared Desktop Commander tool core
```

Advantages: one transport lifecycle, fewer processes, less serialization, and a clearer home for HTTP limits/auth/policy/cancellation. Cost: a larger refactor to separate tool registration/application state from stdio/global startup, plus broader regression testing.

Keep stdio as the default local adapter. Add HTTP as an explicit remote-edge adapter rather than replacing local stdio.

## Implementation method C — refactor the separate local control plane for direct dispatch

This is attractive only if the Better Auth/passkey/OAuth work in `implementation/apps/control-plane` is worth retaining.

Proposed target:

```text
ChatGPT -> tunnel -> separate control-plane OAuth/resource endpoint
        -> authenticated direct local execution bridge
        -> Desktop Commander
```

This would reuse the separate control-plane application's Better Auth/passkey/browser authorization work and protected-resource metadata while replacing its current Jazz pending-call dispatch for the single-laptop mode.

Benefits:

- preserves standards-compatible OAuth and existing browser/passkey investment;
- removes Jazz availability, heartbeat, and same-machine claim/completion from the direct live path;
- keeps a path to later central identity if desired.

Trade-offs:

- it is cross-workspace refactoring, not a feature already present here;
- current Jazz routing/liveness/durable-call guarantees disappear unless deliberately retained where needed;
- destructive-call crash/idempotency rules still apply;
- public `/mcp` routing and transport-session behavior must be verified rather than inferred from the current `/api/mcp` source route.

## Implementation method D — retain the current OAuth + Jazz + remote-device architecture

Use this when the product needs multiple independently addressable devices, queued delivery, central presence, centralized revocation, server-side audit independent of the laptop, or a committed hosted account/service model.

For one owner and one home laptop, it has the most moving parts and weakest cost/complexity ratio. Existing code alone is not a reason to keep it in the live request path.

## Tunnel/provider comparison

| Edge | Stable identity | Minimum infrastructure cost | Strengths | Important qualifications |
| --- | --- | ---: | --- | --- |
| Tailscale Funnel | Tailscale node/tailnet `*.ts.net` name | $0 Personal for non-commercial home use | Existing provider code; outbound/public TLS ingress; no router setup | Public; beta; 443/8443/10000 only; non-configurable bandwidth limits; Tailscale-owned hostname; macOS packaging/capability needs live preflight |
| zrok v2 | Reserved `namespace:name` | $0 hosted free tier | Existing provider code; reserved identity persists between share sessions | Hosted limits/interstitial policy must be tested; reserved name is not equivalent to free custom-domain ownership |
| ngrok Free | Auto-assigned account Dev Domain | $0 Free tier | Stable account-assigned hostname; fast setup; documented API traffic is not blocked by browser warning | Free quotas; cannot choose the free hostname; browser OAuth path still needs testing; custom domain is paid |
| Cloudflare Named Tunnel | Owned hostname -> named tunnel UUID | Tunnel available on all plans; domain cost if needed | Provider-independent human-facing hostname; outbound-only; DNS record persists while tunnel is down | Low-cost setup normally uses Cloudflare authoritative DNS; partial/CNAME zone setup is Business/Enterprise; streaming/long-running MCP behavior still needs real-client validation |
| Small VPS reverse edge | Domain you own | VPS + domain | Maximum application-layer control | Highest operations burden: patching, TLS, firewall, monitoring, availability |

### Provider decision rule

If the exact URL only needs to survive **laptop/tunnel restarts**, Tailscale Funnel, zrok reserved names, ngrok Dev Domain, and an owned Cloudflare hostname are all candidates subject to their limits.

If the exact URL must survive a **future tunnel-provider migration**, use a hostname/domain you control from the beginning. Migrating later from `*.ts.net`, zrok, or ngrok to `mcp.example.com` changes ChatGPT configuration and can also change OAuth issuer/resource identity and passkey RP assumptions.

## Authentication ownership

A public tunnel is transport, not application authorization. Desktop Commander exposes filesystem/process capabilities, so a public no-auth MCP endpoint is not acceptable.

Two practical authentication paths are:

1. **Reuse/refactor the separate Better Auth control plane** (Method C), with exact issuer/resource/scope validation and refresh-token support.
2. **Build a smaller standards-compatible single-owner OAuth authority** if the broad account/device product is unnecessary.

Do not invent an ad-hoc long-lived shared bearer token solely because there is one owner. ChatGPT compatibility, revocation, browser security, and stable refresh behavior are easier to reason about with supported OAuth conventions.

For an always-configured ChatGPT app, verify refresh-token support (`offline_access` or provider equivalent) before acceptance; otherwise reauthentication may be required after access-token expiry.

## Remote security profile

Before exposing Desktop Commander through any public tunnel:

- bind the local gateway to literal loopback only;
- authenticate before tool listing and invocation;
- use a **remote-specific tool allowlist**, initially harmless/read-only;
- keep security-policy configuration local-only unless a separate admin authority is designed;
- treat process/shell execution as a separate high-risk capability decision;
- validate MCP protocol version, content types, request sizes, `Origin`, and `Host` as appropriate;
- set explicit deadlines and bounded concurrency;
- audit history/debug/stderr/telemetry/notifications for sensitive arguments/results;
- never log authorization headers, refresh tokens, passkey material, or secret-bearing tool data;
- preserve useful local validation such as path/symlink checks, but do not call it a sandbox;
- use OS-level confinement if a real containment boundary is required;
- propagate cancellation, but never treat disconnect as proof a side effect did not happen.

For non-idempotent writes, a lost HTTP response can create an uncertain outcome. If retry safety is required, use a small local operation/idempotency ledger keyed by authenticated principal + idempotency key/request hash. Never automatically replay an uncertain destructive operation merely because a lease or connection expired.

## Stable identity rules

Treat the public URL as configuration identity. Never automatically rename/reset a Tailscale node, switch tailnets, delete/recreate a zrok reserved name, replace a Cloudflare Named Tunnel with a Quick Tunnel URL, or generate a new public origin merely because the laptop was offline.

Persist only the provider metadata needed to recover the same identity. Keep tunnel credentials and OAuth secrets in provider stores or the OS credential vault, never in repository files.

## Failure and lifecycle semantics

| Event | Required behavior |
| --- | --- |
| Laptop reboot | gateway and tunnel restart; same public URL recovers |
| Wi-Fi/public-IP change | outbound tunnel reconnects; URL unchanged |
| Laptop sleep/offline | URL remains configured; calls fail/unavailable until wake |
| Sidecar/stdio child crash | fail current call safely; recover later calls without changing public identity |
| Tunnel crash | reconnect with saved identity; do not mint a replacement hostname |
| OAuth access expires | refresh if valid; otherwise reauthorize at the same issuer/resource |
| Provider identity deleted externally | report identity loss/drift; do not silently create a new ChatGPT URL |
| Destructive call disconnects mid-flight | reconcile or mark indeterminate; never blind-retry |

For macOS production operation, use per-user service supervision for components that need it. Never embed secrets in LaunchAgent plist files.

## Recommended implementation sequence

### Gate 0 — verify the actual ChatGPT product capability

Before any tunnel work, verify the account/workspace can create the required custom MCP app and whether the desired tool set is read-only or includes writes. Full write/modify acceptance currently requires Business or Enterprise/Edu; Pro is currently read/fetch for custom MCP.

### Gate 1 — freeze hostname strategy

Decide whether a provider-owned stable hostname is sufficient or whether the product requires an owned domain from day one. Do this before freezing OAuth issuer/resource/passkey identity.

### Phase 1 — harmless authenticated Method A transport spike

Build an experimental loopback Streamable HTTP-to-stdio adapter outside the existing tool implementation. Expose only a tiny harmless/read-only allowlist. Prove ChatGPT authentication, tool scan, one read call, protocol negotiation, cancellation, restart, and exact URL recovery through the chosen tunnel.

Do **not** begin with `start_process`, configuration mutation, arbitrary filesystem write, or other high-impact tools.

### Phase 2 — security/logging gate

Audit remote tool policy, policy mutation, child history, debug/stderr, notifications, telemetry/capture, and executable pinning. Decide explicitly whether process/shell tools can ever be remote. Add real OS confinement if containment is a requirement.

### Phase 3 — adapt tunnel health boundaries

If reusing the current Tailscale/zrok provider code, separate provider/transport health from the current OAuth/device profile unless the sidecar intentionally implements the same `mcp:tools` + `device:sync` resource contract.

### Phase 4 — choose product runtime

After the sidecar is proven:

- choose **Method B** for a compact native runtime and fewer process boundaries; or
- choose **Method C** if retaining the separate Better Auth/passkey control plane provides enough value to justify cross-workspace refactoring.

Retain **Method D** only when durable multi-device coordination is truly required.

### Phase 5 — expand remote capability cautiously

Add write/process tools only after the actual ChatGPT plan supports them and after uncertain-write, revocation, policy, and logging tests are green. ChatGPT may ask for confirmation based on permissions/context, but the architecture must not depend on a confirmation appearing for every call.

## What not to build for the one-laptop MVP

- no Jazz subscription solely to forward a live request back to the same laptop;
- no global device registry for one executor;
- no heartbeat database unless a remote UI requires presence;
- no central claim/completion protocol solely for symmetry;
- no router port-forwarding;
- no Cloudflare Quick Tunnel or zrok ephemeral share for a persistent ChatGPT configuration;
- no public no-auth MCP endpoint;
- no automatic tunnel identity regeneration;
- no assumption that existing provider health checks are transport-only;
- no assumption that current Desktop Commander policy/logging is already safe for public remote use;
- no promise of offline execution while the only executor is asleep/disconnected.

## Acceptance matrix

Run acceptance with the real ChatGPT client and a disposable workspace.

1. Verify account/workspace eligibility for the intended MCP capabilities.
2. Configure ChatGPT once with the chosen `/mcp` URL.
3. Complete authentication and scan/list the allowed tools.
4. Run a harmless read-only tool.
5. Confirm disallowed tools, including remote policy mutation, are not available/callable.
6. Restart Desktop Commander; same URL works.
7. Restart the HTTP adapter; same URL works.
8. Restart the tunnel agent; same URL works.
9. Change Wi-Fi/network; same URL works after reconnect.
10. Reboot the Mac; same URL recovers without editing ChatGPT configuration.
11. Sleep/wake the Mac; calls fail safely while offline and recover at the same URL.
12. Revoke OAuth/ChatGPT authorization; stale credentials cannot cause a local side effect.
13. Kill the stdio child during an in-flight request; failure is bounded and later calls recover without unsafe replay.
14. Inspect history/debug/stderr/notifications/telemetry and process arguments for sensitive data leakage.
15. Verify current tunnel provider health can distinguish transport health from application/OAuth health.
16. Only when the plan/security profile allows writes: run one approved disposable write, disconnect at crash boundaries, and prove uncertain execution is never blindly replayed.
17. Delete/rename the tunnel identity in a controlled test; runtime reports identity loss rather than silently issuing another public URL.

## Decision table

| Requirement | Preferred choice |
| --- | --- |
| Least-disruptive transport proof | Method A + a verified low-cost tunnel |
| Existing tunnel provider code matters most | Method A + Tailscale Funnel or zrok, after health-profile adaptation |
| Lowest-volume simple stable assigned hostname | Method A + ngrok Free is a valid experiment |
| One owned hostname intended to remain unchanged for years | Named tunnel/edge behind a domain you control from day one |
| Preserve existing Better Auth/passkey investment | Method C, explicitly as cross-workspace refactoring |
| Fewer runtime processes after proof | Method B |
| Multi-device routing/offline queue/global presence | Method D |

## Suggested decision for this project

1. Verify ChatGPT plan/workspace capability first.
2. If “same URL forever” includes provider migration, choose an owned hostname now; otherwise Tailscale Funnel is the fastest repo-aligned experiment and zrok/ngrok are viable alternatives.
3. Prototype Method A with a **real authenticated Streamable HTTP MCP adapter** and a tiny harmless remote allowlist.
4. Do not reuse the existing tunnel providers unchanged; adapt/separate their OAuth/device health profile as needed.
5. Audit policy mutation and all child logging/history before exposing powerful tools.
6. After real ChatGPT acceptance, choose Method B or Method C based on whether the separate control-plane investment is worth keeping.
7. Keep Jazz only for requirements that actually need durable cross-device coordination.

This sequence minimizes both recurring infrastructure cost and irreversible engineering work without treating a tunnel hostname as the security boundary.

## Repository evidence used

DesktopCommanderMCP:

- `src/index.ts`
- `src/server.ts`
- `src/remote-device/desktop-commander-integration.ts`
- `src/remote-device/device.ts`
- `src/remote-device/remote-channel.ts`
- `src/remote-device/control-plane-client.ts`
- `src/remote-device/tunnel/create-tunnel-provider.ts`
- `src/remote-device/tunnel/tailscale-tunnel-provider.ts`
- `src/remote-device/tunnel/zrok-tunnel-provider.ts`
- `src/remote-device/tunnel/tunnel-health.ts`
- `src/utils/toolHistory.ts`
- configuration/filesystem/process tool paths inspected through CodeGraph

Separate control plane:

- `implementation/apps/control-plane/lib/auth.ts`
- `implementation/apps/control-plane/lib/auth-db.ts`
- `implementation/apps/control-plane/lib/protected-resource-metadata.ts`
- `implementation/apps/control-plane/app/api/mcp/route.ts`
- current call-router/Jazz paths inspected through CodeGraph

## External sources verified on 2026-09-08

- OpenAI Help, *Developer mode and MCP apps in ChatGPT*: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- MCP specification, latest transport overview (2026-07-28): https://modelcontextprotocol.io/specification/latest/basic/transports
- MCP 2026-07-28 release material and TypeScript SDK migration notes: https://blog.modelcontextprotocol.io/posts/2026-07-28-release/ and https://modelcontextprotocol.io/docs/sdk/migrate-to-v2
- Tailscale Funnel: https://tailscale.com/kb/1223/funnel
- Tailscale pricing: https://tailscale.com/pricing
- zrok pricing: https://zrok.io/pricing/
- zrok v2 names: https://netfoundry.io/docs/zrok/how-tos/shares/manage-reserved-names
- zrok custom domains: https://netfoundry.io/docs/zrok/myzrok/custom-domains
- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Cloudflare Tunnel DNS: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/
- Cloudflare partial/CNAME zone setup: https://developers.cloudflare.com/dns/zone-setups/partial-setup/
- Cloudflare Quick Tunnel limitations: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- ngrok domains: https://ngrok.com/docs/domains/
- ngrok free limits/interstitial behavior: https://ngrok.com/docs/pricing-limits/free-plan-limits/

## Non-goals and limits

This document changes no source, tests, dependencies, configuration, tunnel account, OAuth state, ChatGPT configuration, or OS service. It proposes implementation boundaries and acceptance gates only.

CodeGraph absence findings are scoped to indexed source. The separate `implementation` index reported pending changes, so cross-workspace ownership was verified from CodeGraph's current on-disk source output rather than treated as a clean-index snapshot.

No live ChatGPT/tunnel interoperability test was performed as part of this research. Provider documentation can establish naming/cost/transport properties, but it cannot prove the exact ChatGPT protocol, streaming, OAuth-browser, sleep/reconnect, or long-running-call behavior for this application.
