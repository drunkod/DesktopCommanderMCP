# Family chat security, local operations, and acceptance tasks

Status: **docs-only implementation plan**. All checkboxes are future work. No service was installed, no public endpoint was created, and no production test is claimed by this document.

Shared architecture: [01-ARCHITECTURE-AND-CORE-TASKS.md](01-ARCHITECTURE-AND-CORE-TASKS.md). UI: [02-REFERENCE-AND-UI-TASKS.md](02-REFERENCE-AND-UI-TASKS.md). Queue: [03-QUEUE-AND-WORKER-TASKS.md](03-QUEUE-AND-WORKER-TASKS.md).

`CP` means the separate `implementation/apps/control-plane` app, `IMPL` its parent implementation workspace, and `DC` the current DesktopCommanderMCP repository. All target paths described below are implementation proposals unless explicitly identified as existing evidence.

## 1. Threat boundaries and scope

Assets: family transcripts, device files/processes, passkeys and OAuth grants, local auth/Jazz databases, model/API/tunnel credentials, approvals and idempotency evidence.

Untrusted input: public HTTP, family browsers, model-selected tool calls, text/files returned by tools, client-provided IDs/cursors, uploaded content if later enabled, and all forwarded headers not set by the trusted ingress.

Trusted components: local auth verification, authoritative queue/policy services, private device claim/completion boundary, pinned local executor, owner-controlled OS and secret stores. Backend Jazz credentials bypass ordinary row policy and must never cross those boundaries.

The local OS owner can access application data and process memory. “Private conversation” means application access control between family members, **not cryptographic secrecy from the Mac administrator or a chosen model provider**. Document that clearly. A shared macOS user/process is not a per-family-user sandbox.

## 2. Task dependencies

| Task | Dependencies | Deliverable |
| --- | --- | --- |
| SEC-01 Identity, membership, and revocation | CORE-01, CORE-02 | Existing auth reused; explicit family/conversation/worker identity model |
| SEC-02 Effective tool policy and approvals | SEC-01, CORE-02 | Least-privilege delegation, no worker-owner escalation, enforceable tool boundary |
| SEC-03 Public HTTP, logging, and model-output safety | CORE-01, SEC-01 | Protocol/CSRF/limits/redaction rules covering child and ingress |
| SEC-04 Local data/secret ownership and recovery | CORE-02, SEC-01 | Persistent local stores, recovery and privacy contract |
| OPS-01 Local runtime and exclusive coordinator | CORE-01, CORE-02, SEC-03, SEC-04 | Supervised all-local processes and tested public path boundary |
| OPS-02 Tunnel identity and protocol interoperability | OPS-01, CORE-01, SEC-03 | One durable origin, correct streaming/OAuth, no hidden cloud dependency |
| OPS-03 Sleep/restart/backup/rollback drills | OPS-01, OPS-02, QUEUE-06, SEC-04 | Bounded safe outage and recovery with no blind effect replay |
| OPS-04 Integrated release evidence | UI-10, QUEUE-07, SEC-01 through SEC-04, OPS-01 through OPS-03 | Recorded release gates using synthetic data and real client tests |

SEC-01 defines identity contracts before QUEUE-01. QUEUE-01 implements the application schema; identity tasks must not create a circular dependency by requiring an already-complete queue before agreeing the policy model.

## SEC-01 — Existing identity, family enrollment, and authorization

Future touch points: CP existing `lib/auth.ts`, `lib/auth-plugins.ts`, `lib/auth-db.ts`, session accessors and passkey flows; proposed `lib/family-policy.ts`, `lib/chat/principals.ts`; IMPL protocol schema and CP permissions.

### Tasks and subtasks

