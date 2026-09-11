# P0 ADR — Passkey-only product and security decisions

Status: **PROPOSED / approval required before formal P1 starts**

Parent: `docs/PASSKEY-TASK-P0-PRODUCT-CONTRACT.md`

Review source: `docs/PASSKEY-ONLY-REGISTRATION-TASK-PACK-REVIEW.md` R-01

## Purpose

This is the single approval record for G0. Example values elsewhere in the task pack are not approval. Formal P1 and production implementation remain blocked until every `TBD-APPROVAL` field below is replaced by an approved value and the named approvers sign the record. Optional `P1-preflight` work is disposable, non-gating research only; it cannot produce P1 GO or unlock a downstream task.

## Decision table

| Decision | Proposed value | Approval state |
| --- | --- | --- |
| `PASSKEY_RP_ID` | `auth.desktopcommander.app` | TBD-APPROVAL |
| `PASSKEY_ORIGIN` | `https://auth.desktopcommander.app` | TBD-APPROVAL |
| `AUTHORIZATION_SERVER_ISSUER` | prefer `https://auth.desktopcommander.app` (pathless) | TBD-APPROVAL |
| `WEBAUTHN_USER_VERIFICATION` | `required` | REQUIRED / approver sign-off pending |
| resident credential | `required` | REQUIRED / approver sign-off pending |
| attestation | `none` | REQUIRED / approver sign-off pending |
| account identity | email-less, opaque stable subject | REQUIRED / approver sign-off pending |
| normal recovery | multiple/synced passkeys only; no support bypass | TBD-APPROVAL |
| lost-all-passkeys | old cloud account unrecoverable; create new account and re-pair local device | TBD-APPROVAL |
| fresh-auth max age | TBD-APPROVAL duration | OPEN |
| resource model | exact per-device resource identifiers | TBD-APPROVAL |
| route authorization model | see P7A route matrix | TBD-APPROVAL |
| dual issuer in production | default **no**; any exception requires dated ADR | TBD-APPROVAL |
| post-revocation access exposure ceiling | 300 seconds maximum; release may choose lower | REQUIRED / approver sign-off pending |
| minimum platform versions | TBD-APPROVAL | OPEN |

## Non-negotiable security invariants

1. Server verification must reject WebAuthn registration and authentication when UV is absent.
2. No deliverable-looking synthetic email identity may be created merely to satisfy framework schema.
3. Device approval and ChatGPT consent remain separate explicit decisions.
4. RP ID/origin and production issuer are release-pinned identity, not mutable rollout flags.
5. A resource token is accepted only for its exact configured audience and required route scope.
6. Device refresh credentials remain in the OS credential vault and are bound to issuer + resource.

## Route authorization decision to approve

Preferred V1 model: one logical per-device OAuth resource, with route-specific scopes.

| Route family | Audience | Required scope | Exposure |
| --- | --- | --- | --- |
| public `/mcp` | exact `publicMcpResource` | `mcp:tools` | public tunnel |
| `/api/device/**` | same exact `publicMcpResource` | `device:sync` | local/controlled transport only |
| central auth/browser routes | central issuer/session rules | not a resource bearer token | stable auth service |

This shared-resource model is only approved when the resource metadata advertises both supported scopes and every route enforces its own scope. If operations/security instead require a separate device-sync audience, P7A must be revised before implementation.

## Fresh-auth decision

`FRESH_AUTH_MAX_AGE` must be an explicit duration used by credential-management and other sensitive account changes. It may not be inferred from ordinary browser-session lifetime.

Approval field:

```text
FRESH_AUTH_MAX_AGE=TBD-APPROVAL
```

## Supported platform decision

Record minimum versions for:

```text
macOS Safari
macOS Chromium
Windows Edge/Chrome
Linux Chromium/Firefox
cross-device hybrid flow
roaming FIDO2 security key
```

A platform that cannot satisfy required UV does not fall back to password/email.

## Account loss and local re-pair semantics

Lost-all-passkeys is **not account recovery**. The approved V1 transition must be:

```text
old cloud account inaccessible
-> local user proves control of the Desktop Commander installation/device
-> create a new passkey account
-> create a NEW account-device association
-> invalidate/revoke old device refresh authority according to P6/P9
-> reconcile resource/client ownership through the P7A lifecycle protocol
```

The old OAuth subject is never silently transferred to the new account.

## Approval roles

Fill accountable people/teams before formal P1 starts:

```text
DRI: TBD-APPROVAL
Product approver: TBD-APPROVAL
Security approver: TBD-APPROVAL
Operations approver: TBD-APPROVAL
Auth/platform approver: TBD-APPROVAL
```

## Approval checklist

- [ ] Production RP hostname is reserved and controlled.
- [ ] Exact passkey origin approved.
- [ ] Exact authorization issuer approved.
- [ ] Server-required UV approved as non-negotiable.
- [ ] Email-less account identity approved.
- [ ] Fresh-auth duration approved.
- [ ] Shared-vs-split route audience model approved.
- [ ] OAuth scopes per route/client approved.
- [ ] Lost-all-passkeys/re-pair consequence approved.
- [ ] Minimum browser/OS matrix approved.
- [ ] Dual-issuer policy approved.
- [ ] DRI and product/security/operations approvers recorded.

## Gate behavior

Until every approval item is complete, P0 remains **OPEN**. Only an explicitly named `P1-preflight` disposable research spike may run; formal P1 must not start, preflight results cannot be called P1 GO, and no downstream dependency is satisfied. No production credential registration or source cutover may claim G0 complete.
