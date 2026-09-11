# Reference review and family chat UI implementation tasks

Status: **docs-only plan; no application implementation or runtime validation performed.**

## 1. Scope and non-negotiable boundaries

Build an accessible family chat for approximately 15 people at `/chat`, a sibling of `/mcp` on the **same durable HTTPS origin**. All application services and persistence remain on the local Mac. The browser uses authenticated same-origin `/api/chat` routes for chat data: bounded GET snapshots and SSE/poll events, and POST mutations. Existing login/session routes remain the existing Better Auth routes; this does not mean moving login into `/api/chat`.

- `/chat` is a browser UI, **not** an MCP endpoint or a browser-to-Jazz client.
- No browser connection to localhost Jazz, no public Jazz endpoint, no browser database mutation, no Jazz backend credentials or worker credentials in client bundles.
- Retain the existing **Better Auth SQLite** identity/session store. Do not introduce a parallel account database or copy the reference's Jazz-backed auth tables, adapter, JWT-linking flow, anonymous accounts, seeding, or demo administration bootstrap.
- Port the reference's **visual organization, composer behavior, and permission-aware UX**, not its data/auth architecture. Server authorization is authoritative; hiding a button is not authorization.
- UI contracts are model-independent. An MCP ChatGPT worker is **experimental**, with no guarantee of continuous/background polling or execution. Sending a message must not silently enable a billed model API or imply that an assistant is always running.
- Origin provisioning, service supervision, networking, auth/security policy, and durable queue implementation belong to other plan owners. UI tasks consume their contracts, not alternate implementations.
- This document specifies future UI work only. Maintaining it does not authorize changes to application code, dependency configuration, reference checkouts, services or Git state. Preserve unrelated local work; implement application changes separately under the control-plane root.

**Future application target:** `/Users/test/Documents/RemoteMCP-Jazz/implementation/apps/control-plane` — separate from DesktopCommanderMCP. Every target path below is **proposed, relative to that application root**, not an assertion that a file/framework exists. Resolve actual routing, components, installed versions, and test tooling before implementing. DesktopCommanderMCP holds the plan only.

## 2. Verified reference identity and source evidence

Verification date: 2026-09-08. Reference root, abbreviated **R** below:

`/Users/test/Documents/RemoteMCP-Jazz/references/jazz-auth-betterauth-chat`

Example root, abbreviated **E** below: `R/examples/auth-betterauth-chat`.

| Item | Read-only evidence/result |
| --- | --- |
| HEAD | `git --no-pager rev-parse HEAD` → `6d352663f8e03278b0007752e27213a6062d5917`; claimed `6d35266` confirmed. |
| Origin | `git --no-pager remote get-url origin` → `https://github.com/garden-co/jazz.git`. This is a sparse Jazz monorepo checkout, not a standalone example repository. |
| Tracked worktree | `git --no-pager --no-optional-locks status --short --untracked-files=no` produced no tracked changes at inspection time. This is not a claim about ignored or untracked files. |
| License | `R/LICENSE:1–21`: MIT, copyright 2026 Garden Computing, Inc. and contributors; retain copyright and permission notice for copied/substantial portions. `R/LICENSE:23–27` excludes homepage webfonts under `docs/public/fonts/` from that MIT grant. Do not import those fonts without separate license review. |
| Search method | Reference CodeGraph availability: **NO INDEX**. No index was created. Used read-only Python filesystem listing/numbered source reads from DesktopCommanderMCP cwd; workspace package manifests outside the sparse checkout were read from existing Git objects. No environment/secret files were opened and no dependencies installed or reference services started. |

For indexed repositories, future source discovery must use CodeGraph. Do not retry/create the reference index as part of these UI tasks. The separate target application is outside this reference inspection: retaining existing SQLite auth is a design constraint, not an implementation claim verified by this document.

### 2.1 Component, auth, Jazz, and permission evidence

Line ranges below refer to the verified checkout/source, not installed runtime behavior.

| Evidence path and lines | Actual behavior | Port decision |
| --- | --- | --- |
| `E/src/ChatPanel.tsx:5–18,104–178` | Reusable panel props; title, read-only notice, empty state, author/time, delete action, pending/error composer. Uses `Intl.DateTimeFormat`. | Adapt presentation to server DTOs. Add explicit labels, multiline input, accessible action visibility and machine-readable `dateTime`. |
| `E/src/ChatPanel.tsx:29–58` | `useDb`, `useSession`, `useAll`; queries all matching messages ascending by timestamp; queries `db.canDelete` per message. | Do not port browser hooks, unbounded query, or per-row permission requests. Return bounded data plus server-computed capabilities. |
| `E/src/ChatPanel.tsx:66–101` | Client `db.insert` / `db.delete`, then `.wait({ tier: "edge" })`; clears text after success. | Preserve pending/error/draft experience, replace writes with idempotent POSTs. Edge synchronization is not proof that a durable assistant job was accepted/completed. |
| `E/src/AuthCard.tsx:14–59,98–132` | Controlled auth form, pending state, error handling, password reset when switching mode, labeled fields and autocomplete. | Reuse interaction principles only through the existing target auth UI. Do not create a second sign-up/login authority. |
| `E/src/AuthCard.tsx:65–95,134–136` | Shows Jazz account identity, sign-up mode, and demo admin sign-in instructions. | Prefer existing server-authenticated display name; omit demo credentials, anonymous identity, and open sign-up assumption. Family membership/invitation policy is SEC-01's decision. |
| `E/app/page.tsx:20–53` | Computes announcement send permission from client auth mode/role; shows Announcements and General panels; uses account ID as author label. | Useful read-only-room UX, not an ACL implementation or a mandate for exactly two rooms. Private conversations must not default to family-wide visibility. |
| `E/app/page.tsx:59–92,106–143` | Configures `JazzProvider` with public server URL and `initial="local-first"`; uses `useJazzAuth`, `loginOrRegisterJWT`, `linkJWT`, logout and `createLocalFirst`. | Entire provider/account lifecycle is excluded from the browser implementation. |
| `E/src/lib/auth-client.ts:1–22` | Better Auth React client with `jwtClient()`; token fetch for Jazz login. | Not needed for chat transport. Use the target's existing cookie session integration; no JWT in browser storage or SSE URLs. |
| `E/src/lib/auth.ts:11–51,54–68` | `jazzAdapter`, admin/bearer/JWT/nextCookies plugins; permissive demo password policy and startup user creation. JWT expiry in code is `1h`; payload contains top-level role/username. | Do not copy configuration, embedded development credentials, bootstrap, plugin assumptions, or adapter. Preserve SQLite auth. |
| `E/src/lib/auth-jazz-client.ts:20–45` | Global cached backend session, memory driver, backend-secret admission, readiness check, failed-session cache reset. | Backend-only reference, not durable queue design; memory storage and global cache do not establish restart durability. Do not port the auth backend. |
| `E/schema.ts:1–17` | Merges Better Auth schema with messages table containing author name, chat ID, text and timestamp. | Presentation field inspiration only. No job status/idempotency/approval/durable queue contract exists here. Do not merge auth schema into chat storage. |
| `E/permissions.ts:8–28` | Both known rooms readable; General insert allowed without external-login predicate; creator-bound General update/delete; admin Announcements mutations. Same predicate applies to old/new rows on update. | Preserve permission explanations and cross-room-move regression idea; reject anonymous access and role-only UI trust. Server SEC-01 ACLs determine actual access. |
| `E/schema-better-auth/schema.ts:66–90` | Denies ordinary CRUD on generated auth tables. | Confirms reference protections, but these are not tables to create in the target. |
| `E/next.config.ts:1–17` | `withJazz` development integration and embedded demo server configuration. | Do not copy dev server plumbing, public Jazz URL injection, or credentials. |
| `E/app/api/auth/[...all]/route.ts:1–11` | Next wrapper around the example's asynchronous Better Auth handler. | Evidence of example routing only; do not replace target auth routes. |
| `E/app/globals.css:1–20,50–61,243–282,365–430` | System fonts, card/grid layout, composer, breakpoints at 1024/720 px. | Adapt small semantic primitives and responsive intent; audit contrast, focus, touch and narrow screens rather than copying wholesale. |
| `E/app/globals.css:331–347` | Delete button defaults to opacity zero and appears on hover. | Do not reproduce hover-only discoverability; actions must remain visible/reachable on touch and keyboard. |
| `E/tests/browser/auth-betterauth-chat.test.ts:78–128` | Auth-table deny-all assertions; old/new update predicate equality; role/creator enforcement; explicitly allows anonymous General posting. | Translate relevant denial/ownership tests into HTTP API tests. Reverse anonymous-General expectation for authenticated family chat. These tests are Jazz permission tests, not proof of an accessible family UI. |
| `E/tests/server/auth.test.ts:6` | Test declares sign-up, sign-in, session JWT and logout through app auth handler. | Reference test intent only; not target session integration coverage. |

