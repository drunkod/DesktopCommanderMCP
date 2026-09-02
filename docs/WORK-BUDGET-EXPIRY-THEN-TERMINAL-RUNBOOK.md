# Work budget expiry -> terminal launch acceptance runbook

Status: manual acceptance scenario for the lifecycle MVP on `feat/jazz-remote-device`.

## Goal

Prove that when one logical work window reaches the configured 25-minute budget and is marked `interrupted`, Desktop Commander terminal tools remain usable, terminal infrastructure is not killed, and a later command starts a fresh work window.

Expected state transition:

```text
work A: running
  -> 25-minute budget reached
work A: interrupted / budget_expired
  -> later start_process call
work B: running (new id)
  -> terminal child continues according to its own process lifetime
```

## Important interpretation

`budget_expired` is lifecycle metadata, not a terminal lockdown. It should stop the old work-window timer, persist interruption, queue the one-shot expired notice, and leave terminal policy unchanged.

The next non-UI MCP tool call is expected to create a new work window automatically. `start_process` is just another such tool call.

"Any program" means any executable Desktop Commander could normally start under the current OS, PATH, permissions, `blockedCommands`, security policy, and ChatGPT confirmation rules. Expiry must not introduce any additional restriction.

## Current branch precondition

As of 2026-09-02, the production expiry path is wired in `src/utils/work-lifecycle.ts`: when the configured budget is reached, `evaluateThresholds()` queues `expired`, changes state to `interrupted`, sets `interruptionReason` to `budget_expired`, stops the lifecycle timer, and persists state.

Verify before testing:

```bash
cd ~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
rg -n "budget_expired|queueNotice\('expired'\)|state.status = 'interrupted'" src/utils/work-lifecycle.ts
```

Unlike logical `complete()`, this path is already runnable end-to-end today.

## What the implementation should do

Budget expiry currently:

1. requires the current state to be `running`;
2. queues the one-shot `expired` lifecycle notice;
3. changes status to `interrupted`;
4. sets `interruptionReason` to `budget_expired`;
5. stops the lifecycle timer;
6. durably persists the interrupted state;
7. does not call `kill`, `forceTerminate`, or terminal-manager cleanup.

## Step 1 — build and run focused lifecycle tests

```bash
cd ~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
nix develop
npm run build
node test/test-work-lifecycle.js
```

**PASS:** build succeeds and focused lifecycle tests pass.

## Step 2 — record terminal policy before expiry

From ChatGPT/Remote Desktop Commander, call `get_config` and record:

```text
defaultShell
blockedCommands
allowedDirectories
```

Do not change policy for this test.

**PASS:** later post-expiry commands are judged against exactly the same policy that existed before expiry.

## Step 3 — start work A

Make one harmless non-UI tool call such as `get_config`.

Then record:

```bash
jq '{id,status,lastTool,completedOperations,deadlineAt}' \
  ~/.claude-server-commander/work-state/current.json
```

Save the ID as `WORK_A_ID`.

Expected before expiry:

```text
status: running
id: WORK_A_ID
```

## Step 4 — let the real budget expire

For the release-confidence test, use production timing with all lifecycle overrides unset:

```bash
unset DC_WORK_CHECKPOINT_MINUTES
unset DC_WORK_WARNING_MINUTES
unset DC_WORK_CRITICAL_MINUTES
unset DC_WORK_BUDGET_MINUTES
```

Production thresholds are:

```text
checkpoint = 20 minutes
warning    = 23 minutes
critical   = 24 minutes
expired    = 25 minutes
```

After at least 25 minutes, inspect durable state before making another tool call:

```bash
jq '{id,status,lastActivityAt,pendingNoticeLevel,interruptionReason,interruptionDetail}' \
  ~/.claude-server-commander/work-state/current.json
```

**PASS:**

```text
id: WORK_A_ID
status: interrupted
pendingNoticeLevel: expired
interruptionReason: budget_expired
interruptionDetail: Configured defensive work budget reached
```

The remote device and terminal infrastructure must still be online.

For fast developer iteration only, use the accelerated timing profile from the lifecycle Web runbook, but repeat this step once with the real 25-minute default before release.

## Step 5 — launch a short-lived program after expiry

From ChatGPT through the same Desktop Commander development app, run:

```text
start_process(command="printf 'post-expiry-ok\\n'", timeout_ms=5000)
```

Expected lifecycle marker on that first post-expiry result:

```text
[DCMCP_WORK_BUDGET expired] action=checkpoint_now_and_resume_in_a_new_work_window
```

**PASS:** the process starts and returns `post-expiry-ok` normally.

Immediately inspect lifecycle state again:

```bash
jq '{id,status,lastTool,completedOperations}' \
  ~/.claude-server-commander/work-state/current.json
```

**PASS:**

```text
id: <different from WORK_A_ID>
status: running
lastTool: start_process
```

