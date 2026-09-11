# Single-Mac MCP and family chat: architecture and core tasks

Date: 2026-09-08. Status: **planning only; not implemented or deployment-approved**.

Read [README.md](README.md) for the task index and delivery gates. This document fixes the shared architecture for the UI, queue, and security/operations task packs. In a conflict with earlier research, this pack's explicit contracts take precedence for the proposed implementation; earlier documents remain unchanged historical evidence.

## 1. Product contract

- One owner-operated MacBook hosts every application-owned service and persistent store.
- Approximately 15 invited family members use a browser chat UI.
- The ChatGPT custom app registers `https://stable-host.example/mcp`.
- The family opens `https://stable-host.example/chat`: **same origin, sibling path**, never `/mcp/chat`.
- Existing `/api/auth/...` and OAuth metadata remain on that origin. The configured issuer can include its existing `/api/auth` path; an origin, an issuer, and an MCP resource are distinct identifiers.
- No VPS, hosted Next.js deployment, hosted Jazz authority, hosted SQL, Supabase, Redis, or cloud queue is required.
- Local HTTP services still exist. “No cloud application server” or “single host” is accurate; “no server processes” is not.
- The tunnel is an external transport dependency. Remote browsers and a selected remote model are outside the Mac. Content sent to ChatGPT/model APIs leaves the Mac; local execution does not mean that all data stays local.
- Laptop sleep, logout where a LaunchAgent stops, shutdown, internet loss, or storage failure can make both routes unavailable. A durable hostname is not an availability guarantee.
- OpenAI Secure MCP Tunnel is excluded. Do not install, test, or recommend it in this work.
- This branch creates documentation only. Application source changes need a later implementation step in the correct repositories.

## 2. Workspace ownership and evidence

| Alias | Absolute root | Responsibility |
| --- | --- | --- |
| DC | `/Users/test/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP` | This plan; existing device worker, stdio tools, tunnel providers and native credential store |
| IMPL | `/Users/test/Documents/RemoteMCP-Jazz/implementation` | Shared protocol and control-plane application; separate Git worktree/repository |
| CP | `IMPL/apps/control-plane` | Existing Next.js/Better Auth/Jazz/MCP HTTP service; future `/chat` and authenticated chat APIs |
| REF | `/Users/test/Documents/RemoteMCP-Jazz/references/jazz-auth-betterauth-chat` | Read-only sparse upstream reference, not production application code |

The new DC branch does **not** branch IMPL or REF. Before later implementation, inspect their Git state and obtain the appropriate branch/worktree plan without moving their unrelated work.

CodeGraph evidence from current source:

| Observed file | What it establishes | What it does not establish |
| --- | --- | --- |
| DC `src/index.ts` | Default stdio server path; explicit remote mode | A production HTTP MCP listener in DC |
| DC `src/remote-device/desktop-commander-integration.ts:59–109,153–196,206–247` | MCP Client and stdio child bridge; local-build/global fallback; tool forwarding | Remote family ACL, approval isolation, safe logging, or a pinned child build |
| DC `src/remote-device/control-plane-client.ts:150–183` | Literal-loopback internal origin; device register/token/heartbeat/claim/complete routes | Public inaccessibility of those routes if the whole listener is tunneled |
| DC `src/remote-device/remote-identity.ts:37–89` | Separate canonical issuer, exact `/mcp` resource, literal-loopback internal API origin | Automatic safe hostname or passkey migration |
| DC `src/npm-scripts/remote.ts:35–49` | Tunnel target and private control-plane origin are separate settings | A tested public path allowlist |
| CP `app/mcp/route.ts`, `app/api/mcp/route.ts` | Canonical MCP route re-export and protected handler in the separate application | Chat workflow-only grants or family queue tools |
| CP `lib/auth-db.ts:15–31` | Local `node:sqlite`, foreign keys, WAL, busy timeout | Multi-database transactions with Jazz or power-loss-safe backups by copying a live `.db` |
| CP `lib/auth-plugins.ts:23–29,64–89,92–127,139–159` | Current scopes, OAuth/passkey configuration, RP ID/origin and MCP plugin | New worker-specific token purpose or family grants already implemented |
| CP `lib/jazz-principal.ts:4–6` | Privileged backend handle; explicit caller ownership requirement | Row-level authorization automatically protecting privileged backend reads |
| CP `lib/call-router.ts:19–45,72–115` | Owner-only dispatch, durable idempotency pattern | Shared-device family authorization or general exactly-once effects |
| CP `scripts/jazz-authority.ts`; IMPL `packages/protocol/src/application-schema.ts` | Local persistent authority and existing devices/remoteCalls/audit schema | Chat schema/migrations or proven concurrent chat queue semantics |