**Documentation drift:** `E/README.md:149–162` describes `JazzSessionProvider` / `useJazzSession`, while `E/app/page.tsx:4,83,106` actually uses `JazzProvider` / `useJazzAuth`. README JWT example at `E/README.md:82–92` says `30d` and nested `claims`; source `E/src/lib/auth.ts:32–47` says `1h` and top-level role/username. Prefer verified source when assessing this reference; none of these APIs/configurations are an instruction to install or port them.

### 2.2 Verified dependency versions, not target upgrade instructions

| Package/tool | Reference version/declaration | Evidence |
| --- | --- | --- |
| Better Auth | `1.7.1` | `E/package.json:14–20`; `R/pnpm-lock.yaml:375–379`. |
| React / React DOM | `19.2.4` / `19.2.4` | `E/package.json:19–20`; `R/pnpm-lock.yaml:389–394`. |
| Next.js | `catalog:default` → `16.2.11` | `E/package.json:18`; `R/pnpm-workspace.yaml:21–37`; `R/pnpm-lock.yaml:386–388`. |
| Jazz tools / NAPI | `workspace:*`; manifests at HEAD say `2.0.0-alpha.54` for both | `E/package.json:16–17`; `R/pnpm-lock.yaml:380–385`; Git-object source `packages/jazz-tools/package.json:2–5` and `crates/jazz-napi/package.json:2–5` at verified HEAD. Links are workspace source, not evidence of a published stable release or target compatibility. |
| TypeScript / Vite | `6.0.2` / `8.0.1` via catalog | `R/pnpm-workspace.yaml:29–37`; `R/pnpm-lock.yaml:417–422`. |
| Vitest / browser packages | `4.1.0` | `R/pnpm-workspace.yaml:25–26,37`; `R/pnpm-lock.yaml:408–413,429–431`. |
| Browser tooling | Lock importer uses Playwright `1.58.2`; React Vite plugin `6.0.1` | `R/pnpm-lock.yaml:405–413`; root `R/package.json:44`. |
| Runtime/package manager | Node `>=22.12`; pnpm `10.14.0` | `R/package.json:49–52`. |

No package installation, version migration, runtime compatibility, or reference test success is implied by this inventory. Inspect the target's actual dependency management before implementation; prefer its existing components/tooling. Do not add browser Jazz dependencies for this UI.

## 3. Dependency contract and proposed target map

External task IDs define prerequisite contracts; their inclusion does not imply that implementations already exist:

- **CORE-01 — origin contract:** authoritative durable origin, `/chat` and `/mcp` sibling routing, same-origin `/api/chat`, existing auth route integration, redirects and streaming behavior.
- **SEC-01 — identity/ACL:** current Better Auth SQLite session verification, family identity/membership, conversation/message/job capabilities, mutation CSRF/origin enforcement, revocation and safe errors.
- **QUEUE-01 — contracts:** bounded snapshot/event/mutation schemas, model-independent states, acceptance receipt, idempotency scope, approval and cancellation command semantics.
- **QUEUE-02 — durable jobs:** transactional acceptance, persisted jobs/messages/idempotency receipts, resumable events or resnapshot contract, recovery after restart, authoritative job transitions. UI cannot substitute an in-memory queue.

| UI task | Dependencies | Proposed target files (under separate application root) |
| --- | --- | --- |
| UI-01 Reference/adaptation record | Verified evidence above | `docs/chat-reference.md`, existing third-party notice location (resolve first) |
| UI-02 API-facing view contracts | CORE-01, SEC-01, QUEUE-01 | `src/chat/contracts.ts`, `src/chat/api-client.ts`, `src/server/chat/http.ts` |
| UI-03 Authenticated shell/navigation | UI-01, UI-02, CORE-01, SEC-01 | `src/chat/ChatPage.tsx`, `src/chat/FamilyHeader.tsx`, existing router's `/chat` entry |
| UI-04 Bounded conversation/timeline views | UI-02, UI-03, QUEUE-01 | `src/chat/ConversationList.tsx`, `src/chat/MessageTimeline.tsx`, `src/chat/view-store.ts` |
| UI-05 Idempotent composer | UI-02, UI-04, QUEUE-02 | `src/chat/Composer.tsx`, `src/chat/use-submit-message.ts` |
| UI-06 SSE/poll recovery | UI-02, UI-04, CORE-01, QUEUE-02 | `src/chat/use-chat-events.ts`, `src/chat/view-store.ts` |
| UI-07 Permission/approval/cancel UX | UI-04, UI-05, UI-06, SEC-01, QUEUE-01, QUEUE-02 | `src/chat/ApprovalCard.tsx`, `src/chat/MessageActions.tsx` |
| UI-08 Worker/status explanations | UI-04, UI-06, UI-07, QUEUE-01 | `src/chat/JobStatus.tsx`, `src/chat/WorkerNotice.tsx` |
| UI-09 Responsive/accessibility hardening | UI-03 through UI-08 | `src/chat/chat.css`, component accessibility tests |
| UI-10 Integrated acceptance/handoff | UI-01 through UI-09, CORE-01, SEC-01, QUEUE-01, QUEUE-02 | `tests/chat/*.test.ts`, `tests/e2e/chat.spec.ts`, `docs/chat-acceptance.md` |

