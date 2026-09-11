# P8A — Durable datastore and transaction foundation

Parent: `docs/PASSKEY-TASK-P8-DURABLE-AUTH-AND-SERVERLESS-SPLIT.md`

Depends on: P1 selected auth architecture

Blocks: P2 durable schema implementation, P3, P5, P6, P7B locking/persistence, P8B, P9, P10

## Objective

Select an executable production datastore/adapter and provide the physical transaction, lock, uniqueness, idempotency, outbox/inbox, independent-journal, and rate-limit primitives required by the passkey/OAuth system before higher-level flows depend on them. P8A does not independently invent business-flow semantics: each per-flow terminal contract is finalized jointly with its owning P-task in the canonical cross-store ADR.

## P8A.1 Datastore ADR fields

Must be filled before exit:

```text
database product/service: TBD-IMPLEMENTATION
database engine/server version: TBD-IMPLEMENTATION
driver package + version: TBD-IMPLEMENTATION
Better Auth adapter + version: TBD-IMPLEMENTATION
serverless connection pool/proxy: TBD-IMPLEMENTATION
migration tool/version: TBD-IMPLEMENTATION
distributed rate limiter: TBD-IMPLEMENTATION
backup/PITR policy: TBD-OPERATIONS
primary region/topology: TBD-OPERATIONS
```

A compatibility label alone is not acceptance: record the exact engine/service and server/runtime version actually used.

## P8A.2 Physical foundation versus per-flow contracts

P8A must first freeze the reusable physical foundation:

```text
transaction begin/commit/rollback API and supported isolation levels
row/advisory lock and compare-and-swap APIs
unique/foreign/check constraint behavior
transactional outbox producer + inbox/dedupe consumer primitives
bounded retry helper and retryable database errors
independently retained append-only revocation and migration journals
operator repair query/tool ownership
```

Then every flow owner must jointly fill its rows in `docs/PASSKEY-P8A-CROSS-STORE-CONSISTENCY-ADR.md` with the exact record owner, physical store, authoritative key, transaction participation, and one consistency mode:

```text
SINGLE_STORE_TRANSACTION  all listed authoritative records share one proven physical transaction boundary
DURABLE_SAGA              records span stores; SQL anchor + transactional outbox/inbox + idempotent roll-forward/compensation
REPLAY_PROTOCOL           isolated restore replays independent append-only security journals before readiness
```

Joint ownership is P3/P8A for registration/authentication, P6/P8A for credential management/recovery, P5/P8A for device approval, P7A/P8A for bootstrap/resource/revocation, P7B/P8A for device credential transitions, and P9/P11/P8A for migration/retirement. Selecting a database/adapter does not approve those flow contracts.

The word `atomic` is used only for a proven `SINGLE_STORE_TRANSACTION`. Cross-store flows are sagas with explicit outbox/inbox, idempotency, retry deadline, compensation or roll-forward, and terminal manual-repair states. Any required `TBD-*` row blocks the owning flow's exit.

## P8A.3 Isolation and locks

For each flow specify:

```text
transaction isolation level
row/advisory lock key
unique constraint relied on
compare-and-swap predicate
maximum retries
retryable SQL states/errors
idempotency key
```

No correctness rule may rely on one Node process or sticky routing.

## P8A.4 Core uniqueness constraints

At minimum:

```text
account primary key unique
WebAuthn user handle unique per identity model
credentialID globally unique
canonical OAuth resource identifier unique
client-resource link unique
registration intent ID unique
bootstrap ID unique
one-time decision nonce unique/consumable
```

## P8A.5 Registration and authentication terminal models

The normative terminal models are in `docs/PASSKEY-P8A-CROSS-STORE-CONSISTENCY-ADR.md`; P3/P8A must select and implement the exact adapter boundary before either flow exits.

Registration's preferred `SINGLE_STORE_TRANSACTION` performs, in order, a pending/unexpired/purpose-bound challenge CAS, registration-intent CAS, account create/activation, globally unique credential insert with initial counter/backup metadata, session/fresh-auth creation, and intent completion, then commits before attempting `Set-Cookie`. All listed writes roll back together. If the library commits challenge consumption internally first, the intent enters durable `verified_pending_commit`; an application failure can only retry with a **new** challenge for the same legal pending intent/account. It never replays the consumed challenge or reports authenticated success.

