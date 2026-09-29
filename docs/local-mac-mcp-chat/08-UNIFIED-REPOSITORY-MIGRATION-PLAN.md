# Unified repository migration and controlled cutover plan

**Status:** repository consolidation implemented and validated through pre-cutover gates; production cutover and local-device activation remain blocked by device branch divergence. A copied-state row-repair rehearsal found no accepted row-level repair; a clean-authority logical reseed rehearsal is the next copy-only repair track.
**Date:** 2026-09-29.
**Target repository:** `drunkod/DesktopCommanderMCP`.
**Target branch:** create a dedicated consolidation branch from the current clean Desktop Commander tip.
**Primary objective:** consolidate the product source into one Git repository without changing the accepted MVP behavior, losing runtime state, rotating identities, or making rollback ambiguous.

This plan supersedes only the earlier **repository-placement** decision that kept the control plane in a separate Git repository. It does **not** collapse the architectural boundary between the control plane and Desktop Commander.

## 1. Decision

Use the existing `DesktopCommanderMCP` repository as the single authoritative product repository and import the current `/Users/test/Documents/RemoteMCP-Jazz/implementation` Git history under:

```text
DesktopCommanderMCP/
  control-plane/
```

Keep the existing Desktop Commander package at the repository root so its upstream relationship remains straightforward. Keep the control plane's pnpm workspace, Nix flake, application layout, protocol package, operations scripts and tests internally intact during the first migration.

Do not create a third product repository. Do not combine npm and pnpm during consolidation. Do not redesign the runtime while moving the source.
## 2. Verified baseline

The migration starts from the known-good source tips below, but the Desktop Commander baseline used for the isolated consolidation checkout must be the **reviewed documentation commit created immediately before MIG-01**, not the older pre-plan SHA. Record that new SHA after committing this plan/index update:

| Component | Current branch | Baseline commit | Publication state |
| --- | --- | --- | --- |
| Desktop Commander | `docs/local-mac-mcp-chat-plan` | pre-plan source tip `5abac1a`; replace with reviewed docs commit before MIG-01 | existing source tip pushed; new docs baseline must be recorded before consolidation |
| Control plane | `feat/mcp-task-worker-mvp` | `393b3dd` | local only; no remote |

The unpublished control-plane history is exactly:

```text
95184e8  feat: add local Remote MCP Jazz control plane
b5cd9c6  ops: add local service and deployment tooling
393b3dd  docs: add setup testing and acceptance runbooks
```

The current control-plane regression command has been rerun successfully from the existing checkout:

```bash
cd /Users/test/Documents/RemoteMCP-Jazz/implementation
nix develop -c pnpm check
```

It completed with exit code 0, covering the passkey patch/security tests, OAuth revocation matrix, worker queue, MCP transport, two-authority restart/cold-cache recovery and TypeScript checks.

This green state is the migration baseline. Consolidation must not weaken or silently bypass it.
## 3. Current runtime facts that affect migration

The repository move is not only a source-control operation. The current deployed control plane is path-sensitive.

Verified path-sensitive behavior includes:

- `flake.nix` sets `REMOTE_MCP_ROOT="$PWD"` inside the control-plane development shell.
- `scripts/init-local-env.sh` writes `BETTER_AUTH_DB_PATH` using the checkout's absolute root.
- `scripts/jazz-server.sh` derives Jazz authority storage from `$ROOT/.data/jazz`.
- `ops/macos/run-local-stack.sh` currently defaults its root to `/Users/test/Documents/RemoteMCP-Jazz/implementation`.
- The production runner defaults `JAZZ_BACKEND_DATA_PATH` to `$ROOT/.data/jazz-backend-runtime.db`.
- `ops/macos/install-launch-agent.sh` generates runtime paths and also performs the live `launchctl bootout/bootstrap/kickstart` cutover.
- The installed LaunchAgent currently points directly at the old `implementation` checkout.
- The current runtime environment file stores Nix-resolved Node and pnpm paths and is generated under the checkout's `.data` directory.

Therefore, importing Git history and switching the running service are separate phases with separate rollback points.

## 4. Target repository layout

The first migration should produce this shape without broad refactoring:

```text
DesktopCommanderMCP/
├── src/                       # existing Desktop Commander source
├── test/
├── scripts/
├── docs/
│   └── local-mac-mcp-chat/
│       └── 08-UNIFIED-REPOSITORY-MIGRATION-PLAN.md
├── control-plane/
│   ├── apps/control-plane/
│   ├── packages/protocol/
│   ├── ops/
│   ├── scripts/
│   ├── docs/
│   ├── patches/
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── pnpm-workspace.yaml
│   ├── flake.nix
│   ├── flake.lock
│   └── Justfile
├── package.json               # existing Desktop Commander npm package
├── package-lock.json
├── flake.nix                  # existing Desktop Commander flake
└── flake.lock
```