- [ ] Keep Better Auth's existing SQLite identity/session authority. Do not copy the reference's Jazz auth adapter or anonymous/demo account flow.
- [ ] Use invitation-only family membership. Separate account existence from membership acceptance; an authenticated stranger must not gain access merely by signing in.
- [ ] Define roles `owner`, `adult`, `child`, `guest` as management defaults only; capabilities remain independent grants. Document who can invite/revoke members, create shared rooms, and authorize device access.
- [ ] Provide owner bootstrap/recovery using the existing trusted local ceremony. No published default admin password, automatic first-public-visitor ownership, or model-driven privilege grant.
- [ ] Provision membership with an expiring one-use invitation bound to intended family/role; never accept role/owner status from an untrusted registration payload. Hash invitation secrets and exclude them from request logs.
- [ ] Keep Better Auth `user.id` as human subject. Persist issuer-qualified subject when the boundary can involve more than one issuer; do not use display name, email text, or client-supplied Jazz identity as the principal.
- [ ] Resolve browser identity through the existing server-side session accessor; validate OAuth token issuer, exact resource/audience, expiry, algorithm/JWKS, grant status, client and permitted purpose on MCP calls. Never accept a dashboard/browser token as a device or worker credential.
- [ ] Introduce explicit human, workflow-worker, and device principal classifications. Unknown/ambiguous purpose is denied. A broad owner OAuth token cannot be silently downgraded merely by a model-supplied session field.
- [ ] Establish workflow-only worker authorization for a conversation/domain. Do not issue or reuse unrestricted owner credentials for the queue worker. Apply restrictions to callable handlers, not just `tools/list`.
- [ ] Define private-by-default conversation ACLs. Sharing is an explicit authorized mutation, visible to participants. Membership in the same family/device does not grant all transcript reads.
- [ ] Align service checks and Jazz permissions. Browser/worker/device principals cannot insert or edit trusted queue, receipt, approval, family-role or policy fields directly. Privileged backend queries must apply ACLs before selecting/returning data.
- [ ] Design SQLite-to-Jazz provisioning as idempotent staged work, not an assumed cross-store transaction. Until both identity and membership are valid, deny access. Missing rows do not imply auto-enrollment.
- [ ] On account disable/revocation, check the authoritative auth status and invalidate sessions/grants according to the existing auth contract. On family/device-grant removal, serialize policy changes with job/effect admission and device claims.
- [ ] Stream revocation: close relevant subscriptions and stop new payload emission when authority changes; periodically revalidate session freshness (initial bound 30 seconds) even when no event arrives. Test logout, auth expiry, permission removal and loss of the revocation watcher. A failed validator pauses delivery.
- [ ] Define linearization for revocation: new admissions/claims after the authoritative revocation must fail; a process already executing is subject to tool-specific stop/reconciliation, not a promise of instant rollback.
- [ ] Limit invitation/session enumeration, use non-disclosing object-not-found responses, rate-limit login and enrollment with account/route dimensions, and preserve existing passkey anti-replay/user-verification protections.

### Illustrative principal union

This is a **proposed domain type**, not a JWT parsing implementation. Construct it only after current library-backed authentication and authoritative grant checks; TypeScript casts do not authenticate.

```ts
type Subject = { issuer: string; subject: string };
type RequestPrincipal =
  | { kind: "human"; identity: Subject; sessionId: string }
  | { kind: "worker"; identity: Subject; clientId: string;
      grantId: string; conversationId: string; trustDomainId: string }
  | { kind: "device"; identity: Subject; clientId: string; deviceId: string };

function requireHuman(principal: RequestPrincipal) {
  if (principal.kind !== "human") throw new Error("human_required");
  return principal;
}
```

**Acceptance:** unauthenticated/foreign-family reads denied; forged subjects/roles ignored/rejected; member revocation denies new work and closes streams within the documented bound; old invitation reuse fails; provisioning crashes never activate a half-created membership; the worker cannot call owner/device administrative APIs.

## SEC-02 — Effective capability policy and human approvals

Existing evidence: CP `lib/call-router.ts` currently checks owner equality. DC `src/tools/filesystem.ts` allows broad access with empty/root settings; `src/tools/config.ts` mutates configuration; `src/tools/improved-process-tools.ts` provides process execution. Preserve useful checks, but do not treat them as a family sandbox.

Future touch points: proposed CP `lib/chat/effective-policy.ts`, `lib/chat/approvals.ts`, `lib/chat/device-delegation.ts`; existing CP router/device claim/completion and protocol permissions; focused DC validation/result-reporting changes only where required by QUEUE-05.

### Tasks and subtasks

