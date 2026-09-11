# P8A ADR — Cross-store consistency and terminal repair ledger

Status: **REQUIRED IMPLEMENTATION ADR — physical choices remain gated by P1/P8A selection**

Parent: `docs/PASSKEY-TASK-P8A-DATASTORE-AND-TRANSACTION-FOUNDATION.md`

## Scope and ownership split

P8A owns the physical foundation: database/driver/adapter versions, transaction API, isolation and lock primitives, transactional outbox/inbox implementation, retry helper, migration lock, independent security journal, and operator repair tooling.

The owning flow task must finalize its rows jointly with P8A:

| Flow contract | Owning task(s) |
| --- | --- |
| passkey registration and registration intent | P3 + P8A |
| passkey authentication, credential management, and recovery | P3/P6 + P8A |
| device approval and OAuth transitions | P5 + P8A |
| bootstrap, resource/client lifecycle, and revocation | P7A + P8A |
| device credential persistence/re-pair | P7B + P8A |
| migration entitlement and destructive retirement | P9/P11 + P8A |

P8A selecting a database does not by itself approve a per-flow contract. Conversely, a flow document may not claim atomicity until its records are mapped to the selected physical transaction boundary here. Any `TBD-*` in a required row is an exit gate for its owner.

## Consistency vocabulary

- `SINGLE_STORE_TRANSACTION`: all authoritative writes listed for the flow commit or roll back in one physical database transaction supported by the selected adapter/API.
- `DURABLE_SAGA`: one SQL anchor transaction writes authoritative state plus an outbox event; consumers apply idempotently and acknowledge through an inbox/dedupe record. Failure is rolled forward or compensated explicitly.
- `REPLAY_PROTOCOL`: an isolated restore replays independently retained, append-only security events idempotently before readiness; it is not an online distributed transaction.
- Never write `transaction/saga` as if the two were interchangeable.
- No in-memory queue, best-effort event, or request-local callback qualifies as an outbox/inbox step.

## Record-owner and physical-store matrix

Fill every `TBD-P8A` value with the selected product, schema/table or stream, and service owner before the first dependent flow exits.

| Record / authority | Record owner | Physical store | Authoritative key | Transaction participation |
| --- | --- | --- | --- | --- |
| WebAuthn registration challenge | auth/control-plane (P3) | `TBD-P8A` shared auth SQL | challenge ID/hash | registration transaction when adapter supports it; otherwise library boundary must be recorded |
| registration intent and pending-account state | auth/control-plane (P3) | `TBD-P8A` shared auth SQL | registration intent ID | registration anchor transaction |
| account + WebAuthn user handle | auth/control-plane (P2/P3) | `TBD-P8A` shared auth SQL | account ID / unique user handle | registration transaction |
| passkey credential + counter/backup metadata | auth/control-plane (P2/P3/P6) | `TBD-P8A` shared auth SQL | globally unique credential ID | registration/authentication/credential-management transaction |
| browser session + fresh-auth marker | auth/control-plane (P3/P6) | `TBD-P8A` shared auth SQL | session ID | registration/authentication transaction |
| WebAuthn authentication challenge | auth/control-plane (P3) | `TBD-P8A` shared auth SQL | challenge ID/hash | authentication transaction when adapter supports it; otherwise library boundary must be recorded |
| OAuth device authorization/decision state | auth/control-plane (P5) | `TBD-P8A` shared auth SQL | pending authorization ID | approval/redeem transaction |
| bootstrap challenge/reservation/receipt | auth/control-plane (P7A) | `TBD-P8A` shared auth SQL | bootstrap ID + canonical resource | provisioning anchor transaction |
| OAuth resource/client/link/grant/refresh family | auth/control-plane (P7A) | `TBD-P8A` shared auth SQL or provider store | canonical resource/client/grant/family ID | local transaction or saga participant, as fixed below |
| account-device ownership association | `TBD-P7A` auth or Jazz/device-directory owner | `TBD-P8A/P7A` | account ID + device stable ID | local transaction or saga participant, as fixed below |
| legacy-login entitlement | auth/control-plane (P9/P11) | `TBD-P8A` shared auth SQL | account ID | migration entitlement transaction |
| immutable migration evidence | auth/control-plane/release (P9) | `TBD-P8A` append-only audit/evidence store | account ID + evidence step | append-only evidence transaction/outbox |
| password verifier retirement marker | auth/control-plane (P11) | `TBD-P8A` protected legacy/auth store | account ID | destructive contraction transaction/job |
| revocation journal | security control plane (P7A/P8A) | `TBD-P8A` independently retained append-only store | revocation watermark + event ID | independently committed security event |
| migration/cutover journal | release/security control plane (P9/P11) | `TBD-P8A` independently retained append-only store | migration watermark + event ID | independently committed security event |

