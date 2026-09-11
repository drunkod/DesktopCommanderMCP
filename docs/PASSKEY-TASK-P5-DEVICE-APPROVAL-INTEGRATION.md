# P5 — Device-code auto-advance and explicit device approval

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: control-plane/auth UX + device authorization

Depends on: P3, P4, P7A protocol contract, P7B implementation, P8A durable state/transactions

Blocks: P9, P10

## Objective

Remove the redundant device-code `Continue` click when the CLI opened a complete verification URL, while preserving explicit account authentication and explicit approval/denial of the computer.

## Current behavior

`src/remote-device/device-oauth.ts` already prefers:

```ts
verification_uri_complete ?? verification_uri
```

The control-plane `/device` page receives `user_code`, but still renders a form and requires `Continue` before routing to `/device/approve`.

The approval page then displays raw OAuth client/scope/resource values and the user's email.

## Target behavior

```text
CLI displays verification_uri + user_code and opens verification_uri_complete
        |
        v
/device?user_code=ABCDEFGH
        |
        v
strict full-code validation + durable rate limit + P7A/P8A server lookup
        |
        +--> invalid/expired/non-pending -> reject with generic error; no metadata disclosure
        |
        v
mint opaque approval reference mapped server-side to the pending request;
redirect/replace browser URL with
/device/approve?request=<opaque-approval-reference>
        |
        v
not signed in -> /sign-in?callbackURL=<canonical request callback>
        |
        v
passkey auth/registration
        |
        v
server-authoritative pending-request summary + possession code,
with device name/platform labeled self-asserted
        |
        +--> POST Deny
        |
        +--> POST Approve
```

The raw `user_code` is input to the verification step only. After successful server validation it is replaced in browser continuation state by a distinct high-entropy approval reference; it is never the callback key or pending-request identifier.

## P5.1 Auto-submit only prefilled complete URLs

Rules:

- if `user_code` query parameter is present, run the complete raw value through the strict validator automatically; only provider-defined display-separator normalization is permitted;
- if no code is present, retain a manual code-entry fallback page;
- never approve automatically;
- do not start passkey registration automatically just because a code exists.

This preserves manual RFC 8628 usability while optimizing the CLI-opened path.

## P5.2 Validate code in one shared helper

Normalize **only** separators explicitly defined by the selected RFC 8628 provider (for example a displayed hyphen). Then validate the entire resulting string against the provider's exact ASCII alphabet and exact length.

Rules:

- reject leading/trailing whitespace rather than trimming it into validity;
- reject Unicode confusables, controls, arbitrary punctuation, extra characters, and over/under-length input;
- reject the input if any character, separator placement, or length is invalid; do not salvage a candidate value;
- never strip arbitrary characters;
- never truncate;
- manual and complete-URI paths use the same validator and rejection behavior;
- rate-limit failed lookups durably under P8A.

Two distinct invalid strings must never collapse to the same accepted code through lossy normalization.

## P5.3 Verify request before redirecting

Call the P7A-defined device-authorization lookup against shared P8A state before producing any approval reference or auth callback. A supplied code must resolve to one server-authoritative request that is:

```text
known
unexpired
pending
not denied
not already consumed
```

Unknown, malformed, over/under-length, expired, denied, or consumed codes are rejected; they are never stripped, truncated, or transformed into another lookup value. Do not create a passkey account solely for an already-expired device request. The sign-in page may still offer normal account creation outside that device transaction.

## P5.4 Preserve the opaque approval-reference callback through passkey auth

After a valid code lookup, mint a distinct high-entropy `approvalReference` and store a durable P8A mapping to the server-owned `pendingDeviceAuthorizationId`. Use only this canonical browser callback:

```text
/device/approve?request=<opaque-approval-reference>
```

The approval reference is short-lived, browser-safe, revocable/consumable, and reveals neither the `user_code` nor the provider's pending-request ID. The passkey flow stores the parsed callback binding plus the distinct pending-request binding in P3 intent/session continuation state. On every GET/POST, the server resolves the reference, reloads authoritative pending state, and requires the mapping and request to remain active and mutually consistent. The browser cannot replace client, bootstrap, resource, scopes, or request state by editing the callback.

## P5.5 Human-readable device presentation

Lead with a possession confirmation derived from the validated server record. Clearly separate server-authoritative request facts from self-asserted presentation:

```text
Approve this computer?

Code shown by server: ABCD-EFGH
Self-reported name: “Tests-MacBook-Air”
Self-reported platform: macOS
Capability: Receive Desktop Commander commands through authorized MCP clients

[Deny] [Approve]

Advanced server-verified request details
  client id
  requested scopes
  exact resource
  request expiry/state
```