- [ ] Resolve device owner, requesting family member, worker identity and job identity separately. Never substitute the owner as requester to pass `device.ownerId === subject`.
- [ ] Compute permissions as an intersection: member/conversation rights, active device grant, job authorization, workflow-worker rights, and device runtime policy. Expired/revoked policy always narrows, never widens.
- [ ] Start with no device tools for the queue-worker smoke test. First real capability should be a narrowly scoped read-only operation against a disposable fixture directory.
- [ ] Define capability IDs over validated tool/argument profiles rather than a user-editable array of arbitrary tool names. Example intent: read a bounded text file in a chosen shared folder, not “any `start_process` command.”
- [ ] Exclude family-worker access to configuration mutation, shell/REPL/arbitrary code, process control, network-fetch proxies and unrestricted filesystem calls by default. Tool discovery must not leak configuration or unrestricted device catalogs.
- [ ] For path-limited capabilities, resolve against owner-approved roots on the Mac, reject traversal/NUL/unsupported schemes, verify canonical containment and symlinks, and design execution-time TOCTOU defenses. Prefix checks such as `path.startsWith(root)` are not sufficient. A gateway check before delayed execution is not enough.
- [ ] If needed restrictions cannot be enforced at the real filesystem/process boundary, disable that capability or use an owner-approved OS isolation mechanism. Do not invent a sandbox by filtering shell strings.
- [ ] Recheck arguments/policy immediately before device execution after durable claim. Bind validated policy/effect metadata to protected protocol fields; strip reserved `_meta`/delegation keys from user/model input.
- [ ] Make terminal/process handles, search IDs, file-upload references and pagination cursors scoped to requester/job where applicable. Another family's process/session ID must not be usable as an indirect read/write channel.
- [ ] Add durable approval records for allowed mutating capabilities. Bind approval to conversation, requester, job/operation, actual device, capability, normalized arguments hash, policy version, approver and expiry.
- [ ] Display concrete effect scope and readable arguments to the authorized human. No “approve all future tools,” model-generated approval, hidden argument changes or inherited ChatGPT confirmation as the sole enforcement gate.
- [ ] Distinguish requester, approver and device owner policy. A child cannot approve a capability they are not permitted to authorize. An owner approval does not automatically broaden a worker's transcript visibility.
- [ ] Consume an approval atomically with the corresponding durable effect admission. Exact replay returns its existing receipt; changed arguments/operation/target require a new approval. Device claim still checks current grant/revocation and expiry.
- [ ] Keep receipts for indeterminate effects; do not re-enable approval merely because a response timed out. A retry is not a new authorization to repeat a deletion.
- [ ] Cover direct `/mcp`, compatibility routes, queue tools, internal router helpers and public chat APIs with the same policy enforcement. Tests must attempt raw calls not shown in the UI.

### Example: fail-closed tool-set intersection

A small executable illustration of one part of policy. It **does not** enforce paths, role changes, approvals, device arguments or operating-system isolation.

```ts
export function intersectToolSets(
  policies: readonly ReadonlySet<string>[],
): Set<string> {
  if (policies.length === 0) return new Set();
  return new Set([...policies[0]].filter(
    (tool) => policies.every((policy) => policy.has(tool)),
  ));
}

// Empty or missing applicable authority must never mean unrestricted access.
```

### Example: effect authorization transaction

Proposed service pseudocode. `tx` operations are contracts to implement under the QUEUE-01 writer/authority model, not invented Jazz APIs. No OS side effect occurs inside the transaction callback.

```ts
async function approveAndPrepareEffect(ctx: VerifiedHumanContext, input: ApprovalInput) {
  return policyWriter.transaction(async (tx) => {
    const proposal = await tx.requirePendingProposal(input.proposalId);
    await tx.requireCurrentApprover(ctx, proposal);
    await tx.assertUnchangedArgumentHash(proposal, input.displayedArgumentsHash);
    await tx.assertCurrentGrantAndDeadline(proposal);
    // Commit a single-use decision and exact operation binding, plus audit/event.
    return tx.recordApproval(proposal, ctx.identity, input.operationId);
  });
}
// Later effect admission validates and consumes that exact decision.
// An approval is not an HTTP bearer token and must not be accepted for another job.
```

**Acceptance:** a child cannot access terminal/config or escape a fixture root; a worker owner credential cannot amplify requester permissions; changed arguments invalidate approval; duplicate approval/effect operations converge; revoked or expired grants reject delayed claims; unauthorized process IDs and raw route bypasses fail.

## SEC-03 — Public HTTP, payload safety, logs, and model input

Future touch points: CP HTTP/ingress contracts, chat routes, MCP security context, existing logging/audit helpers; DC `src/utils/toolHistory.ts`, `src/custom-stdio.ts`, `src/tools/config.ts`, bridge debug output where policy requires changes.

### Tasks and subtasks

