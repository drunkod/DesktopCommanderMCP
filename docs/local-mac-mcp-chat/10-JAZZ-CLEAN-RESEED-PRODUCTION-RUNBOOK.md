# Jazz clean-authority production recovery runbook

**Status:** operator handoff prepared; live recovery is **not yet authorized**.
**Date:** 2026-09-29.
**Scope:** recover the historical Jazz alpha.53 device-branch divergence after repository consolidation and control-plane deployment relocation are already complete.

The accepted copy-only recovery evidence is:

- evidence: `control-plane/.data/recovery-evidence/clean-reseed-20260930T042753Z`
- recovery-code SHA recorded by the evidence: `c872470262362f9bdadde33f595465c618f3c8f7`
- `rehearsalAccepted=true`
- `productionMigrationAuthorized=false`
- old backend cache reconnect: compatible
- post-reconnect fresh-cache convergence: exact
- device Jazz persistence: memory-only

This document does not override `productionMigrationAuthorized=false`. It defines the operator boundary and the sequence that must be satisfied before the reviewed live stage/apply commands may be executed.

## 1. Non-negotiable boundaries

1. Run live maintenance only from a human-controlled, already-open Terminal or SSH session.
2. Remote Desktop Commander may prepare code and inspect evidence, but it is not the accepted shutdown/snapshot/rollback channel.
3. Do not use row-level Jazz update/upsert repair against the old authority.
4. Do not upgrade production alpha.53 storage in place.
5. Do not copy old Jazz row-history into the clean authority.
6. Preserve principal provenance: backend queue state stays backend-owned; admin-visible devices/calls/audit stay admin-owned.
7. Materialize the target device in both backend and admin branches with the same canonical logical row.
8. Keep the unrelated/default Desktop Commander credential vault and any unrelated global remote process untouched.
9. Do not create or start the isolated local-Jazz device until four-view identity convergence is verified after recovery.
10. Public ingress reopens last.
## 2. Human independent-control gate

From an already-open local Terminal or independent SSH session:

```bash
cd /Users/test/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP/control-plane
./ops/macos/independent-control-preflight.sh attest

export DEVICE_RESEED_ACCEPTED_EVIDENCE_DIR="$PWD/.data/recovery-evidence/clean-reseed-20260930T042753Z"
./ops/macos/verify-jazz-clean-reseed-live-preflight.sh
```

The second command must print:

```text
live clean-reseed preflight: PASS
independent_control=verified
production_state_mutated=false
```

If it does not pass, stop. Do not freeze ingress or stop writers.

The preflight verifies that the accepted evidence is intact, its Git SHA is an ancestor of the current checkout, the recovery implementation has not changed since that evidence, the repository is clean, the live state files exist, no cutover freeze marker is already active, and the independent-control attestation is valid for the current checkout.

## 3. Freeze and drain while MCP is still reachable

Set the expected deployment owner only in the independent shell:

```bash
export CUTOVER_EXPECTED_OWNER_ID='<deployment owner id>'
./ops/macos/cutover-control.sh task-freeze
pnpm cutover:quiesce-workers
./ops/macos/cutover-control.sh effect-freeze
pnpm cutover:inspect
```

Required result: `pnpm cutover:inspect` exits 0.

Task freeze occurs first so an already-running worker retains its public MCP completion path. Worker sessions are quiesced only after running jobs reach zero. Effect admission freezes only after workers are quiesced.
## 4. Freeze public ingress and close request races

After readiness is green:

```bash
./ops/macos/cutover-control.sh ingress-freeze
sleep 12
pnpm cutover:inspect
```

The second readiness check must also exit 0. The 12-second grace exceeds the current maximum 10-second `wait_for_task` long poll.

If state changed during the grace period, do not continue. Reopen only the specific layer needed, drain deliberately, and repeat the gates.

## 5. Stop execution and server writers

The unified local-Jazz device should still be inactive at this stage. Verify that no process launched through `run-local-device.sh` is consuming calls.

Do **not** stop an unrelated global/upstream `desktop-commander remote` process merely because it runs under the same macOS user. The local-Jazz launcher has a dedicated config and credential namespace and is the only device process in scope for this recovery.

Stop the launchd-managed control-plane stack from the independent shell:

```bash
launchctl bootout "gui/$(id -u)/com.remote-mcp.local-stack"
```

