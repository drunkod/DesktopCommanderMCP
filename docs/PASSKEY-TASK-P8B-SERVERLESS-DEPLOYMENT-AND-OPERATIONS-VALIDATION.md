# P8B — Serverless deployment, packaging, scaling, and operations validation

Parent: `docs/PASSKEY-TASK-P8-DURABLE-AUTH-AND-SERVERLESS-SPLIT.md`

Depends on: P2, P3, P4, P5, P6, P7B, P8A

Blocks: P9, P9A, P10, P11

## Objective

Validate the completed passkey/OAuth implementation under production-shaped deployment boundaries, cold starts, concurrency, key rotation, rate limiting, backups, and artifact packaging.

## P8B.1 Freeze deployable artifacts and deployment ownership

Release evidence records immutable values and accountable owners, not workspace nicknames:

```text
central auth artifact repository + commit: TBD-IMPLEMENTATION-REVISION
central auth artifact digest + artifact owner: TBD-RELEASE
per-device resource repository + commit: https://github.com/drunkod/DesktopCommanderMCP.git + release commit
per-device resource artifact digest + artifact owner: TBD-RELEASE
IaC repository + immutable revision + IaC owner: TBD-RELEASE
future P9A deployment-state/telemetry repository/package/deployment boundary + owner: TBD-RELEASE (NO P9A artifact digest/result is a P8B output)
contract version: passkey-remote-auth-v1
migration source revision: TBD-RELEASE
one-shot migration job artifact/digest + job owner: TBD-RELEASE
migration executor IAM/service identity + least-privilege policy revision: TBD-RELEASE
deployment/promotion executor IAM/service identity: TBD-RELEASE
secrets owner: TBD-OPERATIONS
signing-key/KMS owner: TBD-OPERATIONS
CI workflow revision + evidence artifact location/retention owner: TBD-RELEASE
promotion command/workflow: TBD-RELEASE
rollback command/workflow: TBD-RELEASE
```

Every P8B-owned `TBD-*` above is a hard P8B exit gate; the later P9A parser/telemetry **digest** is intentionally not a P8B output and is frozen by P9A before P10. P11 promotion additionally requires that P9A/P10 digest evidence. Recording a human-readable service nickname or mutable tag does not satisfy any gate. The current uncommitted control-plane workspace is evidence input only and cannot satisfy an immutable release revision. Release evidence must prove the deploying actor, migration actor, P8B-owned artifact digests, IaC revision, and the declared deployment boundary for the future P9A artifact agree with the approved record.

Schema migrations execute as an explicit one-shot deployment job under the recorded migration identity and immutable migration artifact. Application cold start and ordinary request handlers are prohibited from holding migration IAM permission or running production migrations.

## P8B.2 Packaging-negative test

Inspect the built per-device artifact and fail if it exposes/imports:

