# Work completion -> terminal launch acceptance runbook

Status: manual acceptance scenario for the lifecycle MVP on `feat/jazz-remote-device`.

## Goal

Prove that marking one logical work window `completed` does not disable Desktop Commander terminal tools, kill terminal infrastructure, or prevent a later command from starting a fresh work window.

Expected state transition:

```text
work A: running
  -> completion hook
work A: completed
  -> later start_process call
work B: running (new id)
  -> terminal child continues according to its own process lifetime
```

## Important interpretation

`completed` is lifecycle metadata, not a terminal lockdown. It should stop the old work-window timer and persist completion only.

The next non-UI MCP tool call is expected to create a new work window automatically. `start_process` is just another such tool call.

"Any program" means any executable Desktop Commander could normally start under the current OS, PATH, permissions, `blockedCommands`, security policy, and ChatGPT confirmation rules. Completion must not introduce any additional restriction.
## Current branch precondition

As of 2026-09-02, `WorkLifecycleManager.complete()` exists in `src/utils/work-lifecycle.ts`, but no production code calls `workLifecycle.complete()`.

Check before doing the end-to-end test:

```bash
cd ~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
rg -n 'workLifecycle\.complete\(|\.complete\(\)' src test
```

**Current expected result:** no production call site.

That means the end-to-end completion-trigger portion of this runbook is **BLOCKED until a real completion signal is wired**. Do not fake a PASS by editing `current.json` manually.

Once the hook is wired, this command must show the production call site that marks logical work completion.

## What the implementation should do

`complete()` currently:

1. requires the current state to be `running`;
2. changes it to `completed`;
3. updates `lastActivityAt`;
4. stops the lifecycle budget timer;
5. durably persists the completed state;
6. does not call `kill`, `forceTerminate`, or terminal-manager cleanup.
## Step 1 — build and run focused lifecycle tests

```bash
cd ~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
nix develop
npm run build
node test/test-work-lifecycle.js
```

**PASS:** build succeeds and focused lifecycle tests pass.

## Step 2 — record terminal policy before completion

From ChatGPT/Remote Desktop Commander, call `get_config` and record:

```text
defaultShell
blockedCommands
allowedDirectories
```

Do not change policy for this test.

**PASS:** the later post-completion commands are judged against exactly the same policy that existed before completion.

## Step 3 — start work A

Make one harmless non-UI tool call such as `get_config`.

Then record:

```bash
jq '{id,status,lastTool,completedOperations}' \
  ~/.claude-server-commander/work-state/current.json
```

Save the ID as `WORK_A_ID`.
Expected before completion:

```text
status: running
id: WORK_A_ID
```

## Step 4 — trigger the real completion hook

Use the actual product path that is supposed to mean **the logical job is finished**. Do not substitute tool completion (`toolCompleted`) for work completion (`complete`).

Immediately inspect the durable state:

```bash
jq '{id,status,lastActivityAt,completedOperations,interruptionReason}' \
  ~/.claude-server-commander/work-state/current.json
```

**PASS:**

```text
id: WORK_A_ID
status: completed
interruptionReason: null/absent
```

Wait longer than the configured lifecycle poll interval and inspect again.

**PASS:** the state stays `completed`; it must not later become `budget_expired` because `complete()` stops the work-window timer.
## Step 5 — launch a short-lived program after completion

From ChatGPT through the same Desktop Commander development app, run:

```text
start_process(command="printf 'post-completion-ok\\n'", timeout_ms=5000)
```

**PASS:** the process starts and returns `post-completion-ok` normally.

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

This is the key proof that a completed work window does not block later terminal execution; the later command simply starts work B.
## Step 6 — launch an interactive program after completion

Start an interactive REPL through Desktop Commander, for example:

```text
start_process(command="python3 -i", timeout_ms=5000)
```

Then send:

```text
interact_with_process(pid=<pid>, input="print('interactive-post-completion-ok')")
```

**PASS:** the REPL accepts input and returns `interactive-post-completion-ok`.

Repeat with another available interactive executable if useful, such as `node -i` or the default shell.

**PASS:** interactive process handling is unchanged by the prior completion event.

## Step 7 — launch a long-running child after completion

Start a harmless long-running process:

```text
start_process(command="sleep 30", timeout_ms=1000)
```

Record its PID and call `list_sessions`.
**PASS:** the `sleep 30` session is present and keeps running until its own process lifetime ends or you explicitly terminate it.

Completion of work A must not retroactively terminate this child, because the child belongs to work B and terminal lifetime is independent of lifecycle status.

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

For each case, compare behavior before and after a completed work window.

**PASS:** anything that was allowed and runnable before completion remains allowed and runnable after completion.

**EXPECTED NON-LIFECYCLE FAILURES:** executable not installed, command blocked by `blockedCommands`, missing PATH entry, OS permission failure, ChatGPT confirmation denied, or application-specific startup error.

Do not classify those as lifecycle failures unless the same command works before completion and fails only after completion.
## Step 9 — prove an already-running child survives completion

Start a harmless child first:

```text
start_process(command="sleep 30", timeout_ms=1000)
```

Confirm it appears in `list_sessions`, then trigger the real completion hook for the current work window while that child is still alive.

Immediately call `list_sessions` again.

**PASS:** the same PID is still present after lifecycle state becomes `completed`.

This proves logical work completion does not implicitly terminate terminal children.

If product semantics eventually decide that a specific completion signal should also clean up selected children, make that an explicit separate policy; do not hide it inside generic lifecycle completion.

## Step 10 — ChatGPT Web end-to-end prompt

After the completion hook is wired, use a fresh normal ChatGPT Web chat with the candidate development app and send:

```text
Use Desktop Commander on the online Mac. Complete one harmless logical task,
then trigger the product's work-complete path. After it reports completion,
start a terminal process that runs: printf 'after-complete-ok\n'.
Then show the new lifecycle id and confirm it differs from the completed work id.
Do not modify configuration.
```
## Result sheet

```text
[ ] Production completion hook call site exists
[ ] Build passes inside nix develop
[ ] Focused lifecycle tests pass
[ ] Work A starts as running
[ ] Real completion hook changes Work A to completed
[ ] Work A stays completed after the poll interval
[ ] Short-lived start_process works after completion
[ ] Post-completion start_process creates WORK_B_ID != WORK_A_ID
[ ] Interactive REPL works after completion
[ ] Long-running child works after completion
[ ] Already-running child survives completion
[ ] Representative allowed executables behave the same before/after completion
[ ] blockedCommands / permissions remain unchanged
```

## Acceptance decision

**GO:** completion is durable, does not mutate terminal policy, does not kill existing terminal children, and the first later non-UI tool call starts a fresh work window with a new ID.

**NO-GO:** completion disables `start_process`, changes command policy unexpectedly, kills unrelated children, leaves the old work ID running, or causes the next tool call to reuse the completed work ID.

## Current expected status

On the current branch, the lifecycle semantics support this design, but the end-to-end test is **not yet runnable** because no production path calls `workLifecycle.complete()`.

Wire the real logical-completion signal first; then execute this runbook unchanged.
