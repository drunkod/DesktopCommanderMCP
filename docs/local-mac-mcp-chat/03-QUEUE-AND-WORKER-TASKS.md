# Queue and worker implementation tasks

Status: **plan only; implementation and validation gates remain open**. Source inspection: 2026-09-08.

## Scope and non-negotiable boundaries

Build a durable, engine-neutral chat queue for approximately 15 family members using one Mac. The canonical application origin serves `/chat`, `/mcp`, and `/api/auth` (CORE-01). Authentication, the control plane, queue coordination, Jazz authority/storage, and Desktop Commander device execution run locally. No hosted Jazz service, hosted database, or VPS is required. Keep Jazz as the queue store; do not introduce Redis, Postgres, or another queue database by default. Existing Auth SQLite remains the authentication store; Jazz remains the durable application/queue store. This contract does not imply an atomic transaction spanning Auth SQLite and Jazz.

An external model is an optional inference provider, not a required application host. ChatGPT or another remote engine necessarily receives the context/tool outputs explicitly sent to it and can have separate account, plan, usage, and cost constraints. A local engine can avoid that model-provider dependency. Reachability of the local origin from ChatGPT is a CORE-01 deployment prerequisite, not a reason to move the application to a hosted service. Do not use or recommend OpenAI Secure MCP Tunnel.

This document defines the queue/worker contract and implementation acceptance gates within the shared local-Mac chat documentation. CORE, SEC, UI, and OPS companion plans define the adjoining origin, identity, policy, presentation, and operational contracts; documentation presence does not mean their implementation gates have passed. Application changes belong under `/Users/test/Documents/RemoteMCP-Jazz/implementation/apps/control-plane` and `/Users/test/Documents/RemoteMCP-Jazz/implementation/packages/protocol`. Change the DesktopCommanderMCP repository only where the existing device bridge needs a verified safety extension. Schema and destructive recovery experiments must use copied or synthetic data, not live family storage.

### Shared OPS topology contract

The main OPS plan selects the public topology and route allowlist; queue work must conform to this target rather than expose another public service:

- Public traffic reaches the **local ingress router at `127.0.0.1:3000`**, which forwards only allowed routes to **Next at `127.0.0.1:3001`**. These loopback addresses are local upstreams, not the public OAuth issuer URL; CORE-01 still supplies the single canonical public origin.
- Local Jazz authority listens privately on **`127.0.0.1:1625`**. No raw Jazz sync, admin, or database endpoint is publicly forwarded. Browser queue projections/replay use authenticated application routes, not public raw Jazz access.
- The single queue writer is accessed through a **local Unix-domain socket**, not a public HTTP route. OPS must define socket permissions, caller authentication/trusted context forwarding, and process ownership/restart guards; possession of a socket path or a caller-supplied principal is not authorization.
- The public router uses a default-deny route allowlist. In particular it denies **`/api/device` and its descendants**, the **`/api/mcp` compatibility alias**, and **raw Jazz** routes. `/mcp` is the public MCP resource. Any approved human device-management route must be separately enumerated; a broad `/api/*` allow rule is not acceptable.
- Local device control-plane requests may use the private Next loopback service with device authentication. Public denial does not remove internal authorization/fencing checks, and any retained `/api/mcp` implementation alias must enforce the same policy if invoked internally.
- Auth SQLite remains local. Socket location, ingress route details, and launch configuration belong to OPS; these addresses describe the agreed target, not a claim that current services have already been moved.

### Privacy constraint that must shape the architecture

A scoped queue query is not a clean model context. **A shared ChatGPT conversation retains prior family messages, tool results, and instructions even when the next job fetch returns only one person's data.** Do not advertise private family chats as isolated if one owner ChatGPT thread processes them all.

The ChatGPT worker is disabled by default and must be explicitly opted into and pinned to **one application conversation within one trust domain** for the lifetime of its ChatGPT thread. A deliberately shared household room can be that domain if participants understand who and which provider can see it. Private conversations require separate, appropriately isolated engine contexts and authorizations; reusing an owner thread with a different session ID is not isolation. A fresh thread alone does not prove isolation from account-level memory, shared projects, files, or connector privileges: test those settings and document their limits. If adequate isolation cannot be established, disable this adapter for private conversations.

The requester and allowed devices/tools come from the **claimed job and current server-side policy**, never from the owner worker's broad OAuth privileges. Hiding direct tools from discovery is not sufficient: raw `tools/call`, compatibility routes, device-admin endpoints, and internal dispatch helpers must not bypass this rule.

## Verified starting point and limits of the evidence

Paths beginning with `apps/` or `packages/` below are relative to `/Users/test/Documents/RemoteMCP-Jazz/implementation`. Paths beginning with `src/` or `test/` in the DC column are relative to DesktopCommanderMCP.

CodeGraph was queried with explicit project paths for both indexed repositories. Broad implementation queries sometimes returned stale `.next-stale-*` bundles; those bundles are not a version baseline. Relevant current application files and the installed Jazz runtime were inspected directly where indexing was insufficient. The separate reference checkout at `/Users/test/Documents/RemoteMCP-Jazz/references/jazz-auth-betterauth-chat` was reported **unindexed**; its chat example was inspected as reference material, not as the deployed schema.

| Area | Observed source | Consequence for implementation |
|---|---|---|
| Protocol schema | `packages/protocol/src/application-schema.ts` defines `devices`, `remoteCalls`, `auditEvents` with `schema.table`, `string`, `json`, `ref`, `timestamp`, and `int`; `src/schema.ts` defines the application and exported row types. | No existing `chatJobs`, conversations, worker sessions, or queue event schema was found there. Additive schema evolution must be verified rather than assumed. |
| Call identity | `remoteCalls` has `ownerId`, `requestId`, `requestFingerprint`, `deviceId`, tool/args/metadata, status, result/error, `claimedByClientId`, `claimedAt`, completion time, expiry. | It is a device-call ledger, not a chat turn/job queue. Current claim fields are not a complete expiring, attempt-fenced worker protocol. |
| Local backend | `apps/control-plane/lib/jazz-context.ts` creates a memory-driver backend context pointing at `env.jazzInternalServerUrl`, using `tier: "global"`; `lib/jazz-principal.ts` exposes a trusted backend handle with a warning to enforce ownership explicitly. | The backend process's memory is not the durable queue. Backend privilege bypasses client policy and must remain inside trusted services. |
| Local authority | `apps/control-plane/scripts/jazz-authority.ts` uses `startLocalJazzServer` with an explicit data directory, app ID, JWKS, backend/admin secrets. | Local authority storage is the intended durability boundary. Verify the selected data path, startup configuration, and recovery before enabling admission. Do not infer crash/fsync guarantees merely from this wrapper. |
| Installed baseline | Control-plane and protocol manifests pin `jazz-tools` to `2.0.0-alpha.53`; control-plane pins `@modelcontextprotocol/server` to `2.0.0` and Better Auth packages to `1.7.1`. | CORE-02 must verify resolved packages, runtime/WASM, schema tooling, and DC compatibility. A manifest is evidence, not proof that all running processes use it. |
| Jazz transactions | Installed `jazz-tools/dist/runtime/db.js`: `Db.transaction(callback)` uses `runInBatch`; `DbTransaction` uses batch mode `transactional`; `tx.one/all` carry `transactionBatchId` and deferred local updates. Documentation in that source says the writes settle together after authority validation. `DbDirectBatch` has different, direct visibility semantics. | Use transactions, not an optimistic list insertion or a direct batch, for queue invariants. These APIs do not by themselves prove the required serialization/absence-read behavior. |
| Jazz commit wait | Installed `dist/runtime/client.js`: `runInBatch` commits after the callback resolves and returns a `WriteResult`; `.value` is the callback value. `WriteResult.wait` waits through `WriteHandle`/`waitForBatch` then returns that value; persisted rejection can throw `PersistedWriteRejectedError`. The type documentation defines `global` as persistence at the global server. | `await db.transaction(...)` is **not** the final durability acknowledgement. Await the returned handle's `wait({ tier: "global" })`. Here “global” names a Jazz tier served by the configured local authority, not a requirement to host Jazz in the cloud. It is not a universal linearizability/CAS or power-loss guarantee. |
| Existing idempotency | `lib/call-router.ts` derives a deterministic remote-call row ID from subject/device/key, hashes canonicalized tool arguments and metadata, uses a transaction, waits globally, and re-reads a winner on error. | Useful precedent, but queue admission must atomically include the human message and queue event too. Do not copy its broad catch into a generic “retry every error” implementation. |
| Device claim/completion | `app/api/device/calls/[id]/claim/route.ts` checks device/owner/client, reads pending status in a transaction, writes `executing`, and awaits global persistence. It handles `transaction_conflict`. Completion uses a transaction and accepts an already-terminal call from the same client without comparing a result fingerprint. | Preserve authority-before-execution, add required delegation/fencing validation, and specify stronger duplicate-result behavior. Existing code is not proof that all queue contention cases are safe. |
| MCP exposure | `app/mcp/route.ts` re-exports the canonical handler from `app/api/mcp/route.ts`. The handler authenticates `mcp:tools`, constructs `buildServer(claims.sub)`, and exposes owner-scoped `list_devices`, device controls, and `call_device_tool`. | The worker must not inherit this generic owner dispatch surface. Apply restrictions to both `/mcp` and its compatibility alias and every downstream service path. |
| Blocking remote dispatch | `lib/call-router.ts` admits a call and waits for terminal status, by subscription, with a default 120-second timeout; device heartbeat freshness is checked against 45 seconds. | Factor admission from waiting for the queue bridge. A timeout awaiting a result does not prove that execution failed or stopped. |
| DC executor | `src/remote-device/device.ts`: `MCPDevice.handleNewToolCall` claims before effects, then invokes `DesktopCommanderIntegration.callClientTool`; `src/remote-device/remote-channel.ts` subscribes to global pending calls with a memory-driver Jazz client and performs claims/completions through the control plane. `src/remote-device/desktop-commander-integration.ts` uses a stdio MCP client/transport. | Reuse this executor and transport. The in-memory seen-call set is only a local optimization, not durable deduplication or a queue lease. |
| Lost device completion | DC's execution catch also covers result-persistence failure and attempts a `failed` report. `scripts/cleanup-calls.ts` turns expired pending calls into `cancelled` and stale executing calls into `indeterminate`, then applies terminal retention. | Do not equate `failed` with “no side effects.” Distinguish execution failure from reporting failure before enabling destructive queue work; preserve uncertain outcomes. Cleanup needs queue-aware retention and race validation. |
| Work budget | `src/utils/work-lifecycle.ts` defaults to 25 minutes with notices at 20/23/24 minutes. It persists `current.json`, restores work state, and marks expiry interrupted. `src/server.ts:runWithWorkLifecycle` starts/touches that manager and records cancellation. | This is a process-level defensive lifecycle, not a per-chat distributed lease. It does not prove cancellation kills a subprocess or that ChatGPT will continue making tool calls for 25 minutes. Do not stretch HTTP to match it. |
| Chat reference | Reference `examples/auth-betterauth-chat/schema.ts` has messages with `author_name`, `chat_id`, `text`, `sent_at`; its `ChatPanel` waits at `edge`. | UI-01 may borrow presentation ideas. Display names and string chat IDs are not family authorization, queue admission, or a reason to change the local authority's required commit tier. |
| Current permissions | `apps/control-plane/permissions.ts` grants scoped reads and denies direct client insert/update/delete on existing application tables. | Retain service-owned writes for queue rows. Design member-readable projections or scoped reads separately; never send backend credentials to browsers or model workers. |