Do not create these target files in DesktopCommanderMCP. The file names express responsibilities; adapt them to the existing target router/framework rather than scaffolding another application.

### 3.1 Canonical cross-plan vocabulary and routes

- Send: **`POST /api/chat/conversations/:id/messages`**. The validated path ID selects the conversation; the server derives identity and resolves authorization.
- Bounded snapshot: **`GET /api/chat/conversations/:id`**, with agreed pagination/limit parameters.
- Durable event replay, SSE or bounded polling: **`GET /api/chat/conversations/:id/events?after=<opaque-cursor>`**. `after` is the wire query key; a DTO's `eventCursor` supplies its value. Apply QUEUE replay bounds and resnapshot rules, not a separate UI event log.
- Canonical queue domain names are **`chatMessages`**, **`chatJobEvents`** and **`workerSessions`**. Original research names `messages`, `chatEvents` and `agentSessions` are aliases only, not additional tables or a parallel schema. Literal reference-source identifiers in section 2 remain evidence of that example, not target naming instructions. A DTO's `messages` collection is a view field, not a storage table name.
- Canonical durable QUEUE states: `queued`, `running`, `cancel_requested`, `blocked`, `completed`, `failed`, `cancelled`, `indeterminate`. `waiting_for_worker` and `awaiting_approval` are derived display projections; `offline` belongs only to connectivity. Preserve the durable state in DTOs alongside any projection (section 5.2).
- The server message-content limit is **16 KiB UTF-8 (16,384 bytes)**. An additional 8,000-character UI bound is allowed but cannot replace byte validation. Request-envelope, attachment, event and response limits are separate QUEUE contracts.
- ChatGPT consent and **`engineAuthorizationId`** are resolved and frozen server-side at admission from an explicitly authorized conversation setting, or supplied per request and explicitly validated against the authenticated actor, conversation, engine and consent scope. Sending alone is not consent. Exact idempotent replay retains the original frozen authorization; it must not switch engine, recipient scope or billing mode after conversation settings change. Execution still revalidates expiry/revocation and current policy; freezing does not make revoked authorization valid.

## 4. Detailed tasks and acceptance gates

### UI-01 — Freeze the reference/adaptation record

- [ ] Record full SHA, origin, license path, source evidence and package declarations above in the future target's provenance record.
- [ ] Identify any copied code/CSS and retain the MIT notice in the target's established third-party notices mechanism; keep system fonts unless separate font licensing is deliberately reviewed.
- [ ] Make a presentation-only adaptation checklist: card/header, author/time, empty/loading/error states, composer pending/draft preservation, read-only explanation, permitted actions.
- [ ] Explicitly reject auth adapter/schema, automatic registration/linking, anonymous accounts, seeded admin, demo secrets, public Jazz connection, `withJazz` and client-side database operations.
- [ ] Inspect target source using CodeGraph if indexed; verify routing, existing auth UI, styling, component/test conventions and package versions without changing them as part of discovery.

**Done when:** reviewers can distinguish each reused visual idea from deliberately excluded behavior. No dependency upgrade is justified solely by this reference's alpha/workspace APIs.

### UI-02 — Agree on browser/API view contracts

- [ ] Have CORE-01, SEC-01 and QUEUE-01 owners approve URL, DTO, error, cursor and capability contracts before wiring UI to real data.
- [ ] Keep all chat requests under same-origin `/api/chat`; mutations use POST. Never treat `/mcp` as a chat browser backend or connect to a Mac loopback service from a family device.
- [ ] Specify bounded conversation and message snapshots. **Proposed pagination limits:** 30 conversations/page, 50 messages/page, hard maximum 100 requested records. Enforce the canonical **16 KiB UTF-8 (16,384-byte) message-content limit** on the server and check it in the composer; retain an additional 8,000-character UI bound. The illustrative `maxLength`/`.length` bound counts UTF-16 code units, not bytes or grapheme clusters. Confirm separate request-envelope/response/event bounds with QUEUE; client checks never replace server enforcement.
- [ ] Include stable IDs, server timestamps, per-object revisions, opaque pagination/event cursors, visibility labels, authenticated viewer display name, capabilities, and safe job summaries. Do not return credentials, raw tool arguments, arbitrary filesystem paths, or unfiltered worker logs.
- [ ] GET never enqueues work, marks approvals, deletes content or creates anonymous accounts. A successful send returns a durable acceptance receipt with message/job IDs, not a fabricated assistant answer. Resolve and freeze explicit engine consent/`engineAuthorizationId` server-side per section 3.1; if the API accepts a per-request selection, validate it rather than trusting it. Missing consent must not silently admit ChatGPT-bound work.
- [ ] Agree typed error codes for unauthenticated, forbidden/hidden resource, validation, conflict, rate limit and unavailable service; map them to family-readable text without leaking internal errors.
- [ ] Specify `Cache-Control: no-store` for authenticated chat responses, credentialed same-origin fetch, and no shared/service-worker cache of private transcript data.
- [ ] Keep runtime validation at both ends; TypeScript types alone do not validate JSON. Unknown event/status versions trigger safe resnapshot or update-needed UI, not guessed success.

**Done when:** fixture snapshots/events/mutation results pass agreed validators, and all UI components can run from DTOs with no Jazz or database import.

### UI-03 — Authenticated family shell and origin navigation

- [ ] Add `/chat` through the target's existing router/layout, retaining existing `/mcp` behavior unchanged.
- [ ] Derive browser navigation from the current origin; do not hardcode a tunnel hostname, service port, or localhost. A server-rendered share link uses CORE-01's validated configured origin, never untrusted forwarded-host input.
- [ ] Show friendly signed-in identity, conversation navigation, visibility, connection status, worker notice, and existing sign-out entry. Do not expose raw Jazz account handles as names. Follow the family-notebook direction in UI-09: privacy and worker/connectivity status belong to the application header, not model-authored chat bubbles.
- [ ] For missing/expired session, show a sign-in explanation and use the existing auth flow; allow only validated same-origin return destinations such as `/chat`.
- [ ] Clear private view state, capabilities, active streams and pending UI callbacks on logout/account switch. Do not automatically resubmit a prior user's draft after another person signs in on a shared device.
- [ ] Separate session loading, authenticated empty state, no access, offline/unreachable server, and recoverable failure. Do not briefly render cached protected content while session identity is unresolved.