`deviceName` and `platform` are supplied by the requesting device. Even when stored durably and integrity-bound to the pending request, they remain attacker-chosen, self-asserted presentation strings—not verified identity or authorization facts. Escape them, enforce conservative length limits, and reject controls/bidirectional-confusing characters.

The approval reference, pending authorization ID, validated P7A bootstrap/device association, client ID, exact resource, requested scopes, canonical code display, expiry, and pending/terminal state come only from server-owned P7A/P8A records. Browser query values and presentation strings cannot populate or override those fields.

## P5.6 Extend pending device metadata safely

If Better Auth's current device request record does not preserve device name/platform, attach application-owned metadata when the device starts RFC 8628 authorization, but preserve the trust distinction in storage and APIs.

Canonical logical shapes:

```ts
type SelfAssertedDevicePresentation = {
  deviceName: string;
  platform: string | null;
};

type ApprovalDecisionStateV1 =
  | "pending"
  | "decision_committing"
  | "approved_pending_ownership"
  | "denied"
  | "expired"
  | "consumed"
  | "approval_repair_required";

type OwnershipFinalizationStateV1 =
  | "not_started"
  | "ownership_sync_pending"
  | "owned"
  | "ownership_repair_required"
  | "revoked";

type ServerAuthoritativePendingDeviceState = {
  pendingDeviceAuthorizationId: string;
  approvalReference: string; // separate high-entropy browser continuation reference
  bootstrapId: string;
  validatedDeviceId: string;
  clientId: string;
  resource: string;
  requestedScopes: string[];
  canonicalUserCodeDisplay: string;
  approvalState: ApprovalDecisionStateV1;
  ownershipState: OwnershipFinalizationStateV1;
  operationRevision: number; // durable CAS revision
  expiresAt: Date;
  presentation: SelfAssertedDevicePresentation;
};
```

P7A defines and validates bootstrap/client/resource/scope identity; P8A owns the durable reference mapping, TTL, uniqueness, and conditional transitions. Storing `presentation` inside the authoritative record integrity-binds what was presented but does not make its values server-verified. Never source any field from the approval-page query except `approvalReference`, and never let browser input override the loaded record.

## P5.7 Replace email-based account copy

Remove:

```tsx
Signed in as <strong>{session.data?.user.email}</strong>
```

Use:

```text
Signed in to your Desktop Commander account.
```

or a P2-approved pseudonymous account display label.

## P5.8 Keep raw OAuth data under advanced details

The current page exposes:

```text
Code
OAuth client
Scope
Resource
```

These are valuable diagnostics but not primary product concepts.

Advanced section rules:

- collapsed by default;
- exact resource visible for expert verification;
- no access/refresh token;
- no secret client metadata;
- no passkey credential/user-handle material.

## P5.9 Approval semantics

Approve must:

1. require a valid authenticated session;
2. resolve the opaque approval reference through its durable P8A mapping and load/lock the exact server-authoritative pending authorization;
3. verify mapping/request binding, `approvalState == pending`, expiry, decision nonce, and P7A bootstrap/client/resource/scope policy;
4. CAS to `decision_committing` and bind the authenticated account;
5. commit the provider decision and durable ownership outbox/idempotency anchor;
6. move to `approved_pending_ownership` + `ownership_sync_pending` when Jazz/device ownership is separate, or atomically to `consumed` + `owned` when all records share one transaction;
7. expose a non-actionable success/pending page, but do **not** release tokens while ownership is pending or in repair;
8. allow the device poll to receive tokens exactly once only after `ownershipState == owned` and the grant/token commit is authoritative.

A known partial provider decision moves to `approval_repair_required`; a committed approval awaiting Jazz moves to `ownership_sync_pending`; an exhausted roll-forward moves to `ownership_repair_required`. All three are non-actionable in the browser, reject a second decision, and fail token polling closed while an idempotent worker/operator runbook rolls forward or revokes. Deny similarly commits a terminal decision, performs required cleanup, and produces no token.

## P5.10 Double-submit/idempotency

Disable UI while decision is in flight, but server correctness must not rely on the button state.

Tests:

```text
double approve -> one authorization result
double deny -> one denial result
approve then deny -> terminal first decision, no contradictory state
deny then approve -> terminal first decision, no token if denial won
expired during click -> no token
provider decision commits but response is lost -> reconcile same decision, never redisplay actionable pending
approval commits but ownership outbox is delayed -> ownership_sync_pending and token poll remains pending/denied
ownership finalization exhausts retries -> ownership_repair_required and no token
repair worker retries -> one owned association and one token result, or terminal revocation
```