### What has not been established

No contention, process-restart, power-loss, schema migration, device cancellation, or real ChatGPT liveness test was run for this plan. In particular, CRDT replication must **not** be treated as compare-and-swap. No Jazz `compareAndSwap`, row-lock, uniqueness, or automatic migration API is assumed or invented below.

## Dependency and delivery map

The prerequisite IDs below refer to the shared CORE, SEC, and UI contracts in companion documentation. Coordinate topology and the Unix-socket writer with the main OPS plan. Track completion by evidence at each gate, not by whether its plan file exists.

| Task | Depends on | Deliverable / release gate |
|---|---|---|
| QUEUE-01 — protocol, schema, and authority gate | CORE-02 (version baseline), SEC-01 (identity model); consult CORE-01 | Typed model, schema evolution rehearsal, proven single-writer/authority contract |
| QUEUE-02 — atomic admission and idempotency | QUEUE-01, CORE-01 (origin), SEC-01, SEC-02 (effective tool policy) | One authoritative human-message + job + event commit |
| QUEUE-03 — claims, lanes, leases, and scheduling | QUEUE-01, QUEUE-02, SEC-01, SEC-02 | Attempt-fenced claims, serialized conversation turns, bounded heartbeat protocol |
| QUEUE-04 — worker sessions and engine adapters | QUEUE-03, CORE-01, SEC-01, SEC-02; coordinate UI-01 | Workflow-only tools, isolated context, opt-in ChatGPT experiment |
| QUEUE-05 — delegated device effects | QUEUE-03, QUEUE-04, SEC-02, CORE-02 | Safe bridge into existing `remoteCalls` and DC stdio executor |
| QUEUE-06 — replay, cancellation, recovery, fallback | QUEUE-02 through QUEUE-05; coordinate UI-01 | Durable UI replay, recovery/reconciliation, explicit fallback authorization |
| QUEUE-07 — acceptance and rollout | QUEUE-01 through QUEUE-06, CORE-01/02, SEC-01/02, UI-01 | Deterministic tests, actual local-authority faults, actual ChatGPT tests, operator runbook |

UI-01 consumes authoritative receipts/events and exposes engine choice, sharing consent, cancellation, and uncertain outcomes. The UI must not create queue rows itself or silently retry an engine behind the user's back.

### Durable job state versus UI projection

`JobState` below is the persisted state machine. **`waiting_for_worker` and `awaiting_approval` are UI/API projection statuses over durable job state and related records**, not additional writable job states or synonyms for “running.” Return the durable state, projected status, typed block reason, and relevant authorized receipt/approval references together.

| Durable evidence | UI projection | Scheduling consequence |
|---|---|---|
| Eligible `queued` job with no currently available authorized worker | `waiting_for_worker` | Keep it queued; opening a session alone does not create a running claim. |
| `blocked` with reason `approval` and a durable pending operation/approval request | `awaiting_approval` | No dispatch; only an authorized non-model principal can approve the bound operation. |
| `blocked` with reason `engine` | `blocked` with the engine reason | Explain missing/revoked consent, unavailable engine, or required explicit engine decision; do not silently switch providers. |
| `blocked` with reason `reconciliation`, or `indeterminate` with unresolved effect evidence | `blocked` or `indeterminate`, preserving the durable state and reason | Retain the lane block and show reconciliation evidence; never disguise uncertainty as merely waiting for a worker. |

Other states project without overriding terminal, cancellation, or indeterminate evidence. Worker availability may change without rewriting a job, but entry/exit from `blocked` is a durable transition with an event. Every `blocked` job must carry an `approval`, `engine`, or `reconciliation` reason plus a bounded reason code and relevant record reference; non-blocked jobs have no active block reason. Approval status is derived from a real record, never from model text such as “the user approved.”

## QUEUE-01 — Define the model and prove the storage boundary

### Tasks and subtasks

- [ ] Record the exact resolved Jazz/MCP/auth versions, authority binary or runtime, protocol schema identity, permission artifact identity, and DC protocol import/build relationship under CORE-02. Exclude `.next-stale-*` outputs from evidence.
- [ ] Add engine-neutral protocol types and runtime validators under `packages/protocol`; enumerate statuses and allowed transitions instead of relying on arbitrary persisted status strings.
- [ ] Propose additive Jazz tables for `conversations`, membership/policy references, `chatMessages`, `chatJobs`, `chatJobEvents`, `workerSessions`, operation-approval requests/decisions, admission/operation receipts, and device-effect linkage. Decide which receipts can safely be embedded in immutable job fields instead of separate tables.
  - [ ] Every job has a requester principal, conversation/trust-domain identity, selected engine, frozen resolved engine authorization, immutable admission fingerprint, input-message reference, stable turn order, and context boundary. Validate the durable-state/block-reason invariant and the separate UI projection contract.
  - [ ] Every accepted mutation has a deterministic receipt or operation ID; every state transition and lane update has its associated event in the same transaction.
  - [ ] Keep `remoteCalls` separate: one chat job may generate zero, one, or many device operations.
  - [ ] Add first-class protected delegation/effect fields or a separate protected mapping for remote calls. Do not make client-supplied `metadata` authoritative.
- [ ] Specify read permissions: family membership and conversation ACLs for human clients; session pin and active claim for workers; device-specific remote calls for devices. Avoid exposing full transcript data in job list queries.
- [ ] Retain server-only mutation authority. Deny browser, dashboard, and device tokens direct queue writes, including updates to identities, engine choice, sessions, lease expiry, receipt hashes, and event sequence numbers.
- [ ] Rehearse schema evolution on a **copy** of local Jazz data: inspect the supported alpha.53 schema tooling and runtime compatibility before choosing commands. Test old rows, optional/backfilled fields, missing references, permission deployment, mixed-version refusal, backup/restore, and rollback compatibility. Do not assume a generated migration command exists or that an added required field is backward compatible.
- [ ] Establish `QueueStore`'s transaction semantics with tests against the actual local authority; fake adapters alone are insufficient.
- [ ] Use one authoritative queue writer at the local service layer, reached through the OPS local Unix socket, for this family-sized deployment until stronger concurrency guarantees are demonstrated. Next handlers and cleanup act as clients of this writer, not additional backend queue writers.
  - [ ] All admission, claim, heartbeat, cancellation, completion, session revocation, lane changes, and queue cleanup use that writer. Device-claim authorization touching job state participates in the same ordering boundary.
  - [ ] An in-process mutex is acceptable only within a demonstrably single service process. Next.js globals are not a cross-process lock; HMR, multiple workers, and independently launched cleanup scripts must not become competing writers.
  - [ ] Choose and test a process ownership guard for the separately supervised socket-serving coordinator (for example, an OS-held exclusive lock). Refuse overlapping writers and unauthorized socket clients; test stale-socket cleanup without stealing a live writer's socket. A replicated “leader=true” Jazz row without tested exclusion is not a leader election mechanism.
  - [ ] Keep the write gate held until authority acceptance/rejection has been resolved. A request timeout may end the HTTP response but must not permit conflicting work while a commit remains unknown.
  - [ ] If the writer dies, first establish exclusive ownership, reconnect to the authority, settle/inspect ambiguous receipts, and reconcile active claims before reopening admission. If proof is unavailable, remain paused/read-only.
  - [ ] If the authority cannot provide the required atomic accepted batch behavior even with one writer, stop this implementation gate. Do not silently downgrade to independent writes or add a new database without a separate design decision.

### Proposed model example — not an existing Jazz schema

These are domain types to translate into the **verified** schema/validation facilities. JSON storage is not validation. Omitted related rows, such as membership and receipt records, still require concrete definitions before implementation.

