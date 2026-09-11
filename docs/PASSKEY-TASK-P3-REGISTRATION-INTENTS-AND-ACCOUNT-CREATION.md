# P3 — Registration intents and verified passkey account creation

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: control-plane/auth service

Depends on: P1 GO, P2 schema/config, P8A transaction foundation; P7A approval is required before the device-bound callback slice

Blocks: P4, P5, P6, P9

## Objective

Create a one-product-click account-registration flow in which untrusted browser state cannot choose the final account, callback, or pending device authorization. Persist an active account only through a server-verified passkey ceremony and establish a session atomically when supported by the P1 architecture.

## Invariant

```text
Create account with a passkey
        |
        v
server creates short-lived registration intent
        |
        v
WebAuthn registration options bound to intent/account handle
        |
        v
OS/browser ceremony
        |
        v
server verifies challenge + RP + origin + UP + required UV
        |
        v
transaction creates/activates account + credential + session
        |
        v
intent consumed exactly once
        |
        v
safe relative callback
```

Cancellation or verification failure must not leave an active orphan account.

## P3.1 Define the complete registration-intent contract

Canonical logical record:

```ts
type RegistrationIntentState =
  | "pending"
  | "verified_pending_commit"
  | "retry_new_challenge"
  | "repair_required"
  | "completed"
  | "expired"
  | "revoked";

type PasskeyRegistrationIntent = {
  id: string; // at least 256 bits of CSPRNG entropy; opaque and URL-safe
  ceremony: "registration";

  accountId: string;
  webauthnUserHandle: string;
  displayLabel: string;
  callback: AuthCallbackBinding;

  challenge: {
    recordId: string;       // durable server-owned one-time challenge record
    valueHash: string;      // hash of the exact challenge emitted to the browser
    issuedAt: Date;
    expiresAt: Date;
    consumedAt: Date | null;
  };
  expectedRpId: string;
  expectedOrigin: string;
  browserBindingHash: string;

  pendingDevice: null | {
    authorizationId: string; // opaque server-owned RFC 8628 pending-request ID
    bootstrapId: string;
    clientId: string;
    resource: string;
    requestedScopesHash: string;
  };

  state: RegistrationIntentState;
  version: number;
  createdAt: Date;
  expiresAt: Date;
  verifiedAt: Date | null;
  consumedAt: Date | null;
};
```

Rules:

- `id` is never reused, is only an idempotency/reference key, and is never browser-session authority;
- `challenge` identifies shared durable P8A challenge state; the exact response challenge must hash to `valueHash`, and challenge expiry/consumption changes by CAS;
- `expectedRpId`, `expectedOrigin`, `browserBindingHash`, account/user-handle fields, callback, and pending-device binding are server-owned and immutable after options issuance; only the challenge slot may be replaced by the explicit `retry_new_challenge -> pending` CAS described below;
- `pendingDevice.authorizationId` is the P7A-defined server-owned pending authorization ID, never a raw or fast-hashed `user_code`;
- the immutable pending-device fields bind the intent to the request observed at creation, but completion must reload the P7A/P8A pending record and compare current authoritative bootstrap, client, exact resource, scopes, expiry, and state;
- callback is a parsed route-specific structure, not an arbitrary string URL;
- state and version transitions use durable P8A compare-and-swap; process memory is never production authority;
- expired, revoked, completed, and `repair_required` records cannot start another ceremony; `retry_new_challenge` can start only the server-controlled fresh-challenge transition below and cannot accept a WebAuthn response itself.

### Browser-binding V1 protocol

`browserBindingHash` is not a hash of IP address, User-Agent, TLS properties, callback data, or any browser-controlled identifier. The exact V1 protocol is:

```ts
const BROWSER_BINDING_COOKIE = "__Host-dc-registration-binding";
const BINDING_BYTES = 32;

type BrowserBindingRecordV1 = Readonly<{
  version: 1;
  intentId: string;
  challengeRecordId: string;
  bindingMac: string; // base64url HMAC-SHA-256 output
  issuedAt: Date;
  expiresAt: Date;
}>;

function bindingMac(input: {
  serverBindingKey: Uint8Array;
  intentId: string;
  challengeRecordId: string;
  browserNonce: Uint8Array;
}): Uint8Array {
  return hmacSha256(
    input.serverBindingKey,
    utf8(`DC-PASSKEY-REGISTRATION-BINDING-V1\n${input.intentId}\n${input.challengeRecordId}\n${base64url(input.browserNonce)}\n`),
  );
}
```