Call the new ID `WORK_B_ID`.

This is the key proof that an expired/interrupted work window does not block later terminal execution; the later command simply starts work B.

## Step 6 — launch an interactive program after expiry

Start an interactive REPL through Desktop Commander, for example:

```text
start_process(command="python3 -i", timeout_ms=5000)
```

Then send:

```text
interact_with_process(pid=<pid>, input="print('interactive-post-expiry-ok')")
```

**PASS:** the REPL accepts input and returns `interactive-post-expiry-ok`.

Repeat with another available interactive executable if useful, such as `node -i` or the default shell.

**PASS:** interactive process handling is unchanged by the prior expiry event.

## Step 7 — launch a long-running child after expiry

Start a harmless long-running process:

```text
start_process(command="sleep 30", timeout_ms=1000)
```

Record its PID and call `list_sessions`.

**PASS:** the `sleep 30` session is present and keeps running until its own process lifetime ends or you explicitly terminate it.

Expiry of work A must not retroactively terminate this child, because the child belongs to work B and terminal lifetime is independent of lifecycle status.

## Step 8 — test representative executable classes

Run only programs that are already installed and allowed by policy. A useful matrix is:

```text
[ ] shell builtin / simple command: printf or echo
[ ] runtime: node --version
[ ] runtime: python3 --version
[ ] VCS/tooling: git --version
[ ] interactive REPL: python3 -i or node -i
[ ] long-running child: sleep 30
[ ] project command inside nix develop: npm --version or npm test subset
```

For each case, compare behavior before and after a budget-expired interruption.

**PASS:** anything that was allowed and runnable before expiry remains allowed and runnable after expiry.

**EXPECTED NON-LIFECYCLE FAILURES:** executable not installed, command blocked by `blockedCommands`, missing PATH entry, OS permission failure, ChatGPT confirmation denied, or application-specific startup error.

Do not classify those as lifecycle failures unless the same command works before expiry and fails only after expiry.

## Step 9 — prove an already-running child survives expiry

Start a harmless child before the 25-minute boundary:

```text
start_process(command="sleep 1800", timeout_ms=1000)
```

Confirm it appears in `list_sessions`, then allow the work window to reach its 25-minute budget while that child is still alive.

Before making a new MCP tool call, verify `current.json` says `interrupted / budget_expired`.

Then call `list_sessions` again.

**PASS:** the same PID is still present after lifecycle state becomes `interrupted`.

This proves lifecycle budget expiry does not implicitly terminate terminal children.

If product semantics ever decide that a specific interruption should also clean up selected children, make that an explicit separate policy; do not hide it inside generic lifecycle expiry.

## Step 10 — ChatGPT Web end-to-end prompt

Use a fresh normal ChatGPT Web chat with the candidate development app and send:

```text
Use Desktop Commander on the online Mac. Start one harmless logical work window
and let its configured lifecycle budget expire without manually stopping it.
After the state reports budget_expired, start a terminal process that runs:
printf 'after-expiry-ok\n'. Then show the new lifecycle id and confirm it differs
from the interrupted work id. Do not modify configuration.
```

For fast developer testing, temporarily use accelerated lifecycle thresholds. For final acceptance, repeat the same prompt flow with the real 25-minute budget.

## Result sheet

```text
[ ] Production budget-expiry path exists
[ ] Build passes inside nix develop
[ ] Focused lifecycle tests pass
[ ] Work A starts as running
[ ] Real budget expiry changes Work A to interrupted
[ ] interruptionReason is budget_expired
[ ] Expired marker is delivered once on the next tool result
[ ] Short-lived start_process works after expiry
[ ] Post-expiry start_process creates WORK_B_ID != WORK_A_ID
[ ] Interactive REPL works after expiry
[ ] Long-running child works after expiry
[ ] Already-running child survives expiry
[ ] Representative allowed executables behave the same before/after expiry
[ ] blockedCommands / permissions remain unchanged
[ ] Final production 25-minute soak passes
```

## Acceptance decision

**GO:** budget expiry is durable, does not mutate terminal policy, does not kill existing terminal children, delivers the expired marker once, and the first later non-UI tool call starts a fresh work window with a new ID.

**NO-GO:** expiry disables `start_process`, changes command policy unexpectedly, kills unrelated children, leaves the old work ID running, fails to persist `budget_expired`, or causes the next tool call to reuse the interrupted work ID.

## Current expected status

On the current branch, this scenario is runnable today. The automated accelerated real-MCP-server test on 2026-09-02 passed the core transition:

```text
work A: running
  -> interrupted / budget_expired
  -> start_process("printf 'post-expiry-ok\\n'") succeeds
  -> expired marker delivered once
  -> work B: running with a new id and lastTool=start_process
```

The remaining release-confidence item is the same test at the real 25-minute production timing through the candidate ChatGPT Web route.