```ts
type Engine = "local-model" | "api-model" | "chatgpt-worker";
type JobState =
  | "queued" | "running" | "cancel_requested" | "blocked"
  | "completed" | "failed" | "cancelled" | "indeterminate";

type BlockReason = {
  kind: "approval" | "engine" | "reconciliation";
  code: string; // bounded, validated reason-code enum in the concrete protocol
  recordId: string; // approval request, engine decision, or reconciliation record
};

type PrincipalRef = {
  issuer: string;
  subject: string;
};

type WorkerIdentity = PrincipalRef & {
  clientId: string;
  grantId: string; // server-resolved grant binding, not a caller assertion
};

type ClaimProof = {
  jobId: string;
  sessionId: string;
  attempt: number;
  writerEpoch: string;
  fencingToken: string; // opaque secret; store a digest, not this plaintext
};

type FrozenEngineAuthorization = {
  id: string;
  version: string;
  snapshotHash: string;
  source: "conversation" | "explicit_selection";
  // Immutable record binds engine/provider/model, sharing scope, cost/replay
  // policy, approving principal, and expiry; current revocation still applies.
};

type OperationApproval = {
  id: string;
  jobId: string;
  operationId: string;
  deviceId: string;
  capabilityId: string;
  argumentHashVersion: string;
  argumentHash: string; // server-computed hash of immutable canonical args
  policyVersion: string;
  approvedBy: PrincipalRef; // verified authorized non-model principal
  authorizationDecisionId: string;
  approvedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  consumedByEffectId: string | null; // one bound effect, not a reusable grant
};

type ChatJob = {
  id: string;
  schemaVersion: number;
  conversationId: string;
  trustDomainId: string;
  requester: PrincipalRef;
  inputMessageId: string;
  inputFingerprint: string;
  idempotencyScope: string;
  turnSequence: number;
  contextRevision: number | null; // fixed at claim after prior turn resolves
  engine: Engine;
  engineAuthorizationId: string;
  engineAuthorizationSnapshot: FrozenEngineAuthorization;
  requestedPolicyVersion: string;
  capabilityGrantId: string; // server policy, never owner OAuth substitution
  state: JobState;
  blockReason: BlockReason | null; // required iff state === "blocked"
  attempt: number;
  claim: null | {
    sessionId: string;
    worker: WorkerIdentity;
    writerEpoch: string;
    tokenDigest: string;
    claimedAt: string;
    heartbeatAt: string;
    leaseExpiresAt: string;
    attemptDeadlineAt: string;
  };
  cancelRequestedAt: string | null;
  cancelRequestedBy: PrincipalRef | null;
  completionFingerprint: string | null;
  completionReceiptId: string | null;
  supersedesJobId: string | null;
  createdAt: string;
};

type WorkerSession = {
  id: string;
  worker: WorkerIdentity;
  engine: Engine;
  conversationId: string; // immutable pin
  trustDomainId: string; // immutable pin
  threadBindingId: string | null;
  authorizationId: string;
  openedAt: string;
  hardExpiresAt: string;
  revokedAt: string | null;
  maxActiveJobs: 1;
};

type ChatJobEvent = {
  id: string;
  conversationId: string;
  jobId: string;
  sequence: number; // conversation-scoped durable replay order
  attempt: number;
  operationId: string;
  kind: "admitted" | "claimed" | "progress" | "effect_dispatched"
      | "cancel_requested" | "completed" | "failed" | "cancelled"
      | "indeterminate" | "blocked" | "reconciled";
  payload: unknown; // replace with a bounded discriminated union validator
  occurredAt: string; // authority/coordinator time
};
```

Runtime validators must enforce the state/reason invariant and all timestamp formats on both incoming payloads and restored rows. `OperationApproval` represents an actual approved decision; pending/rejected requests are separate durable records, not fabricated approved rows. Enforce non-model approver identity and authorization in the service even though `PrincipalRef` alone cannot express that proof.

A conversation row needs an approved, versioned `engineAuthorization` reference and durable `nextTurnSequence`, `nextEventSequence`, `activeJobId`, and a context revision/resolution boundary. The single writer allocates and updates them atomically. Multiple simultaneous human submissions can be admitted, but only the earliest eligible turn can be claimed. Context for a turn includes only allowed messages/results up to its boundary, not later queued messages. Event ordering is unrelated to wall-clock timestamp sorting.

**Done when:** storage and schema decisions are backed by executable evidence, all authoritative writers are enumerated, and no queue invariant depends on an unverified CRDT/CAS assumption.

## QUEUE-02 — Atomically admit a message, job, and event

### Tasks and subtasks

- [ ] Provide the canonical same-origin authenticated submission service **`POST /api/chat/conversations/:id/messages`** used by UI-01; do not introduce a competing global messages/admission endpoint. Apply SEC-01 session validation and cookie-auth CSRF/origin defenses; CORS alone is not authorization.
- [ ] Accept a client-generated idempotency key, bounded message content/attachment references, and a strict engine-selection discriminant. The conversation ID comes from the canonical route; any duplicated body ID must match. Selection is either `conversation` (resolve the already-approved conversation `engineAuthorization`) or `explicit_selection` (a strictly validated approved authorization reference/selection). No omitted/unknown selector, arbitrary provider configuration, or worker-invented consent may silently authorize sharing. Never accept authoritative requester IDs or tool privileges from the request body.
- [ ] Resolve and freeze consent/engine configuration inside the serialized admission boundary: persist the authorization ID, version, immutable snapshot/hash, selection source, approving principal, sharing limits, cost/replay policy, and expiry with the job/receipt. An approved conversation authorization avoids asking for fresh consent on every message within its scope; explicit selection must independently satisfy current authorization. Missing, revoked, or out-of-scope authorization rejects admission with a safe actionable error, without partial message/job/event creation. Later conversation defaults never retarget an admitted job; current revocation still prevents claim/dispatch.
- [ ] Validate membership, conversation status, attachment access/content digests, engine/sharing consent, quota, and capability grant under the serialized admission operation. Recheck mutable authorizations in the transaction/ordering boundary.
- [ ] Define a versioned canonical JSON fingerprint over all behavior-affecting admission inputs: authenticated requester scope, conversation, content, immutable attachment digests, engine choice/config authorization, policy/grant selection, and input protocol version.
  - [ ] Reject non-JSON values and ambiguous representations; normalize defaults once. Sort object keys recursively, preserve array order and message whitespace, and define Unicode handling. Do not hash unspecified serialization.
  - [ ] Do not include timestamps, fresh random row IDs, or retry counters in the fingerprint.
  - [ ] Namespace deterministic IDs with application identity + requester issuer/subject + conversation + idempotency key using unambiguous encoding. Do not concatenate unchecked delimiter-bearing strings.
  - [ ] Same key/same fingerprint returns the original committed receipt; same key/different fingerprint is a conflict, never an overwrite. On a retry, compare the submitted selection/content against the receipt's **frozen** resolved authorization, not the conversation's possibly changed default. Returning an authorized receipt is not reauthorization to execute. Keys in another principal/conversation scope must not expose the original receipt.
- [ ] Within **one accepted transaction**, insert the human message, `chatJobs` row, `admitted` event, and admission receipt, and advance conversation counters. If permission validation or any write fails, none is admitted.
- [ ] Return `202` with stable message/job/receipt IDs and replay cursor only after authoritative commit. The UI may display a separate local “sending” draft but must not treat it as an accepted queue row.
- [ ] On lost acknowledgement, retry the exact admission key/payload or query its receipt. A commit-wait deadline produces an unknown/temporarily unavailable response, not “definitely failed” and not permission to create another job.
- [ ] Resolve ambiguous commits before releasing the writer gate for dependent operations; make failure/unknown state observable without exposing request content in logs.
- [ ] Enforce initial configurable limits: message 16 KiB UTF-8, at most 8 attachment references, 5 queued jobs per requester and 30 per conversation, bounded global backlog for this Mac. Tune with QUEUE-07 instead of treating family size as unlimited capacity.

### Proposed QueueStore abstraction — explicitly not Jazz API

`transaction` below is an **application contract to implement**, not a claimed Jazz isolation mode. Its promise resolves only after accepted commit. All helper methods shown are proposed domain operations. No external model/device/network effect is allowed inside a retried transaction callback.

```ts
interface QueueStore {
  transaction<T>(fn: (tx: QueueTx) => Promise<T>): Promise<T>;
  // Must serialize through the authoritative writer, resolve commit ambiguity,
  // and expose only authority-accepted state to dependent operations.
}

interface QueueTx {
  assertMaySubmit(actor: PrincipalRef, input: AdmissionInput): Promise<void>;
  findAdmission(scope: string, key: string): Promise<AdmissionReceipt | null>;
  resolveApprovedEngineAuthorization(
    actor: PrincipalRef, input: AdmissionInput,
  ): Promise<FrozenEngineAuthorization>;
  allocateTurnAndEvent(conversationId: string): Promise<{
    turnSequence: number; eventSequence: number;
  }>;
  insertAdmissionBundle(bundle: AdmissionBundle): Promise<void>;
}

// AdmissionInput/Receipt/Bundle, canonicalJson, deriveIds, admissionScope,
// fingerprintAdmission, and buildAdmissionBundle are proposed protocol helpers.
// Implement and validate these explicitly; they are not imported Jazz methods.
async function admit(
  store: QueueStore,
  actor: PrincipalRef, // supplied by authenticated server context
  input: AdmissionInput,
): Promise<AdmissionReceipt> {
  const scope = admissionScope(actor, input.conversationId);
  const ids = deriveIds(scope, input.idempotencyKey);
  return store.transaction(async (tx) => {
    // Validate actor/access and strict input shape; do not re-resolve a default
    // before checking a retry's immutable receipt. Receipt reads stay scoped.
    await tx.assertMaySubmit(actor, input);
    const prior = await tx.findAdmission(scope, input.idempotencyKey);
    if (prior) {
      const fingerprint = fingerprintAdmission(actor, input, prior.engineAuthorizationSnapshot);
      if (prior.fingerprint !== fingerprint) throw new IdempotencyConflict();
      return prior;
    }
    const engineAuthorizationSnapshot = await tx.resolveApprovedEngineAuthorization(actor, input);
    const fingerprint = fingerprintAdmission(actor, input, engineAuthorizationSnapshot);
    const order = await tx.allocateTurnAndEvent(input.conversationId);
    const bundle = buildAdmissionBundle({
      actor, input, engineAuthorizationSnapshot, fingerprint, ids, order,
    });
    await tx.insertAdmissionBundle(bundle);
    return bundle.receipt;
  });
}
```