The reference lacks a CodeGraph index. It was inspected read-only without creating an index. Its verified SHA, license, actual versions, and port exclusions are documented in [02-REFERENCE-AND-UI-TASKS.md](02-REFERENCE-AND-UI-TASKS.md). Broad IMPL CodeGraph queries sometimes return stale generated bundles; those are not the version baseline.

## 3. Selected local topology

The original research exposes all of Next.js at port 3000 while calling `/api/device/*` private. Those statements require an additional enforcement boundary. A tunnel to a loopback port publishes the routes served on that port; forwarded request headers do not prove local origin.

**Proposed production default:** a small local ingress/router with an explicit public method/path allowlist. It uses a reviewed HTTP proxy implementation or an existing suitable local reverse proxy, not an ad-hoc parser. Final package/config selection is CORE-02/OPS-01 work, not an assumed installed dependency.

```text
Family browser                             ChatGPT custom app
     | /chat + /api/chat/...                    | /mcp
     +-------------------+----------------------+
                         |
                One durable HTTPS origin
                         |
                 Outbound tunnel relay
                         |
             127.0.0.1:3000 local ingress
              exact public route allowlist
                         |
              127.0.0.1:3001 existing Next.js
                 /chat /mcp /api/auth/...
                  |                  |
             Auth SQLite        local queue coordinator
                                      |
                           Unix socket, owner-only directory
                                      |
                        local Jazz authority 127.0.0.1:1625
                                      |
                             MCPDevice / RemoteChannel
                                      |
                          DesktopCommanderIntegration
                                      |
                           Desktop Commander stdio child
```

- Port numbers are **proposed**, not current-state claims. Keep the external tunnel target `127.0.0.1:3000`; move/configure Next's backend port deliberately.
- The device calls Next's private listener at `http://127.0.0.1:3001`, not the public ingress. The already-separate `MCP_SERVER_URL` supports the identity distinction; integration testing remains required.
- **Current CLI mismatch:** `desktop-commander remote tunnel prepare` currently prints `MCP_SERVER_URL=<provider localTarget>`. In this topology the provider `localTarget` is the ingress (`127.0.0.1:3000`), while `MCP_SERVER_URL` must be the private Next origin (`127.0.0.1:3001`). Do not copy the current prepare output unchanged; CORE-02/OPS-01 must split these settings and add a regression test.
- The public ingress does not forward `/api/device/*`, `/api/mcp`, raw Jazz synchronization, debug, bootstrap, or administrative backend APIs. Device APIs still require proper device credentials even over loopback.
- The queue coordinator is a single independently supervised local writer using a private Unix socket, not an in-process Next.js singleton. All authoritative chat mutations and related delegation transitions pass through it. Existing unrelated remote operation behavior must be regression-tested.
- Next verifies browser/OAuth identity. The private coordinator accepts only authenticated local service traffic and a validated principal context, not arbitrary browser-provided subjects. Protect the socket directory and protocol; do not expose it through the public router.
- Both browser and ChatGPT see only the public origin. No public `ws://127.0.0.1:1625`, Jazz backend secret, or native credential is sent to clients.
- Local malware/another process under the same owner account is outside this network-isolation guarantee. Address OS access, FileVault, device lock and account separation in SEC-04.

A route-separated internal listener within the application can replace the small ingress only if it proves equivalent isolation and proxy/TLS behavior. Do not silently fall back to tunneling every route. This extra local process is justified by an actual boundary, not by a desire to build more infrastructure.

Diagrams: [architecture.mmd](architecture.mmd), [job-sequence.mmd](job-sequence.mmd).

## 4. Public route and transport contract