**Done when:** direct `/chat` loading and refresh work on phone/desktop under the durable origin, signed-out users see no transcript, and `/mcp` remains a sibling rather than a nested chat route.

### UI-04 — Bounded conversations and readable message timeline

- [ ] Use server-selected accessible conversations and server-issued capabilities; no client-side filtering of a family-wide transcript download.
- [ ] Make privacy visible beside the conversation title and before first send. Shared rooms are optional SEC-01 decisions, not the reference's broad-read default.
- [ ] Render author, server time (`<time dateTime="…">`), plain text with preserved line breaks, job association and authoritative status. Treat model/tool output as untrusted content; use React text rendering by default, no raw HTML.
- [ ] Add explicit older-message pagination with stable tie-breaking/cursors, deduplication by ID and revision, bounded retained pages, and a restore/older-history strategy. Never issue the reference's unbounded ascending query.
- [ ] Preserve scroll anchor when prepending history; only follow new messages if already near the end. Otherwise show an accessible “New messages” control without stealing focus.
- [ ] Handle empty conversations, long names/URLs/text, removed messages, permission changes and server-updated visibility. Purge a revoked conversation rather than leaving stale private content visible.
- [ ] Reconcile optimistic placeholders with accepted message IDs. Do not show duplicate rows when POST receipts and events arrive in either order.

**Done when:** bounded pages remain stable under concurrent arrivals, pagination and reconnect; another user's private conversation is neither downloaded nor displayed.

### UI-05 — Composer with stable idempotency and honest acceptance

- [ ] Use a labeled multiline textarea, explicit Send button, character/UTF-8-byte guidance and a read-only reason. Validate the frozen submission text against both the 8,000-character UI bound and the canonical 16,384-byte server limit. Default Enter to newline; optionally offer documented Ctrl/Cmd+Enter, respecting IME composition.
- [ ] Trim/validate meaningful text without silently altering an already-submitted command on retry. Disable repeat submission with a synchronous ref/mutex as well as visual pending state.
- [ ] Generate one opaque idempotency key **per send intent** and keep the exact payload/key until acceptance is reconciled. Transport retry reuses it; deliberate new send gets a new key only after the earlier outcome is resolved.
- [ ] Require QUEUE-02 to atomically scope the key to the authenticated actor/operation, compare the canonical payload, and return the original receipt on exact replay. Changed payload with reused key returns conflict, never a second job.
- [ ] Clear draft only after a validated durable acceptance receipt. Timeout, disconnect, malformed response and uncertain 5xx preserve the attempt as `indeterminate`; reconcile using receipt lookup or exact replay, not a fresh key.
- [ ] Keep drafts/attempts in memory by default. No browser durable offline queue, auth tokens in storage, or service-worker auto-send. If reload recovery of drafts is later desired, obtain an explicit shared-device privacy/storage policy first; durable accepted messages remain recoverable from server snapshots.
- [ ] Aborting an HTTP wait/unmount does not cancel accepted work. Expose job cancellation as a separate authorized POST, not `AbortController` semantics.
- [ ] Reject sends while known offline without promising local persistence; allow editing an unsubmitted draft. Keep a submitted unresolved payload immutable and offer reconciliation, not blind “send again”.

**Done when:** double-click/shortcut race, dropped acceptance response, duplicate delivery and retry produce at most one durable user message/job for a single intent; pending text is not lost or silently rebilled.

### UI-06 — Authenticated SSE with bounded polling fallback

- [ ] First fetch an authenticated bounded snapshot containing an event cursor at a consistent snapshot boundary. Subscribe from that cursor so changes between GET and stream establishment are replayed or cause an explicit resnapshot.
- [ ] Use cookie credentials on same-origin GETs/streams; never send session/JWT/backend credentials in query strings. Conversation IDs and opaque cursors are not authorization grants.
- [ ] Apply only validated, authorized events for the active conversation/identity epoch. Deduplicate by revision/event identity and ignore stale callbacks after room switch, logout or unmount.
- [ ] Reconnect with bounded exponential backoff and jitter, resuming the last applied cursor or taking a fresh bounded snapshot. Cap retry frequency; honor safe retry guidance and avoid per-row/per-job connections.
- [ ] Handle replay-window expiry, cursor invalidation, server restart and protocol mismatch with explicit reset/resnapshot. Do not concatenate a partial old transcript with an unrelated new snapshot.
- [ ] Stop streams, fetches, timers and reconnects on cancellation/unmount. Session expiry or revoked access stops retries and clears protected state; re-entry requires a newly authenticated/authorized snapshot.
- [ ] Require the server stream to enforce SEC-01 revocation/session policy throughout its lifetime, not only at initial subscription; closing the browser stream is not sufficient protection.
- [ ] Define heartbeat/dead-stream detection with CORE-01; a connected SSE socket is not worker liveness. A stalled connection must eventually reconnect or fall back rather than spin indefinitely.
- [ ] Poll fallback uses the same authorized bounded GET contract with non-overlapping requests, abortable waits, cursor handling and backoff. **Proposed default:** every 5 seconds in the foreground, slower while hidden; confirm with CORE-01. Never run full-rate polling and healthy SSE concurrently.
- [ ] On foreground/network recovery, resnapshot before enabling stale capabilities. `navigator.onLine` is a hint, not proof that the Mac or worker is reachable.

**Done when:** network flaps, logout, room switching, Mac restart and event gaps do not leak data, duplicate messages, accumulate listeners, or lose accepted work.

### UI-07 — Permission-aware actions, approvals and cancellation

- [ ] Consume per-conversation/per-message/per-job capabilities from the server. Hide or disable actions with an accessible reason; never infer authorization from display names, client role claims, author fields or a cached capability alone.
- [ ] Reauthorize every action on the server using the existing session and target object. Never send trusted `userId`, role or owner assertions in the mutation body.
- [ ] Port the read-only-notice pattern for membership restrictions, announcement rooms if approved, expired session, and unavailable actions.
- [ ] Approval UI shows a server-provided, safe action summary, relevant scope/consequences, requester, expiry and Approve/Reject controls. It must not render tool-provided HTML or ask the user to paste credentials.
- [ ] Approval/rejection/cancel POSTs carry unique intent keys and expected approval/job revision as defined by QUEUE-01. On stale revision or expired approval, refresh and explain; do not locally force a state transition.
- [ ] Render durable `cancel_requested` as “Cancellation requested”, distinct from terminal `cancelled` and from a local cancellation POST still awaiting acknowledgement. Render `blocked` with its server-provided reason and authorized resolution action. Explain that already executed external effects may not be undone. A completed job cannot become cancelled just because a late UI request finishes.
- [ ] If message deletion is in scope, show confirmation and server-defined semantics. Deleting/hiding a message must not imply cancelling its job or erasing an audit record. Do not invent delete policy in the UI.
- [ ] Do not offer “retry execution” for an `indeterminate` side-effectful job unless QUEUE-02 provides an explicit safe resolution action. Transport replay of a send is different from creating another execution.