The verified Jazz call shape an adapter can build on is:

```ts
// Existing API shape, not a complete QueueStore or concurrency proof.
const result = await db.transaction(async (tx) => {
  const row = await tx.one(app.remoteCalls.where({ id: callId }));
  if (!row || row.status !== "pending") return "not_pending" as const;
  tx.update(app.remoteCalls, callId, { status: "executing" });
  return "claimed" as const;
});
const acceptedOutcome = await result.wait({ tier: "global" });
// Do not execute based on result.value before this wait succeeds.
```

Production claim code must also perform all identity, expiry, policy, and fence checks from QUEUE-03/05; the short excerpt only demonstrates transaction/handle syntax. `db.batch` is not a replacement. A bounded conflict retry may re-read authoritative state, but timeout/disconnect does not cancel an in-flight commit. Test missing-row reads, rejected local speculative state, counter updates, and delayed old batches. If accepted state cannot be distinguished from a still-pending client branch, quarantine that connection and pause the writer until resolved.

**Done when:** deterministic retry tests and real-authority fault tests show one complete admission bundle or no accepted bundle, including acknowledgement loss and process restart.

## QUEUE-03 — Implement claims, conversation lanes, and leases

### Tasks and subtasks

- [ ] Implement a fair local scheduler: round-robin across eligible conversations/requesters, FIFO within a conversation, one active turn per conversation. Start with one active model job for the Mac; make higher global concurrency an explicit measured setting.
- [ ] Claim only committed queued work. In one transaction, read the session, job, conversation lane, requester authorization, and current engine/policy grant; set the active lane, increment attempt, generate a fresh fence token, and append `claimed`.
- [ ] Store the full authenticated worker binding (issuer/subject/client/grant), session ID, attempt, token digest, writer epoch, claim time, heartbeat, lease expiry, and absolute deadline. Return plaintext token only to the claiming worker after commit. Never place it in transcript text, event streams, or logs.
- [ ] Validate every mutating worker request against **all** claim fields and current job/lane state, not just possession of `jobId` or matching owner subject. Check current requester membership, worker grant revocation, device grant, session pin, engine, and policy as applicable.
- [ ] Make claim and heartbeat operations idempotent with operation IDs/receipts. A lost claim reply must recover the same claim without incrementing attempts or claiming a second job; design secure proof recovery (for example, principal-bound retained encrypted reply material) rather than assuming a token digest can reconstruct a secret.
- [ ] Use coordinator-controlled time. Reject client timestamps for authority decisions. Validate timestamps and safe finite clock values at runtime, including restored rows; malformed/missing dates or `NaN` must fail closed, not pass a comparison with expiry. On Mac sleep/wake, long pauses, backward clock jumps, or uncertain clock/authority health, invalidate or pause claims conservatively; never extend a stale lease because a browser reports activity.
- [ ] Use short leases and bounded calls, with proposed initial values:
  - [ ] Worker heartbeat every 30 seconds, soft claim lease at most 90 seconds.
  - [ ] Hard worker session duration at most 25 minutes, **experimental**, beginning at session open. A late claim receives only the remaining session budget.
  - [ ] `leaseExpiresAt = min(now + softLease, attemptDeadlineAt, session.hardExpiresAt, applicable authorization expiry)`. Heartbeats cannot extend the hard deadline.
  - [ ] Queue operations have short request deadlines; a worker wait returns within 10 seconds with a job or idle/backoff. No 25-minute HTTP request or continuous browser fetch is needed.
  - [ ] Near hard expiry, stop admitting new effects and checkpoint. At expiry, fence new work even if an old process still runs.
- [ ] Treat supervisor/device/HTTP health and worker heartbeat as separate signals. The server cannot truthfully heartbeat on behalf of a ChatGPT turn that stopped making calls.
- [ ] On expiry, bump/invalidate the fence before any possible reassignment. Do not immediately requeue jobs with dispatched effects; route them to reconciliation. Even generation-only work may have provider cost or a lost result, so retry behavior must be authorized.
- [ ] Preserve lane ownership until the turn is completed or safely resolved. An indeterminate external effect blocks subsequent dependent turns; do not let a later turn reason as if it never happened.

### Fence validation sketch

```ts
// Proposed domain pseudocode, executed under QueueStore's serialization gate.
// Require the canonical UTC representation used by new Date(ms).toISOString().
// The finite and round-trip checks also reject invalid/normalized calendar dates.
function timestampMs(value: unknown): number {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new StaleClaim();
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new StaleClaim();
  }
  return ms;
}

function assertActiveClaim(
  job: ChatJob,
  session: WorkerSession,
  proof: ClaimProof,
  authenticatedWorker: WorkerIdentity,
  now: number,
): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new StaleClaim();
  const c = job.claim;
  if (!c || job.state !== "running" || job.cancelRequestedAt !== null) throw new StaleClaim();
  if (!sameWorker(c.worker, authenticatedWorker)) throw new Forbidden();
  if (!sameWorker(session.worker, authenticatedWorker)) throw new Forbidden();
  const hardExpiry = timestampMs(session.hardExpiresAt);
  const leaseExpiry = timestampMs(c.leaseExpiresAt);
  const attemptDeadline = timestampMs(c.attemptDeadlineAt);
  if (session.revokedAt !== null || hardExpiry <= now) throw new StaleClaim();
  if (session.conversationId !== job.conversationId ||
      session.trustDomainId !== job.trustDomainId || session.engine !== job.engine) {
    throw new Forbidden();
  }
  if (proof.jobId !== job.id || proof.sessionId !== c.sessionId ||
      proof.sessionId !== session.id || proof.attempt !== job.attempt ||
      proof.writerEpoch !== c.writerEpoch ||
      !verifyTokenDigest(proof.fencingToken, c.tokenDigest)) throw new StaleClaim();
  if (leaseExpiry <= now || attemptDeadline <= now ||
      leaseExpiry > attemptDeadline || attemptDeadline > hardExpiry) {
    throw new StaleClaim();
  }
  // Also verify the current coordinator epoch, active conversation lane,
  // worker/requester grants, engine consent, and current effective policy.
}
```

`sameWorker`, `verifyTokenDigest`, and error types are proposed helpers. Runtime validators must also enforce valid nonempty IDs, positive safe-integer attempts, bounded token encoding, grant bindings, and chronological consistency of session/claim/heartbeat times before this sketch runs. The implementation must execute the policy/lane/epoch checks noted in the sketch, not leave them as comments. Do not implement authorization by casting untrusted request data into these types. Raw `Date.parse(value) <= now` is unsafe because invalid input produces `NaN`, whose comparison is false; the helper explicitly rejects invalid input. Apply the same fail-closed parsing to approval/consent expiry and recovery code. For a duplicate operation already committed, a separately authenticated, scope-bound receipt lookup can return its unchanged outcome; this is not permission for an expired claim to perform a new mutation.

**Done when:** two claimants never receive authority to execute the same attempt, stale workers cannot write or dispatch, and later conversation turns cannot overtake unresolved earlier turns.

## QUEUE-04 — Add bounded worker sessions and engine adapters

### Tasks and subtasks

- [ ] Define one engine interface independent of provider/UI mechanics. Local workers and API workers use the same queue semantics as ChatGPT, but may have different wakeup and context-isolation implementations.
- [ ] Make session opening require an explicit server-side worker authorization, approved engine, conversation pin, trust-domain pin, and sharing consent. The worker may request a binding; only the server validates and resolves it.
- [ ] Distinguish the OAuth worker principal from the family requester. Use a dedicated workflow-only grant/client/token classification. If the provider token cannot be reliably distinguished/restricted from an unrestricted owner token, **do not enable the worker**.
- [ ] Replace the current assumption `buildServer(claims.sub)` is enough for all callers: resolve a validated request security context including token purpose, client/grant, and scopes. Register the permitted surface and enforce it again inside each dispatch service.
- [ ] Worker credentials must be denied direct `call_device_tool`, `list_devices`, controls including shutdown/reconnect, and equivalent REST/admin routes. Omission of a worker-session argument cannot turn a worker request into an owner request. Unknown session/fence/token-purpose fields fail closed.
- [ ] Do not attach an unrestricted owner connector beside a restricted worker connector in the same model context. Where that cannot be prevented or verified, document the limitation and refuse the private-worker use case.
- [ ] Resolve job context server-side after claim: requester-visible messages through the fixed context boundary, tool results for that job, necessary policy instructions, and bounded attachment data. Never fetch a global family history and filter after sending it to the model.
- [ ] Treat transcript/tool text as untrusted data. Instructions inside a message cannot change the pin, requester, engine, device scope, or session policy. Progress events are not a channel to store hidden chain-of-thought; store concise operational summaries only.
- [ ] For ChatGPT, create a new approved thread binding for each permitted conversation/domain. Do not repin a thread after session close, expiry, or worker restart. A model-supplied thread label is not authenticated evidence of thread isolation; explicitly record whether binding is operator-attested or verifiable by the actual integration.
- [ ] Limit ChatGPT to one claimed job at a time. Require the operator to start/continue a worker turn when needed. A logical session lease cannot force the ChatGPT UI/plan to remain alive, autonomously wake, or repeatedly poll.
- [ ] Expose provider/session health separately from durable job state: `available`, `awaiting_worker`, `working`, `stale`, `disabled`, plus last real heartbeat and hard expiry. Map an eligible queued job with no live authorized worker to the shared UI projection **`waiting_for_worker`**; map durable approval blocks to **`awaiting_approval`**. Internal adapter health `awaiting_worker` is not a second public job-status spelling. “Session opened” must not imply “always-on worker.”