| Surface | Public behavior | Authentication/limits |
| --- | --- | --- |
| `/chat` and approved child navigation | Family UI, no unauthenticated transcript | Existing browser sign-in; server-side session/ACL |
| Explicit static asset routes, e.g. required `/_next/static/` assets | Necessary application assets only | No source maps, development endpoints, or private payload cache |
| `/sign-in`, `/consent`, required passkey/device-approval browser pages | Existing browser ceremonies | Exact routes reviewed from current auth flows; no wildcard administrative UI |
| `/api/auth/...` | Required existing auth protocol routes only | Plugin session/CSRF/PKCE/redirect validation; method inventory, not blindly every future auth action |
| Required `/.well-known/...` and JWKS paths | OAuth/resource/key discovery | Public metadata only; exact immutable issuer/resource |
| `/mcp` | Canonical Streamable HTTP MCP | Bearer resource/audience/scope/grant validation on each request; origin validation where supplied |
| `/api/chat/conversations` | Authorized bounded list/create operations | Browser session; CSRF for mutations; no family-wide private transcript dump |
| `/api/chat/conversations/:id` | Authorized snapshot with consistent event cursor | `no-store`, ACL, bounded history |
| `/api/chat/conversations/:id/messages` | POST one idempotent human turn | 16 KiB UTF-8 message bound; current engine consent; 202 only after durable commit |
| `/api/chat/conversations/:id/events?after=...` | GET SSE, or bounded JSON pages by negotiated `Accept` | Same ACL; durable cursor replay; session/grant revocation throughout stream |
| Explicit chat receipt/cancel/approval routes | Reconciliation and human decisions | Strict operation IDs and object ownership; no implicit resubmission |
| `/api/device/*`, `/api/mcp`, Jazz/debug/bootstrap routes | Denied at public ingress | Private Next/device credentials as a separate access path |
| Unknown routes/methods | Denied by default | Normalize/reject ambiguous paths before proxying |

The inventory is a contract, not an exhaustive ready-to-paste proxy configuration. CORE-01 must enumerate actual auth/discovery/browser routes so OAuth device approval is not accidentally blocked while its private execution APIs stay blocked. MCP GET/POST/DELETE behavior must match the pinned SDK/client revision; do not indiscriminately expose HTTP methods or emulate transport with custom JSON parsing.

**SSE distinction:** browser `/api/chat` event streaming is ordinary authenticated SSE. MCP uses the pinned Streamable HTTP binding, which may itself return request-scoped SSE. Neither is a reason to create the legacy separate MCP SSE transport or a 25-minute open request.

## 5. Browser reference integration decision

Use REF's `ChatPanel` as the main presentation/composer reference. Do not clone a second chat platform or introduce assistant-ui as a prerequisite.

The reference actually uses browser Jazz hooks, direct row writes, a Jazz auth adapter and demo bootstrap. The target deliberately retains SQLite-backed Better Auth and server-owned Jazz writes. Thus this is a **presentation-pattern port with API adaptation**, not a drop-in copy.

The family UI has a quiet notebook-like layout: conversation list, readable timeline, composer, and a persistent visibility/engine/status header. A clear “Shared family room” or “Private conversation” label matters more than decorative chat chrome. Local licensed assets and existing app conventions are preferred; no external font/tracking dependency is required.

## 6. Persistence and model contracts

Canonical names in the proposed domain:

| Record | Purpose |
| --- | --- |
| `families`, `familyMembers`, `deviceGrants` | Membership, sharing and least-privilege policy; Better Auth IDs remain identity source |
| `conversations` and explicit conversation membership | Private/shared trust boundary and serialized turn lane |
| `chatMessages` | Human/assistant visible messages; bounded content and retention |
| `chatJobs` | Engine-neutral reasoning work, immutable requester/context/consent binding |
| `workerSessions` | Hard 25-minute maximum for the experiment, immutable conversation/domain pin |
| `chatJobEvents` | Durable ordered state changes and replay cursor |
| Admission/completion/approval/effect receipts | Deduplication, precise human authorization, audit and recovery |
| Existing `remoteCalls` | Concrete device effects, never the chat queue itself |

Earlier research names `messages`, `agentSessions`, and `chatEvents` map conceptually to `chatMessages`, `workerSessions`, and `chatJobEvents`; do not create duplicate tables for the aliases. Whether receipts need standalone tables is finalized during QUEUE-01 schema review.

