# Continued architecture review findings

Status: **docs-only second-pass review; no application implementation or live deployment performed.**

Date: 2026-09-08. Review scope: current `docs/local-mac-mcp-chat/` plan, current DesktopCommanderMCP source, and current local `implementation/apps/control-plane` source using CodeGraph plus direct read-only inspection.

## Overall verdict

The selected product shape still holds:

```text
one immutable HTTPS origin
  /chat -> family browser UI
  /mcp  -> ChatGPT workflow MCP
  -> all application services and persistent state on the owner's MacBook
```

Jazz remains useful as the local durable application state/queue. The existing `MCPDevice -> RemoteChannel -> DesktopCommanderIntegration -> stdio` executor should be reused rather than replaced.

The plan is **not implementation-ready until the P0 findings below are resolved**. None requires adding a hosted server/database.

## P0-1 — Preserve device owner identity separately from family requester identity

Current `remoteCalls.ownerId` participates in the existing Jazz/device authorization model. Device claim and completion verify that the call owner matches the OAuth device subject and that the OAuth client owns the device.
For family sharing, do **not** replace that field with the family member ID and do not impersonate the owner merely to pass the old check.

Recommended migration:

- keep device-owner/credential identity as its own protected authority;
- add protected requester issuer/subject, parent job, delegation grant, effect operation ID and fingerprint fields, or a protected linked effect record;
- require both device-owner/client validity **and** current requester delegation at device claim time;
- keep browser/model input unable to set these authority fields.

This is now explicit in QUEUE-05.

## P0-2 — Split execution failure from completion-reporting failure

Current DC `MCPDevice.handleNewToolCall()` executes the tool and then persists `completed`. Its catch covers both execution errors and completion-persistence errors and then attempts to report `failed`.

For a destructive operation this can produce the wrong semantic result: the filesystem/process effect may already have happened even though the `completed` report failed.

Required change before destructive family capabilities:

- tool failed before effect/known failure -> `failed_before_execution` or equivalent;
- tool completed but result report is unknown -> retain the same result/fingerprint and retry only the report;
- if outcome cannot be proven -> `indeterminate`;
- never rerun the tool merely to recover a lost result acknowledgement;
- reject a conflicting second terminal payload instead of accepting any same-client `already_terminal` response.
## P0-3 — Current tunnel prepare output conflicts with the two-port topology

The existing `remote tunnel prepare` command prints:

```text
MCP_SERVER_URL=<provider localTarget>
```

That was valid when the tunnel target and private control-plane origin were the same listener.

In the reviewed production topology they are intentionally different:

```text
tunnel target / public ingress = http://127.0.0.1:3000
private Next / device API      = http://127.0.0.1:3001
```

Therefore the current prepare output must not be copied into the new deployment unchanged. Either adapt the command/config contract to carry both values or provide a separate reviewed local runtime launcher. This is now explicit in CORE-01/OPS-01.

## P0-4 — The existing `/mcp` owner tool surface cannot become the workflow worker surface unchanged

The current control-plane MCP handler authenticates `mcp:tools`, calls `buildServer(claims.sub)`, and exposes owner-oriented tools such as `list_devices`, controls and generic `call_device_tool`.

The family worker must use the **same public `/mcp` resource** but a narrower authenticated security context. It must not inherit generic owner dispatch simply because the ChatGPT account belongs to the Mac owner.
Preferred approach:

- keep one canonical `/mcp` endpoint and resource identity;
- introduce a workflow-only OAuth client/grant/purpose (and, if needed, a dedicated scope such as `chat:worker`);
- resolve caller purpose/client/grant before constructing the tool surface;
- worker credentials get only bounded queue/session/result tools;
- deny direct device/admin tools in both discovery and dispatch services;
- if scopes change, update protected-resource metadata and the existing tunnel health validators together.

## P1-1 — Local Jazz JWKS should avoid an unnecessary public tunnel hairpin where supported

The control plane's Jazz backend context already accepts a configurable `JAZZ_JWKS_URL`, and the local Jazz authority also receives a JWKS URL.

