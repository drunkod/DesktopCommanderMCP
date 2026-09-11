# Service overview and implementation status report

**Review date:** 2026-09-11
**Scope:** `DesktopCommanderMCP` + `/Users/test/Documents/RemoteMCP-Jazz/implementation`
**Purpose:** explain what the service gives a user today, how it is structured, what is implemented, and what remains for the full family-chat product.

## 1. Review method and confidence

This report is based on the current on-disk worktrees, not only earlier plans. Both repositories were indexed and synchronized with CodeGraph before the review.

- `DesktopCommanderMCP`: 244 indexed files, 4,049 symbols, 11,530 graph edges.
- `implementation`: 279 indexed files, 7,395 symbols, 47,361 graph edges.
- Core paths reviewed: MCP server, worker queue, Better Auth/OAuth/passkeys, Jazz schema/permissions/authority, durable remote-call router, device APIs, `MCPDevice`, `RemoteChannel`, OAuth token handling, Tailscale/zrok providers, launchd runtime, tests and acceptance evidence.
- Both worktrees contain substantial pre-existing staged/unstaged/untracked work. This review does not reset, stage, commit, stash or rewrite runtime code.

Status vocabulary used below:

- **Accepted** — implemented and exercised in the current real-client acceptance path.
- **Implemented** — present in code and covered by local/integration tests, but not necessarily part of the final real-client acceptance run.
- **Partial / MVP** — works for the private MVP but deliberately lacks full-release security or product behavior.
- **Planned** — documented/design work exists, but the product feature is not implemented end to end.

## 2. Executive summary

The project turns a Mac running Desktop Commander into a remotely reachable MCP service that can be used from ChatGPT while keeping application-owned execution and durable state on the Mac.

The current private MVP has two useful capabilities:

1. **Remote computer access through Desktop Commander.** The control plane can route authenticated MCP calls to a paired Mac, where Desktop Commander performs file, terminal, process, search and document operations under the local user's OS permissions.
2. **A durable 25-minute reasoning worker.** ChatGPT can open one fixed worker lease, read queued tasks, atomically claim them, reason about them, save results to Jazz, continue polling through idle periods, and stop when the original deadline expires.

The final normal-Chat acceptance run proved the hardened worker path `wait_for_task -> claim_task -> save_task_result` for the full 1500-second window. Tasks injected at minutes 0, 6, 15 and 24 were persisted as `153`, `133`, `12` and `42`; the queue ended with no queued/running/failed work and no replacement worker session.

The MVP is deliberately **not** the full household product. There is no `/chat` UI, no family membership/ACL model, no requester-scoped device delegation, no workflow-only OAuth scope, and no hardened public/private ingress split yet.

### What a user gets today

A technically capable owner can run the service on a Mac, expose `/mcp` through the configured tunnel, connect ChatGPT with OAuth, use the queue worker for bounded reasoning jobs, and invoke the owner's paired Desktop Commander device tools remotely.

The user does **not** yet get a family web chat, multiple private user identities, household permissions, approval UX, or production-grade isolation between a queue worker and broad owner/device powers.

## 3. Codebase structure

The service is split across two repositories/workspaces with distinct responsibilities.

| Area | Current responsibility | Key files |
| --- | --- | --- |
| Desktop Commander core | Local MCP tools for terminal, processes, filesystem, search, config, Excel/PDF/DOCX and editing | `src/index.ts`, `src/tools/**`, `src/utils/files/**` |
| Remote device runtime | Pair the Mac, hold OAuth credentials, subscribe to Jazz calls, claim before execution, invoke local Desktop Commander, report results | `src/remote-device/device.ts`, `remote-channel.ts`, `control-plane-client.ts` |
| Tunnel runtime | Establish/check a public HTTPS identity and protect against target/identity drift | `src/remote-device/tunnel/**`, `src/npm-scripts/remote.ts` |
| Public control plane | Next.js routes for MCP, OAuth/passkeys, device APIs and operator pages | `implementation/apps/control-plane/app/**` |
| Authentication | Better Auth, passkeys, OAuth Provider, MCP protection, device authorization and CIMD/DCR support | `lib/auth.ts`, `lib/auth-plugins.ts`, `lib/env.ts` |
| Durable application state | Jazz authority plus application schema and permissions | `scripts/jazz-authority.ts`, `packages/protocol/src/application-schema.ts`, `permissions.ts` |
| Reasoning queue | 25-minute sessions, enqueue/read/claim/complete/fail/recovery logic | `lib/worker-queue.ts`, `lib/mcp-server.ts` |
| Device call router | Durable `remoteCalls`, owner checks, heartbeat freshness, idempotency and terminal waiting | `lib/call-router.ts`, `/api/device/**` |
| macOS operations | Start Jazz + production Next and reassert Tailscale Funnel under launchd | `ops/macos/run-local-stack.sh`, installer/LaunchAgent files |