- Better Auth remains the identity authority in SQLite; Jazz stores application relationships and chat state.
- There is no assumed atomic SQLite+Jazz transaction. Use staged/idempotent account-to-family provisioning and fail-closed reconciliation (SEC-01).
- A Jazz transaction must be accepted at the configured local authority before dependent work executes. The API's `global` tier describes that authority tier, not a cloud requirement.
- A successful HTTP response is not proof of exactly-once OS effects. Lost device results and cancellation can be indeterminate.
- Job states are `queued`, `running`, `cancel_requested`, `blocked`, `completed`, `failed`, `cancelled`, `indeterminate`. `waiting_for_worker` and `awaiting_approval` are UI projections; offline describes connection health, not durable success/failure.
- One active turn per conversation and initially one model job globally. A family of 15 is not a requirement for 15 concurrent models/subprocesses.

## 7. AI engines and release ordering

| Engine | Application process location | External dependency | Release posture |
| --- | --- | --- | --- |
| Deterministic fake worker | Mac | None | Required test fixture, never presented as real AI |
| ChatGPT MCP worker | Reasoning in an explicitly started ChatGPT conversation; local queue/tools | ChatGPT plan, supported MCP permissions, active model turns | First real-engine experiment, workflow-only credentials, synthetic/shared-room data first |
| Local-model adapter | Mac | Initial model download; no external inference once provisioned | Optional after queue proof; hardware/load/quality gate |
| Model-API adapter | Orchestration on Mac, inference external | Separate API credential, usage billing and data sharing | Optional, explicit opt-in; not paid for by a ChatGPT subscription by implication |
| Hybrid | Same local queue, authorized adapter choices | As selected | Deferred until recovery and consent rules pass |

A ChatGPT worker cannot be woken by Jazz itself or used as a guaranteed autonomous background worker. The owner's ChatGPT conversation cannot safely serve unrelated private family threads just because a server query filters each job: model context and account memory may persist. Pin one approved model context to one app conversation/trust domain; private use requires an adequate isolation story or a different adapter.

A chat request does not grant the owner worker's OS permissions to its requester. Effective privileges are an intersection of requester, conversation, device grant, job grant, worker grant, and local device policy. Raw direct tool APIs must not bypass the workflow restriction.

The current research loop names are refined into bounded family-prefixed tools in QUEUE-04. Renewal cannot extend a session indefinitely. Waiting for a job returns within 10 seconds; processing a tool uses a durable effect ID plus separate status reads.

## CORE-01 — Freeze origin, public routes, and client eligibility

Dependencies: none. Priority: P0. Future owners: CP routing/configuration and DC deployment configuration.

- [ ] Confirm a durable hostname choice, acceptable provider dependency, hostname ownership, and any domain cost before enrolling passkeys or registering the ChatGPT app.
- [ ] Record the selected origin, exact existing issuer, exact `/mcp` resource, passkey RP ID, OAuth redirect policy and private listener identity as separate fields.
- [ ] Verify the real ChatGPT account/plan/workspace supports required MCP tools and app creation. Recheck current vendor guidance; do not infer write access from an active personal subscription.
- [ ] Inventory current `/mcp`, compatibility alias, metadata/JWKS, sign-in, consent, passkey, device-approval and callback routes using CodeGraph. Record method and authentication policy per route.
- [ ] Specify and test ingress allowlisting, proxy host/protocol handling, redirect behavior and method filtering. Do not use `X-Forwarded-For`, Host, or a request body to prove internal device origin.
- [ ] Configure one immutable external origin and a separate private Next origin. Browser absolute links derive only from the configured origin; browser relative navigation uses `/chat`.
- [ ] Deny public raw Jazz, `/api/device/*`, `/api/mcp`, debug/bootstrap and unapproved admin routes, including encoded/double-encoded traversal, slash normalization, redirects and upgrade attempts.
- [ ] Verify ordinary MCP authentication errors remain protocol responses, not browser HTML redirects. Cookie-auth UI/API errors and OAuth bearer errors have distinct contracts.
- [ ] Agree that static identity is preserved on network/reboot recovery, but name deletion/reassignment is explicit migration. No automatic origin reset during failure.
- [ ] Choose local-only privacy behavior: server data remains local at rest, selected remote-model context leaves it, and no external model runs without an approved engine authorization.