## Per-flow transaction/saga matrix

`none` is legal only when the record is in the same physical transaction shown in the row. Every saga row must replace all `TBD-*` cells before its owning flow exits.

| Flow | SQL anchor / participating records | Other-store step and mode | Outbox / inbox | Idempotency key | Compensation or roll-forward | Terminal/manual-repair state and operator path |
| --- | --- | --- | --- | --- | --- | --- |
| passkey registration | challenge CAS; intent CAS; pending account activation/create; credential insert with initial counter/backup state; session/fresh-auth create | `TBD-P1/P8A`: prefer `SINGLE_STORE_TRANSACTION`; use `DURABLE_SAGA` only if a proven library/store boundary forces it | `none` for single transaction; otherwise `TBD-P3/P8A` outbox + inbox | registration intent ID + challenge ID | rollback all writes in one transaction; split-boundary recovery consumes no challenge twice and issues a new challenge for the same legal pending intent | `registration_retry_new_challenge`; `registration_repair_required` only for unresolved saga side effects; query/runbook `TBD-P3/P8A` |
| ordinary passkey sign-in | purpose=`sign_in` challenge CAS; credential-owner/counter/backup CAS; new session S1 for resolved account A; **no fresh-auth marker** | `TBD-P1/P8A`: prefer `SINGLE_STORE_TRANSACTION`; document library-internal challenge boundary if unavoidable | `none` for single transaction; otherwise `TBD-P3/P8A` outbox + inbox | sign-in challenge ID | rollback counter/session together; after separately consumed challenge, issue a new challenge and never replay the assertion | `auth_retry_new_challenge`; `auth_repair_required` only if external session store forces saga; query/runbook `TBD-P3/P8A` |
| fresh passkey reauthentication | purpose=`fresh_reauth` challenge bound to expected account A + current session S0; credential owner must be A; counter/backup CAS; exact S0→S1 rotation; `FreshAuth(A,S1)` | `SINGLE_STORE_TRANSACTION` preferred/required unless P1 proves forced challenge boundary and P8A records repair | `none` for single transaction; otherwise `TBD-P6/P8A` outbox + inbox | fresh-reauth challenge ID + expected S0 generation | reject stale/noncurrent S0 or credential owner B with no mutation; rollback challenge/counter/S0/S1/fresh marker together; forced split retries only with a new challenge | `auth_retry_new_challenge`; `auth_repair_required` only for proven external ambiguity; query/runbook `TBD-P6/P8A` |
| final-passkey deletion guard | account lock/CAS + credential delete + session/revocation policy | `SINGLE_STORE_TRANSACTION` required unless P6 approves a new ADR | none | credential-management operation ID | transaction rollback | `credential_delete_rejected` or `TBD-P6/P8A` repair path |
| bootstrap provisioning | bootstrap proof/challenge; resource reservation; OAuth resource/client/link; provisioning receipt | `TBD-P7A/P8A` based on selected OAuth adapter/store | `TBD-P7A/P8A` when saga | bootstrap ID + canonical resource | release reservation for safe pre-authority failure; otherwise idempotent roll-forward to receipt or explicitly revoke created OAuth authority | `provision_repair_required`; query/runbook `TBD-P7A/P8A` |
| RFC 8628 approve/deny/redeem | pending authorization + one-time decision nonce + grant/token state | `TBD-P5/P8A`; same store must be one transaction, separate provider must be saga | `TBD-P5/P8A` when saga | pending authorization ID + decision nonce | terminal deny/expire or idempotent grant roll-forward; never return to pending after terminal decision | `approval_repair_required`; query/runbook `TBD-P5/P8A` |
| account-device ownership finalization | auth SQL pending association | Jazz/device directory when physically separate: `DURABLE_SAGA` | `TBD-P7A/P8A` ownership outbox + Jazz inbox/dedupe | pending authorization/association ID | keep authorization non-usable until ownership is confirmed; roll forward or revoke association/grant | `ownership_sync_pending` then `ownership_repair_required`; query/runbook `TBD-P7A/P8A` |
| account/device/resource/client/grant/refresh revocation | auth SQL revocation state + journal event | Jazz/device directory and/or local denial feed when separate: `DURABLE_SAGA` | `TBD-P7A/P8A` revocation outbox + consumer inbox | revocation event ID | security authority becomes revoked in the anchor first; consumers only roll forward to denial, never compensate by re-enabling | `revocation_sync_pending` then `revocation_repair_required`; deadline/runbook `TBD-P7A/P8A` |
| lost-account re-pair | new account-device association + old authority revocations | Jazz/device directory when separate: `DURABLE_SAGA` | `TBD-P6/P7A/P8A` outbox + inbox | re-pair operation ID | keep new remote authority unusable until local-control proof and ownership finalization; roll forward revocations/association | `repair_sync_pending` then `repair_repair_required`; query/runbook `TBD-P6/P7A/P8A` |
| account deletion | account lock/CAS; deletion operation; deny-new-authority marker; browser-session/OAuth/device/resource revocation state; credential erasure state | independently retained revocation journal plus Jazz/device/resource cleanup: `DURABLE_SAGA` | anchor outbox + independent journal append/ack + each consumer inbox/dedupe | account-deletion operation ID + account ID | commit denial/revocation first; never compensate by restoring authority; roll forward remote cleanup, then erase passkeys/deletable data and retain a non-secret anti-resurrection tombstone | `remote_cleanup_pending`, `credential_erasure_pending`, then `repair_required`; query/runbook `TBD-P6/P7A/P8A` |
| migration entitlement change | account entitlement + session invalidation policy + append-only evidence reference | `TBD-P9/P8A`; saga if evidence or session authority is separate | `TBD-P9/P8A` when saga | migration operation ID | entitlement may roll back during soak only while verifier is retained; evidence never moves backward | `migration_entitlement_repair_required`; query/runbook `TBD-P9/P8A` |
| destructive verifier retirement | retirement marker + verifier deletion in P11 contraction | `TBD-P11/P8A`; one-shot migration job, saga if protected verifier store is separate | `TBD-P11/P8A` when saga | contraction migration ID + account ID | no password restoration compensation; forward repair only after precondition proof | `credential_retirement_repair_required`; query/runbook `TBD-P11/P8A` |
| isolated restore security replay | restored DB watermarks | `REPLAY_PROTOCOL` from independent revocation and migration journals | replay inbox/dedupe `TBD-P8A` | journal stream + event ID | idempotently roll forward every missing security event; discard/rebuild failed restore rather than expose stale authority | `restore_isolated` / `restore_replay_required`; readiness query/runbook `TBD-P8A/P11` |

