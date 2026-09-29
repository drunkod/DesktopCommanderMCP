# Controlled cutover architecture

**Status:** executable migration architecture companion to Plan 08.
**Scope:** unified-repository cutover only; no product authorization redesign.

## Objective

Move the accepted local control plane from the historical `implementation` checkout to
`DesktopCommanderMCP/control-plane/` without losing accepted work, duplicating a device effect,
rotating credentials, exposing two state writers, or reopening public ingress before continuity is
verified.

## Safety invariants

1. A tested control channel independent of Remote Desktop Commander is required before public ingress is disabled or the device agent is stopped.
2. New worker work is frozen before worker drain, while already-running workers retain their MCP completion path.
3. Task freeze blocks new worker sessions, new task inserts, and new task claims; it does not block already-running task completion.
4. Task freeze does not block device remote calls because a running worker may still require device tools to finish.
5. Worker sessions are quiesced only after running jobs reach zero.
6. Device-effect admission is frozen only after worker sessions are quiesced.
7. Effect freeze blocks new remote-call rows but preserves retries/readback of an already-created idempotent call.
8. Stack-wide readiness verifies the expected deployment owner against Better Auth and Jazz, while unexpected active owners block readiness.
9. Public ingress is disabled only after task and effect admission are both frozen and the stack-wide readiness probe is green.
10. The public-ingress maintenance marker survives supervisor restarts; launchd startup must not reopen Funnel while it exists.
11. At most one production control-plane stack writes production Better Auth/Jazz state.
12. At most one production device agent consumes production remote calls.
13. A pre-cutover snapshot is never restored over newer persistent mutations without reconciliation.
14. The native device credential vault is not copied, cleared, refreshed for testing, or re-paired.
15. OAuth semantics, Jazz schema, accepted worker protocol, and device ownership semantics do not change during repository consolidation.

## Cutover control layers

### Task admission freeze

Persistent marker: `control-plane/.data/task-admission.frozen`.

The task freeze rejects new `enqueue_task` work, new worker sessions, and new claims. An idempotent
retry for an already-existing task is still readable, and a task already running under the same
worker session can retry its existing claim and save its terminal result.

This is the first cutover freeze because remote workers still require public MCP access to call
`save_task_result`.

### Worker-session quiescence

`pnpm cutover:quiesce-workers` is an operator action. It fails closed unless task admission is
frozen, the expected deployment owner is verified against Better Auth and observed Jazz state, with no unexpected active owner, and there are zero running jobs. Once those
conditions hold it closes stored active worker sessions through the authoritative Jazz backend.

Because task freeze prevents new sessions and new claims, a successful quiesce establishes a stable
worker boundary.
### Device-effect admission freeze

Persistent marker: `control-plane/.data/effect-admission.frozen`.

The effect freeze rejects creation of new `remoteCalls`. Existing idempotent call rows remain
available to retry/reconcile. This marker is applied only after workers are quiesced, so it cannot
prevent an already-running worker from using device tools required to finish.

### Stack-wide readiness

`pnpm cutover:inspect` requires `CUTOVER_EXPECTED_OWNER_ID` and queries all worker jobs, remote
calls, worker sessions, and devices. It does not filter the evidence to the supplied owner.
`CUTOVER_EXPECTED_OWNER_ID` is checked read-only against the file-backed Better Auth user table,
and the same owner must also be observed somewhere in durable Jazz state. Historical terminal-only
owner IDs remain diagnostic and do not block readiness. Unexpected active owners block readiness
when they own queued or running jobs, non-terminal remote calls, active worker sessions, or
non-revoked devices. Entirely empty Jazz state fails closed.

Exit codes are:

- `0`: ready for public-ingress freeze;
- `2`: observed state is not cutover-ready;
- `1`: configuration/runtime error.

Ready means both task and effect admission are frozen, the expected owner is verified against
Better Auth and observed in Jazz, no unexpected active owner is present, no worker job is running,
no remote call is non-terminal, and no effective worker session is active.

Queued jobs may remain. They cannot be claimed while task admission is frozen and survive the
repository migration as durable work.

The CLI explicitly exits after Jazz cleanup because the pinned Jazz NAPI runtime can retain process
handles.