Then verify that the production loopback writers are gone:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:1625 -sTCP:LISTEN
```

Both commands must show no production listener before final snapshots are taken.
## 6. Final frozen-state recovery snapshot

With all three freeze markers present, launchd booted out, and ports 3000/1625 free, capture the stopped state from the independent shell:

```bash
pnpm device:capture-clean-reseed-frozen-state -- production
```

The command creates a mode-0700 directory under `control-plane/.data/recovery-live/frozen-*` and prints its path. Set:

```bash
export RECOVERY_DIR='<printed absolute recovery directory>'
export DEVICE_RESEED_LIVE_RECOVERY_MANIFEST="$RECOVERY_DIR/recovery-manifest.json"
```

The capture uses SQLite `.backup` for the Jazz authority and backend runtime databases and, when configured, Better Auth. It also preserves the production `.env.local`, installed LaunchAgent plist and launchd runtime environment with restrictive permissions.

`recovery-manifest.json` binds:

- the current Git SHA;
- the exact stopped live authority/backend paths;
- the exact snapshot paths and SHA-256 values;
- SQLite `quick_check` results;
- a logical stopped-state fingerprint defined as the SHA-256 of a SQLite `.backup` made from each stopped live database;
- WAL/SHM presence, size and SHA-256 at capture as diagnostic context.

The logical fingerprint is authoritative for freshness because SQLite `.backup` includes committed state visible through WAL. Before staging and again immediately before handoff, the recovery code creates fresh temporary `.backup` files from the still-stopped live databases and requires their hashes to equal the manifest fingerprints.

You can verify this explicitly while writers remain stopped:

```bash
./ops/macos/verify-jazz-clean-reseed-frozen-state.sh "$RECOVERY_DIR/recovery-manifest.json"
```

The accepted copy-only evidence is not a substitute for this final frozen snapshot. Production may have changed since the rehearsal.

Preserve the old Jazz authority directory and backend cache as a rollback pair. Do not overwrite either one in place.

## 7. Validated logical recovery semantics

The implemented stager `pnpm device:stage-clean-reseed -- production` reproduces the semantics proven by `pnpm device:rehearse-clean-reseed`. It accepts only frozen snapshot inputs under `.data/recovery-live`, requires the independent-control attestation, all three freeze markers, launchd booted out, and no listeners on ports 3000/1625:

1. Start only working copies of the frozen snapshots on isolated ports.
2. Read both backend-service and authority-admin logical projections.
3. Require the known permission/provenance split:
   - admin: devices, remote calls, audit events;
   - backend: worker sessions, chat jobs;
   - exactly one target-device overlap.
4. Require reference closure and no unexplained overlap.
5. Build the target canonical row using canonical `stableId` from admin/device/dashboard consensus and the newer `lastSeenAt` from the backend branch.
6. Create a new empty authority with the same app ID, admin/backend secrets, schema, permissions and JWKS contract.
7. Seed backend-owned projection through the backend context.
8. Seed admin-owned projection through admin.
9. Materialize the canonical target row in both branches.
10. Restart the staged authority and verify exact backend/admin projections and all four target views.
11. Reconnect a copy of the pre-reseed backend cache, require exact synchronization and an acknowledged canonical no-op write.
12. Restart again and require another fresh backend cache to converge exactly.
## 8. Implemented stage and handoff boundary

The production stage/apply boundary is implemented, but **has not been executed against live Jazz state**.

Current hardened recovery implementation SHA: `c872470262362f9bdadde33f595465c618f3c8f7`.

Committed-code rehearsal evidence:

- staged authority: `control-plane/.data/recovery-stage/rehearsal-20260930T042846Z`
- `stageReady=true`
- stage manifest Git SHA: `c872470262362f9bdadde33f595465c618f3c8f7`
- returning backend cache compatible: `true`
- post-returning-cache fresh convergence: `true`
- `productionApplyAuthorized=false`
- handoff rehearsal using copies of the accepted old and staged SQLite authority: new-stage hash landed at the live rehearsal path and the old-authority hash landed at rollback;
- journal phase after successful rehearsal handoff: `awaiting-validation`;
- supervised startup barrier transition: `startup-attempted` with `startupAttempted=true` before any Jazz/Next/pnpm runtime subprocess is invoked;
- copied-state startup-failure rehearsal: Jazz exited before opening a listener, all processes were stopped, and automatic `recover` still refused to move either authority directory;
- journal recovery before any startup attempt restored both the old live authority and the staged new authority exactly.

Production staging, from the independently controlled shell **after Phase 6 frozen snapshots exist**, is:

```bash
export DEVICE_RESEED_STAGE_SOURCE_AUTHORITY_DB="$RECOVERY_DIR/source-authority.sqlite"
export DEVICE_RESEED_STAGE_SOURCE_BACKEND_DB="$RECOVERY_DIR/source-backend.sqlite"
export DEVICE_RESEED_LIVE_RECOVERY_MANIFEST="$RECOVERY_DIR/recovery-manifest.json"
export DEVICE_RESEED_DEVICE_ID='<target device row id>'
export DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID='<historical backend stable id>'
export DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID='<canonical stable id>'

pnpm device:stage-clean-reseed -- production
```

Before staging, the wrapper verifies that the selected authority/backend snapshots are exactly the pair named by `recovery-manifest.json`, that their hashes match, and that fresh logical backups of the still-stopped live databases still equal the frozen-state fingerprints. The stager then writes only under `.data/recovery-stage/production-*`, deploys schema/permissions into a new authority, preserves backend/admin provenance, validates both principal projections, reconnects a copy of the frozen backend cache, restarts again with a fresh cache, stops every staged process, runs SQLite `quick_check`, hashes the staged authority, and writes `stage-manifest.json`. That stage manifest records the recovery-manifest path and SHA-256, so handoff is bound to the exact frozen pair. It never moves the active authority and never self-authorizes production apply.

After reviewing the stage manifest, handoff is:

```bash
export DEVICE_RESEED_STAGE_DIR='<absolute production stage directory>'
export DEVICE_RESEED_LIVE_RECOVERY_DIR="$RECOVERY_DIR"