```text
passkey registration/account management pages
central `/api/auth/**` token/session endpoints
generic OAuth resource admin endpoints
auth schema migration runner
central private signing keys
```

## P8B.3 Stateless central app instances

Cold start must not generate identity, signing keys, RP configuration, or resource registry state. Multiple instances share P8A datastore/rate limiter/key material.

## P8B.4 Connection limits

Record and load-test:

```text
maximum app instances
pool size per instance/proxy mode
database connection ceiling
queue/timeout behavior at saturation
```

## P8B.5 Signing/JWKS rotation

Keys are managed shared secrets/material, never generated per cold start. Test overlapping old/new verification windows, JWKS cache expiry, and rollback during rotation.

## P8B.6 Failure modes

| Failure | Expected behavior |
| --- | --- |
| DB unavailable | new auth/approval/provisioning fail closed |
| rate limiter unavailable | endpoint-specific fail/degraded policy from P8A |
| JWKS fetch unavailable at resource | bounded cached keys only; no unbounded trust |
| registry unavailable | no new resource issuance/provisioning |
| app dies mid-registration | retry on another instance without duplicate account |
| app dies mid-approval | durable state determines terminal outcome |
| cold start | no new issuer/RP/key identity |

## P8B.7 Region topology

Initial recommendation: one write-primary auth region with shared SQL and stateless replicas/instances near it. Multi-region writes require a new consistency ADR proving one-time challenge/approval/resource semantics.

## P8B.8 Health/readiness during rolling deployment

Each immutable application artifact declares and signs:

```text
minimum compatible schema revision: TBD-RELEASE
maximum compatible schema revision: TBD-RELEASE
required schema capabilities: TBD-RELEASE
known-incompatible revisions/capabilities: TBD-RELEASE
```

Central readiness checks:

```text
DB reachable
current schema revision is within the artifact's inclusive compatible range
all required expanded columns/tables/capabilities exist
no known-incompatible revision/capability is present
signing key available
issuer metadata internally coherent
RP/origin config coherent
independent revocationWatermark and migrationWatermark caught up
rate limiter/provisioning backend status according to policy
```

Do **not** require exact schema-version equality during an expand-compatible rolling deployment. Readiness fails when a bound is absent, a required capability is absent, a known-incompatible future capability/revision is present, or a contraction would strand a running artifact.

Resource readiness checks exact central issuer/JWKS configuration, protected-resource metadata, contract compatibility, and local MCP bridge health.

## P8B.9 Isolated restore drill and traffic gate

Restore into an isolated environment with no production ingress, load-balancer membership, token issuance, or implicit failover path. Prove accounts/passkeys, unique constraints, OAuth resources/clients/links, and signing policy are coherent, then replay independently retained append-only P8A streams from the restored DB's `revocationWatermark` and `migrationWatermark` to their current target watermarks.

Traffic and issuance remain blocked until:

```text
artifact-declared schema range/capability readiness passes
every revocation and migration event after the backup point replays idempotently through durable dedupe
both watermarks equal their independent targets with no gaps
revoked accounts/sessions/devices/grants/refresh families/clients/resources remain revoked
legacy-login entitlement and destructive credential/schema cutover markers are current
signing/JWKS compromise/retirement policy matches release configuration
restore verification artifact records source backup, target watermarks, artifact digests, verifier, and approval
```

Only then may readiness become true. Production traffic attachment is a separate audited operator action; a successful database restore never auto-registers itself with production routing.

## P8B.10 Production-shaped load/concurrency

Run at minimum:

```text
simultaneous WebAuthn option/verify across instances
RFC8628 polling + browser approval on different instances
resource provisioning while another instance issues tokens
many refresh/authorization failures under distributed limits
cold-start storm within DB pool limits
```

## P8B.11 Observability boundary

Operational telemetry records outcome classes and durations only. No challenge, credential ID, raw user code, callback URL, access/refresh token, public key, bootstrap capability, or free-form OAuth body/error.

## P8B.12 Exit evidence

Attach immutable, non-secret CI/release artifacts:

```text
build manifests with repository commits and artifact digests
artifact/IaC/migration/deployment ownership gate record
one-shot migration job digest, executor IAM identity, command, and result
packaging-negative test result
cold-start test result
connection saturation result
JWKS rotation result
restore drill source/target watermarks and traffic-gate result
cross-instance integration result
rate-limiter outage result
schema compatibility range/capability test result
P9A package/deployment boundary declaration (path/package/owner only; no future digest)
```

P8B exit explicitly does **not** require `passkey-auth-gate` to be green and does not require a runtime deployment-state/parser digest. P9A produces/freezes that digest after this task; P10 runs the completed `passkey-auth-gate` against it. P8B may validate that the future package/deployment boundary is buildable/deployable, but it cannot fabricate future parser or P10 evidence.

## Exit checklist

- [ ] Exact **P8B-owned** central/per-device/IaC/migration/CI revisions and artifact digests, accountable owners, promotion/rollback workflows, plus the future P9A package/deployment boundary are frozen. P9A parser/telemetry digest is NOT required here.
- [ ] Migration source/job artifact, owner, one-shot executor IAM identity/policy, command, and result are frozen; cold-start migrations and migration IAM are prohibited.
- [ ] Packaging-negative test passes.
- [ ] Cold starts preserve identity/key state.
- [ ] DB connection limits load-tested.
- [ ] Cross-instance flows pass.
- [ ] JWKS rotation passes.
- [ ] Rate-limiter outage behavior passes.
- [ ] Isolated backup/restore replays both independent append-only revocation and migration watermarks before readiness and requires separate audited traffic attachment.
- [ ] Production-shaped observability is secret-safe.

## Rollback

Shared datastore and identity remain authoritative. Roll back stateless application artifacts within the compatible contract window; never redeploy a resource artifact that exposes central auth routes or interprets v2 credentials as unbound.
