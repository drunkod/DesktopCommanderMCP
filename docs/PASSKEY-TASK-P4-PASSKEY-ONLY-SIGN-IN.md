# P4 — Username-less passkey-only sign-in

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: control-plane/auth service

Depends on: P2, P3, P8A

Blocks: P5, P6, P9

## Objective

Replace email/password sign-in with a username-less discoverable-passkey flow that preserves pending device/OAuth callbacks, supports conditional UI where available, and always provides an explicit passkey button fallback.

## P4.1 Replace the current form

Current `app/sign-in/page.tsx` maintains:

```text
mode = sign-in | sign-up
name
email
password
```

Target primary actions:

```text
Sign in with a passkey
Create account with a passkey
```

No typed identity field is required.

## P4.2 Username-less authentication

The generated request must not restrict `allowCredentials` to a username-selected account for the normal sign-in path.

The authenticator returns a discoverable credential; the server finds the credential row by ID and derives its owning account.

Required server checks are inherited from P1:

```text
challenge
RP ID
origin
signature
UP
required UV
credential status
account status
```

## P4.3 Conditional UI

Use conditional mediation/autofill only when supported and only as enhancement.

Illustrative client logic:

```ts
async function tryConditionalPasskey() {
  if (!("PublicKeyCredential" in window)) return;
  const capability = PublicKeyCredential
    .isConditionalMediationAvailable?.();
  if (!capability || !(await capability)) return;
  await authClient.signIn.passkey({ autoFill: true });
}
```

Exact API follows the P1-selected library. Do not make page usability depend on conditional UI.

## P4.4 Always show explicit fallback

The page must always render:

```text
[ Sign in with a passkey ]
```

The button invokes a user-initiated WebAuthn request and supports platform, roaming, and hybrid authenticators according to browser behavior.

## P4.5 Keep create and sign-in semantics distinct

Never implement:

```text
sign-in failed/cancelled -> assume user is new -> silently create account
```

`NotAllowedError` can mean cancellation, timeout, permission, unavailable authenticator, or no matching credential.

Creation starts only from explicit `Create account with a passkey`.

## P4.6 Preserve callback safely

Use P3 shared callback validation. Sign-in success routes to the validated pending destination.

Required scenarios:

```text
/device/approve?... -> sign-in -> same device approval
/consent?...        -> sign-in -> same OAuth consent
/dashboard/...      -> sign-in -> dashboard
malicious callback  -> safe default
```

## P4.7 Handle authenticated users

If a valid session already exists:

- do not launch WebAuthn automatically unless fresh authentication is specifically required;
- continue directly to safe callback;
- management/security-sensitive pages may require P6 fresh passkey assertion separately.

## P4.8 Account display without email

Avoid current implementation language:

```text
Signed in as user@example.com
```

Use either no identifier or an application display label. Never reveal user handle, credential ID, OAuth client ID, or token subject as friendly identity by default.

## P4.9 Error handling

Normalize at least:

| Error class | Behavior |
| --- | --- |
| user cancel/timeout | stay on page, allow retry |
| WebAuthn unsupported | show supported alternatives/platform guidance, no password fallback |
| no matching credential | generic “No usable passkey was selected” + create-account choice |
| revoked/deleted credential | generic auth failure; security event without full credential ID |
| wrong origin/RP | fail closed; configuration diagnostic to ops |
| missing UV | fail closed |
| network | retry without creating account |
| session creation failure | fail closed, no partial authenticated UI |

Avoid account enumeration wording.

## P4.10 Sign-out semantics

Sign-out removes server/browser session only. It must not:

- delete passkeys;
- clear device OAuth credentials;
- revoke the paired computer automatically;
- delete local Desktop Commander data.

Make those separate explicit actions.

## P4.11 Fresh authentication helper

P6 credential management needs a recent passkey assertion. Establish a reusable concept:

```ts
type FreshAuth = {
  accountId: string;
  sessionId: string;   // exact post-reauthentication rotated/current session
  verifiedAt: number;  // server-issued time only
  method: "passkey";
};
```

Fresh authentication is an **account-and-session-bound** ceremony, not merely "some passkey was just used":

```text
load current authenticated session S0(account=A)
-> perform a new passkey assertion
-> resolve asserted credential owner
-> require asserted owner == A == S0.accountId
-> rotate/refresh to current session S1 for the sensitive-operation continuation
-> persist/derive FreshAuth(accountId=A, sessionId=S1.id, verifiedAt=serverNow)
-> sensitive action requires current session.id == FreshAuth.sessionId
   AND current session.accountId == FreshAuth.accountId
   AND age <= approved freshness window
```

A discoverable credential for account B while the browser session belongs to account A is rejected and cannot create a fresh-auth marker for either account. Client timestamps/account IDs/session IDs are ignored. Session rotation not performed as part of the fresh-auth success, later session rotation, sign-out, account switch, or revocation invalidates the marker unless the selected framework proves an equivalent server-side freshness primitive bound to the same session/account.

Do not treat an hours-old cookie session as sufficient for deleting passkeys. Better Auth session freshness may be used only if P1 proves these exact account/session binding semantics; otherwise use the explicit marker above.

## P4.12 Tests

```text
username-less passkey sign-in success
explicit button works without conditional UI
conditional UI unsupported -> page still usable
cancel does not create account
no matching credential does not create account
wrong challenge fails
wrong origin fails
wrong RP fails
missing UV fails
revoked passkey fails
callback /device preserved
callback /consent preserved
external callback rejected
existing session skips redundant ordinary sign-in
fresh-auth: session A + account B passkey -> reject
fresh-auth marker bound to old/other session -> reject
fresh-auth verifiedAt/account/session supplied by client -> ignored/reject
sign-out invalidates fresh-auth marker but keeps passkey credential
```

## Future implementation targets

```text
apps/control-plane/app/sign-in/page.tsx
apps/control-plane/lib/auth-client.ts
apps/control-plane/lib/auth-callback.ts
apps/control-plane/lib/webauthn-errors.ts
apps/control-plane/test/passkey-sign-in*.test.ts
```

## P4.13 Fresh-auth and callback hardening

Sensitive credential/account actions use the P0-approved `FRESH_AUTH_MAX_AGE`, which is independent of normal session lifetime. If the marker is too old, require a new passkey assertion.

All post-auth callbacks go through the exact/segment-boundary helper defined by P3; no page may implement its own `startsWith(prefix)` redirect policy.

## Exit checklist

- [ ] No email/password fields in normal sign-in UI.
- [ ] Explicit passkey sign-in always available.
- [ ] Conditional UI is enhancement only.
- [ ] Sign-in never auto-creates account.
- [ ] Server enforces required UV.
- [ ] Callback validation centralized.
- [ ] Device/OAuth pending requests survive auth.
- [ ] No email identity required for UI.
- [ ] Fresh-auth primitive defined for P6.
- [ ] Unsupported platform has clear terminal guidance without legacy auth fallback.

## Rollback

If sign-in rollout fails, disable the new entry page/routing while retaining registered passkeys and schema. Do not invalidate passkeys or change RP configuration. During migration windows, a legacy login page may be restored only under the P9/P11 migration policy, not as a permanent hidden fallback.