## Registration terminal model

The selected adapter must implement and test one of these two explicit boundaries.

### Model A — one physical transaction

```text
pending(intent=pending, challenge=pending)
-> verification succeeds without durable side effects
-> BEGIN
   CAS challenge pending + unexpired + registration purpose -> consumed
   CAS intent pending + unexpired -> committing
   create/activate account and stable WebAuthn user handle
   insert globally unique credential + initial counter/backup metadata
   create/rotate server session + fresh-auth marker
   set intent -> completed
   COMMIT
-> completed_server_state
-> attempt Set-Cookie
-> completed_cookie_delivered | completed_cookie_unknown
```

A failed CAS rejects the request. Any failure before commit rolls back challenge, intent, account, credential, and session/fresh-auth writes together. No success or cookie is emitted before commit.

### Model B — forced split library boundary

```text
pending
-> library CAS-consumes challenge in its own committed transaction
-> durable intent CAS -> verified_pending_commit
-> application anchor transaction creates/activates account, credential,
   initial counter/backup metadata, session/fresh-auth; completes intent
-> completed_server_state
-> attempt Set-Cookie
-> completed_cookie_delivered | completed_cookie_unknown
```

Model B is gated on `TBD-P1-LIBRARY-BOUNDARY-PROOF` and a filled saga/repair row. If the application transaction fails after challenge consumption, the only automatic recovery is `registration_retry_new_challenge` for the same still-valid pending intent/account. The consumed challenge and original response are never replayed. A partial external side effect moves to `registration_repair_required`, returns no authenticated success, and requires the recorded idempotent roll-forward/compensation runbook.