The public MCP resource is the same logical `/mcp` endpoint for queue-worker and owner device tools. This is convenient for the MVP but is also the main privilege-separation problem for the full release.

## 4. Current runtime architecture

Today the deployed MVP runs application-owned services on one MacBook:

- production Next.js control plane on loopback `127.0.0.1:3000`;
- Better Auth using local SQLite;
- local Jazz authority on `127.0.0.1:1625` with persistent authority data;
- a persistent Jazz backend cache for the control-plane process;
- Tailscale Funnel exposing the current public HTTPS origin;
- launchd supervising Jazz + Next and reasserting Funnel after restart;
- optional `MCPDevice` process for remote Desktop Commander execution;
- local Desktop Commander child MCP over stdio.

The current public origin is transport-dependent. Tailscale Funnel works and has passed the current acceptance checks, but its hostname is tied to the current tailnet/node identity. An owned domain is still required if the product contract means the URL must survive provider/tailnet migration.

The main Desktop Commander repository also contains a zrok tunnel provider with reserved-name persistence, health checks, repair/restart logic and macOS agent support. Tailscale is the currently exercised MVP path; zrok is an alternative implementation path, not the canonical live deployment in this report.

For the full hardened topology, the existing plan proposes a public ingress listener on loopback `:3000` and a private Next listener on `:3001`. The tunnel would expose only the ingress allowlist, while `/api/device/*`, raw admin/bootstrap paths and other private surfaces stay unreachable from the Internet.

## 5. User journeys implemented today

### 5.1 Connect ChatGPT to the local service

1. The owner exposes the control plane through the tunnel and configures ChatGPT with the public `/mcp` resource.
2. ChatGPT discovers the protected-resource and authorization-server metadata.
3. The owner authenticates with the Better Auth/passkey flow and grants OAuth access.
4. The MCP request handler verifies issuer, audience, JWKS, resource and scopes before building the tool server for the authenticated subject.

For the private MVP, ChatGPT registration uses an explicit DCR escape hatch because this Mac's proxy/TUN environment made the secure CIMD metadata fetch resolve to a special-use address. The default remains to keep unauthenticated client registration disabled.

### 5.2 Run the 25-minute reasoning worker

1. ChatGPT opens one worker session with a hard 1500-second deadline.
2. `wait_for_task` performs a genuinely read-only long poll.
3. If a job appears, ChatGPT calls `claim_task`; Jazz transactionally changes the row from `queued` to `running`.
4. ChatGPT reasons about the prompt and calls `save_task_result`.
5. The server stores the bounded result in the private Jazz queue row and ChatGPT resumes read-only polling.
6. After the original deadline, the server rejects further worker operation instead of extending or replacing the lease.

This path has been proven with a real normal-Chat 25-minute run and late work at minute 24.

### 5.3 Execute a Desktop Commander tool remotely

1. An authenticated MCP client calls `call_device_tool` or a dedicated control tool.
2. The control plane verifies that the device belongs to the OAuth subject, is not revoked, and has a fresh heartbeat.
3. A durable `remoteCalls` row is inserted in Jazz; optional idempotency keys converge duplicate logical requests.
4. The device sees the pending row through a read-only Jazz subscription.
5. Before any local side effect, the device calls the private control-plane claim API. Failure to claim means no execution.
6. The local Desktop Commander child MCP executes the requested non-control tool.
7. The device reports completion/failure through authenticated HTTP; the control plane persists the terminal state and returns the durable result to the MCP caller.

### 5.4 Recover after local service restart

- launchd owns the Jazz + Next lifecycle;
- the production launcher waits for each local port before continuing;
- the persistent Jazz authority and backend cache preserve queue state;
- integration tests cover two Jazz authority restarts, fresh backend processes and a cold cache;
- a live launchd persistence test proved a queued task and then its completed result survived real stack restarts.

## 6. Implemented feature matrix

