# RemoteMCP Jazz implementation

This directory is the **real implementation repository** for the self-hosted
Remote Desktop Commander control plane. Research and prototypes stay one level
up under `plan/` and `research/`.

## Repository responsibilities

- `apps/control-plane/` — Next.js MCP/OAuth/dashboard service.
- `packages/protocol/` — shared Jazz application schema and protocol constants.
- `scripts/` — local developer/test helpers.
- `ops/` — deployment examples; not required for local Mac development.
- `docs/` — testing, Git and implementation workflow.

Better Auth owns OAuth/OIDC/MCP authentication state in SQLite. Jazz owns the
Remote MCP application data (devices, calls and audit events) and validates
Better Auth JWTs through JWKS. Supabase is not part of this implementation.

The Desktop Commander device-agent changes are intentionally **not** copied
into this repository. They belong in the existing `DesktopCommanderMCP` Git
repository so upstream changes remain mergeable.

## Quick start

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
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

Phase 1 is to get the control-plane/protocol repository reproducibly green
under Nix. Phase 2 moves into the existing DesktopCommanderMCP repository and
replaces its Supabase remote transport with the shared Jazz protocol.

See [`docs/JAZZ-BETTER-AUTH-DECISION.md`](docs/JAZZ-BETTER-AUTH-DECISION.md)
for the compatibility research behind the SQLite/JWKS boundary.