- [ ] Enforce exact configured external origin independently from internal bind addresses. Validate allowed Host and supplied Origin values; absent Origin can be normal for an authenticated nonbrowser MCP client and must follow the pinned protocol.
- [ ] Strip inbound proxy/client-IP identity headers at ingress and set only trusted values. Do not permit arbitrary upstream destinations, `CONNECT`, raw WebSocket upgrades or forwarded host/protocol rewriting of issuer/resource.
- [ ] Protect cookie-auth chat mutations using existing session-bound CSRF controls plus exact origin checks and appropriate content types. CORS and SameSite alone are not the complete mutation policy. Preserve required standards-compliant OAuth exceptions in their own audited handlers.
- [ ] Set secure, HttpOnly, appropriately SameSite and host-scoped session cookies using Better Auth's supported configuration. Do not put tokens in browser storage, SSE query strings, URLs, HTML bootstrap or logs.
- [ ] Inventory `nextCookies`, OAuth code/PKCE/state, refresh, CIMD/registration, token revocation and public metadata behavior. Do not replace library validation with private ad-hoc JWT parsing.
- [ ] Preserve current OAuth scopes during the thin slice. If adding a worker-specific scope/purpose, update issuer resource policy, token issuance/verification, protected-resource metadata, tests and both providers' exact health checks together; otherwise valid new scope profiles may appear unhealthy.
- [ ] Apply pre-parse body byte limits, strict runtime schemas and unknown-field rejection. Starting limits: 64 KiB chat mutation body, 16 KiB message text, 32 KiB worker context/result pages and 64 KiB aggregate event/result pages; per-tool argument bounds can be smaller.
- [ ] Bound per-session and per-member queue depth, auth/MCP/chat request rate, open streams, subprocess/model concurrency and execution time. Do not rate-limit solely by relay IP, which may represent all family members.
- [ ] Use `Cache-Control: no-store` for authenticated HTML/data; no CDN cache/service-worker cache of transcripts. Verify no production source maps/debug routes expose server implementation or secrets.
- [ ] Separate normal access logs from durable audit. Log approved event types/opaque IDs/durations/outcomes, not bodies, tool arguments, file contents, authorization headers, cookies, refresh tokens, grant secrets or stack traces containing payloads.
- [ ] Review **child** tool history and stderr/MCP logging notifications, not just Next/ingress logs. Current DC history can persist arguments/results. Disable or minimize unsafe history for this profile, with tests, before real family/model traffic is enabled.
- [ ] Redact existing configuration dumps and bridge previews. A first-100-characters preview can still contain a full token/password; truncation is not redaction.
- [ ] Default chat rendering to plain React text. If Markdown is later enabled, disable raw HTML, constrain links and image loading, and block script/data URLs. Do not auto-fetch remote images or hidden URLs from model text.
- [ ] Treat user documents, file names and tool outputs as untrusted model input. They cannot grant permissions, repin conversation/session identity or instruct the server to exfiltrate extra data.
- [ ] Do not store hidden chain-of-thought. Persist user-visible answers and concise operational events only.
- [ ] Return stable safe error codes; distinguish invalid request, forbidden, commit unknown, stale claim, worker idle and effect indeterminate. Never recommend blind retries of effects in generic error text.

### Example: allowlist audit records instead of logging entire objects

```ts
type SafeAuditEvent = {
  event: "chat.admitted" | "claim.denied" | "effect.indeterminate";
  operationId: string;
  outcome: "accepted" | "denied" | "unknown";
  durationMs: number;
};

export function safeAuditLine(event: SafeAuditEvent): string {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(event.operationId)) {
    throw new Error("invalid audit operation ID");
  }
  if (!Number.isFinite(event.durationMs) || event.durationMs < 0) {
    throw new Error("invalid audit duration");
  }
  // Select individual fields: a structurally wider input cannot inject payloads.
  return JSON.stringify({
    event: event.event,
    operationId: event.operationId,
    outcome: event.outcome,
    durationMs: Math.round(event.durationMs),
  });
}
```

The real boundary still needs runtime validation of enum fields and purpose-generated opaque IDs, log permissions/retention, and forbidden-marker tests across every process. Type annotations alone cannot prevent a caller putting sensitive text inside an approved string field.