For the all-local topology, prefer a verified private Next JWKS endpoint for Jazz capability validation if the pinned alpha.53 runtime supports that arrangement. Keep JWT issuer/audience claims canonical to the external product identity.

This can let local Jazz authorization recover without depending on a round trip through the public tunnel.

However, **device OAuth is different**: the current DC OAuth client validates authorization-server metadata and endpoints against the configured public authorization-server origin. Device startup therefore still depends on that public origin being reachable unless a separately reviewed internal transport mapping preserves all issuer/endpoint checks.

## P1-2 — Public ingress isolation is a defense-in-depth choice, not proof that current device APIs are unauthenticated
The current `/api/device/*` handlers already require `device:sync`, validate issuer/audience/JWKS through the Better Auth MCP protection layer, require an active OAuth client, and then bind device owner/client IDs again.

So the extra ingress allowlist is best described as **attack-surface reduction and route isolation**, not as compensation for a completely unauthenticated device API.

Two viable local architectures remain:

1. **Hard-isolation default (recommended):** tunnel -> public allowlist ingress -> private Next listener. More local moving parts, smaller public route surface.
2. **Minimal-process variant:** tunnel -> Next directly, with every route treated as Internet-facing and hardened/tested accordingly. Less local plumbing, larger attack surface and stricter route-level security burden.

For a service that can control the Mac filesystem/processes, the plan should keep hard isolation as the production default while retaining the direct variant as a consciously accepted simplification, not an accidental fallback.

## P1-3 — Startup ordering is now explicit

A safe initial order for the selected hard-isolation topology is:

```text
1. persistent state / secrets available
2. private Next listener starts and can serve local JWKS/auth metadata dependencies
3. local Jazz authority starts and reaches its configured JWKS
4. queue coordinator obtains exclusive writer ownership and recovers state
5. public ingress starts in admission-paused mode
6. tunnel publishes the stable origin
7. public OAuth/resource metadata verifies successfully
8. MCPDevice refreshes/pairs, registers and connects to local Jazz
9. coordinator/device readiness becomes green
10. chat admission and workflow-worker tools are enabled
```
## What still holds up after review

- Same public origin with sibling `/mcp` and `/chat` is the right product contract.
- Keeping all application-owned services/data on one MacBook is feasible with the current stack.
- Local Jazz is useful for durable chat/job/effect state; `remoteCalls` should remain the concrete device-effect ledger, not the chat queue.
- The Garden Jazz Better Auth chat example remains the best UI/reference base, but its browser-Jazz and Jazz-auth-adapter architecture should not be copied into this target unchanged.
- The 25-minute concept belongs in an application worker/session lease. It is not one 25-minute HTTP request and not proof that ChatGPT will keep polling.
- Family browser users do not need their own ChatGPT connector for the `/chat` product. The selected AI worker account/engine is a separate concern.
- No hosted application server, hosted SQL, hosted Jazz, Redis, Supabase or VPS is required by the selected design.

## Remaining release blockers

1. Prove the actual Jazz alpha.53 transaction/authority behavior under contention and restart.
2. Prove one writer/coordinator ownership and recovery semantics.
3. Implement family membership, conversation ACLs and device grants without conflating requester and device owner.
4. Implement workflow-only MCP authorization on the existing `/mcp` resource.
5. Fix/extend remote-call delegation, completion fingerprinting and post-effect reporting semantics.
6. Prove the 3000 ingress / 3001 private Next configuration including the current tunnel CLI mismatch.
7. Prove real ChatGPT tool cadence and the 25-minute experiment; early model stop must remain a visible liveness failure.
8. Run public/private route, log-redaction, backup/restore, sleep/reboot and approximately-15-session acceptance tests.

## Review scope / non-changes

This review changed planning documents only. It did not change application source, tests, dependencies, existing staged/unstaged source work, local databases, tunnel configuration, OAuth state or services. The inherited dirty worktree remains intentionally preserved.
