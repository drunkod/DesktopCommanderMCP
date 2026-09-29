# Mac/Nix testing guide

This is the exact local test sequence for the current control-plane/protocol
phase. You run the commands; send me the first failure and I will assess it.

## What this phase is intended to prove

This phase does **not** yet prove the DesktopCommanderMCP device agent. That is
the next repository/branch.

When the relevant checks pass, they establish that:

1. the Nix environment is reproducible;
2. dependencies install under Node 22;
3. Better Auth can migrate its OAuth/MCP schema into SQLite;
4. Jazz application schema/permissions validate and deploy;
5. the control plane type-checks and builds;
6. Better Auth publishes JWT/JWKS correctly;
7. Jazz accepts the configured external JWT authority;
8. `/mcp` rejects unauthenticated traffic.

Architecture boundary: Better Auth persists auth state in SQLite; Jazz persists
`devices`, `remoteCalls`, `auditEvents`, `workerSessions` and `chatJobs`.

The commands below are a repeatable validation procedure; record their results
for each release. Queue/build/restart checks are separate from the remaining
[real ChatGPT OAuth and 25-minute acceptance](MVP-CHATGPT-ACCEPTANCE.md).

## Step 0 — enter the repository

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
```

## Step 1 — enter the pinned Nix shell

```bash
nix develop
just doctor
```

Expected tools come from the flake, not your global shell:

- Node 22.x
- pnpm 11.x
- Git
- SQLite CLI
- cloudflared
- `just`

The flake now includes SQLite only for inspection/operator commands. Better Auth
itself uses Node's built-in `node:sqlite` API.

If `nix develop` downloads SQLite after this change, that is expected; the
existing `flake.lock` still pins the same nixpkgs revision.

## Step 2 — install dependencies

For a fresh checkout:

```bash
just bootstrap
```

If it already passed and `pnpm-lock.yaml` is present, do not reinstall merely
because source code changed.

## Step 3 — create or upgrade local environment

A fresh checkout uses:

```bash
just env
```

This creates ignored `apps/control-plane/.env.local` with mode `0600`.

If your `.env.local` predates the SQLite architecture change, **do not regenerate
all secrets**. Upgrade it in place:

```bash
just env-upgrade
```

That adds only:

```text
BETTER_AUTH_DB_PATH=<repo>/.data/better-auth.sqlite
```

Never paste `.env.local` or any secret values into chat.

To intentionally start from completely new local identities later, stop all
processes and use `just env-force`; that is not a normal debugging step.

## Step 4 — inspect the Better Auth migration

Run:

```bash
just auth-plan
```

`auth-plan` loads `lib/auth-migration-config.ts`. That config uses the same
schema-affecting Better Auth plugins as runtime, but replaces runtime `mcp()`
with its underlying `oauthProvider()` without configured resources. This avoids
a boot-time resource seed before the OAuth tables exist.

The plan should include Better Auth core/JWT/OAuth/device-authorization tables.
Do not worry about exact table order. Do stop if it proposes dropping existing
data or reports a release-migration blocker.

The plan command may create the empty SQLite file because opening `DatabaseSync`
creates it; it must not apply the planned table/schema changes.

**Checkpoint:** on the first run, send me the `just auth-plan` output before
applying it if anything looks destructive or surprising.

## Step 5 — apply the Better Auth migration

After reviewing the plan:

```bash
just auth-migrate
```

Then inspect only non-secret database metadata:

```bash
just auth-db-info
```

Expected shape:

```text
Better Auth SQLite: .../.data/better-auth.sqlite
foreign_keys: 1
journal_mode: wal
tables:
<Better Auth tables...>
```

The database file, WAL and SHM files are all under ignored `.data/` and must
never be committed.

If migration fails, stop and send the complete first error plus `just auth-plan`
output. Do not manually create OAuth tables.

## Step 6 — validate Jazz application schema and permissions

```bash
just jazz-validate
```

There are no `better_auth_*` tables in the Jazz schema anymore. Validation is
for:

```text
devices
remoteCalls
auditEvents
workerSessions
chatJobs
```

and their permission rules.

If validation fails, stop before starting either server and send the complete
error.

## Step 7 — TypeScript and regression checks

```bash
just check
```

The control-plane `check` now includes `pnpm test:worker-restart` as well as its
other checks. A standalone restart-test pass is not a full `check` pass.

Do not fix errors by adding `any`, disabling `strict`, or suppressing a package.
Send the first root error.

### Worker restart regression

From the repository root inside the pinned Nix shell, run:

```bash
pnpm --filter @remote-dc/control-plane test:worker-restart
```

Equivalently, run `pnpm test:worker-restart` from `apps/control-plane/`. This runs
`scripts/test-worker-restart.ts`. The test:

- launches an actual child-process Jazz authority and restarts it twice;
- verifies that enqueue/claim/complete state and a closed worker session persist;
- verifies recovery using the same backend cache and a completely fresh reader
  cache, rather than relying solely on a surviving local replica;
- exercises isolated worker CLI processes and the read-only session inspector;
- verifies inspection does not heartbeat active/closed sessions or persist expiry.

The verified root cause was a control-plane Jazz context configured with tier
`global`: global-acknowledgement awaits settled locally instead of establishing
that the authority had acknowledged the writes. The correction uses an `edge`
node and explicit global transaction reads. The pinned `alpha.53` queue rejects
sealed transactions with default edge reads; explicit global reads resolve this.
Fresh-reader recovery therefore does not require the old backend cache for the
newly acknowledged writes covered by this test.

This is a process-restart persistence regression, not end-to-end production
acceptance. It does **not** prove a real ChatGPT 25-minute worker session, LIVE
launchd operation, or durability through physical reboot or power loss. Record
those acceptance results separately; a passing local test is not a substitute.

### Backend cache and worker CLI isolation

The production control-plane context uses a persistent cache selected by
`JAZZ_BACKEND_DATA_PATH`, defaulting to `.data/jazz-backend-runtime.db` relative
to the control-plane working directory (normally `apps/control-plane/`). The
runtime creates its parent directory. Prefer an absolute path in production and
use one file per concurrently running runtime.

Worker CLIs automatically use isolated, disposable temporary persistent caches
instead of sharing the web database, await globally acknowledged writes, and
shut down and clean up in `finally`.

`pnpm worker:inspect -- SESSION_ID` reads session timing and task metadata without
mutating `lastSeenAt`. Use it instead of the heartbeat-producing MCP
`task_worker_status` when observing ChatGPT's activity. See the
[acceptance runbook](MVP-CHATGPT-ACCEPTANCE.md) for production environment loading,
owner checks, and evidence limits.

**Do not delete an existing deployed backend cache until any legacy local-only
data has been reconciled or backed up.** The context-tier/read fix needs no schema
migration, but fresh-reader recovery for new writes does not establish that old
local-only data reached the authority.

## Step 8 — production build

Only after the checks succeed:

```bash
just build
```

## Step 9 — start Better Auth/control plane first

Open **Terminal A**:

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
nix develop
just web
```