**Acceptance:** canary tokens/fixture contents absent from captured ingress/Next/coordinator/device/child logs; cross-origin cookie mutations rejected; valid bearer MCP calls without browser Origin work as the protocol permits; oversize payloads rejected before unbounded allocation; model output cannot execute HTML or silently load tracking images.

## SEC-04 — Local persistence, secrets, and household recovery

### Tasks and subtasks

- [ ] Establish absolute owner-only state directories outside checkout, build output, temp and public/static folders. Document auth SQLite, Jazz authority data, schema/permission versions, queue recovery records and allowed file roots.
- [ ] Keep existing native credential storage for device credentials; use provider-managed tunnel credentials and a supported OS-vault path for optional model API secrets. No secret in plist, process arguments, copied example config, source control or client bundles.
- [ ] Prefer FileVault and locked OS accounts; document limits when the logged-in Mac owner can read data and when Keychain is locked/unavailable after boot.
- [ ] Define owner bootstrap, passkey loss/recovery, family invite revocation, OAuth refresh/revocation, tunnel-identity loss and signing-key rotation runbooks. Recovery must not quietly reset account ownership or issuer/resource URLs.
- [ ] Decide explicit retention separately for chat text, audit events, idempotency receipts, pending/indeterminate effects and model context. Never delete deduplication evidence while a supported retry can still arrive; expired old keys must be rejected or quarantined, not treated as fresh.
- [ ] Keep attachment/upload support disabled until content limits, storage isolation, scanning/preview policy and model-sharing consent are separately implemented. A chat text field is not a filesystem upload API.
- [ ] Design coordinated backups: pause admissions/claims, drain or checkpoint active effects, quiesce all relevant writers, snapshot auth SQLite using a verified backup method or clean shutdown including WAL handling, and snapshot persistent Jazz with its supported procedure.
- [ ] Record a restore manifest binding auth identity/JWKS state, Jazz application/schema/data, policy version and queue recovery boundary. Do not assume two independently copied live databases describe one coherent point in time.
- [ ] Encrypt and protect backups using an owner-chosen local/external-disk scheme. No cloud backup dependency is required; any optional remote backup needs separate privacy consent.
- [ ] Restore into isolated copied state before reconnecting a tunnel or starting a device executor. Fence old worker sessions, reconcile effects, verify auth-to-family mappings, and intentionally revoke stale credentials as needed.

**Acceptance:** missing/locked secrets cause a safe paused state; restart uses persistent state, not empty fallback; an isolated restore preserves accepted messages and uncertain-effect evidence without automatically executing work.

## OPS-01 — Supervise the local runtime and enforce one writer

Future touch points: CP deployment scripts and proposed local ingress/coordinator entry points, existing Jazz authority script; DC `src/remote-device/tunnel/macos-launch-agent.ts` as a supervision reference, not proof it already supervises all services.

### Tasks and subtasks

- [ ] Build a production local runtime, not `next dev`, with explicit working directories and pinned node/binary paths. Verify process architecture and native dependencies on the actual Mac.
- [ ] Assign proposed endpoints: public ingress loopback 3000, private Next loopback 3001, private Jazz loopback 1625, queue coordinator owner-only Unix socket. Explicitly validate IPv4/IPv6 binds; no wildcard LAN listener.
- [ ] Make `MCP_SERVER_URL` point to the private Next origin while tunnel target points to ingress. Keep `APP_ORIGIN`/issuer/resource public values unchanged by this private port split.
  - [ ] Do not use the current `remote tunnel prepare` output verbatim: it currently derives `MCP_SERVER_URL` from the tunnel provider's `localTarget`. For this design define/test two independent settings, e.g. tunnel target `http://127.0.0.1:3000` and device API origin `http://127.0.0.1:3001`.
- [ ] Inventory startup dependencies carefully: signing key/SQLite availability, JWKS discovery, Jazz authority readiness, coordinator recovery, Next API readiness, device credential activation and tunnel publication. If public discovery is needed during boot, publish only safe auth/readiness surfaces while work admission remains paused; do not bypass TLS/resource identity checks to break a boot cycle.
- [ ] Ensure local Jazz/JWKS traffic resolves to tested local service paths where supported, without trusting a client-controlled host or falling back to a hosted peer. Keep canonical issuer identity separate from internal discovery routing.
  - [ ] Prefer an internal `JAZZ_JWKS_URL` to the private Next listener if the pinned Jazz runtime accepts that configuration, while keeping JWT issuer/audience claims canonical to the public product identity. This removes an unnecessary tunnel hairpin from local Jazz token verification; prove the exact alpha.53 behavior before adopting it.
  - [ ] Device OAuth discovery/token verification currently requires endpoints on the configured **public authorization-server origin**. Startup therefore still depends on the tunnel/public origin becoming reachable before `MCPDevice` authorization succeeds. Treat that as an explicit boot dependency unless a separately reviewed internal-transport override preserves all issuer/endpoint checks.