### Proposed bounded MCP tool contracts

All inputs use strict runtime schemas and reject unknown fields. All outputs have structured schemas plus a compact text summary. Proposed initial request-body ceiling: 64 KiB; output ceiling: 64 KiB (lower per-tool limits below). Operation IDs and user keys: 8–200 characters; IDs: validated opaque IDs; page limits capped on the server. Rate-limit by authenticated worker/session and requester, not IP alone. The table defines the **canonical family-prefixed worker tool names** for the shared protocol; these are planned tools, not a claim that exports already exist.

| Tool | Minimal input | Authoritative behavior and bound |
|---|---|---|
| `open_family_worker_session` | `authorizationId`, `conversationId`, `engine`, `operationId`, optional approved `threadBindingId` | Resolve identity from verified OAuth context; create immutable pin; hard TTL no more than 25 minutes; return session, expiry, limits. No arbitrary requester/device policy parameters. |
| `claim_family_chat_job` | `sessionId`, `operationId`, `waitMs` 0–10,000 | Claim at most one eligible job inside that pin. Return claim proof, small job summary, context revision, or `idle` with bounded backoff. Never return family-wide queue contents. |
| `heartbeat_family_chat_job` | proof, `operationId`, bounded progress label | Revalidate live claim and authorization, extend soft lease within hard expiry, report cancellation/deadline. Progress text at most 1 KiB. No fabricated continuation. |
| `read_family_job_context` | proof, opaque cursor, `limit` 1–50 | Return claim-scoped context only; at most 32 KiB per page. Bind cursors to session/job/context revision; reject cross-job cursors. |
| `append_family_job_event` | proof, `operationId`, allowed kind, bounded payload | Only worker-allowed progress/checkpoint kinds; payload at most 4 KiB, with per-attempt count/rate cap. Server creates sequence, identity, timestamp; workers cannot emit terminal/authority events arbitrarily. |
| `call_family_job_tool` | proof, stable `operationId`, permitted capability ID, bounded arguments | QUEUE-05 policy/approval checks; create a durable approval block when required, otherwise admit the effect/call. Return approval reference or call ID/state promptly, never owner-level raw dispatch. Arguments at most 32 KiB and tool-specific bounds. |
| `read_family_job_tool_result` | proof or authorized receipt reference, call ID, cursor | Return only this job's delegated call state and bounded result page; at most 32 KiB. A pending response is not a retry instruction. |
| `complete_family_chat_job` | proof, `operationId`, final text/result reference, result fingerprint version | Server validates/hashes final payload (text at most 32 KiB), resolves outstanding effects, atomically commits assistant message + final event + terminal state + lane release + receipt. Caller hash alone is not trusted. |
| `fail_family_chat_job` | proof, `operationId`, enum failure code, summary | Summary at most 2 KiB. Server derives `failed`, `blocked`, or `indeterminate` from effect ledger; worker cannot claim “no effects” without evidence. |
| `close_family_worker_session` | `sessionId`, `operationId`, reason enum | Revoke/fence session in bounded transaction. Active work enters recovery rather than disappearing or silently requeuing. Duplicate close returns the same receipt. |

#### Research-name compatibility map (conceptual only)

| Research term | Canonical contract | Constraint |
|---|---|---|
| `next_chat_job` | `claim_family_chat_job` (then `read_family_job_context` as needed) | Bounded wait and authority-accepted fenced claim; no unscoped queue read. |
| `publish_chat_reply` | `complete_family_chat_job` | Atomic final message/state/event/receipt commit, not an independent optimistic message insert. |
| `renew_family_worker_session` | `heartbeat_family_chat_job` for an active claim; `open_family_worker_session` only for a separately authorized new bounded session | No renewal tool that extends a session's hard expiry. Heartbeats only renew the soft lease within the original hard limit. Opening another session is not automatic renewal, does not revive an old claim, and cannot repin an existing ChatGPT thread to another domain. |

These are research vocabulary mappings, **not registered aliases or an additional tool surface**. A new session requires fresh authorization validation and explicit continuation under the same conversation/thread constraints; no loop of reopen calls may manufacture unbounded worker authorization or a liveness guarantee.

Human submission, approval decisions, cancellation, receipt reads, and authorized event replay use `/api/chat/...` service routes, not an owner-only backdoor for the worker. Submission remains `POST /api/chat/conversations/:id/messages`. Approval decisions require a verified authorized non-model principal and are not included in the worker tool surface. A proposed human `cancel_family_chat_job` wrapper, if later exposed through MCP, must call the same cancellation service with the human principal and must not be silently granted to workers for arbitrary family jobs.

Stable error codes should include `forbidden`, `stale_claim`, `session_expired`, `idempotency_conflict`, `commit_unknown`, `queue_paused`, `quota_exceeded`, and `effect_indeterminate`. Return actionable safe state/receipt references; do not suggest redispatch on every timeout. Tool annotations are hints, not authorization. Mark claim/completion/event tools as mutations, and tool invocation as potentially destructive; do not advertise exactly-once external effects.

### Engine interface sketch

```ts
// Proposed protocol/service boundary, not a provider SDK integration.
interface ChatEngineAdapter {
  readonly kind: Engine;
  startAuthorizedAttempt(input:
    | { mode: "push"; claim: ClaimProof; contextRevision: number;
        engineAuthorizationId: string }
    | { mode: "pull"; jobId: string; engineAuthorizationId: string }
  ): Promise<{ status: "started" | "awaiting_worker" }>;
  requestStop(input: { jobId: string; attempt: number }): Promise<{
    acknowledged: boolean; // acknowledgement does not prove effects were undone
  }>;
}
```

For a pull-based ChatGPT adapter, `startAuthorizedAttempt` receives the `pull` variant without a fabricated claim and may only report `awaiting_worker` until a real tool call claims work. It must not return `started`, disclose protected context, or execute tools without an accepted claim. Validate adapter mode against engine authorization at runtime; the `push` variant requires an already accepted live claim. Do not create a claimed job on behalf of an absent ChatGPT turn. A local/API adapter may actively run under the local coordinator, with isolated context and bounded provider requests. Neither adapter gets backend Jazz credentials or unrestricted device-owner credentials.

**Done when:** direct-call bypass tests pass, the context pin has an honest documented assurance level, and ChatGPT remains disabled wherever consent or isolation cannot be established.

## QUEUE-05 — Delegate effects through the existing device bridge

### Tasks and subtasks

- [ ] Refactor the implementation-side remote-call router into durable admission/status operations and an optional bounded wait wrapper. Preserve existing non-worker behavior where safe; do not require a chat worker HTTP call to wait for a 120-second device operation.
- [ ] Introduce a trusted delegation service that resolves, from the claimed job:
  - requester issuer/subject and current conversation membership;
  - actual device owner/credential binding, separately from requester identity;
  - device sharing grant and policy version;
  - allowed tools/capability IDs, argument/path/network restrictions, confirmation requirements, and expiry;
  - job/session/attempt/fence and stable effect operation identity.
- [ ] Calculate effective permission as the intersection of current requester permission, conversation policy, explicit device-sharing grant, job grant, worker's narrow grant, and device capability. Never use the union with the owner's privileges. Revocation narrows immediately; an old policy snapshot is audit evidence, not permanent authority.
- [ ] Implement durable operation-bound approval when effective policy requires confirmation. Persist a pending request binding job ID, stable operation ID, device/capability, canonical immutable argument hash/version, policy version, and expiry; commit `blocked` with reason `approval` and its event before returning `awaiting_approval`. No executable `remoteCalls` row may be admitted merely by requesting approval.
  - [ ] An approval decision must be an actual service-owned `OperationApproval` record approved by an **authenticated, authorized non-model principal**. Resolve the approver and authority from SEC-01/SEC-02, not a body field. Worker/model credentials, assistant messages, a UI label, and conversation engine consent cannot approve device operations.
  - [ ] Bind approval to the exact job/operation/device/capability and immutable server-computed argument hash. Changed arguments, target, policy scope, or expired/revoked authority require a new approval decision; never silently reuse a consent flag or approve a wildcard operation.
  - [ ] Consume/link approval atomically with admission of its single effect. Duplicate transport requests return the original bound effect receipt; the approval cannot authorize a second execution. Recheck current approval, approver authority, job fence, and policy before device claim; approvals do not override cancellation or revoked grants.
  - [ ] Persist approval/rejection/revocation and corresponding events through the Unix-socket writer. Resume an approved blocked job only after revalidating policy, effects, and lane ownership; transition it to eligible queued work for a fresh fenced claim rather than reviving an expired claim. Approval waiting does not extend the session hard deadline. Denial/expiry stays explicitly blocked or is explicitly cancelled according to policy, never auto-approved.
