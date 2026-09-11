# Local Mac MCP + family chat implementation plan

**Status:** planning pack plus implementation-status supplements. The original task checkboxes remain planning artifacts; `06-MVP-WITHOUT-CHAT.md` and `07-SERVICE-OVERVIEW-IMPLEMENTATION-REPORT.md` record the separately implemented and tested MVP state.

**Date:** 2026-09-08. **Planning branch:** `docs/local-mac-mcp-chat-plan`.

**Branch base:** `19addf3c7fb5af82bb36424ccca3c003030c4832`, branched from `feat/passkey-only-registration`. Pre-existing staged, unstaged and untracked work was retained; the branch is not an isolated clean implementation baseline. No commit, push, stash, reset or dependency installation is part of this planning task.

## The result we are planning

```text
ChatGPT app endpoint:  https://your-stable-origin/mcp
Family chat UI:        https://your-stable-origin/chat
Existing auth:        https://your-stable-origin/api/auth/...
```

The hostname above is illustrative. The provisioned deployment uses one immutable HTTPS origin. `/chat` is a sibling of `/mcp`, not `/mcp/chat`.

Every application-owned process and persistent store runs on the owner's MacBook: local ingress, Next.js/React UI and API, Better Auth/SQLite, Jazz authority, chat coordinator, MCPDevice and Desktop Commander stdio. A tunnel is external transport; ChatGPT or another remote model is an explicitly selected external inference provider. A local model is an optional all-local inference path. No hosted application server, cloud database, hosted Jazz or VPS is required.

**Excluded:** OpenAI Secure MCP Tunnel. **Not promised:** availability while the Mac sleeps/offline, autonomous 25-minute ChatGPT execution, free model API usage, or privacy between unrelated chats processed in one shared model conversation.

## Read in this order

1. [Architecture and core tasks](01-ARCHITECTURE-AND-CORE-TASKS.md) — deployment boundaries, route contract, evidence, compatibility gates and CORE-01/02.
2. [Reference and UI tasks](02-REFERENCE-AND-UI-TASKS.md) — verified Jazz example, what to port/reject, UI-01–UI-10, TypeScript/React examples.
3. [Queue and worker tasks](03-QUEUE-AND-WORKER-TASKS.md) — QUEUE-01–QUEUE-07, durable Jazz admission, claims/fences, engine adapters, device delegation and recovery examples.
4. [Security, operations and acceptance](04-SECURITY-OPERATIONS-AND-ACCEPTANCE.md) — SEC-01–SEC-04, OPS-01–OPS-04, local supervision, approvals and 23 acceptance scenarios.
5. [Continued review findings](05-CONTINUED-REVIEW-FINDINGS.md) — second-pass code-backed findings, explicit P0 blockers, startup/config split and decisions that survived review.
6. [MVP without chat](06-MVP-WITHOUT-CHAT.md) — implemented private-MVP scope and accepted runtime state.
7. [Service overview and implementation status](07-SERVICE-OVERVIEW-IMPLEMENTATION-REPORT.md) — current codebase review, user-facing capabilities, implemented/planned matrix and implementation roadmap.
8. Diagrams: [architecture](architecture.mmd), [job sequence](job-sequence.mmd), plus the [service overview diagram set](diagrams/).

This pack has **27 top-level tasks**, with detailed checklist subtasks, dependencies, proposed file locations, examples and acceptance criteria. All implementation checkboxes start unchecked. These are repository documents, not automatically created external task-tracker entries.

## Decisions made by this plan

| Decision | Choice and reason |
| --- | --- |
| Application home | Extend the existing separate `implementation/apps/control-plane`; do not scaffold another chat platform in DC |
| UI reference | `garden-co/jazz/examples/auth-betterauth-chat`, full reference SHA `6d352663f8e03278b0007752e27213a6062d5917` |
| Port boundary | Borrow presentation/composer/permission-aware UX, not demo auth, anonymous accounts, browser Jazz connection or direct row mutations |
| Authentication | Preserve existing SQLite-backed Better Auth/passkeys/OAuth; server-side session and grant enforcement |
| Browser data path | Authenticated same-origin `/api/chat`, bounded snapshots + SSE/poll replay; no browser-to-Jazz socket |
| Durable state | Local Jazz with separate `chatJobs` and existing `remoteCalls`; no new cloud queue/database |
| Public/private boundary | Proposed local ingress at loopback 3000, Next backend at loopback 3001; explicit public allowlist blocks private device/Jazz/admin paths |
| Queue authority | One local supervised coordinator over an owner-only Unix socket; verified Jazz authority acceptance before dependent effects |
| Initial load | Approximately 15 browser users, one active reasoning job globally and one active turn per conversation; measure before widening |
| First real AI experiment | Opt-in ChatGPT workflow worker with harmless shared/synthetic conversation content; short calls and a hard 25-minute maximum lease |
| Tool execution | Reuse MCPDevice/RemoteChannel/stdio bridge; requester-scoped delegation and durable approval, not worker-owner escalation |
| Recovery | Stable receipts, fenced claims and indeterminate effect handling; no blind destructive replay |
| Optional AI engines | Local model or explicit paid API adapter only by approved choice; no silent fallback |

