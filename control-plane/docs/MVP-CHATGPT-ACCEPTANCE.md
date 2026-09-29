# No-chat MVP: real ChatGPT acceptance

The automated queue, MCP transport, and restart tests do **not** establish that
ChatGPT will keep a tool-calling turn alive for 25 minutes. This checklist is the
remaining client-side acceptance gate. Do not replace it with a scripted MCP loop
and label that a ChatGPT pass.

## Current observed result — 2026-09-09

**PASS — final combined normal-Chat acceptance completed on the hardened protocol.**

ChatGPT conversation: `https://chatgpt.com/c/6aa18ba8-ec50-83eb-9d2f-6566bcc02ac3`.
The exact **Jazz MVP Worker DCR** plugin opened one worker session,
`01a0870a-572f-7251-a738-1edd358c07fc`, at `2026-09-09T16:39:56.954Z`.
Its fixed deadline was `2026-09-09T17:04:56.954Z` (exactly 1500 seconds).
ChatGPT reported **Worked for 25m 23s** and stopped only after `wait_for_task`
returned `The 25-minute worker session has expired.` No replacement session was
created.

The independent read-only observer evidence is
`.data/acceptance/final-read-claim-save-1788971462.jsonl`. It injected the four
deterministic reasoning fixtures and recorded all of them as durable completed rows:

| Offset | Expected | Actual | Claimed | Completed |
| --- | ---: | ---: | --- | --- |
| minute 0 | `153` | `153` | `16:40:15.799Z` | `16:40:24.070Z` |
| minute 6 | `133` | `133` | `16:46:08.403Z` | `16:46:17.086Z` |
| minute 15 | `12` | `12` | `16:55:12.303Z` | `16:55:23.236Z` |
| minute 24 | `42` | `42` | `17:04:08.844Z` | `17:04:19.648Z` |

The minute-24 fixture arrived with about 60 seconds left and was completed with
about 37 seconds left. ChatGPT then continued polling at roughly 23 and 11 seconds
remaining before the next `wait_for_task` observed expiry. The final observer
snapshot was `effectiveStatus=expired`, `completed=4`, `failed=0`, with every
`answerMatches=true`. A separate Jazz query found exactly one session created after
the observer start and the owner queue ended at `queued=0`, `running=0`, `failed=0`.

The final run used the hardened worker protocol: `wait_for_task` is genuinely READ,
`claim_task` is a closed-world WRITE with bounded contention reconciliation, and
`save_task_result` is a bounded/idempotent internal Jazz WRITE. New acceptance runs
must not use the compatibility tools `next_task` or `submit_task_answer`. Earlier
real-Chat testing showed `submit_task_answer` could be stopped by an OpenAI safety
check before reaching the server; `save_task_result` subsequently passed a recovered
`42` write plus a three-write `64/81/144` stress smoke with no safety interruption.
The final 25-minute run likewise reported **no safety check, permission prompt,
connection error, token-acquisition error, or early stop**.

One non-blocking housekeeping issue remains: read-only expiry observation does not
rewrite the stored Jazz session row. Two historical rows currently have
`status=active` despite deadlines already in the past, while all admission/read
logic correctly treats them as effectively expired. This does not invalidate the
MVP acceptance result, but a later cleanup/materialization path should mark such
rows `expired` outside the high-frequency READ poll.

## Current connection

MCP URL:

```text
https://tests-macbook-air.tail70b8a.ts.net/mcp
```

The hostname belongs to the current Tailscale identity, not an owned permanent
domain. Recheck discovery if the tailnet identity changes.

In ChatGPT, open **Plugins → Create app**, name it **Jazz MVP Worker**, and use
**Server URL**, the URL above, and **OAuth**. The released **Remote Desktop
Commander** plugin is a different service and does not expose this worker queue.

Under advanced OAuth settings:

- Use **Dynamic Client Registration (DCR)** for this local MVP. This Mac's current
  proxy/TUN DNS maps `chatgpt.com` to a special-use `198.18.0.0/15` address, so the
  secure CIMD transport correctly refuses the server-side metadata fetch as SSRF
  protection. Do not weaken CIMD address validation to work around the proxy.
- DCR is enabled only by the explicit local MVP flag
  `ALLOW_UNAUTHENTICATED_OAUTH_CLIENT_REGISTRATION=true`. The default/example
  remains false and the full release must remove or harden this escape hatch.
- Default scopes: **`mcp:tools`** only; deselect **`device:sync`**.
- Base scopes: **`offline_access`**. The secure/default access-token lifetime is
  300 seconds. This intentionally insecure local MVP currently sets
  `OAUTH_ACCESS_TOKEN_EXPIRES_IN=1800`, which keeps token refresh outside the
  fixed 1500-second worker window after ChatGPT showed intermittent token-acquisition
  503s at the five-minute boundary. Do not carry this relaxation into the full
  hardened release without review.
- Disable OIDC for this test. This application uses passkey-only identities without
  email addresses; the worker does not need OIDC profile/email discovery.
- Leave discovered authorization/token/resource URLs unchanged. They must all use
  the current origin.

The account owner must review ChatGPT's custom-server risk acknowledgement,
create the plugin, and complete the normal passkey and OAuth consent flow. Never
extract browser tokens, sign a substitute production JWT, use a virtual passkey,
or switch to No Auth to claim this step passed.

`mcp:tools` is the existing broad owner permission, not a queue-only permission.
The server still advertises device tools. For this reasoning-only acceptance run,
do not invoke or authorize device operations. Do not select a global “allow all”
permission merely to avoid tool confirmations.

