# Jazz clean-authority production recovery runbook

**Status:** operator handoff prepared; live recovery is **not yet authorized**.
**Date:** 2026-09-29.
**Scope:** recover the historical Jazz alpha.53 device-branch divergence after repository consolidation and control-plane deployment relocation are already complete.

The accepted copy-only recovery evidence is:

- evidence: `control-plane/.data/recovery-evidence/clean-reseed-20260929T215309Z`
- recovery-code SHA recorded by the evidence: `5c843ea80c47824183ed2a4f255224572d58db7d`
- `rehearsalAccepted=true`
- `productionMigrationAuthorized=false`
- old backend cache reconnect: compatible
- post-reconnect fresh-cache convergence: exact
- device Jazz persistence: memory-only

This document does not override `productionMigrationAuthorized=false`. It defines the operator boundary and the sequence that must be satisfied before a separately reviewed live stage/apply implementation may be executed.

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

export DEVICE_RESEED_ACCEPTED_EVIDENCE_DIR="$PWD/.data/recovery-evidence/clean-reseed-20260929T215309Z"
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

Create a new recovery directory outside Git, under `control-plane/.data/recovery-live/`, with mode 0700.

While writers remain stopped, capture at minimum:

- Jazz authority SQLite using SQLite `.backup`;
- Jazz backend runtime SQLite using SQLite `.backup`;
- Better Auth SQLite using SQLite `.backup`;
- production `.env.local` with mode 0600;
- installed LaunchAgent plist and launchd runtime environment;
- current Git SHA, freeze-marker state, and current Funnel status;
- SHA-256 hashes and SQLite `PRAGMA quick_check` results.

The accepted copy-only evidence is not a substitute for this final frozen snapshot. Production may have changed since the rehearsal.

Preserve the old Jazz authority directory and backend cache as a rollback pair. Do not overwrite either one in place.

## 7. Validated logical recovery semantics

A live staging implementation must reproduce the semantics proven by `pnpm device:rehearse-clean-reseed`:

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
## 8. Deliberate stop point before live replacement

There is currently **no reviewed one-click production stage/apply command** in this repository.

That is intentional. The copy-only rehearsal proves the data-recovery algorithm, not the operational authority-directory replacement.

Do not manually adapt the rehearsal by pointing it at production paths, disabling its alias guards, or changing its cleanup behavior.

Before live replacement is allowed, add and review a stage/apply implementation that:

- consumes only the final frozen snapshots;
- writes a new staged authority directory, never the active one;
- validates the staged authority with the same acceptance checks;
- stops all staged Jazz processes before handoff;
- records hashes and a manifest for the staged directory;
- supports same-filesystem atomic directory handoff while production remains stopped;
- has a rollback procedure for the old authority **and** backend-cache pair;
- refuses to run unless the independent-control preflight is valid.

Until that implementation exists and passes an isolated rehearsal, stop maintenance before Phase 8 and restore the normal service using the existing authority if necessary.

## 9. Post-recovery verification requirements

After a future reviewed live replacement, keep public ingress frozen and task/effect admission frozen until all of these pass:

- loopback Next and Jazz health;
- exact backend projection;
- exact admin projection;
- backend/admin/dashboard/device target identity equality;
- canonical target `stableId`;
- no revocation/owner/client drift;
- current backend cache synchronization;
- `pnpm device:reconcile-identity` reports convergence;
- isolated device config contains only the canonical `stableId`;
- no unexpected queued/running/non-terminal state.

Only after those checks may the isolated local-Jazz device be activated and its dedicated credential flow tested.
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