Authentication's preferred `SINGLE_STORE_TRANSACTION` performs challenge CAS, the P1-approved credential counter/backup-state CAS, and session rotation/create plus fresh-auth marker in one commit. A forced library-internal challenge boundary similarly recovers only through `auth_retry_new_challenge`. Counter behavior follows the approved synchronized-passkey policy, not a naive strictly-increasing rule.

Both flows terminate server-side as `completed_server_state`, followed by `completed_cookie_delivered` or `completed_cookie_unknown`. Commit followed by process death, connection loss, or a lost cookie is not a replayable failure: the client establishes a usable session through fresh passkey authentication. Intent IDs, challenge IDs, idempotency keys, and repair APIs cannot disclose or recreate a session cookie. Any cross-store side effect reaches the ADR's named repair state and returns no success until the security authority is durable.

## P8A.6 Final-passkey deletion

Use row/account lock or serializable/CAS semantics:

```text
concurrent delete A + delete B when two credentials exist
-> at most one can leave account with one credential
-> neither can leave active account with zero credentials
```

Account deletion is a separate explicit terminal workflow allowed to delete all credentials after revocation sequencing.

## P8A.7 Challenge and device code state

Challenges, registration intents, bootstrap challenges, decision nonces, and RFC8628 device authorization state are shared durable records with TTL indexes and conditional transitions.

Expired state is unusable even before cleanup executes.

## P8A.8 Deadlock/serialization retry policy

Define a bounded helper with:

```text
retry only known serialization/deadlock errors
maximum attempts TBD-IMPLEMENTATION
jittered delay
idempotency-preserving callback only
safe terminal error after exhaustion
```

Do not retry arbitrary application failures inside a transaction.

## P8A.9 Distributed rate limiter contract

Endpoint classes:

```text
registration-intent creation
WebAuthn option/verification failures
device user-code guesses
RFC8628 polling abuse
DCR/CIMD
bootstrap/resource provisioning
credential management
consent/approval mutation
```

For each define durable/privacy-safe keys and outage behavior. Security-critical verification/provisioning endpoints fail closed or to a deliberately capped emergency policy; they do not become unlimited.

## P8A.10 Data retention and secret classes

Inventory every auth/OAuth table and record:

```text
retention
PII classification
secret classification
encryption requirement
backup behavior
cascade behavior
revocation behavior
```

Never store raw bootstrap capabilities, CSRF secrets, OAuth access/refresh tokens, or WebAuthn challenge values in ordinary telemetry.

## P8A.11 Migration locking

Only one schema migration leader may mutate production schema at once. Define migration lock/leader election and `expand -> compatible deploy -> backfill -> verify -> contract` phases.

## P8A.12 Backup/PITR restore and independent revocation watermark

A restored database is **not traffic-ready** merely because schema checks pass.

Maintain independently retained append-only security-control journals (or equivalent write-once streams) with monotonically increasing `revocationWatermark` and `migrationWatermark`. The append protocol is part of the security mutation, not a best-effort observer. A completed security mutation must use the exact publication order from `docs/PASSKEY-P8A-CROSS-STORE-CONSISTENCY-ADR.md`: either SQL anchor + transactional outbox + idempotent independent append acknowledgement, or an independent ordered journal as authority followed by idempotent SQL application. The implementation must not return a completed 2xx before the required independent durable append acknowledgement; while waiting, it returns a durable pending operation reference or blocks within the bounded operation deadline.

The streams cover:

```text
revocation journal: account/session, refresh-family/grant, client/resource, device-association, and signing-key compromise/retirement events
migration journal: legacy-login entitlement changes, immutable migration evidence, and destructive credential/schema cutover markers
```

Restore procedure:

```text
restore into isolated network/deployment with issuance disabled and no production ingress/load-balancer membership
-> verify artifact-declared schema compatibility range and required capabilities
-> read DB-contained revocationWatermark and migrationWatermark
-> read independently retained target watermarks
-> replay every later event from both streams idempotently through a durable inbox/dedupe path
-> verify no revoked authority, legacy-login entitlement, or retired credential/schema state was resurrected
-> verify signing/JWKS compromise and retirement policy
-> record both reconciled watermarks and signed restore evidence
-> only then allow readiness
-> attach traffic only through a separate audited operator CAS/approval
```