| Feature | Status | What is present now |
| --- | --- | --- |
| Canonical public MCP resource | **Accepted** | `/mcp`, protected-resource metadata, OAuth challenge and real ChatGPT connection |
| Better Auth + passkeys | **Implemented** | passkey-only registration/sign-in flow, ES256 JWT/JWKS, consent pages and negative security tests |
| OAuth for ChatGPT | **Accepted / MVP** | `mcp:tools`, `offline_access`, DCR escape hatch for this private deployment; local token lifetime relaxed to 1800s |
| Device OAuth | **Implemented** | RFC-style device authorization, refresh, revocation, token verification and native credential persistence |
| Local Jazz authority | **Accepted** | persistent local server, deployed schema/permissions, production auth mode |
| Persistent control-plane Jazz client | **Accepted** | NAPI persistent backend cache prevents cold-process visibility loss |
| Worker session | **Accepted** | fixed 25-minute lease; deadline never extends |
| Read-only worker polling | **Accepted** | `wait_for_task`, READ/closed-world metadata, no idle heartbeat mutation |
| Atomic task claim | **Accepted** | `claim_task`, deadline recheck, bounded transaction conflict handling and loser reconciliation |
| Durable result write | **Accepted** | `save_task_result`, idempotent closed-world completion with terminal-payload conflict checks |
| Failure recording | **Implemented** | `fail_task` terminal state |
| Queue producer | **Implemented / MVP** | `enqueue_task` MCP tool plus local operator CLI; intended to be replaced by `/chat` admission for normal users |
| Worker status/close | **Implemented** | status and explicit early close tools; status is a write/heartbeat path |
| Restart durability | **Accepted** | queue and completed answers survive Jazz/control-plane restart and cold client cache |

| Feature | Status | What is present now |
| --- | --- | --- |
| macOS supervision | **Accepted** | launchd runner starts Jazz then Next, waits for readiness, reasserts Funnel, restarts pair if a child dies |
| Tailscale Funnel | **Accepted** | current public transport, health checks and stable-within-current-tailnet identity |
| zrok provider | **Implemented** | reserved-name persistence, named shares, health/doctor/repair and macOS agent support |
| Device registration | **Implemented** | authenticated registration binds stable ID, OAuth client, capability list and Jazz device token |
| Device heartbeat/reconnect | **Implemented** | online/offline status, reconnect supervisor and local Desktop Commander child restart backoff |
| Durable remote calls | **Implemented** | pending/executing/terminal rows, idempotent request fingerprinting, subscription-based completion wait |
| Dedicated device controls | **Implemented** | list, ping, reconnect and shutdown MCP tools |
| Generic Desktop Commander bridge | **Implemented / broad owner scope** | `call_device_tool` can invoke non-control local Desktop Commander tools on the caller's paired device |
| Desktop Commander terminal/process tools | **Implemented upstream/core** | start/interact/read/terminate sessions, list/kill processes and REPL/data-analysis workflows |
| Desktop Commander filesystem/search | **Implemented upstream/core** | read/write/list/move/search/metadata/edit operations with configured safety checks |
| Excel/PDF/DOCX handling | **Implemented upstream/core** | native Excel operations, PDF read/write/modify, DOCX outline/XML read/create/edit support |
| Configuration and audit utilities | **Implemented upstream/core** | config get/set, usage statistics, recent tool-call history and local logging |

The Desktop Commander core is much broader than the queue MVP. The remote service does not reimplement those capabilities; it exposes them through the paired-device bridge when the authenticated owner's MCP client invokes device tools.

## 7. Features still planned for the full version