## 1. Short end-to-end smoke

Start a fresh ChatGPT conversation with **Jazz MVP Worker** enabled. Ask it to:

1. Call `enqueue_task` with a harmless reasoning task, e.g. “Calculate 17 × 23 and
   persist just the number.”
2. Call `open_task_worker_session` once and record the returned session ID,
   `startedAt`, and `expiresAt`.
3. Call `wait_for_task`, then `claim_task` for the returned task ID, solve it, and
   call `save_task_result` (`391` for the example).
4. Call `wait_for_task` once more to verify idle state, then close the session with
   `close_task_worker_session`.

Do not use `next_task` or `submit_task_answer` in new acceptance runs; they remain
only for compatibility/regression coverage.

Verify actual tool results, not just ChatGPT's narrative. This is only a short
smoke, **not** the 25-minute acceptance run. Record any protocol negotiation or
OAuth error instead of bypassing it.

## 2. Observe without producing fake heartbeats

The MCP `task_worker_status` tool updates `lastSeenAt`. Do not invoke it from an
operator script while measuring whether ChatGPT itself is still polling.

Use the local read-only inspector instead, from the pinned Nix shell:

```bash
cd apps/control-plane
NODE_ENV=production node --env-file=.env.local --import tsx \
  scripts/inspect-worker-session.ts SESSION_ID
```

Or, with the production environment already loaded:

```bash
pnpm worker:inspect -- SESSION_ID
```

This command uses a separate disposable backend cache and global-tier reads. It
never opens, touches, closes, expires, or claims a worker session. Output includes:

- owner ID (needed by the existing local queue producer);
- stored and effective session status, original deadline, and heartbeat age;
- counts and IDs of tasks currently assigned to this session;
- whether answers/errors are recorded, without dumping their contents.

Optionally set `WORKER_TASK_OWNER_ID` to require that the session belongs to that
owner. Without it, this is a **trusted local operator command**, not a public API.
It requires the existing backend environment and must not be exposed publicly.

Save samples with timestamps outside Git if needed. A single recent heartbeat is
not proof of continuous polling or ChatGPT identity; correlate the samples with
the actual ChatGPT tool transcript. Reassigned tasks are not a complete history.
An expired `effectiveStatus` does not rewrite an `active` stored row.

For the unattended 25-minute run, start the dedicated observer immediately before
asking ChatGPT to open the fresh worker session:

```bash
cd apps/control-plane
pnpm worker:soak:observe
```

It detects only a newly-created active session, writes JSONL evidence under the
ignored `.data/acceptance/` directory, samples the session every 30 seconds without
heartbeating it, and enqueues deterministic reasoning fixtures at minute 0, 6, 15,
and 24. It never opens, extends, closes, or replaces the ChatGPT worker session.

## 3. Full 25-minute run

Use a fresh session, not the closed smoke session. First inspect the owner's
existing queue and avoid mixing unrelated tasks into the acceptance run.

Suggested ChatGPT prompt:

> Run the Jazz MVP Worker reasoning-only acceptance test. Open exactly one worker
> session. Keep its original session ID and fixed deadline. Repeatedly call
> wait_for_task with waitSeconds 8. When a task is available, call claim_task for
> that exact task ID, reason about it, call save_task_result, and immediately return
> to wait_for_task. If the queue is empty, keep polling until the server reports
> expiry. Do not call next_task or submit_task_answer, open a replacement session,
> use device tools, execute shell commands, browse, or claim that work continues
> in the background after your turn ends. If a task requires external actions,
> record that limitation with fail_task. At the end, report the session ID and
> actual results, including any early stop or error.

Use the inspector to obtain the session owner. Enqueue small reasoning tasks at
approximately minute 0, minute 6, minute 15, and minute 24. The late arrivals test
whether polling continues through long idle periods and the final minute of the
fixed worker lease. Token-refresh behavior should be tested separately when the
local MVP's 1800-second token lifetime is reduced back to the secure/default value. From the same pinned shell, for example:

```bash
NODE_ENV=production WORKER_TASK_OWNER_ID=OWNER_ID \
  node --env-file=.env.local --import tsx scripts/enqueue-worker-task.ts \
  'Acceptance minute 6: calculate 19 × 7 and submit just the number.'
```

Inspect answers using the existing `scripts/list-worker-tasks.ts` command with the
same owner/environment. Do not send “continue” messages to keep the original test
alive: that would be a different, human-assisted result. If tool approval is
required, record it; do not hide approval interruptions in an unattended-pass claim.

## Evidence and outcome

Record:

- ChatGPT conversation URL, model, custom plugin name, and test start/end times;
- original session ID and its exact 1500-second window;
- OAuth success and successful tool calls after the first token expiration;
- actual enqueue/claim/completion times and expected answers for each fixture;
- idle polling and any approval prompts, token errors, early final response, or
  interruption;
- server rejection after expiry without extending/replacing the session.

**Pass:** the same ChatGPT-initiated worker keeps calling through the original
window, handles late tasks, stores correct answers, and cannot operate after its
fixed deadline. Samples plus the tool transcript support this conclusion.

**Fail/partial:** ChatGPT finishes early, requires human nudges, cannot refresh
credentials, stops polling while idle, or loses a submitted answer. Record the
actual stopping point. A durable queue and healthy public endpoint remain useful,
but do not make the behavioral test pass.

This test does not establish physical reboot/power-loss guarantees, family ACLs,
device-operation safety, or a permanently provider-independent URL.
