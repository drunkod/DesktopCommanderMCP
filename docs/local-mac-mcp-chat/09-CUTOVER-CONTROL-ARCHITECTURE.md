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
8. Stack-wide readiness uses the trusted backend-service view for worker jobs, remote calls, and worker sessions, and the conservative union of backend-service and authority-admin views for device inventory. An active row visible in either device view remains a readiness blocker.
9. Public ingress is disabled only after task and effect admission are both frozen and the stack-wide readiness probe is green.
10. The public-ingress maintenance marker survives supervisor restarts; launchd startup must not reopen Funnel while it exists.
11. At most one production control-plane stack writes production Better Auth/Jazz state.
12. At most one production device agent consumes production remote calls.
13. A pre-cutover snapshot is never restored over newer persistent mutations without reconciliation.
14. The native device credential vault is not copied, cleared, refreshed for testing, or re-paired.
15. OAuth semantics, Jazz schema, accepted worker protocol, and device ownership semantics do not change during repository consolidation.
16. The unified local Jazz device uses an isolated non-secret config under `control-plane/.data/device-agent` and a dedicated native credential namespace; it must not share the default Desktop Commander OAuth vault or lock paths.
17. If backend-service device history disagrees with the canonical identity in authority-admin/device/dashboard views, local-device activation is blocked until manual authority/backend-branch maintenance resolves it.

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
and the same owner must also be observed somewhere in durable Jazz state. The principal model is
split: worker jobs, remote calls, and worker sessions come from the trusted backend-service view;
device inventory is the conservative union of backend-service and authority-admin views. Device
rows are deduplicated only when `id`, `ownerId`, `status`, and revocation state agree; a
`stableId` disagreement alone does not double-count an otherwise identical activation record. If
the same row disagrees on owner, status, or revocation across views, both evidence records are
retained so readiness fails closed. Historical terminal-only owner IDs remain diagnostic, but any
non-revoked device in either view contributes an active owner. Unexpected active owners block
readiness when they own queued or running jobs, non-terminal remote calls, active worker sessions,
or non-revoked devices. Entirely empty Jazz state fails closed.

### Device identity continuity and Jazz branch divergence

The isolated non-secret local-device config is
`control-plane/.data/device-agent/device.json` and must contain only `stableId`. Generated
local-device environment uses the dedicated credential service
`com.desktopcommander.remote-mcp.local-jazz` plus DPAPI and lock paths under
`.data/device-agent`. `run-local-device` refuses the shared default namespace and
`~/.desktop-commander-device` paths. The legacy default
`~/.desktop-commander-device/device.json` is not a migration or stable-ID source and must remain
untouched because older installations may contain credential-format data.

Reconciliation compares backend-service, device capability, dashboard capability, and admin
authority views. When capability/admin views agree on canonical identity but backend-service
differs, dry-run reports `blocked-backend-divergence`; apply must fail before mkdir, config
staging, or database mutation. Automatic backend-history rewriting/upsert is not an accepted
repair. Manual authority/backend-branch maintenance from an independently controlled terminal or
SSH is required, followed by a fresh dry-run. Do not create the isolated config or start the unified
local device until all four views converge.

#### Copied-state branch-repair rehearsal (2026-09-29)

The committed command `pnpm device:rehearse-branch-repair` is copied-state-only. It operated only on SQLite backups under `/tmp` and random isolated Jazz ports; production state was not used as a mutation target. Three fresh-copy candidates were tested:

| Candidate | Result | `durableCanonical` |
| --- | --- | --- |
| Backend update of `stableId` | Candidate acknowledged and both copied views looked canonical immediately; after authority restart plus a brand-new backend cache, backend returned to stale `stableId`. | `false` |
| Backend upsert of full device row with same ID and canonical `stableId` | Immediate copied backend looked canonical; after authority restart plus a brand-new backend cache, backend returned stale. | `false` |
| Admin upsert of already-canonical authority row | Admin stayed canonical; backend stayed stale both immediately and after restart. | `false` |

No tested row-level update/upsert is an accepted production repair. Do not weaken `blocked-backend-divergence` or create/start the isolated local device based on this evidence. Production remains pinned to Jazz alpha.53; do not in-place upgrade as a repair.

#### Clean-authority logical reseed rehearsal — COPY-ONLY accepted (2026-09-29)

The clean-authority recovery path is now implemented as:

```bash
pnpm device:rehearse-clean-reseed
```

It is a **copy-only** recovery rehearsal. It does not authorize production migration, and every accepted result explicitly records `productionMigrationAuthorized=false`.

The rehearsal closes the recovery gaps that blocked the earlier proposal:

1. **Source completeness and provenance.** It takes transactionally consistent SQLite `.backup` snapshots of both authority and backend state, records immutable hashes/provenance, and compares logical application content across backend-service and authority-admin views. Principal-exclusive rows are accepted only when they match the current permission model: devices/remote calls/audit on the admin side, worker sessions/chat jobs on the backend side, plus exactly one explained target-device overlap. Any other overlap or wrong-side row blocks acceptance.
2. **Canonical composite.** The target device is merged only for the explained fields: canonical `stableId` from admin/device/dashboard consensus and the newer `lastSeenAt` from the backend branch. All other fields must already agree, and reference closure must remain valid.
3. **Principal-preserving reseed.** A fresh authority is deployed with the same schema and permissions before import. Backend-owned rows are seeded through the backend context; admin-owned rows through admin. The target device is deliberately materialized into both branches with the same canonical logical row so backend, admin, dashboard, and device-capability views all retain their required visibility.
4. **Reconnect compatibility.** After authority restart, both fresh principal projections must match their expected logical snapshots exactly. A copy of the pre-reseed backend cache is then reconnected, required to synchronize exactly, and performs a canonical no-op write. The authority is restarted again and another brand-new backend cache must still converge. The production remote device uses `driver: { type: "memory" }`, so there is no persistent device Jazz cache to retire.
5. **Immutable evidence.** The evidence snapshots are never opened by a Jazz server. Running authorities use separate working copies. Snapshot SHA-256 values and SQLite `quick_check` results are verified before/after the rehearsal.

Accepted evidence:

- evidence directory: `control-plane/.data/recovery-evidence/clean-reseed-20260929T234323Z`
- committed recovery-code SHA recorded by the evidence manifest: `ae06bd3e93f17dced59c2db9ae565a270d66c24d`
- process exit: `0`
- `rehearsalAccepted=true`
- `productionMigrationAuthorized=false`
- fresh backend projection: exact
- fresh admin projection: exact
- backend/admin/dashboard/device target identity: canonical and exact
- copied pre-reseed backend cache: exact synchronization and write acknowledged
- post-reconnect fresh-cache convergence: exact
- backend cache retirement required: `false`
- persistent device Jazz cache: none
- immutable authority/backend snapshot hashes: unchanged before/after
- SQLite `quick_check`: `ok`

This proves a **candidate recovery procedure on copied state**, not permission to execute it live. The operator handoff is documented in `10-JAZZ-CLEAN-RESEED-PRODUCTION-RUNBOOK.md`. Before any freeze, `ops/macos/verify-jazz-clean-reseed-live-preflight.sh` must pass from a human-controlled independent Terminal/SSH session. A production reseed still requires current-state re-snapshot/revalidation, freeze/drain gates, rollback assets, execution of the reviewed stage/apply commands from that independent channel, and explicit post-handoff verification before local-device activation.

Do not use the older row-level update/upsert candidates. Do not copy old Jazz row-history into the new authority. Do not flatten all tables through one principal: alpha.53 preserves meaningful principal-specific visibility, and the accepted rehearsal depends on preserving that provenance.

The operational recovery boundary is hardened in commit `ae06bd3`. `device:capture-clean-reseed-frozen-state` creates a stopped-state recovery manifest whose authoritative freshness fingerprints are SQLite `.backup` hashes and whose diagnostics record WAL/SHM state. Production staging and handoff both re-backup the still-stopped live authority/backend databases and require exact fingerprint equality before proceeding. `device:stage-clean-reseed` binds its stage manifest to that exact recovery-manifest path/hash and snapshot pair. `device:apply-clean-reseed` creates and fsyncs a write-ahead handoff journal before the first rename, records `prepared -> old-moved -> new-live -> awaiting-validation`, and supports journal/state-driven recovery after hard interruption while services remain stopped. `device:verify-clean-reseed` uses a dedicated verifier backend cache rather than opening the web process's cache, bounds Jazz operations with a shell watchdog, explicitly exits after cleanup, and fails closed on malformed/rejected zero-exit output. The committed-code stage rehearsal `control-plane/.data/recovery-stage/rehearsal-20260929T234452Z` passed with `stageReady=true`, returning-cache compatibility, and post-cache fresh convergence; a handoff/recovery rehearsal using the accepted/staged SQLite copies preserved both hashes and restored both paths exactly. None of these rehearsals authorizes or performs live production recovery.

#### Jazz repair/upgrade boundary

The current upstream jazz-tools CLI exposes validation, schema export/hash, deploy, permissions
status, and migration create/push; it does not expose an operator row-history/branch-repair
command. Jazz implements internal sync repair through row-version fetch and canonical known-state
repair, but that is protocol/runtime machinery, not an operator maintenance surface. The production
dependency is 2.0.0-alpha.53. Upstream 2.0.0-alpha.54 explicitly introduced a breaking
storage-format change without automatic migration from alpha.53 and advises production users with
existing data to get migration help. Therefore, do not upgrade production alpha.53 storage in place
to solve this divergence. Any alpha.54+ experiment must use a copied snapshot or new isolated data
directory, must never point at the production state directory, and needs a tested
rollback/migration procedure before consideration.

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
activation, check the device branch-convergence dry run before cutover, prepare rollback assets,
and record old/new SHAs. Establish and attest the independent
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
running calls. Device continuity requires four-view convergence before starting or resuming the
unified local device. Do not reopen Funnel to make a failed loopback check pass.

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
- backend/admin device-union coverage, including a backend-only foreign active device blocking
  readiness;
- reconciliation apply-guard proof that divergent backend state exits nonzero before filesystem or
  database writes;
- dedicated credential namespace enforcement and legacy-path refusal;
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
