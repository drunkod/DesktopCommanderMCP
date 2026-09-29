# Controlled cutover architecture

**Status:** migration architecture companion to Plan 08.
**Scope:** repository consolidation cutover only; no product authorization redesign.

## Objective

Move the accepted local control plane from the historical `implementation` checkout to
`DesktopCommanderMCP/control-plane/` without creating a window where a remote effect can be
executed twice, losing accepted durable work, rotating device credentials, or exposing a second
writer against the same persistent state.

## Safety invariants

1. Public admission is frozen before execution draining begins.
2. Loopback device completion access remains available while admitted effects drain.
3. The native device credential vault is never copied, cleared, refreshed for testing, or re-paired.
4. At most one production control-plane stack writes the production Better Auth/Jazz state.
5. At most one production device agent consumes pending remote calls.
6. Every executing remote call is durably terminal before the device execution path is stopped.
7. Running worker jobs are durably terminal before server writers are stopped.
8. A pre-cutover snapshot is never restored over newer persistent mutations without reconciliation.
9. The old checkout, old plist, Git bundles, and snapshot remain available through observation.
10. The cutover does not change OAuth, Jazz schema, worker protocol, or device ownership semantics.

## Control boundary

For this migration, admission freeze is an ingress operation rather than a queue-schema change.

The public ChatGPT/MCP ingress is suspended while the loopback control plane remains online.
This prevents new public requests from entering while preserving the local device API needed for
claim acknowledgements, heartbeats, and terminal result commits.

Do not implement a new durable queue state solely for repository migration.

## Cutover state machine

```text
NORMAL
  -> PUBLIC_INGRESS_FROZEN
  -> DRAINING
  -> DRAINED
  -> DEVICE_EXECUTION_STOPPED
  -> SERVER_WRITERS_STOPPED
  -> SNAPSHOT_VERIFIED
  -> NEW_STACK_STARTED
  -> CONTINUITY_VERIFIED
  -> OBSERVING
```

Any failed gate before `NEW_STACK_STARTED` returns to the previous safe state or aborts the
cutover. After persistent mutations occur on the new stack, rollback uses the latest compatible
state rather than blindly restoring the pre-cutover snapshot.

## Readiness probe

`control-plane/apps/control-plane/scripts/inspect-cutover-readiness.ts` is intentionally
read-only. It reports, for one owner:

- queued worker jobs;
- running worker jobs;
- non-terminal remote calls;
- active worker sessions;
- online devices.

The probe declares `drained=true` only when there are no running worker jobs and no non-terminal
remote calls. Queued jobs and active sessions are observations, not execution blockers by
themselves, because public ingress must already be frozen before the probe is authoritative.

The probe does not prove that ingress is frozen, that supervisors are stopped, or that a database
snapshot is consistent.

## Operational sequence

### Phase 1 — prepare while production is live

Build and test the destination checkout. Render the destination launchd configuration without
activation. Resolve the Nix runtime. Verify package isolation. Prepare rollback assets. Record the
old and new commit SHAs.

### Phase 2 — freeze admission

Suspend the public ingress only. Keep loopback Next/Jazz and the current device agent online.
Confirm externally that the public endpoint no longer admits new MCP work.

### Phase 3 — drain effects

Run the readiness probe repeatedly against production state. Wait until there are no running worker
jobs and no non-terminal remote calls. If a call cannot become terminal, stop and classify it as an
operator-visible indeterminate case before proceeding. Never replay it merely because completion
is uncertain.

### Phase 4 — stop execution

Stop the production device agent using its supervisor boundary, not only a child PID. Do not clear
or refresh the native credential vault. Verify no device process remains able to consume calls.

### Phase 5 — stop writers and snapshot

Stop the launchd-managed control-plane stack using launchd. Verify Next and Jazz writers remain
stopped and production ports are no longer owned. Take a consistent snapshot of Better Auth/Jazz
state and preserve the existing environment file with restrictive permissions.

### Phase 6 — start destination

Restore or point the destination to the preserved state, build production assets, activate the
destination LaunchAgent, and confirm only one production stack owns the state and ports. Restore
public ingress only after loopback health and device state reconciliation pass.

### Phase 7 — continuity

Verify existing passkey sign-in, OAuth behavior, device stable identity, native credential reuse,
heartbeat, one harmless remote call, one worker task, durable restart behavior, and the expected
public resource identity.

## Rollback

Before any new-stack persistent mutation, the old code may be restarted against compatible current
state after the new stack is stopped.

After any relevant persistent mutation—or when mutation absence cannot be proven—do not restore the
older snapshot by default. Stop writers and prefer running the old compatible code against the
latest compatible state, or transfer that state back consistently.

Relevant mutations include token rotation, revocation, device state, heartbeats, queue/call changes,
and background recovery writes.

## Observation gate

Retain the old checkout and backups for at least 24 hours. The period must include a controlled
restart, a device reconnect or refresh cycle, one harmless remote call, one worker task, and log
review. Unexpected re-pairing, auth failure, state mismatch, duplicate or indeterminate effect,
tunnel identity change, crash loop, or old-checkout path use resets the observation gate.

## Non-goals

This architecture does not add household delegation, workflow-only OAuth, approvals, chat UI,
public/private two-port ingress, a new tunnel provider, schema migrations, or new effect retry
semantics. Those remain post-consolidation product work.