## Authentication terminal models

Authentication challenges carry a closed server-owned purpose. Ordinary sign-in and fresh reauthentication are different transactions; a caller cannot upgrade one purpose into the other.

### Ordinary sign-in

```text
pending(challenge=pending, purpose=sign_in)
-> verifier resolves exactly one credential owner A and required UV succeeds
-> BEGIN
   CAS challenge pending + unexpired + purpose=sign_in -> consumed
   lock/CAS credential owned by A and apply the P1 counter/backup-state policy
   create new session S1 for A
   COMMIT
-> completed_server_state(A,S1)
-> attempt Set-Cookie(S1)
-> completed_cookie_delivered | completed_cookie_unknown
```

Ordinary sign-in does **not** create a P6 fresh-auth marker. A later sensitive mutation must perform the separate purpose below.

### Fresh reauthentication for an existing session

```text
pending(challenge=pending, purpose=fresh_reauth, expectedAccount=A, expectedSession=S0)
-> verifier resolves credential owner C and required UV succeeds
-> BEGIN
   lock account A, session S0, credential C, and challenge in one physical transaction
   CAS S0 current + active + owned by A + expected generation/revision
   reject unless C.ownerAccountId == A
   CAS challenge pending + unexpired + purpose=fresh_reauth
         + expectedAccount=A + expectedSession=S0 -> consumed
   apply the P1 counter/backup-state CAS policy to C
   rotate exactly S0 -> S1; invalidate S0 in the same transaction
   create FreshAuth(account=A, session=S1, authenticatedAt=server_time,
                    method=passkey, sourceChallengeId=challenge.id)
   COMMIT
-> completed_server_state(A,S1,FreshAuth(A,S1))
-> attempt Set-Cookie(S1)
-> completed_cookie_delivered | completed_cookie_unknown
```

If S0 is stale, signed out, rotated, belongs to another account, or no longer matches its expected generation/revision, the transaction fails without consuming the challenge or changing the credential. If the discoverable assertion resolves to account B while the pre-reauth session is account A, it fails before any session/fresh-auth commit. `FreshAuth(A,S1)` is valid only while S1 remains the current active session and uses the server commit timestamp; it cannot be copied to another session or account.

Challenge, credential metadata, exact session rotation, and fresh-auth state commit or roll back together in Model A. If the selected library forces challenge consumption outside that transaction, the boundary is treated like registration Model B: failure returns `auth_retry_new_challenge`, never reuses the assertion, never rotates S0, and cannot report a counter/session/fresh-auth success that did not commit. Counter semantics must be the P1-approved synchronized-passkey policy, not a naive strictly-increasing rule.

## Commit/cookie ambiguity