- [ ] Implement the coordinator's exclusive process ownership guard. A stale PID file alone is not exclusion. Prevent Next workers/HMR/cleanup scripts from becoming competing authoritative queue writers; hold ordering through accepted/rejected/unknown commits.
- [ ] Use per-user LaunchAgents for supported logged-in operation, with bounded restart backoff and one supervisor per service. Do not promise pre-login availability; LaunchDaemon/root execution is a separate security decision.
- [ ] Treat the DC stdio child as owned by the existing bridge, not a second independently launched service. Pin its build/config; verify start, crash detection and lazy recovery behavior.
- [ ] Add health that distinguishes process live, auth ready, authority durable, coordinator recovering/ready, device ready, tunnel reachable and model worker actually active. A 200 metadata response is not proof an AI worker is running.
- [ ] Graceful shutdown: stop new admissions/claims, revoke/fence sessions, checkpoint/outbox evidence, bound drains, stop device effects as supported, then close stores. At timeout retain indeterminate evidence rather than wiping state.
- [ ] Verify public ingress cannot reach private device APIs or proxy arbitrary upstreams. Test against an existing private route with known internal behavior, not merely a nonexistent path that would return 404 anyway.
- [ ] Test 15 simultaneous browser sessions with bounded streams and one initial model/device work slot. Record CPU/RSS/disk usage/queue age, idle resource usage and reconnect storms; tune measured limits.

### Example: proposed nonsecret runtime contract

This describes intended configuration, not an executable LaunchAgent or existing configuration schema. The host is illustrative; provisioning selects the real durable origin.

```ts
const runtimeContract = {
  publicOrigin: "https://stable-host.example",
  publicMcpResource: "https://stable-host.example/mcp",
  publicChatUrl: "https://stable-host.example/chat",
  publicIngress: "http://127.0.0.1:3000",
  internalNextOrigin: "http://127.0.0.1:3001",
  internalJazzPort: 1625,
  queueTransport: "owner-only-unix-socket",
  maxActiveModelJobs: 1,
  maxActiveJobsPerConversation: 1,
  modelApiEnabled: false,
  chatgptWorkerEnabled: false, // explicit experiment enablement only
} as const;
```

Do not put credentials into this object. Existing DC `RemoteIdentityConfig` uses `authorizationServerIssuer`, `publicMcpResource` and `internalDeviceApiOrigin`; map the above proposal to verified existing config rather than adding redundant conflicting origin settings.

**Acceptance:** second launch cannot create a second writer; service restart returns to the same local state and hostname; LAN connections to internal ports fail; public device routes are denied even with spoofed forwarding headers; no hosted Jazz/database traffic is needed.

## OPS-02 — Durable public ingress and real protocol tests

### Tasks and subtasks

- [ ] Select Tailscale Funnel or zrok reserved identity for the initial existing-provider experiment, after checking current account eligibility, pricing, quotas, public ingress rules and stable naming. No live provider compatibility is assumed from repository code.
- [ ] If owned DNS is a hard long-term requirement, choose Cloudflare Named Tunnel from the beginning as an explicitly new integration/configuration task. Do not promise a later provider-owned-to-custom-hostname switch needs no OAuth/passkey/client migration.
- [ ] Never use ephemeral zrok shares or Cloudflare Quick Tunnel for a persisted ChatGPT app identity. Quick Tunnel limitations are not the named-tunnel behavior contract.
- [ ] Point exactly one tunnel at local ingress, not Jazz, the private Next port, device APIs, or the coordinator socket. Transport is not user authentication.
- [ ] Persist/recover existing provider identity; refuse external name drift or deletion rather than silently regenerating a URL. Verify ownership semantics before replacing another local Funnel/share target.
- [ ] Carry the exact current OAuth metadata profile through ingress. Existing provider health validators require particular scope/issuer/resource values; update them together if the worker auth contract changes.
- [ ] Test request-scoped MCP streaming/JSON as required by the pinned SDK and real ChatGPT client. Verify content types, protocol metadata, request limits, tool schema snapshot behavior and disconnect/cancellation semantics.
- [ ] Test browser SSE with correct `text/event-stream`, no cache/buffering, bounded stream lifetime/reconnect and session checks. Use heartbeat frames and a safe polling fallback; do not assume a relay permits unlimited idle duration.
- [ ] Ensure no provider interstitial/browser challenge/login wall breaks OAuth discovery, token exchange, MCP API requests or browser event streams. Test actual traffic rather than inferring behavior from marketing text.
- [ ] Reboot tunnel, change Wi-Fi, sleep/wake, and change home public IP when feasible: recorded app URL remains unchanged. Distinguish inability to run a test from a passed result.
- [ ] Inspect egress in local-model mode: no hosted Jazz, SQL, external inference, CDN fonts or unexpected telemetry is required for normal chat. Document unavoidable selected tunnel, OAuth client metadata and optional update/model-download traffic separately.