The extra ingress boundary addresses a concrete research flaw: tunneling a loopback Next.js listener publishes its served routes, including `/api/device/*`, unless a real route/listener boundary prevents it. “Local port” alone does not make a tunneled route private.

## Task index

Priority definitions: **P0** contract/security gate, **P1** required feature/runtime, **P2** hardening/release. P2 does not mean optional if the corresponding release gate applies.

| ID | Task | Priority | Main dependencies | Future scope |
| --- | --- | --- | --- | --- |
| CORE-01 | Origin, public route inventory, client eligibility | P0 | None | CP + DC deployment contracts |
| CORE-02 | Version/build/protocol/reference baseline | P0 | None; coordinate CORE-01 | CP + IMPL protocol + DC |
| SEC-01 | Identity, family membership, revocation | P0 | CORE-01/02 | CP auth/policy + protocol |
| SEC-02 | Effective device capabilities and approvals | P0 | SEC-01, CORE-02 | CP policy/claim + targeted DC |
| SEC-03 | Public HTTP, safe logs, model-output safety | P0 | CORE-01, SEC-01 | CP/ingress + targeted DC |
| SEC-04 | Local persistence, secrets, recovery | P0 | CORE-02, SEC-01 | Local runtime + CP/DC state |
| UI-01 | Reference/adaptation provenance | P1 | Verified reference inventory | CP documentation/notices |
| UI-02 | API-facing view contracts | P0 | CORE-01, SEC-01, QUEUE-01 | CP chat contracts |
| UI-03 | Authenticated shell and navigation | P1 | UI-01/02, CORE-01, SEC-01 | CP `/chat` |
| UI-04 | Bounded conversations and timeline | P1 | UI-02/03, QUEUE-01 | CP chat components |
| UI-05 | Idempotent composer | P1 | UI-02/04, QUEUE-02 | CP composer/API |
| UI-06 | SSE/poll reconnect and cleanup | P1 | UI-02/04, CORE-01, QUEUE-02 | CP event routes/hooks |
| UI-07 | Permission, approval and cancellation UX | P1 | UI-04–06, SEC-01, QUEUE-01/02 | CP chat actions |
| UI-08 | Engine and honest worker status | P1 | UI-04/06/07, QUEUE-01 | CP status components |
| UI-09 | Responsive/accessibility refinement | P2 | UI-03–08 | CP styling/a11y tests |
| UI-10 | Browser/API integration acceptance | P2 | UI-01–09 and their contracts | CP tests |
| QUEUE-01 | Model/schema and authority proof | P0 | CORE-02, SEC-01 | IMPL protocol + CP coordinator |
| QUEUE-02 | Atomic message/job/event admission | P1 | QUEUE-01, CORE-01, SEC-01/02 | CP services |
| QUEUE-03 | Claims, lanes, leases and scheduling | P0 | QUEUE-01/02, SEC-01/02 | CP coordinator |
| QUEUE-04 | Workflow sessions and AI adapters | P1 | QUEUE-03, CORE-01, SEC-01/02 | CP MCP/worker |
| QUEUE-05 | Delegated device effects | P0 | QUEUE-03/04, SEC-02, CORE-02 | CP remoteCalls + targeted DC |
| QUEUE-06 | Replay/cancellation/recovery/fallback | P0 | QUEUE-02–05 | CP coordinator/events/cleanup |
| QUEUE-07 | Queue faults and real-engine acceptance | P2 | QUEUE-01–06 and security contracts | CP/DC integration tests |
| OPS-01 | Local runtime, ingress and writer ownership | P1 | CORE-01/02, SEC-03/04 | CP local services, DC runtime |
| OPS-02 | Durable tunnel/client interoperability | P1 | OPS-01, CORE-01, SEC-03 | Local ingress + DC providers |
| OPS-03 | Restart, backup/restore and rollback drills | P2 | OPS-01/02, QUEUE-06, SEC-04 | Disposable deployment |
| OPS-04 | End-to-end release evidence | P2 | UI-10, QUEUE-07, SEC-01–04, OPS-01–03 | Both applications, real clients |

## Recommended delivery slices

### M0 — Freeze the contract before coding

Complete CORE-01/02 and the SEC-01/02 identity/capability designs. Verify the target runtime instead of assuming reference versions are compatible. Record actual ChatGPT plan eligibility and durable hostname choice. Keep all device capabilities disabled for chat.

**Exit:** reviewed origin, route inventory, auth/worker identity model, schema/version baseline, and reference-port exclusions. If the ChatGPT plan cannot run required workflow tools, record the blocker; do not implement browser automation or silently buy API inference.

### M1 — Safe local family UI with deterministic fake replies