pnpm device:apply-clean-reseed -- apply
```

The handoff command again requires independent-control attestation, all freeze markers, launchd booted out, no listeners, a current-SHA `mode=production` stage, matching stage hash/SQLite integrity, same-filesystem live/stage/rollback paths, and a fresh successful verification that the stopped live databases still match the frozen-state manifest.

Before the first rename it durably creates and fsyncs `.data/reseed-handoff-pending-validation.json` as a write-ahead journal with phase `prepared`. It then records these phases durably around the two directory renames:

1. active `.data/jazz` -> `$RECOVERY_DIR/pre-apply-authority-dir`; journal phase `old-moved`;
2. staged authority -> active `.data/jazz`; journal phase `new-live`;
3. after filesystem sync, journal phase `awaiting-validation`.

Ordinary errors trigger in-process rollback and preserve the stage. For an abrupt interruption where traps cannot run, the journal exists before mutation and `pnpm device:apply-clean-reseed -- recover` reconstructs the safe rollback action from both the journal and actual directory state while writers are still stopped. Recovery has tests for interruption after each rename and failures after each journal phase.

On the first supervised start after handoff, `run-local-stack.sh` invokes `mark-jazz-clean-reseed-startup-attempted.sh` **before any Jazz/Next/pnpm runtime subprocess is invoked**. That helper atomically writes and fsyncs `startupAttempted=true`, `startupAttemptedAt=<timestamp>`, and phase `startup-attempted`. If the journal update fails, the runner exits before starting Jazz or Next. Every later restart requires the already-persisted startup barrier. `recover` refuses automatic filesystem rollback once `startupAttempted=true` (or any startup/validation phase is present), even if startup failed before opening a listener and the stack is fully stopped.

Do not manually point the copy-only rehearsal at production paths or bypass the frozen-state, journal, stage/apply, or independent-control guards.

## 9. Post-recovery verification requirements

After handoff, start the existing launchd control-plane stack while all three freeze markers remain present. The runner must therefore keep public Funnel ingress closed.

From the same independently controlled shell run:

```bash
pnpm device:verify-clean-reseed
```

This command requires the independent-control attestation, all freeze markers, launchd running, loopback ports 3000/1625 listening, and the pre-existing `startupAttempted=true` barrier written by the supervised runner. It refuses to validate a journal that skipped the startup barrier. Once the running stack is confirmed, it durably advances the journal from `startup-attempted` to `validating` and records `servicesStartedAfterHandoff=true`. Automatic filesystem rollback was already disabled at the earlier startup-attempt boundary.

The verifier does **not** open the web process's configured backend-cache file. It creates a dedicated verifier cache under the selected recovery directory, connects it to the live authority, and verifies:

- the dedicated fresh backend projection exactly matches the staged expected backend hash/counts;
- the live admin projection exactly matches the staged expected admin hash/counts;
- backend/admin/dashboard/device target identity is exactly the canonical staged identity;
- owner/client/status/revocation identity has not drifted.

Jazz reads, client shutdowns and the whole verifier subprocess are bounded. The TypeScript verifier exits explicitly after cleanup, and the shell wrapper has a 90-second watchdog. If a child exits `0` but its JSON is malformed or does not contain `liveValidationAccepted=true`, the wrapper returns exit `2` rather than accidentally succeeding.

A successful result atomically updates the journal to phase `validated` with `validationComplete=true`, but explicitly reports `admissionsReopenAuthorized=false` and `publicIngressReopenAuthorized=false`.

Then run the remaining continuity gates while ingress and admissions are still frozen:

- `pnpm device:reconcile-identity` reports convergence;
- `pnpm cutover:inspect` shows no unexpected running/non-terminal state;
- isolated device config contains only the canonical `stableId`;
- loopback Next/Jazz health and resource identity are correct.

Only after those checks may the isolated local-Jazz device be activated and its dedicated credential flow tested. Public ingress remains closed until that device continuity succeeds.
## 10. Reopen and observation

After local-device continuity is verified:

```bash
./ops/macos/cutover-control.sh effect-open
./ops/macos/cutover-control.sh task-open
./ops/macos/cutover-control.sh ingress-open
```

Then verify the public resource identity, one harmless remote call, one worker task, and restart/reconnect behavior.

The 24-hour observation gate remains mandatory. It must include a controlled service restart, device reconnect/refresh cycle, harmless remote call, worker task, and log review.

Any re-pair surprise, auth failure, state mismatch, duplicate/indeterminate effect, tunnel identity change, crash loop, or old-path use resets the observation gate.

## 11. Rollback rule

Before any post-recovery persistent product mutation, rollback may restore the frozen authority/backend pair while ingress and admissions remain closed.

After any relevant mutation, do not blindly restore a stale snapshot. Use the latest compatible state or explicit reconciliation.

Relevant mutations include OAuth rotation/revocation, device heartbeat/registration, worker state, remote-call state, and recovery writes.