**Acceptance:** `/chat` and `/mcp` work on the exact same stable public origin, auth survives ordinary restarts or reauthorizes safely, events recover by replay, and private routes remain blocked.

## OPS-03 — Recovery, outages, rollback and operator controls

### Tasks and subtasks

- [ ] Provide a local operator health summary and emergency stop/revoke action. Stop new claims/effects first; do not expose an unauthenticated public control URL.
- [ ] Document expected UX while Mac offline: browser shows unavailable/waiting after timeout, cannot promise an accepted send, retains only a local draft by default. Jobs accepted before outage survive in local storage.
- [ ] Rehearse kill/restart at admission before commit, after commit before HTTP receipt, after claim before device effect, after effect before result, and after completion before acknowledgement.
- [ ] On recovery, hold new work paused while reconciling authority/receipt state and effects. Restore the same origin and persistent identity; invalidate old writer epochs/worker sessions and preserve receipt reads where authorized.
- [ ] Treat sleep/wake and clock jumps as lease events. No remote model or HTTP connection automatically extends a lease; a stale worker's new mutations fail closed.
- [ ] Distinguish result-reporting failure from effect execution failure. Retrying result submission can be safe; rerunning a tool to recover its missing result is not.
- [ ] Test disk-full, SQLite unavailable, Jazz authority unavailable, corrupt/missing schema identity and locked Keychain. Return safe paused/unavailable states, never fresh empty databases or broadened permissions.
- [ ] Rehearse SEC-04 coordinated backup/restore with disposable data and verify restored accounts/grants/conversations and uncertain-effect state before reconnecting public ingress.
- [ ] Implement separate feature gates for chat UI, queue admission, worker grants and device capabilities. Disabling chat does not erase accepted work or silently break ordinary owner MCP access.
- [ ] Define schema rollback compatibility. Do not start an older executable against newer incompatible data or copy a single store backward independently. Restore an approved complete boundary while offline if rollback is necessary.
- [ ] Revoke experimental worker grants and unpublish workflow tools through the actual client update process. A frozen ChatGPT tool snapshot may require explicit app action refresh or reconfiguration; unchanged hostname alone does not update tools.
- [ ] Record operator-visible blocked/indeterminate work and a deliberate reconcile/approve-new-action flow. Do not put a “Retry everything” button in the family UI.

**Acceptance:** each failure point has a recorded safe terminal/paused/reconciled outcome; no test causes duplicate destructive effects; the family sees uncertainty honestly; disabling the new feature preserves existing owner stdio/MCP workflows.

## OPS-04 — Release matrix and evidence ledger

Start with synthetic people and disposable files. The following gates are mandatory, not claims of present success.