| Planned feature | Why it is needed | Current state |
| --- | --- | --- |
| `/chat` web application | Give family users a normal browser chat instead of configuring ChatGPT MCP directly | **Not implemented**; no `/chat` route exists |
| Conversations + messages | Durable human/assistant timeline, replay and per-conversation context | **Planned**; `chatJobs.conversationId` exists only as a hook |
| Authenticated chat API | Admit messages/jobs through same-origin HTTP instead of exposing Jazz to browsers | **Planned** |
| SSE/poll replay | Realtime replies, reconnect and bounded history | **Planned** |
| Household/family model | Invitations, membership, adult/child roles, revocation | **Planned** |
| Private conversation ACLs | Prevent one family user from reading another user's private jobs/messages | **Planned** |
| Workflow-only OAuth identity | Queue worker should receive only queue/session/result tools | **Planned; current `mcp:tools` is broad owner access** |
| Requester/device-owner separation | A family requester must not be rewritten as the device owner just to pass current checks | **Planned** |
| Device grants/capabilities | Share one Mac with family members while limiting tools, paths and operations | **Planned** |
| Approval workflow | Require explicit approval for sensitive/destructive device effects | **Planned** |
| Durable effect receipts | Separate reasoning job identity from concrete Desktop Commander side effects | **Planned** |
| Cancellation/reconciliation | Handle cancel, late result, uncertain outcome and retry without blind replay | **Partial/planned** |
| Hardened public ingress | Publish only intended `/mcp`, auth and future `/chat` routes | **Planned two-port topology** |
| Owned stable domain | Keep the external address independent of Tailscale tailnet/provider identity | **Planned/optional infrastructure** |
| Backup/restore runbook | Restore Better Auth, Jazz and secrets after disk/device failure | **Partial operations only** |
| 15-user household acceptance | Prove target concurrency and privacy under family load | **Not run** |
| Alternate AI engine | Local LLM or explicit paid model-API worker using the same queue | **Optional planned** |

## 8. Important review findings before the full release

### P0 — privilege separation

The current MCP server registers worker tools and broad device tools in the same server built from the same authenticated subject. A user with `mcp:tools` can see `call_device_tool` alongside the queue worker. This is acceptable only for the private owner MVP.

**Required full-release change:** classify the OAuth client/grant/purpose and build a workflow-only tool surface for the family worker. The worker should receive queue/session/result tools, not generic owner device control.

### P0 — family sharing cannot use the current owner check

`dispatchRemoteCall()` currently requires `device.ownerId === subject`. That correctly protects today's owner-only device, but it means a family requester cannot share the owner's Mac without a new delegation model.

**Required change:** preserve device owner identity, add requester/delegation fields and enforce an explicit `deviceGrant`/capability policy. Do not overwrite `remoteCalls.ownerId` with the family requester merely to make the old check pass.

### P0 — post-effect result-reporting ambiguity

`MCPDevice.handleNewToolCall()` executes the local tool and then awaits durable completion reporting inside one broad `try/catch`. If the local side effect succeeded but the `completed` report fails, the catch path can attempt to report the call as `failed`.

**Required before destructive delegated effects:** separate execution from result-reporting. A successfully executed effect with uncertain acknowledgement must retry the same completion receipt or become `indeterminate`; it must not rerun or be relabeled as a known execution failure.

### P0 — public/private route boundary is not yet implemented

The current launchd MVP points Tailscale Funnel directly at Next on `127.0.0.1:3000`. Route-level OAuth still protects device APIs, but every Next route is on the public HTTP surface.

**Required full-release change:** introduce the planned ingress allowlist and private Next listener. Keep route authentication even after network isolation; the ingress is defense in depth, not a replacement for authorization.

### P1 — current OAuth settings are intentionally relaxed

The private MVP enables unauthenticated DCR locally and sets `OAUTH_ACCESS_TOKEN_EXPIRES_IN=1800` to avoid a connector refresh failure inside the 25-minute test window. The secure/default code path remains 300 seconds and DCR-off.

**Required full-release change:** remove or tightly constrain the DCR escape hatch and re-test normal refresh behavior rather than carrying the MVP relaxation forward by default.

### P1 — tunnel/config split needs cleanup for hardened topology

`desktop-commander remote tunnel prepare` still prints `MCP_SERVER_URL` from the tunnel's local target. That is compatible with today's direct `:3000` MVP, but not with the planned `tunnel -> ingress :3000 -> private Next :3001` split.

**Required change:** separate `tunnelTarget` from `MCP_SERVER_URL` in setup/runtime configuration before adopting the two-port topology.

### P2 — expired session rows need housekeeping

Read-only expiry is deliberate: `wait_for_task` must not mutate the session while polling. Consequently historical rows can retain stored `status=active` after `expiresAt`, even though all admission logic treats them as effectively expired.

**Recommended change:** materialize expired rows in a low-frequency cleanup/recovery path, never in the high-frequency READ poll.

### P2 — legacy worker hints remain in compatibility paths

The preferred protocol is `wait_for_task -> claim_task -> save_task_result`, but compatibility tools `next_task` and `submit_task_answer` remain registered. One `open_task_worker_session` response string still mentions `submit_task_answer` even though the server-level instructions and accepted path prefer `save_task_result`.