**Done when:** forged POSTs fail independently of buttons; two approvers, stale pages, cross-room identifiers and cancellation/completion races produce the server's canonical result.

### UI-08 — Model-independent statuses and worker expectations

Implement every required state/projection below. Keep **durable QUEUE job state**, **submission acknowledgement**, **browser connection health** and **worker availability** separate internally. DTOs retain canonical `state` plus derived `displayStatus`; `offline` is connectivity only and cannot replace either durable state or job display status. Project `waiting_for_worker` only from `queued` with server-confirmed worker unavailability; project `awaiting_approval` only from `blocked` with a server-confirmed approval requirement. Other blocks remain `blocked`. Never conceal `cancel_requested`, a terminal state or `indeterminate` behind a worker/approval projection.

| Status | Family-facing text (proposed) | Required behavior |
| --- | --- | --- |
| `waiting_for_worker` (projection) | “Saved. Waiting for a worker to connect.” | Preserve durable `queued`; require server worker-availability evidence. Show accepted receipt/time without promising background execution. |
| `queued` | “Saved in the queue.” | Display authoritative state, no fabricated queue position/ETA. |
| `running` | “A worker is processing this request.” | Use server evidence/revision, not an optimistic send spinner. |
| `cancel_requested` (durable) | “Cancellation requested.” | Stopping is not yet confirmed; use QUEUE's canonical outcome and effect reconciliation, not a local terminal transition. |
| `blocked` (durable) | “This request needs attention before it can continue.” | Show a safe server reason and permitted resolution; do not assume every block is approval or worker absence. |
| `awaiting_approval` (projection) | “Needs approval before continuing.” | Preserve durable `blocked` with an approval-required reason; show safe summary and authorized controls only. |
| `completed` | “Completed.” | Render canonical result; separate completion from delivery/stream connection. |
| `failed` | “The request could not be completed.” | Safe reason and only server-permitted recovery actions; no silent billed fallback. |
| `cancelled` | “Cancelled.” | Show only after durable acknowledgement; do not promise rollback of prior effects. |
| `indeterminate` | “The outcome is not yet confirmed.” | Preserve last known data; reconcile. Distinguish unknown send acknowledgement from unknown execution outcome. |
| `offline` | “Cannot reach the chat service. Updates may be out of date.” | Keep last-known job state visibly stale rather than relabeling every job offline; no implicit send queue. |

- [ ] Use exhaustive status rendering and fixtures; new/unknown wire values show an update-needed/recovery state rather than falling through to `completed`.
- [ ] Present worker availability separately from browser connectivity. A healthy Mac/API with no connected worker is not “offline”. A worker's last-seen timestamp does not guarantee active execution.
- [ ] Show this expectation before the first assistant request and in a compact persistent notice: “Experimental worker connection. Requests are saved, but ChatGPT may need an active session to pick them up. Continuous background execution is not guaranteed.”
- [ ] State that using chat does not automatically enable a paid API. Any future billable execution mode requires an explicit, separately configured choice with visible cost implications; no automatic fallback.
- [ ] Do not assume OpenAI message schemas, model names, token counts, streaming-token protocol or SDK response objects in view types. Human messages, generic jobs, approvals and results are separate DTO concepts.

**Done when:** a family member can tell whether a message was saved, whether a worker is present, whether approval is needed, and whether the outcome is known, without reading developer logs.

### UI-09 — Accessible, responsive family experience

**Visual direction — a restrained family notebook:** reuse the current app's layout, spacing, typography, color tokens, icons and interaction conventions instead of introducing a separate design system. Favor quiet page-like surfaces, a readable text column, modest dividers/date headings and a simple note-writing composer; avoid decorative paper textures, model-brand imitation or a dashboard of glowing status cards. Use existing license-reviewed local assets and system/local fonts; no remote font/image fetches or unreviewed reference assets. Keep decoration subordinate to contrast and reflow.

A persistent, compact **privacy header** identifies the conversation and who can read it, and separately summarizes any authorized sharing with ChatGPT. A distinct application-owned status strip shows service connectivity and worker/job state with text labels. Neither is a model message, assistant avatar, typing indicator or model-authored assurance of privacy. Preserve this distinction on mobile by stacking header/status above the notebook timeline; avoid duplicating sensitive membership details in public previews.

- [ ] At 320 CSS px through desktop, use one-column navigation/content on small screens and a readable constrained timeline on large screens; support 200% zoom and 400% reflow without whole-page horizontal scrolling.
- [ ] Keep composer/actions usable with mobile keyboard, safe-area insets and dynamic viewport height. Do not obscure focused controls beneath a sticky composer.
- [ ] Use landmarks, headings, skip navigation, visible labels, logical tab order, persistent focus indicators and roughly 44×44 CSS px touch targets. Never rely on hover/color/icon alone for state/actions.
- [ ] Announce send errors with `role="alert"` and concise status changes through a polite live region. Do not announce the entire historical transcript on pagination/reconnect or every token/chunk. Preserve focus during background updates.
- [ ] Handle dialog initial focus, escape/cancel, focus restoration and descriptive action names (“Cancel request …”, not multiple unlabeled icons).
- [ ] Verify contrast rather than inheriting the reference's muted opacity values. Respect reduced motion; test long translated text, names, right-to-left content and device-local timestamp formatting.
- [ ] Keep empty, read-only, stale, failed and waiting-for-worker states understandable to nontechnical users. Do not show raw stack traces or infrastructure jargon.
- [ ] Default plain-text rendering; if rich text is later required, use the target's reviewed renderer with unsafe HTML disabled and a safe URL policy. Render code as inert text, never execute it.

**Done when:** keyboard-only and VoiceOver/manual mobile checks pass in addition to automated accessibility checks, including approvals, offline recovery and history pagination.

### UI-10 — Integrated tests and handoff