### Persistent public-ingress maintenance

Persistent marker: `control-plane/.data/public-ingress.frozen`.

When this marker exists, `run-local-stack.sh` starts Jazz and Next on loopback but invokes
`cutover-control.sh ingress-enforce-frozen` instead of `tailscale funnel --bg`. A launchd restart
therefore cannot accidentally reopen the public MCP surface.
`cutover-control.sh ingress-freeze` verifies the current 443 Funnel mapping before resetting it.
It resets only a mapping provably targeting this service's `http://127.0.0.1:<web-port>`; unknown
or foreign 443 mappings fail closed.

`ingress-open` is a separate operator action and removes the maintenance marker only after Funnel
has been successfully enabled and inspected.

## Independent control prerequisite

The production device agent and Remote Desktop Commander cannot be the only control path for the
cutover. Stopping that agent can remove the channel being used to execute or roll back the
migration.

Before public ingress is disabled, establish either:

- a local interactive terminal on the Mac; or
- an independent SSH session whose lifecycle does not depend on Desktop Commander or Funnel.

From that independent session run:

```bash
cd /path/to/DesktopCommanderMCP/control-plane
./ops/macos/independent-control-preflight.sh attest
```

**Human-controlled terminal requirement:** this command must be typed by the operator in an
already-open independent terminal or SSH session. Remote Desktop Commander automation must not
create Terminal.app windows with AppleScript (`tell application "Terminal"` / `do script`), must
not use `open -a Terminal`, and must not append `exec zsh` to keep an automation-created window
alive. If no independent terminal/SSH session already exists, stop and ask the operator to open one.
An automation-created Terminal window is not accepted as the independent control channel.

The attestation records the repository SHA, live session PID, TTY, channel type, and timestamp. It
expires and fails if the process/TTY disappears or the checkout SHA changes. The attestation path
also rejects Remote Desktop Commander process ancestry.

Remote Desktop Commander is valid for development and pre-cutover validation, but it is not accepted
as the independent shutdown/snapshot/rollback channel.
## Cutover state machine

```text
NORMAL
  -> TASK_ADMISSION_FROZEN
  -> WORKER_DRAINING
  -> WORKER_SESSIONS_QUIESCED
  -> EFFECT_ADMISSION_FROZEN
  -> PRE_INGRESS_READINESS_VERIFIED
  -> PUBLIC_INGRESS_FROZEN
  -> POST_INGRESS_GRACE_AND_RECHECK
  -> DEVICE_EXECUTION_STOPPED
  -> SERVER_WRITERS_STOPPED
  -> SNAPSHOT_VERIFIED
  -> NEW_STACK_STARTED_INGRESS_FROZEN
  -> LOOPBACK_CONTINUITY_VERIFIED
  -> ADMISSIONS_REOPENED
  -> PUBLIC_INGRESS_REOPENED
  -> OBSERVING
```

## Operational sequence

### Phase 1 — prepare while production remains normal

Complete builds/tests/package isolation, render the destination launchd configuration without
activation, prepare rollback assets, and record old/new SHAs. Establish and attest the independent
terminal/SSH control path while the current production system remains fully available.

### Phase 2 — freeze new worker work, not MCP

From the independent channel:

```bash
./ops/macos/cutover-control.sh task-freeze
```

Keep public MCP and device execution available. Existing running workers may continue using
`wait_for_task`/their existing claim, device tools, and `save_task_result`. New sessions, tasks,
and claims are rejected.
Wait for running workers to finish. Then run:

```bash
CUTOVER_EXPECTED_OWNER_ID=<owner> pnpm cutover:quiesce-workers
```

Exit `2` means the stack is not yet safe to quiesce, including when running jobs remain. Do not
disable public ingress until this command exits `0`.

### Phase 3 — freeze new device effects

After worker-session quiescence:

```bash
./ops/macos/cutover-control.sh effect-freeze
CUTOVER_EXPECTED_OWNER_ID=<owner> pnpm cutover:inspect
```

The readiness probe must exit `0`. If it does not, investigate the listed blockers. Do not advance.

### Phase 4 — freeze public ingress

Only after the green stack-wide readiness result:

