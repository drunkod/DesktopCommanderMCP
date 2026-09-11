# Deployment examples

These files are MVP deployment templates for the Remote MCP control plane.
They use two authoritative durable stores:

- `better-auth-data` for Better Auth SQLite authentication/OAuth state;
- `jazz-data` for Jazz application data.

The control plane also keeps a persistent Jazz NAPI backend cache. Set
`JAZZ_BACKEND_DATA_PATH` to select its file; the default is
`.data/jazz-backend-runtime.db`, relative to the control-plane working directory
(normally `apps/control-plane/`). The runtime creates the parent directory.
Use an absolute path in production and a separate file for each concurrently
running runtime.

The earlier restart failure was not evidence that fresh clients cannot rehydrate:
the control-plane Jazz context was incorrectly configured with tier `global`, so
awaits for global acknowledgement settled locally. Using an `edge` node with
explicit global transaction reads fixes that boundary. With the pinned
`jazz-tools@2.0.0-alpha.53` queue, default edge reads reject sealed transactions;
explicit global reads resolve this.

The `scripts/test-worker-restart.ts` test restarts an actual
child-process authority twice and verifies persisted enqueue/claim/complete state
and a closed worker session using both the same backend cache and a completely
fresh reader cache. See [the testing guide](../docs/TESTING.md#worker-restart-regression)
for the command and coverage limits. Record full check/build and live launchd
acceptance separately from this disposable test. The remaining client behavior
gate is [real ChatGPT OAuth and 25-minute acceptance](../docs/MVP-CHATGPT-ACCEPTANCE.md).

Worker CLIs use automatically isolated, disposable temporary
persistent caches, globally acknowledged writes, and shutdown plus cleanup in
`finally`, rather than sharing the web runtime database. These disposable CLI
caches are distinct from the deployed backend cache.

**Do not delete an existing deployed backend cache until any legacy local-only
data has been reconciled or backed up.** The tier/read correction requires no
schema migration; it does not itself recover legacy local-only writes.

## Important Jazz alpha.53 boundary

The published `jazz-tools@2.0.0-alpha.53` artifact does not expose the newer
server CLI or expected issuer/audience verification found in current Jazz
`main`. The Jazz image therefore launches the shipped NAPI server API and uses
`socat` only to expose its loopback listener inside the container network.

Treat direct Jazz sync in this Compose template as MVP/lab infrastructure until
a published Jazz release (or a strict WebSocket gateway) enforces the expected
JWT issuer and audience.

## Prepare the environment

From `ops/`:

```bash
cp .env.example .env
# edit .env with production origins and secrets
cp cloudflared/config.yml cloudflared/config.local.yml
# edit tunnel UUID/credential references

docker compose config
```
## First deployment: migrate Better Auth before web startup

Build the images, then inspect and apply the auth migration into the mounted
SQLite volume:

```bash
docker compose build

docker compose run --rm --no-deps web \
  pnpm --filter @remote-dc/control-plane auth:plan

docker compose run --rm --no-deps web \
  pnpm --filter @remote-dc/control-plane auth:migrate
```

Review `auth:plan` before applying migrations to an existing production volume.
The web container receives `BETTER_AUTH_DB_PATH=/data/auth/better-auth.sqlite`,
so users, OAuth clients/grants, refresh tokens and JWKS signing keys survive
container replacement.

Start the stack only after migration succeeds:

```bash
docker compose up -d
```

The web container talks to Jazz internally at `http://jazz:1625`. Browser and
device clients use the public Jazz hostname configured in `JAZZ_SERVER_URL`.

## Required public routes

```text
remote.example.com      -> web:3000
sync.remote.example.com -> jazz:1625
```

## macOS local-only MVP service

For the home-Mac MVP, `ops/macos/` runs Jazz and the production Next control
plane directly on loopback and reasserts Tailscale Funnel for port 3000. Build
first, with no `next dev` process using the same `.next` directory:

```bash
nix develop -c pnpm --filter @remote-dc/control-plane check
nix develop -c bash -lc 'cd apps/control-plane && set -a && source .env.local && set +a && BETTER_AUTH_DB_PATH=:memory: pnpm build'
./ops/macos/install-launch-agent.sh install
./ops/macos/install-launch-agent.sh status
```

The installer resolves the repository's pinned Node/pnpm toolchain once and
records it under ignored `.data/launchd-*` files. The LaunchAgent itself does
not evaluate the Nix flake or require network access to start the application.
It starts Jazz on `127.0.0.1:1625`, Next on `127.0.0.1:3000`, reasserts
`tailscale funnel --bg 3000`, and restarts the pair if either supervised child
exits. Logs are written to `~/Library/Logs/remote-mcp-local-stack*.log`.

This is a user LaunchAgent, so it starts when that macOS user logs in. Tailscale
must already be installed, authenticated, and allowed to use Funnel. A
Tailscale-provided hostname is tied to the current tailnet identity; if the
public MCP URL must survive tailnet/provider migration unchanged, put an owned
hostname in front of the service instead.

To remove the service:

```bash
./ops/macos/install-launch-agent.sh uninstall
```

## Device service examples

Linux systemd and macOS launchd examples are included under `ops/systemd/` and
`ops/launchd/`. Adjust the user, installation paths and environment-file paths
before installing them. Device processes receive public Jazz/control-plane
coordinates and device credentials only; never give them Jazz admin/backend
secrets or the Better Auth database path.

## Backups

Back up both named volumes. Losing `better-auth-data` invalidates users, OAuth
grants, refresh-token families and persisted JWKS keys. Losing `jazz-data`
removes device/call/audit history, worker sessions and chat jobs. Do not treat
either volume as a cache. Preserve the existing deployed backend cache as well
until any legacy local-only data has been reconciled or backed up; fresh-reader
success for newly acknowledged writes is not proof that legacy data reached the
authority.
