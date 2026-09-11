# P0 — Freeze the passkey-only product and security contract

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: product + security + architecture

Type: decision gate; no production code required

Blocks: formal P1 and therefore all implementation tasks; optional `P1-preflight` is non-gating research

## Objective

Turn the desired UX into immutable security/configuration requirements before any passkey is registered. A passkey RP ID cannot be casually changed after launch, and recovery behavior cannot be invented after password paths are removed.

## P0.1 Freeze the account origin

Decide and record exact production values:

```text
account origin:  https://auth.desktopcommander.app
RP ID:           auth.desktopcommander.app
auth issuer:     prefer https://auth.desktopcommander.app (pathless)
```

The hostname above is the current recommendation, not an already-provisioned fact. Replace it only through an explicit architecture decision before production credentials exist.

Acceptance:

- exact HTTPS origin is reserved and controlled;
- no user-generated/untrusted content is served from that origin;
- CSP and script policy are owned by the auth deployment;
- production passkeys are never registered on Tailscale/zrok/per-device hosts;
- localhost development behavior is separately documented.

## P0.2 Freeze WebAuthn policy

Required policy:

```text
residentKey: required
userVerification: required
attestation: none
authenticatorAttachment: unset
username-first identifier: none
```

Security invariant:

> It is not enough to request `userVerification: required` from the authenticator. The server verifier must reject a response that lacks verified UV.

Acceptance:

- registration verification requires UV server-side;
- authentication verification requires UV server-side;
- user presence is also required by WebAuthn verification;
- attestation remains `none` unless a separate device-trust project changes it;
- platform, roaming security keys, and hybrid/phone flows remain eligible.

## P0.3 Freeze identity semantics

The end-user identity model must not depend on email.

Logical account identity:

```ts
type AccountIdentity = {
  id: string;                  // stable OAuth subject
  webauthnUserHandle: string;  // opaque, non-PII, <= 64 raw bytes
  displayLabel: string;        // pseudonymous/friendly UI label
};
```

Rules:

- OAuth `sub` is account `id`, never credential ID;
- multiple passkeys map to one account;
- user handle is random/opaque and stable;
- no fake deliverable email address;
- no required typed name/email/username during onboarding;
- optional friendly label may be added later without changing `sub` or user handle.

## P0.4 Freeze OAuth scope semantics

Review whether OIDC identity scopes are required at all.

Target device scopes:

```text
device:sync
offline_access
```

Target ChatGPT MCP scope:

```text
mcp:tools
```

`openid` may remain if required by the OAuth/OIDC provider/client integration, but `email` must not survive merely because it is a Better Auth default. `profile` should remain only if a concrete interoperable claim is needed.

Acceptance:

- every retained scope has a consumer and documented claim semantics;
- `email` is absent from passkey-only product grants unless a future verified email feature is deliberately introduced;
- approval screens do not display nonexistent email identity.

## P0.5 Freeze explicit trust boundaries

Three actions authorize three different things and must remain distinct:

```text
passkey ceremony -> authenticate account holder
device approval  -> trust this computer/device client
ChatGPT consent  -> let this MCP client invoke allowed tools
```

Do not auto-approve a device because registration succeeded. Do not auto-consent ChatGPT because a device is already trusted.

## P0.6 Freeze recovery policy

Initial release policy:

- synchronized passkeys are allowed;
- user can add multiple passkeys;
- fresh passkey assertion required before credential management;
- final credential cannot be deleted while the account is active;
- after onboarding, encourage a second credential when backup state is not reported as backed up;
- no support-agent email/name bypass;
- no undocumented local-device recovery shortcut.

Lost-all-passkeys behavior for V1:

```text
cloud account access is unrecoverable;
local Desktop Commander data is not deleted;
user may create a new account and re-pair local devices.
```

P0 must explicitly approve that consequence before password removal.

## P0.7 Freeze supported-platform matrix

Record minimum supported combinations for:

| Platform | Required acceptance path |
| --- | --- |
| macOS Safari | Touch ID / Apple Passwords / hybrid where supported |
| macOS Chromium | platform or synchronized passkey |
| Windows Edge/Chrome | Windows Hello |
| Linux Chromium/Firefox | roaming key and/or hybrid phone flow |
| Cross-device | QR/hybrid transport on at least one supported pair |
| Hardware key | at least one roaming FIDO2 key |

Unsupported WebAuthn must render a terminal product explanation, not silently fall back to password/email.

## P0.8 Freeze issuer/resource topology

Architecture invariant:

```text
stable authorization issuer != per-device MCP resource origin
```

Example:

```text
issuer:   https://auth.desktopcommander.app
resource: https://tests-macbook-air.tail70b8a.ts.net/mcp
```

The protected resource advertises the central issuer. The issuer registers/authorizes the exact resource. Device credentials are bound to both values.

## P0.9 Freeze one-CLI UX contract

Passkey work is necessary but not sufficient for one-click onboarding.

First run target:

```text
desktop-commander remote connect
-> recover/create stable tunnel identity
-> determine exact MCP resource
-> start/configure local resource service
-> begin RFC 8628 authorization
-> open stable auth origin
```

The user must not copy:

```text
APP_ORIGIN
REMOTE_MCP_RESOURCE
MCP_SERVER_URL
OAuth issuer
RP ID
```

P0 records this as a cross-project dependency even if implementation is tracked elsewhere.

## P0.10 Required decision record

Before formal P1 starts, create and approve the ADR containing:

```text
PASSKEY_RP_ID=<exact host>
PASSKEY_ORIGIN=<exact https origin>
AUTHORIZATION_SERVER_ISSUER=<exact issuer>
FRESH_AUTH_MAX_AGE=<approved duration>
WEBAUTHN_USER_VERIFICATION=required
PASSKEY_RECOVERY_POLICY=multi-passkey-no-support-bypass
ACCOUNT_IDENTITY=email-less
RESOURCE_MODEL=dynamic-per-device-exact-URL
```

## P0.11 Approval artifact and open-state rule

The actual sign-off record is `docs/PASSKEY-P0-PRODUCT-AND-SECURITY-ADR.md`.

P0 remains **OPEN** while any `TBD-APPROVAL` field remains. This task file defines what must be decided; it does not self-approve the proposal. Formal P1 depends on P0 approval recorded in the signed ADR.

Optional work explicitly labeled `P1-preflight` may investigate candidate libraries or APIs before approval, but it is disposable and non-gating: it cannot produce P1 GO, satisfy P1 for any dependency, create production credentials, or unlock implementation.

The ADR also freezes:

```text
route audience/scope model
fresh-auth maximum age
production dual-issuer policy
minimum concrete browser/OS versions
lost-all-passkeys new-association semantics
named DRI + product/security/operations approvers
```

A pathful issuer is not forbidden, but P7A must use RFC 8414 path insertion and test the exact framework route. A pathless issuer is preferred to avoid that compatibility surface.

## Exit checklist

- [ ] Stable production RP hostname approved.
- [ ] Exact production origin approved.
- [ ] Server-enforced UV is non-negotiable.
- [ ] Email-less account semantics approved.
- [ ] OAuth scopes reviewed.
- [ ] Explicit device approval retained.
- [ ] Explicit ChatGPT consent retained.
- [ ] Lost-all-passkeys policy approved.
- [ ] Platform matrix approved.
- [ ] Central issuer/per-device resource topology approved.
- [ ] One-CLI UX remains a tracked dependency.
- [ ] Signed P0 ADR is the prerequisite for formal P1; any earlier `P1-preflight` is recorded as non-gating.

## Rollback

P0 is a decision artifact. Before production passkeys exist, decisions can be changed with a new ADR. After production registration begins, changing RP ID/origin is a credential migration event and must not be treated as normal configuration.