### Example: derive the sibling chat URL from a canonical registered MCP URL

This is a standalone illustrative validation function using standard URL APIs, not an existing export. It intentionally accepts only production HTTPS and the exact current resource path.

```ts
export function chatUrlFromMcpResource(resource: string): string {
  const url = new URL(resource);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/mcp" || url.search || url.hash ||
      resource !== `${url.origin}/mcp`) {
    throw new Error("Expected the configured canonical HTTPS /mcp resource");
  }
  return new URL("/chat", url.origin).href;
}

// https://stable-host.example/mcp -> https://stable-host.example/chat
// Reject /mcp/chat, query/fragment secrets, userinfo and noncanonical inputs.
// This computes navigation; it does not establish that a hostname is trusted.
```

**Done when:** the operator can name one immutable public identity and demonstrate the route policy from a second device using a harmless fixture. Unknown ChatGPT eligibility or publicly reachable device APIs block later live-family gates.

## CORE-02 — Freeze versions, repository boundaries, and executable contract evidence

Dependencies: none; coordinate CORE-01. Priority: P0. Future owners: IMPL/CP and DC maintainers.

- [ ] Record both application Git SHAs, dirty-state provenance, lockfile hashes, actual resolved dependency versions, Node version and architecture. Do not commit unrelated pre-existing changes as part of the chat plan.
- [ ] Verify CP's Next/React versions from manifests and lockfiles, not only the earlier Next 15/React 19 prose. The reference uses Next 16.2.11 and Jazz workspace alpha.54, while the target inspected Jazz pin is alpha.53. Do not auto-upgrade to match the reference.
- [ ] Record protocol schema/permission artifacts and the exact local Jazz authority/runtime version. Resolve workspace/catalog dependencies deliberately; never copy REF's `package.json` into CP.
- [ ] Check DC's MCP client SDK against CP's server SDK and the actual ChatGPT transport revision. Pin compatibility tests for initialization/version metadata, tools/list, structured errors, cancellation, response framing, reconnect and required auth discovery.
- [ ] Verify existing scripts/test runners before writing executable commands into the later implementation runbook; this plan's new module paths are proposals, not installed scripts.
- [ ] Enumerate new APIs/types with runtime schemas and versioned DTOs. Agree wire field names, receipts, limits, status projections, engine authorization and event cursors across UI/QUEUE/SEC.
- [ ] Choose a reviewed local ingress implementation and a private coordinator transport; keep dependencies minimal and account for macOS packaging/supervision. Avoid introducing an entire hosted chat stack.
- [ ] Require persistent absolute local auth/Jazz paths outside build outputs and repository directories; disable ephemeral memory fallback in the production profile.
- [ ] Pin the launched DC child to the intended build. Existing global fallback is convenient for development but unacceptable as silent production drift after a missing local build.
- [ ] Rehearse migration/permission deployment on copied data, including incompatible-version refusal and additive schema/backfill behavior. Obtain verified Jazz transaction/authority semantics through QUEUE-01 tests.
- [ ] Preserve third-party license notices for source copied from REF. No demo credentials, seeded users, example anonymous permissions or additional auth adapter is copied.
- [ ] Produce a reproducible compatibility record listing observed results and unresolved gates; installed code and mocked tests are not a claim of live ChatGPT success.

**Done when:** versions, shared contracts, data ownership and build identity are pinned, the reference port is bounded, and the smallest local test harness can exercise the real selected runtime without contacting a hosted Jazz/database service.

## 8. Explicitly deferred work

- Hosted multi-region availability, external durable queues, multi-host failover and cross-device routing products.
- Installing a separate complete chat platform or adding assistant-ui before a working port proves a need.
- Attachments/uploads in the first thin slice; later work needs scanning, size/type limits, path policy, storage retention and explicit model-sharing consent. The queue contract may reserve bounded attachment references without exposing an upload route.
- Broad shell access for family members; adults/children are labels, not automatic capability grants.
- Automatic paid fallback, private-room pooling into one owner ChatGPT thread, and infinite worker renewal.
- Model-generated approvals, background browser automation to keep ChatGPT alive, and unverified claims of guaranteed 25-minute runs.
- Cloud deployment or standalone sidecar rewrite of the existing CP stack. This product deliberately retains local Jazz because it now needs durable chat state and two different queues.