A committed database transaction followed by a timeout, process death, connection drop, or lost `Set-Cookie` response is `completed_cookie_unknown`, not a failed or replayable transaction. The server may expire/revoke the inaccessible session under normal policy, but the client obtains a usable session only through a fresh passkey authentication. Registration intent IDs, challenge IDs, idempotency keys, and operator repair APIs must never disclose or recreate a session cookie.

## Independent security-journal publication boundary

A revocation or migration mutation is not acknowledged as successful until its independently retained journal event is durably append-acknowledged. V1 implementations must choose and record one of these executable patterns:

```text
Pattern A — SQL anchor + transactional outbox
BEGIN SQL
  CAS security authority/state
  INSERT immutable outbox(eventId, stream, canonicalEventBytes, digest)
COMMIT
worker -> append eventId to independent write-once stream with idempotent producer key
       -> stream durably acknowledges offset/watermark
       -> record acknowledged watermark in SQL
API success only after the independent acknowledgement required by the operation contract;
otherwise return accepted/pending with operationId, never a false completed success

Pattern B — independent journal is the ordered authority
append canonical event with expected previous watermark
-> receive durable monotonic watermark
-> SQL transaction applies that exact event/watermark idempotently
-> API success only after SQL apply; recovery replays journal forward
```

A direct `SQL commit -> best-effort async append -> 2xx completed` sequence is forbidden. If the platform supports a transactional append to the independent journal in the same durability domain, the ADR must name and prove that primitive rather than call two independent commits atomic.

Canonical event bytes include version, globally unique event ID, stream, operation/account/authority key, mutation kind, server timestamp, previous watermark, and non-secret payload digest. Producer retries use the event ID as the idempotency key; consumers persist `(stream,eventId)` inbox dedupe before effects. Stream acknowledgement, SQL acknowledgement, and API operation status expose no token, credential, code, or secret.

Mandatory crash/fault boundaries:

```text
before anchor transaction
inside anchor transaction before outbox write
between outbox write and SQL commit
immediately after SQL commit before worker visibility
before independent append
append committed but acknowledgement lost
append acknowledged before SQL watermark update
consumer effect committed before inbox acknowledgement
all consumers complete before operation terminal update
API response lost after terminal commit
```

At every boundary, restart must either show no mutation or resume the same event/operation idempotently. It must never omit a committed revocation/migration event, allocate a second event ID for the same operation, acknowledge completion before the required independent append, or compensate by restoring revoked authority.

## Saga requirements

For every `DURABLE_SAGA` row, implementation must fill before merge:

```text
outbox table/topic: TBD-IMPLEMENTATION
inbox/dedupe store: TBD-IMPLEMENTATION
producer transaction API: TBD-IMPLEMENTATION
consumer ownership: TBD-IMPLEMENTATION
retry backoff/deadline: TBD-IMPLEMENTATION
compensation or roll-forward: TBD-IMPLEMENTATION
manual repair query/runbook: TBD-IMPLEMENTATION
```

The authoritative state machine exposes pending/repair states to operators and never reports success to a caller before the security-critical authority is durable. Retry exhaustion always reaches a named terminal/manual-repair state; it does not silently drop an event.

## Isolated restore rule

The independently retained revocation and migration/cutover journals are append-only and each has a monotonically increasing watermark. A restore is created with no production ingress, no production load-balancer membership, issuance disabled, and outbound access limited to required reconciliation dependencies.

```text
restore_isolated
-> verify schema compatibility range + required capabilities
-> read restored DB revocationWatermark and migrationWatermark
-> read independently retained target watermarks
-> replay every later event in each stream idempotently
-> verify no account/session/grant/family/client/resource authority was resurrected
-> verify legacy-login entitlement and destructive-retirement markers
-> verify signing/JWKS retirement/compromise policy
-> persist reconciled watermarks + signed evidence
-> readiness may become true
-> traffic attachment requires separate operator CAS/approval
```

Readiness and traffic attachment fail closed while either restored watermark trails its independent target, replay has gaps/duplicates without a verified dedupe result, or any verification predicate is incomplete. Database PITR alone is never a rollback of the independent security journals.