Implement minimal SEC/OPS foundation, QUEUE-01/02, and UI-01–06. Use one fake worker fixture to prove admission, accepted receipts, conversation isolation, ordered messages, replay and restart. Label fake responses as test-only; do not present this as a completed AI product.

**Exit:** two invited synthetic users can sign in and use `/chat` through the same origin while `/mcp` still works; other users' private content is inaccessible; public private-device/Jazz paths are denied; accepted messages survive restart.

### M2 — Prove the actual ChatGPT worker idea

Implement QUEUE-03/04 with workflow-only grants, one synthetic/shared-room conversation pin, bounded `claim` calls, final reply publication, idle/stale notices and hard expiry. Include API protocol and negative auth tests before using the real ChatGPT account.

**Exit:** real client performs open → claim → publish over multiple short calls. Record the 25-minute soak result honestly. If ChatGPT stops polling, `/chat` shows waiting and no new action is claimed on its behalf. Do not claim continuous availability.

### M3 — Add least-privilege computer actions

Implement QUEUE-05, SEC-02 enforcement and UI-07 approvals/cancel. Start with one fixture-folder read. Add one concrete disposable write only after proof-bound approval, device claim checks and lost-result behavior work.

**Exit:** unauthorized tools/paths are denied; user/model text cannot become owner privileges; the same logical effect cannot be blindly rerun after uncertainty; cancellation and late results are reconciled.

### M4 — Household hardening and operations

Complete QUEUE-06/07, UI-08–10 and all SEC/OPS acceptance. Test 15 browser sessions, real relay streaming, backup/restore, sleep/reboot and secret-lock failure. Roll out to a few invited users before the whole family.

**Exit:** OPS V-01–V-23 have explicit pass/blocked/not-run evidence. Required failed gates prevent enabling the related feature.

### M5 — Optional engine alternatives

Add a local-model adapter or explicit model-API adapter if wanted. Reuse queue/permissions/UI; keep engine authorization and per-conversation context isolated. Hybrid fallback is a later explicit policy, not a default timeout handler.

**Exit:** selected engine's privacy, cost, hardware, tool safety and recovery evidence is recorded. External API use remains opt-in and separate from ChatGPT billing.

## Implementation examples included

- Canonical MCP URL → sibling chat URL validation.
- Reference-aware React composer with stable idempotency keys and uncertain receipt handling.
- Server-authenticated chat route dependency boundary.
- Credentialed SSE lifecycle, bounded retry and cleanup.
- Typed engine-neutral jobs, sessions, claims and durable events.
- Authority-accepted Jazz transaction shape, with its concurrency limitations stated.
- Proposed QueueStore atomic admission contract and claim fencing validation.
- Workflow tool contract table and requester-derived device delegation.
- Deterministic admission/restart/stale-claim test sketches.
- Principal classification, capability intersection, approval transaction and allowlist audit examples.
- Nonsecret local runtime configuration and release evidence record.

**Example policy:** snippets labeled proposed/pseudocode describe interfaces to implement, not APIs asserted to exist. They do not replace strict runtime schemas, auth verification, transaction proofs, real device tests or target-project type checking. No future module is silently created by this plan.

## Scope and validation of this planning change

New artifacts are confined to `DC/docs/local-mac-mcp-chat/`. Existing research documents, diagrams, source, tests, dependencies, configurations and external workspaces are not rewritten by this task. Existing Git index entries remain as they were; a new branch does not clean or commit the inherited worktree.

Planning validation should check file links, unique task IDs, consistent route/state/limit contracts, code-fence pairing, diagram presence, final newlines and trailing whitespace. TypeScript/TSX parser checks, if available, validate syntax only. Real type-checking, runtime tests, Mermaid rendering, local deployment, provider setup and ChatGPT acceptance are separate evidence and must not be inferred from documentation checks.

## Supporting references

- Earlier local product research: [LOCAL-MAC-FAMILY-CHAT-JAZZ-ARCHITECTURE.md](../LOCAL-MAC-FAMILY-CHAT-JAZZ-ARCHITECTURE.md).
- Earlier one-laptop transport research: [STATIC-TUNNEL-CHATGPT-ARCHITECTURE-OPTIONS.md](../STATIC-TUNNEL-CHATGPT-ARCHITECTURE-OPTIONS.md). This pack does not adopt its excluded tunnel option.
- Primary UI source: https://github.com/garden-co/jazz/tree/6d352663f8e03278b0007752e27213a6062d5917/examples/auth-betterauth-chat
- Jazz local server guidance: https://jazz.tools/docs/getting-started/server-setup
- MCP specification: https://modelcontextprotocol.io/specification/ — pin actual client/server compatibility rather than assuming latest documentation matches both.
- ChatGPT account/tool eligibility: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt — recheck during CORE-01 and record actual client behavior.
- Existing provider material to recheck during OPS-02: https://tailscale.com/kb/1223/funnel and https://docs.zrok.io/.

Source URLs are reference/verification targets; their inclusion is not a claim that every page was fetched or that any service was tested during this planning change.