## P5.11 Resource display under the P7A contract

The pending request should show:

```text
Authorization service: auth.desktopcommander.app
Computer resource:    https://<device-origin>/mcp
```

The central issuer and resource are deliberately different. Approval logic must not reject that difference as origin drift.

## P5.12 Success page

After approval:

```text
Computer approved
You can return to Desktop Commander.
```

Do not imply ChatGPT is already authorized. If connector setup is next, present it as a separate explicit next action.

## P5.13 Tests

```text
complete URI auto-advances a valid full code
manual page remains when no code
invalid characters/separator placement/length are rejected, never stripped or truncated
expired/denied/consumed code does not start auth
successful lookup replaces user_code continuation with an opaque approval reference
unauthenticated valid code -> passkey sign-in -> same approval reference and pending request
new account -> same approval reference and pending request
approval labels escaped device name/platform as self-asserted
approval loads client/bootstrap/resource/scopes/expiry/state only from authoritative P7A/P8A pending state
approval hides OAuth details by default
approval does not require email
deny yields no device token
approve yields one device authorization
double-submit is idempotent
resource origin may differ from issuer origin
malicious query or presentation cannot replace authoritative pending state
```

## Future implementation targets

```text
apps/control-plane/app/device/page.tsx
apps/control-plane/app/device/approve/page.tsx
apps/control-plane/app/device/success/page.tsx
apps/control-plane/app/device/denied/page.tsx
apps/control-plane/lib/auth-callback.ts
apps/control-plane/lib/device-presentation.ts   # if needed
apps/control-plane/test/device-approval*.test.ts
```

Device-side test impact:

```text
test/test-remote-jazz-safety.js
test/integration/zrok-remote-mcp-e2e.js
```

## P5.14 Approval mutation security contract

Approve and Deny are POST-only state changes. Require all of:

```text
valid authenticated browser session
CSRF token appropriate to the cookie model
strict Origin validation
Sec-Fetch-Site policy where supported
one-time decision nonce bound to session + pending device authorization
pending request still active/unexpired
client active and exactly matches pending state
resource active and exactly matches pending state
requested scopes subset of server policy for that client class/resource
```

Replay, cross-site submission, changed client/resource/scope, unknown scope, inactive resource, or consumed nonce fails closed.

Browser input contains only the opaque approval reference, decision nonce, CSRF value, and decision. The server resolves the separate pending-request ID and loads subject/client/bootstrap/resource/scopes/expiry/state from authoritative P7A/P8A state. Device name/platform are loaded from the integrity-bound record but remain explicitly self-asserted presentation.

## P5.15 RFC 8628 user-code privacy and guessing controls

Because `verification_uri_complete` legitimately contains a user code, apply explicit exception controls:

- durable per-code and coarse-source attempt limits;
- maximum attempts and expiry terminal behavior;
- generic pre-auth response for unknown/expired/denied/consumed codes;
- no device metadata disclosure before authenticated account context;
- `Referrer-Policy: no-referrer` on verification/approval pages;
- never log or send the full code to analytics;
- after successful validation, always redirect/replace the browser URL with the opaque approval reference; never carry `user_code` into auth callbacks or approval mutations.


## Exit checklist

- [ ] Complete verification URI requires no `Continue` click.
- [ ] Manual code entry remains available.
- [ ] Invalid/expired request does not create onboarding dead-end.
- [ ] Invalid device-code characters, separator placement, and lengths are rejected without stripping or truncation.
- [ ] Successful lookup replaces `user_code` with a distinct opaque approval reference throughout browser/auth continuation.
- [ ] Passkey auth preserves the exact approval-reference mapping and pending request.
- [ ] Explicit Approve/Deny remains.
- [ ] Device name/platform are explicitly labeled self-asserted, escaped, bounded, and integrity-bound to the request.
- [ ] Approval reference, pending ID, bootstrap/device association, client, resource, scopes, expiry, and state are loaded from server-authoritative P7A/P8A records and cannot be overridden by presentation or browser input.
- [ ] Email identity removed.
- [ ] OAuth internals moved to advanced details.
- [ ] Issuer/resource separation accepted.
- [ ] Approval/denial race behavior tested.
- [ ] ChatGPT consent remains a separate trust boundary.

## Rollback

Re-enable the explicit `Continue` page if auto-advance has a regression; do not alter device authorization token semantics. The approval page must continue to require explicit user decision throughout rollback.
