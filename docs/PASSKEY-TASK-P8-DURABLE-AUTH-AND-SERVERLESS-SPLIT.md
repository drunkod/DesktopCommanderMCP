# P8 — Durable authentication foundation and deployment validation

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Status: **split into P8A foundation + P8B deployment validation** after second-pass review

Owner: auth platform + control-plane + operations

Review corrections: `docs/PASSKEY-ONLY-REGISTRATION-TASK-PACK-REVIEW.md` R-05, R-06, R-21

## Objective

Remove the dependency cycle in the original task by separating persistence/transaction primitives required by implementation from later production-shaped serverless/scaling validation.

P8 is now an umbrella. Do not implement directly from this file.

## P8A — datastore and transaction foundation

`docs/PASSKEY-TASK-P8A-DATASTORE-AND-TRANSACTION-FOUNDATION.md`

Depends on: P1 selected auth architecture.

P8A is an early foundation and must select exact:

```text
database/service
driver + Better Auth adapter versions
transaction API
isolation/row/advisory lock strategy
unique constraints
CAS/idempotency strategy
deadlock retry policy
connection pool/proxy assumptions
migration locking
distributed rate limiter
backup/PITR semantics
```

P8A then blocks P2 durable schema implementation and all flows requiring atomic state: P3, P5, P6, P7B.

## P8B — serverless deployment and operations validation

`docs/PASSKEY-TASK-P8B-SERVERLESS-DEPLOYMENT-AND-OPERATIONS-VALIDATION.md`

Depends on implemented P2–P7B plus P8A.

P8B validates:

```text
central/per-device build artifacts and immutable revisions
packaging-negative route ownership
cold starts
cross-instance state
DB connection saturation
JWKS/key rotation
rate-limiter outage behavior
backup/restore/revocation reconciliation
production-shaped observability
```

P8B blocks P9 migration **implementation/rehearsal**, P9A runtime-state/telemetry foundation, and downstream P10/P11 evidence/rollout.

## Canonical dependency rule

```text
P1
 +--> P8A ----+--> P2 --> P3 --> P4 --> P5/P6 --+
 |            +--> P7B <--- P7A                  |
 +--> P7A ---------------------------------------+
                                                  v
                                                 P8B
                                                  v
                                                  P9
```

This replaces the earlier circular requirement where P3/P6 depended on P8 while P8 depended on behavior defined by P3/P6.

## Production authority invariant

Once production passkeys/OAuth grants exist, shared P8A storage remains authoritative. Rollback changes application artifacts, not authority back to process-local SQLite.

## P8 exit checklist

- [ ] P8A exact datastore ADR completed.
- [ ] All implementation flows use P8A transaction/locking primitives.
- [ ] P8B deployable artifacts and route ownership frozen.
- [ ] Packaging-negative test passes.
- [ ] Cross-instance/cold-start tests pass.
- [ ] Restore/revocation reconciliation passes.
- [ ] P8B-owned operations/deployment evidence is attached before P9 implementation/rehearsal; P9A/P10 artifacts/results are explicitly downstream.

## Rollback

Never revert live identity authority to local SQLite. Application rollback must remain compatible with current shared schema, exact issuer/resource identity, and already-written passkeys/grants.