| ID | Scenario | Required evidence / pass condition |
| --- | --- | --- |
| V-01 | Same origin | One configured origin; exact sibling `/mcp` and `/chat`; no `/mcp/chat`; auth redirects use configured origin |
| V-02 | Public/private routes | Known private device endpoints function internally and are denied publicly; encoded paths/aliases/forwarded headers cannot bypass |
| V-03 | Account and family access | Anonymous, stranger, revoked member and cross-conversation reads/writes/streams denied |
| V-04 | Shared worker delegation | Broad direct owner tool route unavailable to worker; child request cannot become owner-powered shell/config access |
| V-05 | Human approval | Exact operation/hash/approver/expiry binding; changed argument and repeated replay tests |
| V-06 | Duplicate send | Same key/payload and lost receipt yield one committed message/job/event bundle; changed payload conflicts |
| V-07 | Concurrent claim | Independent claimants and repeated attempts never execute the same authority-granted attempt; stale fences rejected |
| V-08 | Conversation ordering | Later turn cannot overtake running/indeterminate prior turn; context revision bounded correctly |
| V-09 | Restart durability | Accepted admission/reply/event survives coordinator, Next and authority restart using persistent local data |
| V-10 | Lost effect completion | One device effect; repeated report converges; conflicting terminal payload rejected; uncertain effect not replayed |
| V-11 | Cancellation | Queued cancellation prevents execution; active cancellation is honest about unsupported stop/indeterminate state |
| V-12 | Reconnect/replay | SSE gap, replay retention reset, session expiry, room switch and polling fallback preserve authorized ordered state |
| V-13 | Logs and data sharing | Canary secrets/content absent from all logs; only explicitly authorized model context sent externally |
| V-14 | Locality | Browser has no direct Jazz connection; no hosted state dependency; private services bound only to intended endpoints |
| V-15 | Family UI | Keyboard, VoiceOver, touch, mobile keyboard, long text, reduced motion and narrow viewport; clear privacy/engine/worker labels |
| V-16 | Household load | Approximately 15 browser sessions/reconnect burst; bounded RSS/queue/page/stream/concurrency; no invented performance promise |
| V-17 | Static identity | Process/tunnel restart, Wi-Fi change, sleep/wake and reboot preserve origin; deletion/drift fails explicitly |
| V-18 | Restore/rollback | Isolated coherent backup restore; schemas match; revoked grants not accidentally resurrected; no automatic execution |
| V-19 | ChatGPT real client | Actual eligible account scans tools, opens session, claims/replies with short calls, and stops safely when turn ends |
| V-20 | 25-minute experiment | Record actual tool cadence, idle behavior, last heartbeat, hard expiry and worker stop; model stopping early is a failed liveness gate, not a lease bug to hide |
| V-21 | Model isolation | Separate private context policy or explicit shared room; account memory/project/other connectors considered; no private-room pooling |
| V-22 | Explicit fallback | No paid/remote/local replay on idle without approved authorization; reconcile existing effects before continuation |
| V-23 | Regression | Existing stdio operation, owner MCP auth, device OAuth/claim/completion, tunnel ownership and passkey flows remain covered |

### Execution subtasks

- [ ] Discover actual package scripts and test entry points before running implementation validation; retain existing testing conventions and use temporary state roots.
- [ ] Unit-test standalone contracts/validators with fake clocks and deterministic IDs; implement task-pack pseudocode fixtures explicitly.
- [ ] Integration-test against actual selected local Jazz authority with independent clients, controlled barriers and failure injection. Mock transactions alone cannot prove accepted commit/claim behavior.
- [ ] Exercise real HTTP ingress and authenticated browser flows on a second device, not only `localhost` or internal handlers.
- [ ] Run real ChatGPT worker tests with synthetic/shared-room content and device effects disabled first. Record plan/workspace/client configuration and tool-definition snapshot version.
- [ ] Enable one bounded read-only capability, then one approved disposable write only after authorization/recovery gates pass.
- [ ] Evaluate each optional engine separately. Local-model hardware limits and API billing/privacy are distinct release decisions; a fake worker proves queue/UI behavior only.
- [ ] Save sanitized evidence per matrix ID: command/test identifier, versions, environment, timestamp, result, observed output, and remaining blocker. Never save real family transcripts, cookies, tokens or device secrets as test fixtures.
- [ ] Mark not-run/blocked explicitly. Do not convert “tests planned,” “dependencies installed,” “metadata returned 200,” or “worker session created” into end-to-end acceptance.

### Evidence record example

```json
{
  "gate": "V-20",
  "status": "not_run",
  "environment": "disposable-test-workspace",
  "client": "real ChatGPT account eligibility must be verified",
  "durationObservedSeconds": null,
  "lastSuccessfulOperation": null,
  "artifacts": [],
  "blockers": ["Workflow-only worker grant and bounded queue tools not implemented"]
}
```

**Release rule:** the base `/chat` product can ship with an explicitly selected working local/API adapter only after its own gates pass. A ChatGPT-worker failure must remain visible and cannot be masked by silently buying API inference. Device effects stay disabled until their authorization, approval, durability and recovery gates pass.