The two development environments remain intentionally nested at first:

- repository root: Desktop Commander npm/Nix environment;
- `control-plane/`: control-plane pnpm/Nix environment.

No root workspace should automatically absorb `control-plane/` during the mechanical migration.

## 5. Source-of-truth classification

Everything under `/Users/test/Documents/RemoteMCP-Jazz` must be classified before copying anything.

| Existing area | Classification | Migration treatment |
| --- | --- | --- |
| `implementation/` tracked files | Product source | import with history under `control-plane/` |
| `repositories/DesktopCommanderMCP/` | Product source / destination | retain at repository root |
| `plan/` | design history | selectively curate later into docs |
| `research/` notes | engineering research | selectively curate, never bulk-import clones |
| `research/repositories/` | third-party clones | keep outside product repository |
| `references/` | third-party/reference source | keep outside; record URL/SHA/licence instead |
| `repositories/remote-desktop-commander/` | upstream registry/reference checkout | keep outside unless a concrete owned artifact is required |
| `archive/` | superseded history | keep external or curate a small historical subset |
| `.codegraph/`, `graphify-out/` | generated indexes/reports | regenerate; do not import as product source |
| `node_modules/`, `.next/`, `.next-*/` | generated dependencies/builds | regenerate; do not migrate |
| `.data/`, secrets, databases | persistent operational state | preserve separately; never commit |

This distinction is mandatory: **excluded from Git does not mean safe to delete.**

## 6. Persistent-state inventory

Before any deployment cutover, create a state manifest containing path, role, size, permissions, checksum where practical, backup location and restore test result.

At minimum inventory:

1. Better Auth SQLite database, including WAL/SHM state as applicable.
2. Jazz authority data under the current `.data/jazz` directory.
3. Persistent Jazz backend runtime database/cache and its WAL/SHM files.
4. `apps/control-plane/.env.local`, without printing secret values into logs.
5. Jazz signing keys and admin/backend secrets referenced from that environment.
6. Current `JAZZ_APP_ID`, public origin/resource identity and OAuth settings.
7. Generated LaunchAgent plist and launchd runtime environment file.
8. Tailscale Funnel identity/configuration and current target.
9. Desktop Commander stable device ID at `~/.desktop-commander-device/device.json`.
10. The complete Desktop Commander native credential vault. On macOS the current store uses Keychain service `com.desktopcommander.remote-mcp` with logical account `device-oauth-session`, a current manifest account `device-oauth-session:manifest`, and generation-specific chunk accounts referenced by that manifest; the unqualified account is a legacy fallback, not a complete backup target.
11. Tailscale identity store under `~/.config/desktop-commander/tailscale.json` when used.
12. Acceptance evidence needed for post-cutover comparison.

For this same-user, same-Mac repository migration, **leave the live Keychain vault untouched**. Do not export, rewrite, clear or re-pair it as part of source/state migration. If a future machine/user migration requires credential transfer, use a separate format-aware encrypted procedure that reads the manifest and all referenced chunks; never copy only the legacy account.

Secrets must not be copied into Git, pasted into tickets, or emitted into migration logs.

## 7. State strategy: preserve identity, change paths deliberately

The migration must not call `init-local-env.sh --force` and must not generate replacement secrets merely because the checkout path changes.

Preferred state strategy for the first cutover:

- Preserve the existing identity and database contents exactly.
- Back up the complete state while writers are stopped or otherwise quiesced.
- Restore/copy the required state into the destination control-plane state directory **or** deliberately configure stable external state paths.
- Update path-valued environment entries explicitly.
- Regenerate only machine-derived runtime files such as the launchd Nix profile/runtime environment.
- Validate the restored databases before exposing the new process.

A later improvement may move persistent state out of the Git checkout entirely, for example to a stable application-state directory. That is a separate refactor and should not be mixed into the first repository consolidation unless tested independently.

## 8. Git history preservation model

The three control-plane commits are unpublished, so prefixing them under `control-plane/` is acceptable even though their commit IDs will change.

Required safeguards:

- Create a durable bundle or bare backup of the original `implementation` repository before rewriting.
- Record original branch name and all original commit SHAs.
- Perform history rewriting only in a disposable temporary clone.
- Retain an old-SHA → new-SHA mapping in migration evidence.
- Import the transformed history non-squashed.
- Verify tree equivalence before any path edits.
- Keep the mechanical import commit/history separate from post-import path/config changes.

Authorship, dates and commit order should be preserved where the rewriting tool supports it.
## 9. Isolated consolidation checkout

Do not perform the import in the currently deployed checkout.

Create a separate clone or Git worktree dedicated to consolidation. Requirements:

- It must start from the reviewed Desktop Commander baseline.
- It must not share generated `node_modules`, `.next`, `.data`, CodeGraph DBs or launchd files with production.
- Starting a validation stack from it must use isolated test state and alternate ports.
- It must never repoint the production Funnel during pre-cutover testing.
- It must not invoke the live launch-agent installer until the explicit cutover step.
- An isolated checkout is **not** a credential-vault boundary: the current macOS Keychain namespace is shared by all checkouts running as the same user.
- Pre-cutover device tests must use an injected in-memory/test credential store, a separate OS user, or an explicitly separate test vault namespace. They must not initialize, refresh, pair, repair or clear the production native vault.
- Merely changing ports, checkout paths or lock-file paths is insufficient credential isolation.

A branch name such as `chore/unified-monorepo` is appropriate.

## 10. Publication-safety gate

Before the first push containing the imported history, inspect **all three original control-plane commits and their transformed equivalents**.

The audit must check tracked history for:

- private keys or signing material;
- OAuth/access/refresh tokens;
- passwords, API keys and database credentials;
- `.env.local` or generated environment files;
- SQLite databases, WAL/SHM files or database dumps;
- household/account/user information;
- logs, screenshots or acceptance artifacts containing private content;
- machine-specific absolute paths that disclose more than is acceptable;
- third-party source copied without appropriate licence/attribution.

Also verify the target GitHub repository visibility is intentional before publication.

A clean working tree is not sufficient evidence for this gate.
## 11. Mechanical import procedure

The implementation phase should follow this order:

### MIG-01 — freeze source identities

Record:

```text
DesktopCommanderMCP source SHA
implementation source SHA
branch names
remote URLs
git status
git fsck result
```

Create Git bundles/backups before rewriting any history.

### MIG-02 — transform the control-plane history

In a disposable clone of `implementation`, rewrite every tracked path to live beneath `control-plane/`.

Allowed approaches include `git filter-repo --to-subdirectory-filter control-plane` or an equivalently reviewable history transformation.

Do not run the rewrite in the original control-plane repository.

### MIG-03 — verify transformed history

Verify:

- exactly three logical commits remain;
- authorship/order/message intent is retained;
- no generated/untracked files became tracked;
- `control-plane/.gitignore` is present;
- old-to-new commit mapping is recorded.

Then compare the transformed final tree under `control-plane/` against the original tracked tree, ignoring only the expected path prefix.
### MIG-04 — merge into the isolated Desktop Commander branch

Merge the transformed branch while retaining its history. Do not squash.

Immediately after merge, before path edits:

- verify `git status` is clean;
- verify `git fsck`;
- verify the root Desktop Commander tracked tree outside `control-plane/` is unchanged from baseline;
- verify the imported control-plane tree is equivalent to the original;
- verify no nested `.git` directory was imported.

This point is the cleanest repository-level rollback point.

## 12. Post-import configuration changes

Only after tree equivalence is proven should path-sensitive changes be committed.

Create a separate commit for minimal migration compatibility changes. Expected areas include:

- control-plane documentation paths;
- default `REMOTE_MCP_ROOT` assumptions;
- launchd scripts that embed the historical absolute checkout;
- test/runbook commands that assume `~/Documents/RemoteMCP-Jazz/implementation`;
- any scripts whose `process.cwd()` contract now requires execution from `control-plane/`;
- top-level documentation explaining the nested application.

Do **not** simultaneously redesign OAuth, Jazz schemas, queue semantics, tunnel architecture or the package-manager layout.

Every path change should have a test or explicit runtime-resolution check.

## 13. Ignore and artifact boundaries

The imported `control-plane/.gitignore` must continue excluding its local state and generated files after nesting.

Verify from the monorepo root that these remain ignored:

```text
control-plane/node_modules/
control-plane/.pnpm-home/
control-plane/apps/control-plane/.next/
control-plane/apps/control-plane/.next-*/
control-plane/apps/control-plane/.env.local
control-plane/.data/
control-plane/apps/control-plane/.data/
control-plane/.codegraph/
```
The root repository must not accidentally absorb control-plane build output through a broad `git add`.

## 14. Package and release isolation

Desktop Commander's npm package currently restricts published files to `dist`, `logo.png` and `testemonials`, which reduces accidental inclusion risk but does not replace validation.

Add explicit checks for:

- `npm pack --dry-run` or equivalent package inventory;
- MCPB/release bundle contents;
- release scripts that operate from `process.cwd()`;
- Docker/build contexts;
- GitHub Actions or scripts using repository-root globs;
- source archives or release automation that could include `control-plane/`;
- control-plane commands that mistakenly resolve dependencies from the root npm project.

Expected result: the control plane is present in Git but absent from Desktop Commander's published npm/MCP artifacts unless explicitly intended.