- [ ] Add tests using the target's existing test tools after inspecting their versions. The paths in section 3 are proposed; no command below is claimed to exist or pass today.
- [ ] Run unit/contract tests for canonical URL/`after` derivation, DTO validation, durable-state/display-projection exhaustiveness (including `cancel_requested` and non-approval `blocked`), capability rendering, event reduction/revision order, immutable idempotent attempts and draft handling. Test UTF-8 bytes independently of character count: ASCII, emoji and CJK, exactly 16,384 bytes and 16,385 bytes. For example, `"界".repeat(5461) + "a"` is 16,384 UTF-8 bytes while adding `"b"` exceeds the server limit even though both fit the 8,000-code-unit UI bound. Include direct API tests that bypass the composer.
- [ ] Run real authenticated API integration tests covering bounded GETs, no GET side effects, forbidden snapshots/events, forged authors/roles, CSRF rejection, expired sessions, ACL changes and same-key changed-payload conflicts. Verify missing/revoked/cross-conversation engine consent is rejected, per-request `engineAuthorizationId` cannot elevate scope, and a replay after conversation settings change cannot refreeze authorization or switch engines.
- [ ] Run browser tests covering login/return/logout, two-account shared-device switching, double submit, dropped POST receipt, timeout after durable acceptance, room switch while fetch pending, lost events, server reset, polling fallback and late cancellation results.
- [ ] Verify on a second device through the actual durable origin, not merely localhost: page navigation, credentialed SSE, streaming through the origin layer, reconnect and unchanged `/mcp` routing.
- [ ] Capture browser network assertions: chat data only under same-origin `/api/chat`; no Jazz socket, browser database call, cross-origin model request, backend credentials, or private transcript in local storage/service-worker caches. Existing same-origin auth and static assets are allowed.
- [ ] Coordinate QUEUE-02 crash/restart fixtures: accepted messages survive process/Mac service restart; UI recovers canonical state; pending side-effectful execution is not falsely marked completed or retried.
- [ ] Exercise approximately 15 concurrent authenticated sessions with bounded pages, one active event channel per view, controlled polling and a reconnect burst. Record observed latency/resource limits rather than promising capacity from family size alone.
- [ ] Record automated results, manual accessibility results, unresolved blockers and screenshots using synthetic family identities/messages only. Do not capture real family transcripts or secrets in test artifacts.

**Release acceptance:** all dependencies implemented and reviewed; no UI-side auth/database fork; durable-origin second-device test passes; uncertainty/worker notices are present; no silent API billing; all required statuses and negative authorization cases covered. A mocked UI alone is not release acceptance.

## 5. Illustrative TypeScript/React patterns

These are **proposed contracts and illustrative code**, not installed library APIs, production-ready route modules or permission implementations. Built-in browser/Web APIs and ordinary React patterns are used; adapt to the verified target framework. Symbols marked `declare` represent interfaces that CORE/SEC/QUEUE owners must implement and test, not importable functions known to exist.

### 5.1 Browser origin-derived chat link

```ts
// Browser-only: do not evaluate window during server rendering.
export function currentChatUrl(): URL {
  return new URL("/chat", window.location.origin);
}

// Example click handler: same origin, independent of the current /mcp pathname.
export function openChatHere(): void {
  window.location.assign(currentChatUrl().href);
}
```

For a normal rendered link, `<a href="/chat">Family chat</a>` is simpler and also SSR-safe. Server-generated absolute links must use CORE-01's validated configured public origin. Neither example takes an arbitrary caller-provided host, port or redirect target.

### 5.2 Proposed transport-neutral view types

```ts
export type JobState =
  | "queued" | "running" | "cancel_requested" | "blocked"
  | "completed" | "failed" | "cancelled" | "indeterminate";
export type JobDisplayStatus = JobState | "waiting_for_worker" | "awaiting_approval";
export type ConnectionStatus = "connecting" | "connected" | "offline";
// Validate state/projection pairs as specified in UI-08; offline is connectivity only.

export interface SendCommand {
  conversationId: string; // Internal intent/path parameter, not a second body authority.
  text: string;
  // engineAuthorizationId omitted only for the server-resolved conversation variant.
}
export interface AcceptedSend {
  kind: "accepted";
  messageId: string;
  jobId: string;
  state: JobState; // Canonical durable QUEUE state, including cancel_requested/blocked.
  displayStatus: JobDisplayStatus; // Server-derived projection; never replaces state.
  revision: number;
}
export interface MessageView {
  id: string;
  authorDisplayName: string; // Server-derived, never client-authenticated identity.
  text: string;
  sentAt: string; // Validated ISO timestamp.
  revision: number;
  capabilities: { canDelete: boolean };
}
export interface ChatSnapshot {
  conversationId: string;
  messages: MessageView[]; // Server-bounded page, not all history.
  nextOlderCursor: string | null;
  eventCursor: string; // Consistent boundary paired with this snapshot.
  capabilities: { canSend: boolean };
}
```

QUEUE-01 must finish job/approval/event DTOs, pagination semantics, capability freshness and wire-versioning while retaining the canonical states/routes in section 3.1. Browser identity, room membership and model/provider credentials are intentionally absent from mutation payloads.

**Why `SendCommand` omits `engineAuthorizationId`:** this illustrative variant uses a conversation's explicit server-stored engine consent. Admission resolves and validates that authorization for the current actor/conversation/engine, then freezes its identifier/scope with the job and idempotency receipt. Omission does not authorize default ChatGPT sharing, infer consent from Send, or bypass validation. A per-request engine-selection variant must add `engineAuthorizationId` to its validated payload and idempotency fingerprint; treat it as an untrusted reference, not a credential or grant. Show the effective sharing/engine choice in the privacy header before sending. Reject missing/invalid consent; current revocation rules still apply to execution. Do not send model credentials to the browser.

### 5.3 Composer: one key per intent, explicit uncertain outcome