- [ ] Treat a shared Mac as a shared OS execution environment, not automatic per-family filesystem isolation. Exclude unrestricted shell and arbitrary read/write from private capability sets unless SEC-02 has enforced an appropriate sandbox/path policy. Tool names alone cannot constrain shell escape paths or symlinks.
- [ ] Persist an effect intent, its remote-call row or protected link, and `effect_dispatched` event atomically before dispatch. Store immutable argument fingerprint and requester/delegation provenance in service-owned fields.
  - [ ] Preserve the current semantic role of `remoteCalls.ownerId` as the **device-owner authorization identity** unless the entire device Jazz/claim permission model is migrated in one reviewed change. Add protected requester/delegation fields (or a protected effect mapping) for the family member, parent job, grant, operation ID and fingerprint. The browser/worker must never be able to supply or rewrite those authority fields.
  - [ ] Update device-claim authorization to require both sides: the device credential still matches the device owner/client, and the server-owned delegation still authorizes the original family requester/job. Do not make either identity impersonate the other.
- [ ] Define a stable effect operation ID across transport retries and recovery. Do not derive it solely from a new attempt ID, because that turns retries into new side effects. Same operation/different tool or arguments is a conflict.
- [ ] Before the device's claim authorizes local execution, atomically/order-consistently revalidate pending call, device credential, active parent job/fence, expiry, cancellation, requester sharing grant, and effective tool policy. A call admitted before lease expiry must not execute after expiry just because the device receives it late.
- [ ] Reuse `MCPDevice` → `RemoteChannel.markCallExecuting` → control-plane claim → `DesktopCommanderIntegration.callClientTool` → stdio. Extend the claim response/protocol only where needed to carry trusted authorization/fence material or cancellation/result evidence; do not replace the executor.
- [ ] Strip or reject reserved delegation keys in user/model metadata. Never trust `_meta` merged from an untrusted caller as an authority-bearing context. Validate tool argument bounds both before remote admission and at the relevant execution boundary.
- [ ] Track effect states such as `prepared`, `pending`, `executing`, `completed`, `failed_before_execution`, `cancelled_before_execution`, `indeterminate`. Record execution/reporting errors separately and distinguish tool `isError` from transport success.
- [ ] Separate DC execution failure handling from completion-reporting failure. Retain/retry the **same** result submission with a deterministic completion fingerprint; never rerun the tool to recover a lost completion acknowledgement. If a durable result outbox is necessary, add it in DC only with focused storage/retention tests.
  - [ ] Current DC `handleNewToolCall()` catches both tool-execution errors and `updateCallResult(..., "completed")` persistence errors, then attempts a `failed` completion. That can mislabel a successfully executed side effect as failed. Split these phases before any destructive family capability is enabled: a post-effect report failure remains `executing/report_unknown` until same-result reconciliation or server expiry makes it `indeterminate`; it must not be converted to a fresh failure that invites replay.
- [ ] Validate device completion against call ID, device credential/client, effect linkage, claim generation, and terminal fingerprint. A duplicate same result is acknowledged; conflicting terminal payload is rejected and audited, not silently accepted as `already_terminal`.
- [ ] Do not declare general exactly-once external effects. Fence tokens can prevent new dispatch and stale state mutation but cannot undo a file deletion, sent message, or still-running subprocess that crossed the boundary before cancellation.

### Delegation sketch

```ts
// Proposed service path. resolveDelegation is server-owned; the worker cannot
// supply requester identity, owner credentials, or its own effective policy.
async function callJobTool(requestContext: VerifiedWorkerContext, input: JobToolInput) {
  return queueStore.transaction(async (tx) => {
    const job = await tx.requireActiveClaim(requestContext, input.proof);
    const delegation = await tx.resolveDelegation(job, input.capabilityId);
    const args = validateCapabilityArguments(delegation, input.arguments);
    await tx.assertCurrentPolicy(delegation, args);
    const operation = await tx.prepareOrReadImmutableOperation({
      job, delegation, operationId: input.operationId, arguments: args,
      argumentHashVersion: ARGUMENT_HASH_VERSION,
      argumentHash: hashCanonicalArguments(args),
    }); // conflicts on any changed job/operation target or arguments
    const approval = await tx.findValidOperationApproval(operation, delegation);
    if (delegation.requiresApproval && !approval) {
      // Commit a pending approval request + block reason + event, not a remote
      // call. Returning commits the block; throwing would roll it back.
      return tx.blockForApproval(job, operation);
    }
    return tx.admitEffectAndRemoteCall({
      job, delegation, operation, approval,
    }); // atomically consumes/links required approval to this one effect
  });
  // Return accepted call identity; execution occurs only after the device claim.
}
```

These additional transaction methods/types are proposed extensions to the QUEUE-02 abstraction, not existing Jazz calls. `ARGUMENT_HASH_VERSION` and `hashCanonicalArguments` are proposed versioned protocol helpers using QUEUE-02 canonicalization rules. `findValidOperationApproval` must verify the server-owned decision, exact immutable argument/target binding, authorized non-model approver, policy, revocation, and finite unexpired timestamps. `admitEffectAndRemoteCall` must independently enforce any required approval and receipt deduplication; a caller cannot bypass it by passing `null`. `blockForApproval` preserves lane ordering, suspends/fences further work, and cannot create executable device work. The old `dispatchRemoteCall(subject, ...)` cannot simply be invoked with the worker owner's subject. Where `remoteCalls.ownerId` remains the device owner for existing device authorization, preserve that compatibility while recording and independently enforcing the **requester's** delegated rights. Do not relabel the requester as owner to make the old check pass.

**Done when:** a worker cannot execute beyond the claimed requester's permissions, delayed calls are rejected after fencing/revocation, and lost results cannot trigger duplicate destructive execution.

## QUEUE-06 — Durable replay, completion, cancellation, recovery, and fallback

### Event replay and completion

- [ ] Serve authenticated `GET /api/chat/conversations/:id/events?after=...` with a durable conversation-scoped cursor, bounded pages (initially 100 events / 64 KiB), explicit `hasMore`, and permission rechecks on every read/reconnect.
- [ ] Use Jazz subscriptions or bounded SSE/polling only as notifications. Durable events are the source of truth; a reconnect must replay committed events even if every live notification was lost. UI-01 deduplicates by event ID/sequence, never timestamp or array position.
- [ ] Include durable state, typed `blockReason`, and authorized approval/engine/reconciliation record references in snapshots and replay. Derive `waiting_for_worker` and `awaiting_approval` consistently for UI-01; never infer approval from a progress label or persist projection-only statuses as job state.
- [ ] Couple job changes, event append, and conversation sequence update in one transaction. Heartbeat data need not flood the transcript; important state transitions must have durable events. Bound progress event count/rate and paginate outputs.
- [ ] On completion, check active claim and effect ledger; commit assistant message, final job state, completion fingerprint/receipt, terminal event, context revision advance, and lane release together. The model's plain ChatGPT reply is not automatically the family app's committed answer.
- [ ] If completion is committed but its response is lost, allow an authenticated same-session/principal, same-operation/same-fingerprint receipt read even after lease expiry. This read-only acknowledgement does not mutate a stale attempt. A different result must conflict.
- [ ] If the model produced an answer but no completion was committed, show unresolved work. Recover a retained payload through a valid claim or explicit reconciliation; do not fabricate an answer or blindly rerun the whole job.
- [ ] Define retention across messages, events, admission receipts, completion receipts, and remote calls. Keep idempotency tombstones for at least the maximum supported retry window; reject an expired old key explicitly rather than silently treating it as a new request. Do not delete an unresolved effect or its evidence.
- [ ] If a replay cursor predates compaction, return an explicit reset response with an authorized snapshot and watermark. Verify snapshot + replay has no gaps. Do not reveal deleted/revoked conversation content via retained receipts.

### Cancellation and expiry

- [ ] Authorize human cancellation by requester/conversation policy; atomically set cancellation intent, record actor/reason and event, and fence new claims/tool dispatch. Use an operation ID so repeated cancellation is stable.
- [ ] Queued, never-dispatched work can become `cancelled` and release its lane atomically. For running work, use `cancel_requested`, ask the adapter/device to stop, and inspect effect state before selecting the final outcome.
- [ ] A rejected/aborted HTTP call is not evidence that a device subprocess stopped. Actual cancellation capability must be verified per tool/transport. Unsupported or uncertain abort leads to `indeterminate` or blocked reconciliation, not a false “cancelled with no effects.”
- [ ] Define the completion/cancellation race by authoritative serialization: a committed completion first remains completed; committed cancellation first rejects new normal completion and effects. Later factual device results go through reconciliation and must not overwrite the cancellation history.
- [ ] Expire pending remote effects before device claim where possible. Do not reuse the same job lane for a dependent turn while an old destructive process may still be running.

### Restart and reconciliation

- [ ] On coordinator startup, obtain exclusive writer ownership, load accepted session/job/effect state, establish a new writer epoch, and invalidate old worker sessions/claims before admitting more work. Preserve authenticated read access to immutable receipts where authorized.
- [ ] Resolve unknown admission/completion batches by deterministic receipt lookup against settled authority state. Prove absence before reissuing a write; a single temporarily empty replica read is insufficient.
- [ ] Scan `running`, `cancel_requested`, pending/executing effects, orphaned lane references, and interrupted sessions. Distinguish no-dispatch, confirmed terminal, active execution, and unknown outcome. New claims must not race the recovery scan.
- [ ] For jobs with no external effect, retry only under an explicit configured authorization covering provider replay/cost; otherwise mark awaiting resumption/blocked. Increment attempt and use a new fence. Preserve the same admitted input and turn order.
- [ ] For destructive or unknown effects, do **not** automatically replay. Mark indeterminate, retain the lane block, display known evidence, and request an authorized reconciliation decision. An operator may confirm an observed result or explicitly approve a new action after inspecting the Mac; record the decision and its evidence.
- [ ] Late device completion may be attached by a trusted reconciliation path bound to the original effect/call/client/attempt. It cannot let a stale worker mutate the current job or replace a later final answer. Reconcile the effect first, then resolve the job/lane according to policy.
- [ ] Update cleanup so expiry/grace/retention predicates are rechecked inside the serialized transaction, not only on an earlier scan. Make cleanup honor active job references, receipt retention, and indeterminate evidence. Do not run an independent backend cleanup writer outside the gate.
- [ ] Document Mac restart/sleep, authority unavailable, expired OAuth grants, revoked device, corrupt/missing data, and disk-full behavior. Default to pause/fail closed rather than resetting all jobs to queued.

