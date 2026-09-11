# P7 — Central issuer and per-device resource separation

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Status: **split into P7A protocol gate + P7B implementation** after second-pass review

Owner: DesktopCommanderMCP device client + auth/resource architecture

Depends on: P0, P1

Blocks: P5, P8B, P9, P10

Review corrections: `docs/PASSKEY-ONLY-REGISTRATION-TASK-PACK-REVIEW.md` R-03, R-04, R-06, R-07, R-16–R-18

## Objective

Separate one stable authorization issuer from exact per-device resources without same-origin discovery assumptions, circular first-device provisioning, audience ambiguity, or refresh-token races.

P7 is now an umbrella. Do not implement directly from this file.

## Child tasks

### P7A — protocol/bootstrap/resource contract

`docs/PASSKEY-TASK-P7A-PROTOCOL-BOOTSTRAP-AND-RESOURCE-CONTRACT.md`

Freezes:

- pathless issuer preference and RFC 8414 pathful fallback;
- exact resource canonicalization/rejection rules;
- route audience/scope matrix;
- central vs per-device deployable ownership;
- versioned cross-repository contract;
- one-time first-device bootstrap capability;
- SSRF-safe resource-control proof;
- atomic/idempotent resource + client + link provisioning;
- browser approval input boundary;
- resource lifecycle and revocation exposure.

P7A must close before P7B and before product flows rely on pending-device resource state.

### P7B — device/resource implementation

`docs/PASSKEY-TASK-P7B-DEVICE-RESOURCE-IMPLEMENTATION.md`

Implements:

- immutable issuer/resource/local-transport identity;
- standards discovery with runtime JSON validation;
- verification URL origin validation;
- HTTP timeouts, cancellation, bounded polling/backoff;
- typed OAuth errors;
- interoperable refresh responses;
- versioned vault binding;
- cross-process refresh serialization/CAS;
- same-process clear-vs-refresh epoch safety;
- all Tailscale/zrok health call-site migrations;
- removal of import-order environment capture;
- exact RFC 9728 metadata and MCP bearer challenge;
- route-specific scope enforcement.

## Canonical sequence

```text
P0 approved
  -> P1 GO
     -> P7A protocol contract
        + P8A datastore/locking foundation
          -> P7B implementation
             -> P5 approval integration
             -> P8B deployment validation
```

## Non-negotiable invariants

```text
issuer != resource is expected
resource identity is exact and persisted
OAuth metadata is never rewritten to localhost
unknown/unproven resource cannot be provisioned
normal passkey session cannot administer arbitrary resources
browser approval cannot choose client/resource/scopes
stale refresh writer cannot overwrite newer vault state
unversioned vault credential is never rebound
```

## P7 exit checklist

- [ ] P7A complete and approved.
- [ ] P7B complete under P10 tests.
- [ ] Route audience/scope matrix approved in P0/P7A.
- [ ] First-device bootstrap cycle eliminated.
- [ ] Resource lifecycle/revocation exposure defined.
- [ ] All device/tunnel callers migrated.
- [ ] Multi-process refresh race tests pass.
- [ ] Resource metadata/challenge conformance passes.

## Rollback

Rollback preserves exact provisioned resource records and v2 issuer/resource-bound credentials. Never restore a production behavior that infers issuer from tunnel origin or converts bound credentials back to an unversioned format.