```tsx
import * as React from "react";

// Proposed runtime validator, NOT a library function asserted to exist.
declare function parseAcceptedSend(value: unknown): AcceptedSend;

type Attempt = { key: string; command: SendCommand };

export function Composer(props: {
  conversationId: string;
  canSend: boolean;
  csrfToken: string; // Obtained via SEC-01's existing session-bound mechanism.
  onAccepted: (receipt: AcceptedSend) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [uncertain, setUncertain] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const attempt = React.useRef<Attempt | null>(null);
  const inFlight = React.useRef<AbortController | null>(null);
  const epoch = React.useRef(0);

  React.useEffect(() => {
    epoch.current += 1;
    return () => { epoch.current += 1; inFlight.current?.abort(); };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!props.canSend || inFlight.current) return;
    const text = draft.trim();
    if (!attempt.current) {
      if (!text) return;
      if (text.length > 8000 || new TextEncoder().encode(text).byteLength > 16 * 1024) {
        setNotice("Use at most 8,000 characters and 16 KiB of UTF-8 message text.");
        return;
      }
    }

    // A network retry must reuse this exact command and key.
    const current = attempt.current ?? {
      key: crypto.randomUUID(),
      command: { conversationId: props.conversationId, text },
    };
    attempt.current = current;
    const controller = new AbortController();
    const startedInEpoch = epoch.current;
    const active = () => epoch.current === startedInEpoch;
    inFlight.current = controller; // Synchronous double-submit guard.
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setPending(true);
    setNotice("");
    let accepted: AcceptedSend | undefined;
    try {
      const path = `/api/chat/conversations/${encodeURIComponent(current.command.conversationId)}/messages`;
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": current.key,
          "X-CSRF-Token": props.csrfToken,
        },
        body: JSON.stringify({ text: current.command.text }),
      });
      if (!response.ok) throw new Error("No verified acceptance receipt");
      const receipt = parseAcceptedSend(await response.json());
      if (!active()) return;
      if (controller.signal.aborted) throw new Error("Wait ended before reconciliation");
      accepted = receipt;
      attempt.current = null;
      setDraft("");
      setUncertain(false);
      setNotice("Message saved. Worker progress is shown separately.");
    } catch {
      if (active()) {
        // Conservatively retain the key/payload; never auto-create a new job.
        setUncertain(true);
        setNotice("Acceptance is not confirmed. Check this same request before sending another.");
      }
    } finally {
      window.clearTimeout(timeout);
      if (inFlight.current === controller) inFlight.current = null;
      if (active()) setPending(false);
    }
    // Keep local consumer errors outside the transport uncertainty catch.
    if (accepted && active()) props.onAccepted(accepted);
  }

  return (
    <form onSubmit={submit} aria-busy={pending}>
      <label htmlFor="chat-draft">Message</label>
      <textarea id="chat-draft" value={draft} maxLength={8000}
        disabled={!props.canSend || pending || uncertain}
        aria-describedby="chat-send-notice"
        onChange={(event) => setDraft(event.target.value)} />
      <button type="submit"
        disabled={!props.canSend || pending || (!uncertain && !draft.trim())}>
        {pending ? "Checking…" : uncertain ? "Check same request" : "Send"}
      </button>
      <p id="chat-send-notice" role="status">{notice}</p>
    </form>
  );
}
```

**Required production additions:** mount/key the composer by authenticated identity and conversation so the epoch guard also covers identity/room replacement; route 401/403 to session/access handling; validate typed definitive rejections to unlock an unaccepted draft; honor rate limits; add a documented status/receipt lookup path if QUEUE-01 supplies one. This deliberately conservative skeleton treats all non-acceptance responses as unresolved, so it is not complete error UX. The server must allow exact replay to return a receipt without executing twice. If idempotency retention expires, the server must reject an ambiguous retry for reconciliation, not silently treat it as new. An abort only stops the wait, not a job.

### 5.4 Server-authenticated route pattern (explicitly proposed interfaces)

```ts
// Framework-neutral Web Request/Response pseudocode.
// These adapters are PROPOSED and must be wired to existing application services.
interface Principal { userId: string }
interface ChatHttpDependencies {
  requireExistingSession(request: Request): Promise<Principal>;
  requireSafeMutation(request: Request, actor: Principal): Promise<void>;
  // Above enforces SEC-01 origin/CSRF rules, not merely Content-Type.
  readSendCommand(request: Request, routeConversationId: string): Promise<SendCommand>;
  // Validate path ID and strict body fields; derive command.conversationId from path.
  // Enforce 16,384 UTF-8 bytes of message content plus a separate envelope bound.
  // Reject unsupported media types and malformed/oversized content before admission.
  requireIdempotencyKey(request: Request): string;
  requireCanSend(actor: Principal, conversationId: string): Promise<void>;
  acceptAuthorizedSend(input: {
    actor: Principal; key: string; command: SendCommand;
  }): Promise<AcceptedSend>;
  // QUEUE-02 rechecks authorization in its consistency boundary, resolves/validates
  // the conversation's explicit engine consent and freezes engineAuthorizationId.
  // Commit chatMessages row + job + chatJobEvents event + scoped receipt atomically.
  // Exact replay returns the original receipt/authorization, never reselects an engine.
  publicError(error: unknown): { status: number; code: string };
  // SEC-01 mapping: deny by default, never return raw exceptions/secrets.
}

export function makePostMessage(deps: ChatHttpDependencies) {
  // Router binds POST /api/chat/conversations/:id/messages to this adapter.
  return async (request: Request, routeConversationId: string): Promise<Response> => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    };
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
    }
    try {
      const actor = await deps.requireExistingSession(request);
      await deps.requireSafeMutation(request, actor);
      const key = deps.requireIdempotencyKey(request);
      const command = await deps.readSendCommand(request, routeConversationId);
      await deps.requireCanSend(actor, command.conversationId);
      const receipt = await deps.acceptAuthorizedSend({ actor, key, command });
      return new Response(JSON.stringify(receipt), { status: 202, headers });
    } catch (error) {
      const safe = deps.publicError(error);
      return new Response(JSON.stringify({ error: { code: safe.code } }), {
        status: safe.status, headers,
      });
    }
  };
}
```

No Better Auth `getSession` call shape or Jazz backend API is invented here. Resolve the existing server session accessor through SEC-01. GET snapshot/event handlers similarly authenticate first, authorize each requested scope, apply server bounds, filter data, and never mutate. Long-lived streams require ongoing revocation handling. The browser never supplies the trusted principal and UI capabilities never replace these checks.

### 5.5 Credentialed SSE lifecycle with cancellation and reconnect

This skeleton intentionally takes a fresh bounded snapshot on reconnect, then subscribes from its consistent cursor. That avoids maintaining an unbounded client event log. QUEUE-02 must replay the snapshot-to-subscription gap or explicitly request another snapshot. Event framing/validation is proposed, not a Jazz API.