### Explicit engine fallback only

- [ ] No automatic switch from ChatGPT to a paid API or remote engine on idle/timeout/plan failure. Also do not treat switching to a local engine as inherently safe to replay device effects.
- [ ] Require a durable authorization decision by an authorized non-model principal naming the destination engine/provider/model, permissible context/attachments/tool results, trust-domain compatibility, expected cost or cap, replay policy, expiry, and who may approve it. Resolve it from an approved versioned conversation `engineAuthorization` or strict explicit selection and freeze it for the new job; do not mutate the predecessor's frozen consent. While an engine decision is needed, use `blocked` with reason `engine`; unresolved effect outcomes instead carry a reconciliation record/reason. Reject fallback if these are absent or current membership/consent changed.
- [ ] Preserve the original job/attempt and receipt history. Create a separately identified continuation/replacement job linked by `supersedesJobId` (or an explicitly modeled authorized continuation); freeze/fence the predecessor first and ensure only one owns the conversation lane.
- [ ] Reconcile all existing effects before continuation. Reuse result evidence rather than issuing the same destructive actions again. If a genuinely new effect is authorized, give it a new explicit operation identity and explain why it is not a retry.
- [ ] Rebuild only destination-authorized context. Do not export a contaminated ChatGPT transcript, hidden memory, unrelated family context, or a whole queue snapshot to the fallback provider.

**Done when:** reconnects produce complete authorized history, stale completions cannot overwrite newer state, and every uncertain external effect remains visible and non-replayed until explicitly resolved.

## QUEUE-07 — Deterministic tests, integration gates, and rollout

### Deterministic idempotency examples

The following is test-harness pseudocode, not an available test runner or fixture API. Implement fixtures with a fake clock/explicit barriers, then run equivalent cases with independent clients against the real local authority. No test should depend on hoping two requests overlap during a sleep.

```ts
it("same admission key and canonical payload produce one bundle", async () => {
  const h = await queueHarness();
  const a = h.input({ idempotencyKey: "submit-key-001", text: "Dinner?" });
  const b = h.inputWithReorderedObjectKeys(a);
  const [r1, r2] = await Promise.all([
    h.admit(h.alice, a), h.admit(h.alice, b),
  ]);
  expect(r1).toEqual(r2);
  expect(await h.acceptedCounts()).toEqual({ messages: 1, jobs: 1, admittedEvents: 1 });
});

it("same key with changed semantic input conflicts without a second message", async () => {
  const h = await queueHarness();
  const a = h.input({ idempotencyKey: "submit-key-002", text: "Read the note" });
  await h.admit(h.alice, a);
  await expect(h.admit(h.alice, { ...a, text: "Delete the note" }))
    .rejects.toMatchObject({ code: "idempotency_conflict" });
  expect((await h.acceptedCounts()).messages).toBe(1);
});

it("lost admission ACK survives writer restart without duplicate work", async () => {
  const h = await durableQueueHarness();
  const input = h.input({ idempotencyKey: "submit-key-003" });
  h.failpoints.dropResponseAfterAuthorityCommit("admission");
  await expect(h.admit(h.alice, input)).rejects.toThrow();
  await h.restartWriterAndReconcile();
  const receipt = await h.admit(h.alice, input);
  expect(receipt.jobId).toBe(await h.onlyAcceptedJobId());
  expect((await h.acceptedCounts()).admittedEvents).toBe(1);
});

it("a stale claim cannot cause an effect or replace a completion", async () => {
  const h = await queueHarness();
  const old = await h.claimNext();
  h.clock.advanceBeyondLease();
  await h.expireAndFence();
  await expect(h.callTool(old.proof, "effect-key-001"))
    .rejects.toMatchObject({ code: "stale_claim" });
  await expect(h.complete(old.proof, "late answer"))
    .rejects.toMatchObject({ code: "stale_claim" });
  expect(await h.executedEffectCount()).toBe(0);
});
```

### Required acceptance matrix

- [ ] **Canonical fingerprints:** reordered object keys match; array reorder, whitespace change, engine change, attachment digest change, capability grant change, and policy-selection change conflict appropriately. Define behavior for null/default/omitted fields, Unicode, invalid JSON, oversized keys, and delimiter characters. Same key under another principal/conversation neither collides nor leaks receipts.
- [ ] **Consent resolution/freeze:** test approved conversation authorization versus strict explicit selection; reject missing/unknown selectors, unapproved configurations, revoked grants, and out-of-scope sharing. Change conversation defaults after admission and retry the original key: return the original frozen receipt without retargeting the engine. A changed explicit selection conflicts; revocation blocks future execution even when receipt recovery remains authorized.
- [ ] **UI projection/block reasons:** verify `queued` with no eligible live worker projects `waiting_for_worker`; only durable approval requests with `blocked`/`approval` project `awaiting_approval`. Engine/reconciliation blocks retain their reason/reference across restart/replay. Terminal/cancellation/indeterminate evidence takes precedence. No projection-only status is persisted as `JobState`, and assistant text cannot synthesize an approval.
- [ ] **Operation approval:** forge the approver or approval in worker payloads/messages; use a non-authorized human, another job/operation/device/capability, changed immutable arguments/hash version, expired/revoked approval, or changed policy. All must fail closed. Approve through an authorized non-model principal and verify exactly one bound effect admission, duplicate receipt recovery, no second execution, and fresh claim validation after approval wait. Consent to an engine is not approval of a device operation.
- [ ] **Atomic admission:** inject failure before each write, callback throw, authority rejection, disconnect before/after commit, response loss, and process death. The accepted state is a full bundle or none; optimistic local rows never wake a worker.
- [ ] **Authority contention gate:** force two independent backend clients/processes to read the same missing deterministic ID or same pending job before either commits. Observe accepted outcomes, `transaction_conflict`/typed rejection behavior, counter updates, and whether absence/predicate reads are validated. Repeat with authority and client restarts and delayed pending batches. Do not infer success solely from one in-memory mutex test.
- [ ] **OPS ingress boundary:** from the public origin, allow only approved routes and deny `/api/device` and descendants, `/api/mcp`, and raw Jazz (including encoded/trailing-slash/normalization variants and WebSocket upgrades). Verify router `127.0.0.1:3000` → Next `127.0.0.1:3001`, private Jazz `127.0.0.1:1625`, no public queue-writer listener, and no Auth SQLite exposure. Test private device authentication and Unix-socket permissions/caller validation independently of ingress denial.
- [ ] **Canonical worker names:** advertise only the family-prefixed contract; research `next_chat_job`, `publish_chat_reply`, and `renew_family_worker_session` are not callable aliases. Repeated heartbeat/reopen attempts cannot extend an existing hard deadline, revive a stale claim, or bypass explicit authorization and thread pinning.
- [ ] **Single-writer guard:** attempt overlapping local coordinators, Next.js workers/HMR, and cleanup. Only one can mutate; simulate owner death and verify restart gate/receipt reconciliation before reopening. Verify an unknown commit blocks dependent mutations and does not hang HTTP indefinitely.
- [ ] **Lane serialization:** concurrent admissions to one conversation are ordered; two engines cannot process different turns there simultaneously. A second conversation gets fair service, and a blocked/indeterminate turn does not silently advance its own lane. Later queued text is absent from earlier-turn context.
- [ ] **Claim fencing:** wrong issuer/subject/client/grant, wrong session, different job, wrong attempt/epoch/token, expired soft lease, hard expiry, revoked authorization, and a delayed heartbeat all reject. Lost claim ACK recovers the same claim securely. Cancellation racing heartbeat never resurrects a cancelled claim. Test malformed/missing/empty timestamps, calendar rollover dates, invalid date objects after serialization, `NaN`/infinite clock values, and lease/deadline ordering violations; all fail closed before any mutation or effect.
- [ ] **Durable completion:** drop the response after final commit; retry same operation/payload without a duplicate assistant message/event. Try different payload/fingerprint and stale-attempt writes. Read-only receipt recovery after expiry succeeds only for the bound authorized principal and does not reopen the claim.
- [ ] **Delegation isolation:** Alice's claimed job cannot execute Bob's capability, even when the worker owner owns both devices. Forge requester/owner in body and `_meta`; call direct tools by raw MCP JSON-RPC; use `/api/mcp`, device-admin REST routes, missing session fields, or an unregistered tool name. All bypass attempts must fail closed.
- [ ] **Device boundary:** delay pending delivery past job cancellation/expiry/revocation; device claim refuses execution. Kill stdio child before/after effect, lose claim ACK, lose result ACK, report `isError`, and submit conflicting terminal results. Existing supervision cannot turn uncertain destructive work into a replay.
- [ ] **Cancellation races:** test before admission ACK, while queued, after claim/before dispatch, during effect, after device result/before assistant completion, and after final commit. Assert honest UI status and lane ownership in every case; no claim that cancellation undid an effect.
- [ ] **Recovery/retention:** stop/restart coordinator, device, and authority independently with disk state preserved. Test pending global writes, Mac sleep/clock jump, disk-full persistence errors, old cursors, compaction, tombstones, and orphaned references. Do not run destructive faults on live family storage.
- [ ] **Fallback:** missing consent, changed sharing policy, cost-cap failure, incompatible trust domain, and unresolved effects all prevent replay/switch. An approved transition creates durable lineage and exactly one active lane; no unexpected provider request or data export occurs.
- [ ] **Bounded contracts:** validate body and UTF-8 output ceilings, event rate caps, pagination/cursor scope, quotas, cancelled long polls, malformed payloads, token redaction, and permission revocation during replay. A 15-person load test must remain bounded in memory/subscriptions/backlog.
- [ ] **Migration rehearsal:** test additive schema rollout on copied data, schema/runtime mismatch refusal, older DC compatibility, permission changes, downgrade/restore, and no client write bypass. Record exact commands only after verifying the installed tooling supports them.