## 15. Clean dependency-install validation

Validation should not depend on existing `node_modules`.

In the isolated checkout:

### Desktop Commander

Use the lockfile-preserving install path appropriate to the repository, then run the existing build/tests.

### Control plane

Run from the nested directory:

```bash
cd control-plane
nix develop
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

The important requirement is the working directory: because the flake exports `REMOTE_MCP_ROOT="$PWD"`, run it from `control-plane/` for the first migration.
Do not infer that `nix develop ./control-plane` from the repository root is equivalent until that behavior is explicitly tested.

## 16. CodeGraph validation

Before source changes, retain the existing per-project graph evidence.

After the import and path fixes:

1. initialize or rebuild CodeGraph at the unified repository root;
2. verify it indexes both root Desktop Commander and `control-plane/`;
3. query the main cross-boundary concepts: OAuth/device pairing, remote calls, worker queue, tunnel/runtime, credential persistence;
4. compare key call paths against the pre-migration graph;
5. retain per-subtree indexes only if they add value; the unified root becomes the default architectural graph.

Generated CodeGraph databases remain untracked.

## 17. Pre-cutover runtime validation

Repository validation is not deployment validation.

Before switching launchd, validate the destination checkout with isolated state and non-production ports where possible.

Rules:

- Do not point validation at the production Better Auth or Jazz writers concurrently.
- Do not run a second authority against the same writable Jazz state.
- Do not change the production Funnel mapping.
- Do not use the production native device credential at all for pre-cutover pairing/refresh/repair/clear validation.
- Device validation that needs credentials must use an injected test store or separate OS-user/vault boundary.
- Prefer synthetic/test identities and disposable state for parallel validation.

Validate at least:

- control-plane startup;
- protected-resource and authorization metadata;
- passkey/OAuth test paths;
- Jazz authority and backend cache creation;
- worker enqueue/claim/result lifecycle;
- remote-call schema/serialization;
- clean shutdown and restart.
## 18. Cutover preparation

The cutover is a controlled operational event.

Before stopping production:

- ensure repository and test gates are green;
- run the destination launchd installer in a non-activating `render`/prepare mode and inspect the generated plist/runtime paths;
- resolve and verify the destination Nix Node/pnpm runtime while production is still running;
- ensure the target checkout commit is recorded;
- prepare destination directories and permissions;
- prepare but do not activate destination environment configuration;
- verify the rollback checkout and old LaunchAgent runner still exist;
- capture current service status, public origin, device identity and queue counts;
- establish and attest a live local-terminal or SSH control channel that is independent of Remote Desktop Commander and the public Funnel;
- freeze **new worker/task admission first**, while keeping public MCP and device effects available so already-running workers can finish and call `save_task_result`;
- after running jobs reach zero, quiesce stored active worker sessions;
- then freeze **new device-effect admission**, preserving only reconciliation/retry of already-created idempotent call rows;
- require the stack-wide cutover probe to verify the expected owner read-only against Better Auth and observed in Jazz, use trusted backend-service runtime evidence for worker jobs/remote calls/worker sessions plus the conservative backend-service/authority-admin device union, allow historical terminal-only foreign owners as diagnostic, block unexpected active owners, and confirm both admission freezes, zero running jobs, zero non-terminal remote calls and zero active worker sessions;
- require a non-divergent four-view device-identity reconciliation dry-run before local-device activation; `blocked-backend-divergence` means stop for manual authority/backend-branch maintenance, not automatic rewrite;
- only then freeze public Funnel ingress; wait at least 12 seconds (longer than the current 10-second worker long poll) and repeat the stack-wide probe to catch in-flight-request races;
- if any effect cannot be proven terminal/acknowledged, abort cutover or record it as quarantined/indeterminate before proceeding;
- identify and prepare the supervisor stop commands for both the control-plane stack and the independent device/execution path;
- establish a short change freeze so no intentional work is submitted during the final snapshot.

Do not invoke `install-launch-agent.sh install` during preparation. That command performs the actual service replacement. The migration implementation must add a narrowly scoped non-activating `render` mode (or equivalent) that resolves the runtime and writes/prints a candidate plist without `bootout`, `bootstrap` or `kickstart`.

## 19. Consistent state snapshot

Immediately before cutover:

1. From the independently attested local/SSH control channel, activate the **task admission freeze**. Do not disable public MCP yet.
2. Let already-running workers finish, including any required device calls and `save_task_result`; new worker sessions, task inserts and task claims are rejected.
3. Run the worker-quiesce helper. It must refuse while running jobs remain and must exit successfully only after it can close the remaining active worker sessions.
4. Activate the **effect admission freeze** so no new `remoteCalls` can be created; already-created idempotent receipts remain reconcilable.
5. Run the stack-wide readiness probe with the authoritative expected owner, verified read-only against Better Auth and observed in Jazz. Use trusted backend-service evidence for worker jobs, remote calls, and worker sessions, plus the conservative union of backend-service and authority-admin device inventory. Historical terminal-only foreign owners are diagnostic; unexpected active owners block readiness. It must exit `0`.
6. Freeze public ingress through the ownership-checking Funnel control. The persistent ingress marker must remain set across subsequent restarts.
7. Wait at least 12 seconds, then run the stack-wide readiness probe again. If a request raced the Funnel transition, abort/reconcile and repeat the freeze sequence rather than guessing.
8. If any effect cannot be proven terminal/acknowledged, abort the cutover or explicitly quarantine it as `indeterminate`; do not silently retry it after restart.
9. Using the independent control channel, stop the Desktop Commander remote device/execution path **without clearing credentials** and verify its supervisor will not immediately restart it.
10. Stop the launchd-managed control-plane stack with the supervisor itself (for launchd, use `launchctl bootout`), not merely by killing child PIDs.
11. Verify device, Next and Jazz writer processes remain stopped and the production ports are no longer owned.
12. Record the stop time and final queue/call state.
13. Take a consistent backup of Better Auth SQLite, Jazz authority data and required backend state, including the cutover marker state needed by the destination.
14. Back up `.env.local` and deployment configuration with restrictive permissions.
15. Record checksums and file ownership/modes for restored files where useful and verify the backup is readable.
16. Copy/restore state to the destination or configure the destination to the chosen stable state path.
17. Before resuming the device/execution path, inspect restored remote-call state and ensure quarantined/indeterminate effects are not re-executed automatically.

If SQLite WAL mode is active, do not copy only the main database file from a live writer and assume consistency.

## 20. Destination environment migration

Create the destination `control-plane/apps/control-plane/.env.local` from the preserved deployment configuration, not from fresh secret generation.

Review every path-valued setting, especially:

- `BETTER_AUTH_DB_PATH`;
- `JAZZ_BACKEND_DATA_PATH` if set explicitly;
- any path references introduced by local overrides.

Preserve identity-bearing values such as `JAZZ_APP_ID`, signing keys, OAuth secrets, public origin/resource and Jazz secrets.
The move must not force users or devices to re-pair merely because the Git checkout changed.

Local device state and its non-secret config belong under `control-plane/.data/device-agent`.
Generate the dedicated credential service `com.desktopcommander.remote-mcp.local-jazz` and local
DPAPI/lock paths there. Do not reuse the default/shared native vault or
`~/.desktop-commander-device` paths. Do not copy or rewrite the legacy default `device.json` as
part of migration.

## 21. Launchd cutover

Only after the destination build and state are ready:

1. Build the production Next application in the destination.
2. Verify the destination runtime script resolves the intended control-plane root.
3. Ensure the destination has the persistent public-ingress maintenance marker **before** activation.
4. Run the destination launch-agent installer as the explicit cutover action.
5. Confirm the generated plist points to `DesktopCommanderMCP/control-plane`, not the historical implementation path.
6. Confirm new `launchd-runtime.env` and Nix profile paths were regenerated under the destination.
7. Before activating or starting the local device, require successful four-view identity convergence across backend-service, device capability, dashboard capability, and admin authority; create the isolated config only after convergence.
8. Confirm Jazz and Next listen on the expected loopback ports while Funnel remains closed.
9. Confirm only one production stack owns the state and ports.
10. Verify loopback auth/state/device continuity while public ingress is still closed.
11. Reopen effect admission and task admission only after loopback continuity passes.
12. Reopen Funnel **last** using the explicit ingress-open control, then verify the same intended public identity and target.

Device identity convergence is a cutover gate; this plan does not claim the current production device branch is repaired.

The production control plane is pinned to jazz-tools 2.0.0-alpha.53. Do not treat an in-place
Jazz upgrade as a device-branch repair action. Upstream `garden-co/jazz`'s
`packages/jazz-tools/CHANGELOG.md` states that 2.0.0-alpha.54 changes the storage format without
automatic migration from alpha.53 and tells deployments with existing production data to obtain
migration help before upgrading. Therefore, Jazz alpha.54+ evaluation is a separate migration
track requiring copied-state testing and an explicit migration/rollback plan; it is not part of
this repository cutover.

Do not delete the old checkout after this step.

## 22. Post-cutover continuity tests

Startup alone is insufficient. Test continuity of existing identities and durable state.

Required checks:

- existing passkey sign-in succeeds;
- existing OAuth/client behavior remains valid;
- protected-resource metadata exposes the same logical MCP resource;
- existing device stable ID is retained;
- existing device OAuth credential is accepted or refreshes normally;
- device does not unexpectedly enter a new pairing flow;
- device heartbeat becomes healthy;
- device list/ping/reconnect behavior works;
- a harmless remote Desktop Commander tool call completes;
- OAuth revocation behavior remains correct;
- a queued worker task can be claimed and completed;
- completed worker state survives one controlled restart;
- historical durable records expected to survive are visible.

Record pass/fail evidence against the pre-cutover baseline.
## 23. Rollback model

Rollback depends on whether the new deployment accepted writes.

### Case A — before cutover

Rollback is trivial: discard the isolated consolidation checkout. Production is unchanged.

### Case B — after cutover, with proven absence of relevant persistent mutations

This case is allowed only when evidence proves there have been **no relevant persistent mutations** since the cutover snapshot—not merely no user-submitted work. Relevant mutations include OAuth refresh-token rotation, revocation, device/heartbeat state, recovery writes, queue/call changes and background maintenance.

If that absence is proven, stop the new stack and execution path, restore the old LaunchAgent configuration, and start the old checkout against the compatible preserved state.

### Case C — after any relevant persistent mutation, or when mutation absence cannot be proven

Do **not** blindly restore the pre-cutover snapshot. Prefer stopping writers and running the old compatible code against the **latest compatible state**, or transfer that latest state back consistently. First classify writes:

- Better Auth/OAuth changes;
- device state;
- remote calls/results;
- worker jobs/results;
- revocations;
- schema migrations.

Choose forward repair or an explicit data reconciliation. An old snapshot can lose accepted work or resurrect revoked authority.

Therefore the cutover evidence must include a timestamp and a clear marker for the first post-cutover persistent mutation.

The rollback commands, old plist, old checkout path, backup locations and state-compatibility decision must be prepared and **rehearsed before cutover**. The rollback-drill gate blocks cutover, not merely archival.

## 24. Observation period and archival

Use a **minimum 24-hour observation period** after cutover. It must include at least one controlled service restart, one device reconnect/refresh cycle, one harmless remote call, one worker task, and review of launchd/control-plane/device error logs. Any unexpected re-pairing, auth failure, durable-state mismatch, duplicate/indeterminate effect, tunnel identity change, repeated crash/restart, or path reference to the old checkout resets the observation gate and may trigger rollback.

Keep both old checkouts and backups until all of the following are true:

- continuity tests pass;
- at least one normal restart succeeds;
- backup/restore verification is complete;
- no path unexpectedly references the old checkout;
- release/package checks are clean;
- CodeGraph indexes the unified repository correctly;
- the consolidated branch is reviewed and pushed;
- the 24-hour observation period and required lifecycle events complete without rollback-triggering faults.

Only then archive or remove redundant source checkouts.
Deleting regenerated caches such as old `.next` or `node_modules` is a separate disk-cleanup task and must not be confused with deleting persistent state.

## 25. Commit structure

Keep review boundaries small and reversible. A recommended sequence is:

1. **merge/import history** — non-squashed transformed control-plane history only.
2. **chore(paths)** — minimal nested-path/runtime-resolution fixes.
3. **test(monorepo)** — migration-specific package/build/path checks if new tests are required.
4. **docs(monorepo)** — root documentation and curated project docs.
5. **ops(cutover-readiness)** — only if source changes are required to make cutover safer.

Do not bury auth/queue/product changes inside migration commits.

## 26. Documentation curation

Do not bulk-copy `RemoteMCP-Jazz/plan`, `research`, `references` and `archive` into the product repository.

After source consolidation, review documents individually:

- move still-authoritative architecture decisions into `docs/`;
- retain concise provenance links to external reference repositories and exact SHAs;
- archive or label superseded Supabase-era material;
- avoid importing large graph outputs or third-party repositories;
- preserve the accepted MVP evidence/runbooks that developers actually need.

The documentation should distinguish:
- current source of truth;
- historical investigation;
- external reference material;
- generated evidence.

## 27. Product-development sequencing after consolidation

Repository consolidation should finish before broad new product work. The next development stages are:

### PROD-A — freeze the accepted MVP boundary

Preserve the accepted worker protocol:
`wait_for_task -> claim_task -> save_task_result`.

Clean compatibility hints and housekeeping without changing semantics.
### PROD-B — define multi-user authorization semantics

Before family users can cause computer actions, define and enforce:

1. requester identity;
2. device owner identity;
3. household/family membership;
4. requester-to-device grants;
5. allowed tools/capabilities/path scopes;
6. workflow-worker identity and scope;
7. approval requirements;
8. revocation behavior;
9. audit identity;
10. effect/result reconciliation semantics.

The current owner check `device.ownerId === subject` is correct for the private owner MVP and must not be bypassed by pretending a family requester is the owner.

### PROD-C — least-privilege worker identity

Introduce a workflow-only OAuth/grant purpose and tool surface. The family/chat worker should receive queue/session/result capabilities, not broad owner device controls.

Negative tests must prove hidden/direct invocation of owner/admin/device tools is denied.

### PROD-D — chat data/API foundation

Add households/memberships, conversations, conversation membership, messages and durable events while reusing existing `chatJobs`.

Implement authenticated same-origin chat admission and bounded replay/SSE or polling. Browsers should not directly mutate Jazz worker/device tables.
### PROD-E — minimal /chat UI

Build the authenticated shell, conversation list, timeline, idempotent composer and honest worker/waiting states.

The UI may be developed earlier against fake replies, but enabling real device effects remains blocked on PROD-B/C.

### PROD-F — delegated device effects and approvals

Preserve the real device owner. Add requester identity and explicit grants to effect admission.

Start with a harmless fixture-folder read. Add disposable writes only after approval receipts and lost-acknowledgment behavior are proven.

### PROD-G — indeterminate-effect safety

Separate:
- local execution outcome;
- durable result acknowledgment.

If the device effect succeeded but completion reporting is uncertain, retry the same durable completion receipt or mark the operation `indeterminate`. Never blindly rerun a non-idempotent effect because acknowledgment was lost.

### PROD-H — ingress hardening

Implement the planned public/private boundary so the tunnel exposes only the intended public surface.

Keep route-level authorization even after network isolation.

### PROD-I — recovery, backup and household acceptance

Run backup/restore, reboot/sleep/tunnel-loss/token-refresh/device-child recovery and multi-user privacy/authorization tests before household rollout.
## 28. Validation matrix

| Gate | Required evidence | Blocks |
| --- | --- | --- |
| Git baseline | clean status, SHAs, bundles, fsck | import |
| Publication audit | no tracked secrets/private dumps; visibility approved | push |
| Tree equivalence | original implementation == imported prefixed tree | path edits |
| Root integrity | Desktop Commander baseline unchanged outside intended paths | path edits |
| DC clean install/build | lockfile install + build | merge readiness |
| DC tests | complete repository test gate | merge readiness |
| CP clean install | pnpm frozen lockfile from `control-plane/` | CP tests |
| CP regression | `pnpm check` green | cutover |
| CP production build | Next production build green | cutover |
| Package isolation | npm/MCPB/release inventory excludes control plane | push/release |
| Path resolution | nested flake/scripts resolve correct root | cutover |
| State backup | consistent snapshot + restore/read verification | cutover |
| Cutover controls | task/effect/readiness integration + bounded CLI exits green; auth-backed expected-owner verification and unexpected active-owner blocking verified | cutover |
| Restart-safe ingress | maintenance restart test proves Funnel remains closed | cutover |
| Independent control | live local/SSH attestation independent of Remote Desktop Commander/Funnel | cutover |
| Launchd dry inspection | non-activating render resolves Nix runtime and generated destination paths correctly | cutover |
| Runtime health | Jazz + Next + tunnel healthy | continuity tests |
| Identity continuity | passkey/OAuth/device identity preserved | completion |
| Worker continuity | queue/result survives restart | completion |
| CodeGraph root index | both halves indexed, key paths queryable | developer handoff |
| Rollback drill | old plist/checkout/state paths prepared; non-destructive rollback procedure rehearsed | cutover |

A failed required gate stops the dependent phase; do not convert failures into documentation-only warnings.

## 29. Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| copied live SQLite/Jazz state is inconsistent | auth/data loss | quiesce writers; consistent backup; restore verification |
| launchd starts old checkout after migration | split-brain/confusion | inspect installed plist and process command paths |
| two stacks write same state | corruption/races | isolated test state; one production writer |
| Funnel repointed during validation | outage | prohibit production tunnel mutation before cutover |
| secrets enter transformed history | credential exposure | full-history publication audit before push |
| imported history loses provenance | auditability loss | original bundle + SHA mapping + non-squashed import |
| root release picks up control plane | oversized/leaky package | package inventory gates |
| nested flake uses wrong working directory | wrong state/path | run from `control-plane/`; explicit path tests |
| fresh env generation rotates identity | forced reauth/re-pair | preserve env/secrets; never `--force` during move |
| rollback restores stale snapshot after writes | accepted work lost/revocation undone | post-write rollback reconciliation |
| family chat gains owner tools | privilege escalation | auth semantics + workflow-only identity before effects |
| uncertain effect is replayed | duplicate destructive action | indeterminate/outbox semantics before delegated writes |

## 30. Definition of done for repository consolidation

The consolidation is complete only when:

- one Git repository contains both authoritative product source trees;
- Desktop Commander remains at repository root;
- the control plane lives under `control-plane/` with preserved logical history;
- original unpublished history is backed up and mapped to transformed SHAs;
- no runtime database, secret or generated state is tracked;
- both clean-install build/test gates pass;
- Desktop Commander release artifacts do not unintentionally include the control plane;
- production runs from the new checkout;
- existing auth, OAuth, device identity and worker data remain continuous;
- a restart passes after cutover;
- rollback remains possible and documented;
- the unified root has a working CodeGraph index;
- reviewed consolidation history is pushed;
- old checkouts are retained until the observation/restore gates pass.

## 31. Immediate execution order

When implementation begins, perform these next actions in order:

1. Capture Git/state/deployment baseline and create backups.
2. Create an isolated Desktop Commander consolidation checkout.
3. Audit unpublished control-plane history for publication safety.
4. Transform the control-plane history under `control-plane/`.
5. Merge and prove tree equivalence before path edits.
6. Apply minimal nested-path fixes as separate commits.
7. Run clean installs, both test suites, builds and package inventories.
8. Rebuild CodeGraph at the unified root and verify architecture queries.
9. Prepare destination state and rollback assets without touching production launchd.
10. Quiesce production and take the final consistent state snapshot.
11. Restore/configure state in the destination and build production assets.
12. Run the launchd installer as the explicit cutover.
13. Execute identity/state/device/worker continuity tests.
14. Push the reviewed consolidation branch only after the publication gate passes.
15. Observe, run restart/restore checks, then archive redundant checkouts.
16. Keep production cutover and isolated local-device activation blocked until device branch divergence is resolved and all views converge.
17. Run the copy-only clean-authority logical reseed rehearsal described in Plan 09, with isolated state and ports.
18. If and only if every reseed acceptance criterion passes, separately design and review a production migration/cutover; rehearsal success alone does not authorize production migration.
19. Resume product development with authorization semantics before multi-user device execution.

### Completed copied-state branch-repair rehearsal (2026-09-29)

The committed command `pnpm device:rehearse-branch-repair` is copied-state-only. The rehearsal operated only on SQLite backups under `/tmp` and random isolated Jazz ports; production state was not a mutation target. Three fresh-copy candidates were tested:

| Candidate | Fresh-copy observation | Durable canonical result |
| --- | --- | --- |
| Backend update of `stableId` | Candidate acknowledged; both copied views looked canonical immediately. After authority restart plus a brand-new backend cache, the backend view returned to the stale `stableId`. | `durableCanonical=false` |
| Backend upsert of the full device row, same ID and canonical `stableId` | Immediate copied backend view looked canonical. After authority restart plus a brand-new backend cache, the backend view returned to stale. | `durableCanonical=false` |
| Admin upsert of the already-canonical authority row | Admin stayed canonical; backend stayed stale immediately and after restart. | `durableCanonical=false` |

No tested row-level update/upsert is an accepted production repair. Do not weaken `blocked-backend-divergence` or create/start the isolated local device based on this evidence. Production remains pinned to Jazz alpha.53; do not perform an in-place upgrade as a repair.

### Next repair track: clean-authority logical reseed rehearsal (COPY-ONLY first)

This is a proposed rehearsal, not an implemented or validated repair. Execute only against copied state, using isolated authority/backend storage and ports:

1. Snapshot source authority and backend state.
2. Start the copied source authority read-only for canonical export.
3. Create a new empty isolated authority using the same app ID, admin secret, and backend secret only inside the rehearsal.
4. Deploy the same schema and permissions to the new authority.
5. Export current canonical application rows from the authority-admin view for every app table.
6. Import those rows to the new authority in dependency-safe order, preserving row IDs, references, timestamps/business fields, and current revoked/status state.
7. Do not copy old row-history or internal storage files into the new authority.
8. Restart the new authority and connect a brand-new empty backend cache.
9. Verify complete application-level table inventory/content equivalence, device/dashboard/admin/backend visibility, owner/client invariants, no active-work drift, and stable canonical device identity.
10. Only if all checks pass, separately design a production migration/cutover. The rehearsal itself authorizes no production migration.

## 32. Explicit non-goals of the migration

The consolidation task does not itself:

- add the family chat UI;
- change OAuth scopes;
- redesign Jazz schema/permissions;
- change the accepted 25-minute worker contract;
- introduce the two-port ingress architecture;
- switch tunnel providers;
- merge npm and pnpm workspaces;
- move persistent state to a new long-term system directory unless separately approved;
- delete the historical workspace;
- upgrade major dependencies;
- refactor Desktop Commander upstream structure.

Keeping these out of scope is what makes the repository move reviewable and reversible.

---

**Execution principle:** first prove that the exact accepted product has been moved without semantic change. Only then use the unified repository to continue MVP/product development.