```ts
interface ChatChange { conversationId: string; cursor: string; revision: number }
declare function parseSnapshot(value: unknown): ChatSnapshot;
declare function parseChange(value: unknown): ChatChange;

export function watchConversation(
  conversationId: string,
  sink: {
    replace: (snapshot: ChatSnapshot) => void;
    apply: (change: ChatChange) => void;
    offline: () => void;
    accessLost: () => void; // Clears protected state and triggers existing auth/access UX.
  },
): () => void {
  let stopped = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  let failures = 0;

  function closeSource() { source?.close(); source = undefined; }
  function stop() {
    stopped = true;
    closeSource();
    pending?.abort();
    if (timer !== undefined) clearTimeout(timer);
  }
  function reconnect() {
    if (stopped) return;
    closeSource(); // Disable native reconnect; this owner schedules one retry.
    sink.offline();
    if (timer !== undefined) clearTimeout(timer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
    timer = setTimeout(() => { timer = undefined; void connect(); },
      delay + Math.random() * 500);
  }
  async function connect() {
    if (stopped) return;
    pending = new AbortController();
    try {
      const path = `/api/chat/conversations/${encodeURIComponent(conversationId)}`;
      const query = new URLSearchParams({ limit: "50" });
      const response = await fetch(`${path}?${query}`, {
        credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: pending.signal,
      });
      if (stopped) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        stop(); sink.accessLost(); return;
      }
      if (!response.ok) throw new Error("Snapshot unavailable");
      const snapshot = parseSnapshot(await response.json());
      if (stopped) return;
      if (snapshot.conversationId !== conversationId) throw new Error("Wrong scope");
      sink.replace(snapshot);
      const params = new URLSearchParams({ after: snapshot.eventCursor });
      const stream = new EventSource(`${path}/events?${params}`, {
        withCredentials: true, // Cookie auth; no bearer tokens in URLs.
      });
      source = stream;
      const active = () => !stopped && source === stream;
      stream.addEventListener("change", (event) => {
        if (!active()) return;
        try {
          const change = parseChange(JSON.parse((event as MessageEvent).data));
          if (change.conversationId !== conversationId) throw new Error("Wrong scope");
          sink.apply(change); // Proposed reducer enforces ID/revision deduplication.
          failures = 0; // Only evidence of healthy delivery resets backoff.
        } catch { reconnect(); }
      });
      stream.addEventListener("reset", () => { if (active()) reconnect(); });
      stream.addEventListener("access-lost", () => {
        if (active()) { stop(); sink.accessLost(); }
      });
      stream.onerror = () => { if (active()) reconnect(); };
    } catch {
      if (!stopped) reconnect();
    }
  }
  void connect();
  return stop;
}
```

**Required production additions:** bounded fetch timeout and heartbeat watchdog; runtime event-size/schema limits; definitive auth-loss handling when SSE fails (native EventSource does not expose HTTP error status, so the next authenticated snapshot is the fallback check); polling fallback and visibility throttling; safe handling of callback errors; a React effect cleanup and identity epoch keyed to the current authenticated viewer/conversation; reset backoff after a verified stable heartbeat interval. Do not add a second native reconnect loop alongside this explicit retry owner. Cookie credentials do not bypass ACL checks. Stream cursors must be opaque, bounded and access-scoped; never use them as credentials.

## 6. Test/acceptance matrix for coordination

| Scenario | Observable expected outcome | Primary dependency |
| --- | --- | --- |
| Phone opens durable origin `/chat` | Existing authenticated shell; all chat API URLs remain same-origin; no loopback/Jazz connection | CORE-01, UI-03 |
| Signed-out/expired/revoked user | No snapshot/event data; protected state cleared; no infinite auth retry loop | SEC-01, UI-06 |
| User B requests User A's conversation/job IDs | Server rejects/hides resource; no broad download then client filtering | SEC-01, UI-07 |
| Double send / acceptance response lost | One durable intent; exact key replay returns canonical receipt | QUEUE-02, UI-05 |
| Reuse key with changed text/room | Conflict/reconciliation; never silently creates a second job | QUEUE-01, QUEUE-02 |
| UTF-8 content at/over 16,384 bytes, including multibyte text under 8,000 characters | Byte and UI bounds tested separately; server rejects oversize content even if client is bypassed | QUEUE-02, UI-05 |
| Missing/forged engine consent or settings changed before replay | Validate/freeze consent at admission; exact replay retains original engine authorization; revoked execution remains prohibited | SEC-01, QUEUE-02 |
| `cancel_requested`, non-approval `blocked`, worker/approval projections | Preserve canonical DTO state; only justified projections shown; offline never becomes a job state | QUEUE-01, UI-08 |
| Browser abort after server commits | Message still exists after fresh snapshot; no false cancellation | QUEUE-02, UI-05 |
| Event arrives before POST receipt | Single reconciled message and canonical status | UI-04, UI-06 |
| Snapshot/stream gap or expired cursor | Replay or explicit reset; no missing messages or mixed-identity state | QUEUE-02, UI-06 |
| API reachable but no ChatGPT worker | Saved/waiting notice; no invented running state or billing fallback | QUEUE-01, UI-08 |
| Mac process restart during execution | Last known state reconciled; unknown effects shown as indeterminate, not retried blindly | QUEUE-02, UI-08 |
| Concurrent approvals / late cancel | Server revision wins; no unauthorized/stale local transition | SEC-01, QUEUE-02, UI-07 |
| SSE unavailable | One bounded non-overlapping polling loop, cleanup on logout/room change | CORE-01, UI-06 |
| Hostile message/model output | Inert text, safe links if enabled, no HTML/script execution | UI-04, UI-09 |
| Narrow screen, keyboard, VoiceOver | Visible focus/actions, labeled composer, concise status announcements, readable layout | UI-09 |
| Roughly 15 simultaneous sessions | Measured bounds, no unbounded histories/retry bursts, no implied continuous worker guarantee | UI-10 |

## 7. Open questions and plan limitations

1. The target application's framework/router, dependency versions, source structure and current session accessor were not inspected here. Proposed target files/interfaces must be mapped onto the real application, not created mechanically.
2. CORE-01 must finalize the durable origin and SSE behavior. No hostname, certificate, ingress product or service port is selected by this UI plan.
3. SEC-01 must settle family membership/invitation UX, private versus shared conversations, approval roles, mutation CSRF contract, session expiry/revocation behavior and message-deletion semantics while retaining Better Auth SQLite.
4. QUEUE-01/QUEUE-02 must finalize durable acceptance, status transitions, idempotency retention/replay lookup, event cursor consistency/replay horizon, schema versions and cancellation/approval conflict rules. Illustrative adapter interfaces and remaining DTO details require implementation agreement; canonical routes, state vocabulary, domain names and the 16 KiB UTF-8 message limit in section 3.1 are cross-plan constraints.
5. The reference is an alpha Jazz workspace example with README/source drift. Its verified package declarations are not evidence that those versions are installed, published or suitable for the target.
6. Reference tests were inspected, not executed. Runtime service, browser, build, accessibility, load and end-to-end validation are not established by this documentation-only plan.
7. The experimental MCP ChatGPT worker's ability to pick up work requires separate empirical validation; the UI must remain useful and truthful when there is no active worker and must never promise continuous background processing.

**Plan scope:** reference identity/source/license/version evidence, UI-01–UI-10 dependencies and subtasks, proposed target paths, illustrative examples and acceptance gates. Application implementation belongs under the separate control-plane root.
