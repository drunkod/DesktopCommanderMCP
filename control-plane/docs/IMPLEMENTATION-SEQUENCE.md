# Implementation sequence from here

> **Historical bootstrap document.** The separate control-plane repository described below has been superseded by the unified `DesktopCommanderMCP/control-plane/` layout. For current migration/deployment steps, use `../../docs/local-mac-mcp-chat/08-UNIFIED-REPOSITORY-MIGRATION-PLAN.md`.


## Gate 1 — make the new control-plane repo green

Work only in:

```text
<DesktopCommanderMCP>/control-plane/
```

Run the complete `docs/TESTING.md` sequence. Fix dependency/API/type/build issues
until `just jazz-validate`, `just check`, `just build` and `just smoke` pass.
Then stage the generated `pnpm-lock.yaml` and Better Auth Jazz schema and create
the first baseline commit.

Do not modify DesktopCommanderMCP during Gate 1. A green control plane gives us
a fixed protocol target and prevents debugging both ends simultaneously.

## Gate 2 — migrate the device agent

Work in the existing repository:

```text
~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP/
```

Create `feat/jazz-remote-device` from current `main`. Add the shared protocol as
a package dependency (published, Git URL, or temporary workspace/link during
local development), then replace only the remote-device transport/auth layer.
The first device-agent milestone is deliberately narrow:

1. RFC 8628 device authorization succeeds against the local control plane.
2. The device creates/updates its Jazz `devices` row.
3. Authority-confirmed heartbeat stays fresh.
4. A `__control.ping` row is claimed and completed.
5. One harmless Desktop Commander tool is proxied end-to-end.
6. Reconnect survives killing/restarting the local Jazz server.

Only after those pass do we delete the Supabase remote-channel implementation.
Keeping it until the Jazz path proves itself gives us an easy behavioral diff.

## Gate 3 — use the Jazz fork only for proven Jazz defects

If Gate 1 or Gate 2 produces a minimal Jazz-specific failure, reproduce it in:

```text
~/Documents/work/jazz-tools-mcp-v2/
```

Create `debug/remote-mcp-jazz`, fix/test the Jazz behavior there, then point the
application temporarily at that branch/package. Do not patch Jazz internals from
the control-plane or DesktopCommander repositories.

## Gate 4 — external MCP/ChatGPT test

After local device execution is green, add Cloudflare Tunnel (already in the
flake), HTTPS URLs, ChatGPT OAuth registration and the real remote `/mcp` test.
That is the point where deployment/tunnel configuration becomes active work.