Leave it running. It should listen at:

```text
http://127.0.0.1:3000
```

Confirm these browser routes load before Jazz starts:

```text
http://127.0.0.1:3000/
http://127.0.0.1:3000/sign-in
http://127.0.0.1:3000/api/auth/jwks
```

The JWKS endpoint must return a JSON key set. The runtime `mcp()` plugin may
also insert its protected-resource row into the already-migrated SQLite DB on
first startup; that is expected.

If Next reports an import/runtime error, send the first root-cause stack trace.

## Step 10 — start the Jazz authority

Open **Terminal B**:

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
nix develop
just jazz
```

`just jazz` uses the `startLocalJazzServer()` API shipped in the pinned npm
artifact. The published `alpha.53` CLI does not contain a `server` command.
The local authority uses:

- `JAZZ_JWKS_URL` -> Better Auth `/api/auth/jwks`;
- backend/admin secrets for trusted server/deploy operations;
- ignored `.data/jazz/` for local persistent Jazz state.

Published `alpha.53` has no expected issuer/audience configuration surface, so
the env generator deliberately does not advertise those variables as controls.
Treat direct Jazz sync as local/MVP-only until a published Jazz build (or strict
gateway) enforces the expected issuer and audience. The `/mcp` HTTP route already
does strict issuer/audience/scope verification before entering Jazz.

If Jazz exits at startup, send the complete startup error. Do not rotate secrets.

## Step 11 — deploy the application schema to local Jazz

With Terminal A and B still running, open **Terminal C**:

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
nix develop
just jazz-deploy
```

This publishes `schema.ts` and `permissions.ts` to the local authority. Run
`just jazz-validate` before every deliberate schema deployment.

## Step 12 — run HTTP smoke checks

Still in Terminal C:

```bash
just smoke
```

Expected sequence:

```text
[1/4] Jazz TCP/HTTP endpoint
[2/4] Control-plane home
[3/4] Better Auth JWKS
[4/4] MCP endpoint requires authentication
Smoke checks passed.
```

An unauthenticated `/mcp` request must return `401` or `403`. A `200` is a
security failure.

## Step 13 — inspect Git state

```bash
git status --short
git diff --stat
git diff --cached --stat
```

Secrets, SQLite files, `.data/jazz`, `.next` and `node_modules` must not appear.
`pnpm-lock.yaml` is tracked baseline material after successful bootstrap.

Do not commit yet. Send me the checkpoint so I can assess the migration plan,
SQLite table set, validation/compiler/build state and Git delta first.

## Checkpoint format

Send:

```text
just doctor: PASS / FAIL
just auth-plan: PASS / FAIL
just auth-migrate: PASS / FAIL
just auth-db-info: PASS / FAIL
just jazz-validate: PASS / FAIL
pnpm --filter @remote-dc/control-plane test:worker-restart: PASS / FAIL / NOT RUN
just check: PASS / FAIL / NOT RUN
just build: PASS / FAIL / NOT RUN
LIVE launchd acceptance: PASS / FAIL / NOT RUN
just jazz-deploy: PASS / FAIL
just smoke: PASS / FAIL

First failure:
<full error>

git status --short:
<output>
```

For the first `auth-plan`, include its non-secret migration summary/JSON. Do not
paste cookies, bearer tokens, refresh tokens, database row contents or env
secret values.

## Stopping/resetting

Use `Ctrl-C` in Terminal B (Jazz) and Terminal A (Next).