If the chosen platform cannot provide an independent journal, the ADR must define an equivalent independent control plane whose RPO is no worse than the maximum approved revocation exposure.

Required publication implementation record:

```text
anchor SQL table/transaction API: TBD-P8A
transactional outbox table and unique event-id constraint: TBD-P8A
independent append-only stream/API: TBD-P8A
append durability/acknowledgement definition: TBD-P8A
producer idempotency key: canonical eventId
stream ordering key and previous-watermark CAS: TBD-P8A
consumer inbox/dedupe store: TBD-P8A
pending-operation status API and deadline: TBD-P8A
repair query/runbook for append-ack ambiguity: TBD-P8A
```

Fault injection must kill the producer before/after anchor commit, before append, after append with acknowledgement loss, before/after SQL watermark update, before/after each consumer effect/inbox commit, and after terminal commit with response loss. Every restart must converge on the same event ID and monotonic watermark without resurrecting authority or falsely reporting completion.

## P8A.13 Cross-instance tests

```text
challenge A -> verify B -> replay C rejects
intent create A -> verify B
approval A -> poll B
credential duplicate insert race across instances
final-passkey concurrent delete across instances
bootstrap/provision A -> OAuth issuance B
resource disable A -> issuance B rejects
transaction deadlock -> bounded retry
```

## P8A.14 Cross-store flow ledger

Keep `docs/PASSKEY-P8A-CROSS-STORE-CONSISTENCY-ADR.md` as the executable record-placement and flow ledger. Each row records:

```text
flow and owning P-task
record/service owner
physical datastore
authoritative key
SINGLE_STORE_TRANSACTION, DURABLE_SAGA, or REPLAY_PROTOCOL
transaction participation
outbox/inbox topic/table
idempotency key
retry deadline
compensation or roll-forward action
terminal manual-repair state
operator query/runbook
```

No P3/P5/P6/P7A/P7B/P9/P11 flow exits while any of its required rows remains `TBD-*`; unrelated future rows do not obscure which owner is blocked.

## P8A.15 Revocation enforcement primitive

P7A publishes the configurable V1 upper-bound contract and security approves the actual production numeric value before production promotion. The proposed value is **300 seconds** and remains `TBD-SECURITY-APPROVAL`. P8A exit requires the enforcement mechanism, configuration source/bounds, failure behavior, and `revokedAt`/`revocationCommittedAt`/`firstRejectedAt` hooks to be implemented; P9 pre-production rehearsal may use an explicit non-production fixture value. **P9 does not need production timing evidence to exit.** P10 owns release-shaped timed conformance and P11 requires the security-approved production value with zero misses before/through rollout. Refresh and new issuance denial remain immediate after authoritative revocation commit.

## Exit checklist

- [ ] Exact DB/driver/adapter versions recorded.
- [ ] Physical transaction/outbox/inbox/journal primitives and their owners are frozen.
- [ ] Exact transaction/state-machine API recorded jointly with each flow owner.
- [ ] Registration/authentication challenge and intent CAS, credential insert/counter state, session/fresh-auth state, commit, and cookie ambiguity are covered by terminal models.
- [ ] Isolation/lock/CAS strategy recorded per flow.
- [ ] Unique constraints recorded.
- [ ] Deadlock retry policy recorded.
- [ ] Connection pool/proxy limits recorded.
- [ ] Migration lock selected.
- [ ] Distributed rate limiter selected with outage behavior.
- [ ] Backup/PITR and traffic-isolated restore replay both independent append-only revocation and migration watermarks before readiness.
- [ ] Cross-store ledger contains no ambiguous transaction/saga rows or required `TBD-*` values for an exiting flow.
- [ ] P7A's numeric maximum exposure is security-approved and the revocation primitive exposes measurable commit/rejection timestamps.
- [ ] Cross-instance transaction tests specified and runnable.

## Rollback

Once production credentials/grants exist, the shared datastore stays authoritative. Roll back application versions, not authority to local SQLite. Data restore is an explicit incident procedure with revocation reconciliation.
