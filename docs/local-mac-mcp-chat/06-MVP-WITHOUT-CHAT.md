# MVP without chat vs full family-chat release

Date: 2026-09-08. This document re-sorts the existing task pack around the requested first release: **no `/chat` UI yet**, one owner MCP identity, a 25-minute logical worker window, Jazz task polling, and durable answers.

## MVP product contract

The MVP must do only this:

1. ChatGPT connects to the existing static `/mcp` endpoint.
2. The user starts a worker session with a hard 25-minute deadline.
3. While ChatGPT continues making MCP calls, it repeatedly asks for the next queued task.
4. It solves the task using model reasoning and records the answer in local Jazz.
5. It immediately asks for another task until the queue is empty or the 25-minute session expires.
6. Tasks can be inserted locally now; the future `/chat` API will use the same queue service later.

This MVP explicitly does **not** claim autonomous execution after ChatGPT stops calling tools. The 25-minute record is a server-side lease/deadline, not a guarantee that the consumer ChatGPT client will keep reasoning for all 25 minutes.

## Tasks selected for the MVP

| Existing task area | MVP subset | Status in current implementation |
| --- | --- | --- |
| CORE-01 | Keep one stable `/mcp` origin and existing OAuth resource identity | Reuse existing control plane/tunnel work; no new chat route required |
| CORE-02 | Keep current pinned Next/MCP/Jazz versions; compile against the existing workspace | **Implemented/validated** with full check suite and production Next build |
| QUEUE-01 | Add durable `workerSessions` and `chatJobs` records | **Implemented** in `packages/protocol/src/application-schema.ts` |
| QUEUE-02 | Insert standalone tasks and persist answers/failures | **Implemented** through `worker-queue.ts`; local enqueue/list scripts added |
| QUEUE-03 | Claim one queued task at a time and enforce a fixed 25-minute session deadline | **Implemented** with Jazz transactions and owner/session binding |
| QUEUE-04 | Expose queue-worker MCP tools and instruct the model to loop through short calls | **Implemented** on the existing `/mcp` handler |
| QUEUE-06 | Minimal duplicate admission, restart persistence, stale reasoning-task recovery and explicit session close | **Implemented for reasoning-only MVP**; effect-aware recovery remains deferred |
| OPS-01/02 | Existing local control plane + Jazz + static tunnel remain the runtime | Reused; production two-port ingress redesign is not required for this insecure MVP |
| OPS-04 | Queue/MCP/restart integration tests, typecheck and production build | **Implemented and passing** |

## Verified MVP runtime state — 2026-09-09

- `test:worker-queue`, `test:worker-mcp`, and `test:worker-restart` pass.
- `test:worker-restart` performs two Jazz authority restarts and verifies cold backend processes, idempotency, claim, completion, and stored-answer recovery.
- The full control-plane `check` command and production Next build pass.
- macOS launchd supervises Jazz + Next and reasserts Tailscale Funnel; deliberate service restarts recover in about 7–8 seconds in the current test environment.
- A live synthetic task remained `queued` across one real launchd restart, was completed as `PERSISTENCE_OK`, and the completed answer survived a second launchd restart.
- The control-plane Jazz backend uses a persistent NAPI runtime cache, pinned by the macOS launcher to the ignored repository `.data/` directory.
- **Real ChatGPT acceptance passed on the normal Chat surface.** Session `01a0870a-572f-7251-a738-1edd358c07fc` kept the original 1500-second lease, completed minute 0/6/15/24 fixtures as `153`, `133`, `12`, `42`, and stopped only after server-reported expiry. The final queue was `queued=0`, `running=0`, `failed=0`, with no replacement session or reported safety/permission/connection/token-acquisition error. Evidence: `implementation/.data/acceptance/final-read-claim-save-1788971462.jsonl` and `implementation/docs/MVP-CHATGPT-ACCEPTANCE.md`.

### MVP MCP tools

Preferred worker path:

- `open_task_worker_session`
- `wait_for_task` — genuinely read-only polling; does not heartbeat/claim
- `claim_task` — bounded closed-world write with race reconciliation
- `save_task_result` — bounded/idempotent internal Jazz result write
- `fail_task`
- `task_worker_status`
- `close_task_worker_session`
- `enqueue_task` — intentionally retained as an insecure/test producer until `/chat` is connected

Compatibility-only tools retained for older clients/tests: `next_task` and `submit_task_answer`. New acceptance runs must use `wait_for_task → claim_task → save_task_result`.
## Deliberately insecure/deferred in the MVP

The MVP reuses the existing owner `mcp:tools` identity. It does not introduce a workflow-only OAuth client, family ACL, approval boundary, route-isolating ingress, or requester-vs-device-owner delegation. Existing broad owner tools such as `call_device_tool` therefore remain visible to the authenticated owner MCP client.

That trade-off is acceptable only for this private proof. Do not invite family members to this MVP and do not treat it as the household release.

The following existing task groups are therefore **not MVP blockers**:

- all UI-01 through UI-10 tasks;
- family enrollment, roles, invitations and private-conversation ACLs from SEC-01;
- SEC-02 family/device least-privilege policy and operation approvals;
- most SEC-03 public-ingress/log-redaction hardening;
- SEC-04 household backup/recovery policy beyond preserving local Jazz data;
- QUEUE-05 delegated Desktop Commander effects;
- the full QUEUE-06 cancellation/reconciliation/fallback design;
- QUEUE-07 household/load/security acceptance beyond the minimal queue test;
- the two-port 3000/3001 public/private ingress split;
- 15-user load testing and full release evidence.

## Chat-ready decisions already preserved

The queue table is intentionally named `chatJobs`, even though the MVP has no chat page. Each row already has `requesterId`, `source`, and optional `conversationId`. The queue implementation is a server-side library rather than logic embedded only inside MCP tool callbacks.

When `/chat` is added, its authenticated POST handler should call the same task-admission service instead of inventing a second queue. Chat messages/conversations can then reference the existing `chatJobs` rows, and the current worker tools can continue consuming the same queue.