**Recommended cleanup:** make every preferred-path hint name `save_task_result`, clearly mark legacy tools deprecated, and eventually hide them from workflow-only clients after compatibility evidence is sufficient.

## 9. Functional catalog from the user's point of view

### Remote AI-to-Mac bridge

The user can connect a remote MCP-capable AI to the owner's Mac and have actions executed locally rather than on a hosted application server. The durable control plane mediates identity, device state and results.

### Local computer operations inherited from Desktop Commander

The paired device can expose Desktop Commander's existing capabilities: terminal commands, interactive REPLs, process/session management, filesystem read/write/move/list/search, targeted text editing, configuration management, Excel workbooks, PDFs, DOCX files, URL reads, metadata inspection and usage/debug information.

These tools execute with the local process user's OS permissions. The project contains guardrails such as allowed-directory checks and command blocklists, but Desktop Commander itself explicitly documents that these are not a security sandbox.

### Queue-based reasoning

The user/operator can place a reasoning task in Jazz and ask ChatGPT to act as a bounded worker. This is useful for decoupling task admission from the model turn: jobs and answers remain durable even if the control plane restarts.

### Device operations

The owner can list paired devices, ping them, request reconnection, request graceful shutdown, or invoke a named non-control Desktop Commander tool through a durable call row.

## 10. Recommended implementation sequence for the full version

### Phase A — freeze and clean the accepted MVP contract

- Keep the accepted `wait_for_task -> claim_task -> save_task_result` protocol stable.
- Materialize expired session rows in cleanup/recovery rather than in `wait_for_task`.
- Remove stale preferred-path hints that mention the compatibility result tool.
- Preserve the current restart/queue/MCP acceptance suite as a regression gate.

**Exit:** the no-chat MVP stays green with no behavior change to the accepted 25-minute path.

### Phase B — add the chat data/API foundation

- Add `families/households`, `familyMembers`, `conversations`, conversation membership, `chatMessages` and ordered `chatJobEvents` or equivalent receipts.
- Keep `chatJobs` as the engine-neutral reasoning queue.
- Implement authenticated same-origin `/api/chat` admission with idempotency keys.
- Implement bounded history and SSE/poll replay; browsers should not connect directly to Jazz.

**Exit:** two synthetic users can create isolated conversations, enqueue jobs through HTTP, receive fake/deterministic replies and survive reconnect/restart.

### Phase C — build the `/chat` UI

- Port only presentation/composer ideas from the Jazz Better Auth chat reference.
- Add authenticated shell, conversation list, message timeline, idempotent composer, worker/waiting status and reconnect UX.
- Do not port the reference's browser Jazz connection or Jazz-backed Better Auth tables.

**Exit:** the browser product works end to end with a fake worker before real AI/device powers are enabled.

### Phase D — create least-privilege worker identity

- Introduce a workflow-only OAuth client/grant/purpose and likely a dedicated scope such as `chat:worker`.
- Build the MCP tool surface from verified client/grant context, not only the user subject.
- Give the worker queue/session/result tools only; keep owner/device/admin tools unavailable even if hidden tools are probed directly.
- Re-run protected-resource metadata, client registration and real ChatGPT acceptance with the restricted connector.

**Exit:** the ChatGPT worker can process chat jobs but cannot call `call_device_tool`, list/control devices, or access admin/bootstrap surfaces.

### Phase E — add household device delegation and approvals

- Preserve `device.ownerId` as the device authorization owner.
- Add requester identity, `deviceGrant`, allowed tools/capabilities/path scopes and parent reasoning-job/effect IDs.
- Add approval receipts for sensitive operations.
- Split Desktop Commander execution success from result-reporting success; use durable completion fingerprints/outbox semantics and `indeterminate` for unresolved outcomes.

**Exit:** one harmless fixture-folder read works for an authorized family requester; unauthorized tools/paths are denied. Only after that add a disposable write with explicit approval.

### Phase F — harden network and operations

- Introduce public ingress `:3000` and private Next `:3001` (or an equivalent route-isolated design).
- Split tunnel target from private `MCP_SERVER_URL` configuration.
- Move to an owned domain if provider-independent URL permanence is required.
- Add backup/restore drills for Better Auth SQLite, Jazz data, backend cache policy and secrets.
- Re-test sleep, reboot, tunnel loss, token refresh and local child-process recovery.

