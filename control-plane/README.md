# RemoteMCP Jazz implementation

This directory is the self-hosted Remote Desktop Commander **control-plane component**
inside the unified `DesktopCommanderMCP` repository. It preserves its own pnpm/Nix
workspace so the control plane can be developed and validated independently from the
root Desktop Commander npm package.

## Repository responsibilities

- `apps/control-plane/` — Next.js MCP/OAuth/dashboard service.
- `packages/protocol/` — shared Jazz application schema and protocol constants.
- `scripts/` — local developer/test helpers.
- `ops/` — deployment examples; not required for local Mac development.
- `docs/` — testing, Git and implementation workflow.

Better Auth owns OAuth/OIDC/MCP authentication state in SQLite. Jazz owns the
Remote MCP application data (devices, calls and audit events) and validates
Better Auth JWTs through JWKS. Supabase is not part of this implementation.

Desktop Commander device-agent code remains at the unified repository root under
`src/remote-device/`. The control plane stays nested here so the upstream Desktop
Commander tree remains structurally close to its original layout.

## Quick start

```bash
cd /path/to/DesktopCommanderMCP/control-plane
nix develop
just doctor
just bootstrap
just env               # fresh checkout only
just auth-plan
```

If `.env.local` was created before the SQLite pivot, run `just env-upgrade`
instead of regenerating secrets. Review `just auth-plan` before applying
`just auth-migrate`.

Then follow [`docs/TESTING.md`](docs/TESTING.md) exactly. The local development
loop uses one Better Auth SQLite file, one Jazz authority, and one Next.js
control plane.

Do not commit `apps/control-plane/.env.local`, `.data/`, `.next/` or
`node_modules/`. They are ignored intentionally.

## Current phase

The private no-chat Jazz/Better Auth worker MVP is implemented and tested. The
current phase is unified-repository consolidation and controlled deployment cutover,
followed by least-privilege multi-user authorization and chat work. See the root
`docs/local-mac-mcp-chat/08-UNIFIED-REPOSITORY-MIGRATION-PLAN.md`.

See [`docs/JAZZ-BETTER-AUTH-DECISION.md`](docs/JAZZ-BETTER-AUTH-DECISION.md)
for the compatibility research behind the SQLite/JWKS boundary.