```bash
./ops/macos/cutover-control.sh ingress-freeze
```

This verifies the independent attestation, persists the maintenance marker, and removes only the
provably-owned Funnel mapping.

Existing HTTP/MCP requests may have been in flight when Funnel was changed. Wait at least **12
seconds**, exceeding the current maximum 10-second `wait_for_task` long poll, then rerun:

```bash
CUTOVER_EXPECTED_OWNER_ID=<owner> pnpm cutover:inspect
```

It must still exit `0`. If a race is observed, abort or reopen the necessary admission layer,
drain it deliberately, and repeat the gates. Never assume Funnel removal cancels already-established
requests.
### Phase 5 — stop execution and writers

Using only the independent terminal/SSH channel, stop the production device execution supervisor
without clearing credentials. Verify no device process remains able to claim calls.

Then stop the launchd-managed control-plane stack with `launchctl bootout`, not by killing only
child PIDs. Verify the expected loopback ports have no writers before snapshotting.

### Phase 6 — snapshot and destination start

Take the consistent Better Auth/Jazz/environment snapshot and migrate or reference the preserved
state. Preserve all three freeze markers into the destination state boundary, especially
`public-ingress.frozen`.

Activate the destination LaunchAgent. Its first startup must leave Funnel closed because the public
maintenance marker is already present.

### Phase 7 — loopback continuity while public ingress remains closed

Verify loopback Jazz/Next health, resource identity, state visibility, existing auth database,
device stable identity, device reconnect/heartbeat behavior, and absence of unexpected pending or
running calls. Do not reopen Funnel to make a failed loopback check pass.

After loopback continuity is accepted, reopen local admissions while public ingress is still closed:

```bash
./ops/macos/cutover-control.sh effect-open
./ops/macos/cutover-control.sh task-open
```

Then perform a final loopback readiness/state inspection.

### Phase 8 — public reopen last

Only after loopback continuity and admission-state checks:

```bash
./ops/macos/cutover-control.sh ingress-open
```

Verify the expected public resource identity and then run the normal harmless remote-call and worker
continuity smoke tests.
## Abort and rollback behavior

Before public ingress freeze, an aborted rehearsal may reopen effect/task admission deliberately and
return to `NORMAL` after checking durable state.

After ingress freeze but before server shutdown, keep the public maintenance marker until the reason
for abort is understood. Reopen ingress only through the explicit control command.

After the new deployment has made any relevant persistent mutation, do not blindly restore the
pre-cutover snapshot. Prefer old compatible code against latest compatible state or perform explicit
state reconciliation.

Relevant mutations include OAuth refresh rotation/revocation, device/heartbeat changes, worker
queue state, remote-call state, and recovery writes.

## Required tests

The cutover implementation is gated by:

- stack-wide readiness integration, including wrong-owner fail-closed behavior, empty-state
  fail-closed behavior, allowance for historical terminal-only foreign owners, and blocking of
  unexpected active owners;
- bounded CLI termination for ready and blocked results;
- task freeze preserving completion of already-running work;
- task freeze preventing new sessions/tasks/claims;
- task freeze leaving device-effect calls available during worker drain;
- worker quiescence refusing to close sessions while a job remains running;
- effect freeze rejecting new calls while preserving an existing idempotent receipt;
- Funnel ownership/refusal tests;
- independent-control preflight rejection from non-independent execution;
- restart simulation proving a public-ingress marker prevents automatic `funnel --bg`;
- normal restart simulation proving Funnel still opens when the marker is absent.

## Observation gate

Retain the old checkout and backups for at least 24 hours. The observation period must include one
controlled service restart, a device reconnect/refresh cycle, a harmless remote call, a worker task,
and log review.
Unexpected re-pairing, auth failure, durable-state mismatch, duplicate or indeterminate effect,
tunnel identity change, crash loop, old-checkout path use, or maintenance-marker violation resets the
observation gate and may trigger rollback.

## Non-goals

This cutover architecture does not add household delegation, workflow-only OAuth, approvals, chat
UI, the future two-port public/private ingress architecture, a new tunnel provider, schema
migrations, or generalized effect-retry semantics. Those remain post-consolidation product work.