### Mandatory actual ChatGPT plan/turn experiments

Mocks and a 25-minute lease setting do not satisfy this gate. Test with the actual intended ChatGPT account plan, model, connector, client/browser, and reachable canonical origin; record date/version/settings because platform behavior can change.

- [ ] Explicitly enable a non-sensitive shared test conversation and verify OAuth workflow-only grants, tool discovery, bounded claims, a committed family answer, and real heartbeat timestamps.
- [ ] Observe whether the model actually continues claiming/polling while idle, whether the turn ends, and whether new messages require manual continuation. Do not interpret an open tab/session as a live worker.
- [ ] Exercise 20/23/24/25-minute boundaries with safe read-only fixture work; record actual tool timing and any plan/turn timeout. Try backgrounded/closed browser, disconnected network, ended turn, reauthorization, and model/tool-call limits. No test may rely on a single 25-minute HTTP call.
- [ ] Demonstrate recovery when the model ends after generating text but before `complete_family_chat_job`, and after completion commits but before its response is seen.
- [ ] Seed a synthetic secret in one test conversation, then attempt to reuse that ChatGPT thread for another. Verify the **server refuses repinning**; do not claim the model forgot the secret because a context endpoint was scoped. Test memory/project/file/connector settings and record any unverifiable isolation assumptions.
- [ ] Confirm worker tool permissions remain derived from the job even when the account owner could ordinarily operate the Mac. Prove raw direct calls are blocked, not merely absent from the prompt.
- [ ] Record a clear pass/fail outcome: if reliable continued polling is unavailable, label ChatGPT **manual/turn-driven experimental worker** in UI-01 and keep local/API adapter alternatives separately opt-in. Do not call it an always-on family service.

### Rollout checklist

- [ ] First ship protocol/storage/queue tests with a fake engine and read-only fixture device capability.
- [ ] Enable local execution with one worker, one test conversation, and no destructive tools. Verify actual restart/replay behavior on local Jazz storage.
- [ ] Add per-requester permissions and isolated family conversations before inviting roughly 15 users; test concurrency and quotas with synthetic data.
- [ ] Enable external/API engines only with explicit sharing/cost authorization; enable ChatGPT only after its separate opt-in/privacy/liveness gates.
- [ ] Add destructive capabilities only after device completion ambiguity and cancellation tests pass and reconciliation UX exists.
- [ ] Publish a local operator runbook: authoritative data location and backups, pause/drain procedure, blocked/indeterminate job inspection, session revocation, explicit reconciliation/resume, and version/schema compatibility checks. Do not prescribe resetting the database as normal recovery.
- [ ] Export local operational metrics: accepted/queued/running/blocked/indeterminate counts, oldest queued age, commit failures/unknowns, lease expiries, last genuine worker heartbeat, replay lag, effect-reporting failures. Exclude message text, model context, tokens, and sensitive tool args; do not require hosted telemetry.

**Done when:** the deterministic and real-authority tests pass, privacy/delegation bypass tests pass, and the actual ChatGPT experiments either support the claimed operating mode or leave that adapter disabled/clearly manual and experimental.

## Integration target map for later implementation

All “proposed” paths below identify implementation targets to reconcile with the companion CORE, SEC, UI, and OPS contracts; they do not establish that implementation is already present. Verify current directories and conventions before editing them.

| Responsibility | Existing integration point | Proposed implementation target / constraint |
|---|---|---|
| Shared domain/schema | `packages/protocol/src/application-schema.ts`, `src/schema.ts` | Add validated queue types (for example `src/chat-queue.ts`), row definitions/exports, bounded tool contracts, fingerprint versions, and migration compatibility rules. Do not import an unrelated reference chat schema wholesale. |
| Backend durability | `apps/control-plane/lib/jazz-context.ts`, `lib/jazz-principal.ts`, `scripts/jazz-authority.ts` | Proposed `lib/chat-queue/store.ts` and `lib/chat-queue/authority.ts`; one local Unix-socket writer, commit/unknown handling, private Jazz at `127.0.0.1:1625`, no extra database. Auth SQLite remains. Keep secrets server-side. |
| Admission/scheduling | Existing auth/service conventions under `apps/control-plane` | Proposed `lib/chat-queue/admission.ts`, `claims.ts`, `scheduler.ts`, `recovery.ts`; same store gate for all state changes. |
| Human API/UI | Canonical `/chat` from CORE-01 and UI-01 | Proposed `app/api/chat/...` routes; thin validated handlers over queue services. Canonical submission is `POST /api/chat/conversations/:id/messages`; UI shows pending draft vs accepted message, durable replay, `waiting_for_worker`/`awaiting_approval` projections, typed block reasons, frozen consent, operation-bound approvals, cancellation and reconciliation. |
| Worker MCP surface | `app/mcp/route.ts`, `app/api/mcp/route.ts` | Proposed `lib/chat-queue/worker-tools.ts`, `sessions.ts`, `engines/`; verified token-purpose dispatch, workflow-only grants, immutable pin. Only `/mcp` is public; OPS denies `/api/mcp` at ingress. Any retained internal compatibility handler still enforces identical authorization. |
| Local ingress / private services | CORE-01 origin and main OPS topology | Router `127.0.0.1:3000` → Next `127.0.0.1:3001`; default-deny public route allowlist excludes `/api/device` and descendants, `/api/mcp`, and raw Jazz. Private device requests retain authentication; queue coordination uses the local Unix socket. |
| Effective permissions | `permissions.ts`, `lib/jazz-principal.ts`, existing auth/device-request helpers | Extend Jazz read policies/deny client mutations; central SEC-02 delegation service enforced for all tool/REST paths. Backend privilege is never sufficient proof of authorization. |
| Device-call admission | `lib/call-router.ts` | Split admit/read/bounded-wait, add protected job/effect linkage and deterministic operation receipts; preserve existing callers where compatible. |
| Device claim/results | `app/api/device/calls/[id]/claim/route.ts`, `complete/route.ts` | Revalidate parent claim/current policy at execution admission; fingerprint results, separate uncertain reporting, support trusted reconciliation. |
| Expiry/retention | `scripts/cleanup-calls.ts` | Make cleanup queue-aware and use the single writer. Preserve unresolved effects and retry receipts. |
| DC bridge, only as necessary | DC `src/remote-device/device.ts`, `remote-channel.ts`, `control-plane-client.ts`, `desktop-commander-integration.ts` | Keep MCPDevice/RemoteChannel/stdio execution. Add protocol support for verified delegation/fencing, actual cancellation capability, or durable completion replay only where integration tests prove it necessary. |
| DC budget | DC `src/utils/work-lifecycle.ts`, `src/server.ts` | Keep defensive budget independent of job/session leases. Do not repurpose process-wide `current.json` as a per-conversation queue or extend HTTP lifetimes. |
| Validation | Existing implementation tests plus DC `test/test-remote-device-supervision.js`, `test/test-remote-jazz-safety.js`, `test/test-work-lifecycle.js` | Add queue-specific harnesses and cross-process authority tests; retain existing supervision/lifecycle coverage. Discover exact test commands from the then-current manifests before running. |

## Remaining decisions and explicit stop gates

1. **Authority semantics:** the installed APIs support transaction grouping and global persistence waits, but the required contention, absence-read, delayed-batch, restart, and storage durability behavior must be demonstrated. The target is a gated single local Unix-socket writer under the shared OPS topology, not an invented Jazz CAS.
2. **Schema evolution:** current application schema has no chat queue. Supported alpha.53 deployment/migration behavior and mixed-version compatibility are unproven; rehearse on copied local data before changing production rows.
3. **Principal/delegation model:** SEC-01/SEC-02 must supply family identities, sharing grants, worker token-purpose enforcement, capability/argument restrictions, and authorized non-model approval decisions bound to immutable job operations. An owner token plus a job ID is not delegation; a projection label is not an approval record.
4. **ChatGPT context isolation:** application pin enforcement cannot prove what a remote model remembers. No private-conversation guarantee is permitted for a reused owner thread; opt-in domain pinning and honest limitations are mandatory.
5. **ChatGPT liveness:** 25 minutes is an experimental logical session cap, not a platform promise. Actual plan/turn tests determine whether this is a manual worker, a briefly live worker, or disabled.
6. **External effects:** current DC result reporting and MCP cancellation do not establish reversible or exactly-once execution. Destructive work remains gated on reconciliation and no-blind-replay behavior.
7. **Fallback/cost/privacy:** no provider switch or replay occurs without explicit, durable authorization covering destination, context, cost, and outstanding effects.

These are implementation gates, not reasons to replace local Jazz with a hosted database or move application services off the Mac.