The server creates a 32-byte CSPRNG nonce when issuing registration options, returns it only in a host-only `Secure; HttpOnly; SameSite=Lax; Path=/` cookie, and stores only the MAC bound to the exact intent and challenge record. Production uses the `__Host-` cookie exactly; an explicit HTTP loopback test harness uses a separately named host-only test cookie and can never select production profile. Verification requires cookie presence, decodes exactly 32 bytes, recomputes the MAC, and compares fixed-length bytes in constant time before consuming challenge or intent state.

The binding expires no later than the intent/challenge, is deleted on completed/expired/revoked/repair terminal state, and remains bound to the same browser nonce across Model-B `retry_new_challenge` while the MAC is recomputed for the new challenge record. Missing, malformed, swapped, replayed-after-terminal, or cross-browser bindings fail without account/session creation. CSRF and exact Origin validation remain independently required.

Preferred P8A execution has two explicitly different models. **Model A is the default and preferred implementation. Model B is legal only when P1 proves an unavoidable library transaction boundary and the P8A saga/repair row is fully implemented.**

### Model A — preferred single-store transaction

No durable `verified_pending_commit` state is exposed. The verifier result is held inside the request/transaction boundary and one physical transaction performs:

```text
pending intent + pending/unexpired challenge
-> BEGIN transaction
-> CAS challenge pending -> consumed for exact purpose/browser/RP/origin
-> assert intent still pending/version exact
-> create/activate account
-> insert globally unique credential + initial counter/backup metadata
-> create/rotate session and any fresh-auth state required by the flow
-> CAS intent pending -> completed
-> COMMIT
-> only then emit authenticated success/Set-Cookie
```

Any failure before commit rolls back **all** challenge, intent, account, credential, counter, and session writes. A retry uses the still-pending original intent/challenge only when the transaction rollback truly left both unconsumed; there is no intermediate durable success state to repair.

### Model B — forced split boundary only

Use this only with `TBD-P1-LIBRARY-BOUNDARY-PROOF` and the completed P8A outbox/repair contract. If the auth library durably consumes the challenge before the application transaction can begin:

```text
pending
-> library/verifier consumes exact challenge and proves RP/origin/browser/UP/UV
-> CAS intent pending -> verified_pending_commit
-> application account/credential/session transaction
-> CAS intent verified_pending_commit -> completed
```

If that later transaction fails **with no ambiguous/external side effect**, recovery is:

```text
verified_pending_commit
-> CAS verified_pending_commit -> retry_new_challenge
-> persist a brand-new one-time challenge record/valueHash/issuedAt/expiresAt
   while account/user handle/callback/pendingDevice/RP/origin/browser binding remain unchanged
-> CAS retry_new_challenge -> pending with version increment
-> browser performs a NEW WebAuthn ceremony
```

The old challenge stays consumed/audited and the original assertion is never replayed. `retry_new_challenge` is not a success state and cannot create a session.

If failure leaves any unresolved external/session/provider side effect, unknown commit result, or saga ambiguity, CAS `verified_pending_commit -> repair_required`. `repair_required` is terminal for automatic/browser retry, returns no authenticated success, and requires the P8A-recorded idempotent operator repair/roll-forward path. Other terminal alternatives are `expired` and `revoked`.

## P3.2 Centralize exact callback route/query validation

Use a route-specific parsed callback union instead of arbitrary prefix matching or free-form query passthrough:

```ts
type AuthCallbackBinding =
  | {
      kind: "device";
      route: "/device/approve";
      query: { request: string }; // opaque approval reference, not user_code
    }
  | {
      kind: "consent";
      route: "/consent";
      query: { request: string };
    }
  | {
      kind: "dashboard";
      route: "/dashboard" | "/dashboard/passkeys" | "/dashboard/devices";
      query: Record<string, never>;
    };
```

The parser accepts only these exact schemas:

| Kind | Exact path | Exact query keys | Fragment |
| --- | --- | --- | --- |
| device | `/device/approve` | one `request=<opaque-approval-reference>` | forbidden |
| consent | `/consent` | one `request=<opaque-consent-reference>` | forbidden |
| dashboard | `/dashboard`, `/dashboard/passkeys`, or `/dashboard/devices` | none | forbidden |

Validation rules:

- reject leading/trailing whitespace before URL parsing;
- accept only a relative path beginning with exactly one `/`;
- require an exact path match, an exact query-key set, one value per allowed key, and the server-defined opaque-reference grammar;
- reject backslashes, controls, fragments, encoded controls/separators, recursive encodings, dot segments or normalization changes, duplicate query keys, unknown keys, and nested callback/return parameters;
- parse into the route-specific structure, then re-render the canonical relative URL and require it to equal the accepted representation;
- never preserve an arbitrary browser-supplied path segment, query string, or fragment.

`/device/approve-evil`, `/consent-evil`, `/dashboard/anything`, protocol-relative URLs, and normalized path tricks are rejected.

## P3.3 Bind pending device request

When registration begins from RFC 8628, the canonical transition is:

```text
/device?user_code=<provider-defined code>
-> reject unless the complete code passes the provider's exact validator
-> rate-limited lookup of server-authoritative P7A/P8A pending state
-> mint a high-entropy opaque approval reference mapped durably to that pending authorization
-> redirect/replace URL with /device/approve?request=<opaque-approval-reference>
```

The `user_code` is not carried beyond successful lookup. The callback stores the opaque approval reference, while `pendingDevice.authorizationId` stores the distinct server-owned pending-request ID and immutable binding snapshot. Completion resolves the approval reference server-side, reloads the pending record, and requires both references to identify the same request, still pending and unexpired, with the same bootstrap, client, exact resource, and scopes.

A callback, approval reference, or raw user code never proves ownership. A browser cannot substitute another reference because the exact callback binding, browser binding, intent, approval-reference mapping, and authoritative pending request are checked together under P7A/P8A rules.

## P3.4 Create opaque account identity

Recommended generation:

```ts
import { randomBytes, randomUUID } from "node:crypto";

const accountId = randomUUID();
const userHandle = randomBytes(32).toString("base64url");
const displayLabel = `Desktop Commander ${accountId.slice(0, 8)}`;
```

This is illustrative. If the chosen DB/auth provider imposes ID format restrictions, use a cryptographically strong supported format.

Do not derive user handle from:

```text
email
hostname
device stableId
credential ID
OAuth client ID
IP address
```

## P3.5 Delay active account persistence

Preferred transaction boundary:

```text
verify WebAuthn response
BEGIN
  create/activate account
  insert passkey credential
  create authenticated session
  consume registration intent
COMMIT
set session cookie
redirect
```

If the selected library requires a pending account before WebAuthn options can be generated:

- mark it explicitly `pending`;
- make pending rows unable to authorize OAuth/device/Jazz requests;
- expire/garbage-collect them;
- never report them as active accounts;
- activate only in the verified transaction.

## P3.6 Use context as a reference, not authority

If the selected passkey client supports:

```ts
authClient.passkey.addPasskey({
  context: registrationIntentId,
  createSession: true,
});
```

then `context` must be an opaque reference to server-owned intent state.

Never encode trusted account fields in unsigned browser-controlled JSON such as:

```json
{"accountId":"...","callback":"...","ownerId":"..."}
```

and then accept them without server lookup/signature validation.

## P3.7 Verify registration with all security invariants

Required server checks:

```text
challenge exact match
challenge one-time use
challenge not expired
ceremony == registration
expected origin exact match
expected RP ID exact match
UP required
UV required
credential public key valid
credential ID not already owned elsewhere
intent valid/unconsumed
account/user-handle binding exact
```

The P1-selected verifier is authoritative.

## P3.8 Persist credential metadata

Store only what is required for authentication/security/management:

```text
credential ID
public key
counter
account ID
friendly name (optional)
transports
credential device type
backup state
AAGUID (optional)
createdAt
```

Do not store biometric/PIN data; WebAuthn never sends that data to the relying party.

## P3.9 Establish session after verification

Successful result should return a session/cookie usable immediately by:

```text
/device/approve
/consent
/dashboard
```

Required assertions:

- session subject/account ID equals credential owner;
- session is not created before verified passkey persistence;
- session cookie is emitted only after transaction success;
- response retry does not create a second account.

## P3.10 Handle network ambiguity safely

Hard case:

```text
server commits account/passkey/session
connection drops before browser sees success
```

Retry behavior must be idempotent enough that the user does not create duplicate accounts by pressing the button again.

Strategies:

- intent remains the idempotency key and records completion target;
- retry may query intent status only to learn that registration completed; possession of the consumed intent is never session authority;
- if the commit succeeded but the browser lost its cookie/result, require a fresh passkey authentication to establish a browser session;
- consumed/completed intent returns a terminal “registration already completed” outcome rather than generating a fresh account silently.

## P3.11 Error taxonomy

User-facing outcomes:

| Condition | Product message/action |
| --- | --- |
| user cancelled | “Passkey creation was cancelled. Try again when ready.” |
| authenticator unavailable | explain supported platform/phone/security key |
| intent expired | restart registration, preserve valid outer device request when possible |
| challenge missing/replayed | restart ceremony; security event at debug/audit level |
| RP/origin mismatch | generic configuration error to user, detailed safe ops event |
| duplicate credential | offer sign-in instead; do not auto-create account |
| verification failed | generic passkey verification failure |
| commit failed | retry-safe server error; no active partial identity |
| callback expired | account remains signed in; explain device request must restart |

Do not translate `NotAllowedError` into “no account exists.” Cancellation and lack of credential are intentionally ambiguous.

## P3.12 Rate limits and abuse controls

Security-sensitive operations requiring durable/shared limits:

```text
registration-intent creation
registration-options generation
registration verification
repeated failed assertions
OAuth dynamic client/resource provisioning (separate policy)
```

Rate-limit keys should avoid creating a stable cross-site fingerprint. Use account/session when available plus coarse network/device signals only as a defense-in-depth design reviewed under P8/P11.

## P3.13 Audit events

Allowed transition events:

```text
passkey_registration_intent_created
passkey_registration_started
passkey_registration_verified
passkey_registration_completed
passkey_registration_cancelled
passkey_registration_failed
```

Safe fields:

```text
event time
request correlation ID
coarse error code
callback class (device/consent/dashboard)
credential backup/device-type category if policy permits
```

Never log challenge, response JSON, public key, raw credential ID, session cookie, access token, refresh token, biometric/PIN details.

## P3.14 Tests

### Unit

```text
intent IDs unpredictable/format valid
user handle correct length/non-PII
exact callback route/query acceptance and canonical re-rendering
intent TTL
intent consume exactly once
completed intent retry behavior
```

### Integration

```text
successful verified registration creates one account + passkey + session
cancelled ceremony creates no active account
wrong challenge rejected
wrong origin rejected
wrong RP ID rejected
missing UV rejected
replayed verification rejected
duplicate credential race yields one owner
session callback resolves the same opaque approval reference and authoritative pending request
changed bootstrap/client/resource/scope or non-pending request is rejected
network retry does not duplicate account
```

### Security negative

Test encoded callback attacks such as:

```text
//evil.example/path
/\\evil.example
/%2f%2fevil.example
/device/approve?user_code=<different attacker code>
https://evil.example/
```

## Proposed future target files

Exact names may change after P1/P8:

```text
apps/control-plane/lib/passkey-registration-intent.ts
apps/control-plane/lib/auth-callback.ts
apps/control-plane/lib/account-identity.ts
apps/control-plane/app/sign-in/page.tsx
apps/control-plane/app/api/passkey/registration-intent/route.ts
apps/control-plane/test/passkey-registration*.test.ts
```

Prefer library/auth endpoints supplied by the selected auth stack over redundant custom API routes; create custom routes only where intent orchestration genuinely needs application state.


## Exit checklist

- [ ] Registration is one product click before OS ceremony.
- [ ] Intent durably binds the exact challenge, RP ID, origin, browser continuation, callback, pending request, version, and terminal state.
- [ ] Challenge and intent are short-lived, one-use, and consumed with P8A CAS/transaction semantics.
- [ ] Callback uses an exact route/query schema; unknown paths, keys, duplicates, fragments, and normalization ambiguity are rejected.
- [ ] Device continuation carries only an opaque approval reference after code validation; authoritative P7A/P8A pending state is rebound and revalidated.
- [ ] User handle is opaque non-PII.
- [ ] Active account is not created before verified ceremony.
- [ ] Server enforces required UV.
- [ ] Credential ID is globally unique.
- [ ] Account + passkey + session is atomic or has documented pending-state semantics.
- [ ] Network retry cannot silently create a duplicate account.
- [ ] No secret/passkey material is logged.

## Rollback

Disable new registration entry while keeping already-created passkeys valid for sign-in. Do not delete credential rows or change RP ID/origin during rollback. Preserve pending-intent cleanup until all pre-rollback intents expire.