**Exit:** public route inventory is explicit, private device/admin routes are unreachable externally, and restore/reboot evidence is documented.

### Phase G — household acceptance and optional engines

- Run privacy/ACL negative tests across multiple family identities.
- Exercise approximately 15 browser sessions and measure queue/replay behavior before widening concurrency.
- Complete cancellation, late-result reconciliation, backup/restore and audit-log acceptance.
- Optionally add a local-model adapter or explicit paid model-API adapter behind the same `chatJobs` contract.

**Exit:** every full-release security/operations gate has pass/blocked/not-run evidence, and failed required gates prevent enabling the dependent feature.

## 11. Recommended product positioning

### Private MVP today

"Connect ChatGPT to your own Mac through MCP, keep the service and durable queue local, run a bounded 25-minute reasoning worker, and optionally route owner-authorized Desktop Commander tools to the paired Mac."

### Full product after planned work

"A local-first family AI hub: family members use a browser chat at the same stable origin, jobs are queued locally, an approved AI worker reasons over them, and selected Desktop Commander actions run on the household Mac under explicit per-user capabilities and approvals."

The full product should not be marketed as an autonomous always-on ChatGPT backend. The proven behavior is a bounded model/tool turn that can remain active for 25 minutes when ChatGPT continues invoking tools; durable jobs remain for a later worker if the model stops.

## 12. Mermaid diagram index

1. [`diagrams/01-system-context.mmd`](diagrams/01-system-context.mmd) — user-facing system context and local/cloud boundary.
2. [`diagrams/02-runtime-deployment.mmd`](diagrams/02-runtime-deployment.mmd) — current Mac processes and planned private-ingress split.
3. [`diagrams/03-worker-lifecycle.mmd`](diagrams/03-worker-lifecycle.mmd) — accepted 25-minute queue-worker sequence.
4. [`diagrams/04-device-execution.mmd`](diagrams/04-device-execution.mmd) — durable remote Desktop Commander execution path.
5. [`diagrams/05-auth-and-identity.mmd`](diagrams/05-auth-and-identity.mmd) — owner, ChatGPT and device OAuth/Jazz identities.
6. [`diagrams/06-data-model.mmd`](diagrams/06-data-model.mmd) — current Jazz application tables and relationships.
7. [`diagrams/07-roadmap.mmd`](diagrams/07-roadmap.mmd) — implemented MVP to full household release.

## 13. Key source map for the next implementation pass

### Control plane / worker

- `implementation/apps/control-plane/lib/mcp-server.ts` — public MCP tool definitions and safety annotations.
- `implementation/apps/control-plane/lib/worker-queue.ts` — worker leases, read-only polling, claims, completion, recovery and counts.
- `implementation/packages/protocol/src/application-schema.ts` — `devices`, `remoteCalls`, `workerSessions`, `chatJobs`, `auditEvents`.
- `implementation/apps/control-plane/permissions.ts` — Jazz principal access; queue tables are server-owned in the MVP.
- `implementation/apps/control-plane/lib/auth-plugins.ts` — passkeys, OAuth/MCP, device grant, CIMD/DCR, scopes and token lifetime.
- `implementation/apps/control-plane/lib/call-router.ts` — owner-only device authorization and durable remote-call admission.

### Desktop Commander / device

- `src/remote-device/device.ts` — local device lifecycle and execution bridge.
- `src/remote-device/remote-channel.ts` — Jazz subscription, heartbeats, claim/completion HTTP calls.
- `src/remote-device/device-oauth.ts` and `token-manager.ts` — device OAuth/refresh verification.
- `src/remote-device/remote-identity.ts` — canonical public issuer/resource plus literal-loopback private device API origin.
- `src/remote-device/tunnel/tailscale-tunnel-provider.ts` — current provider implementation.
- `src/remote-device/tunnel/zrok-tunnel-provider.ts` — alternative named-tunnel implementation.

### Acceptance/operations

- `implementation/docs/MVP-CHATGPT-ACCEPTANCE.md` — canonical real-Chat acceptance evidence and runbook.
- `implementation/apps/control-plane/scripts/test-worker-queue.ts` — queue/race behavior.
- `implementation/apps/control-plane/scripts/test-worker-mcp.ts` — MCP annotations/transport behavior.
- `implementation/apps/control-plane/scripts/test-worker-restart.ts` — authority restarts and cold-cache persistence.
- `implementation/ops/macos/run-local-stack.sh` — production local runtime under launchd.
