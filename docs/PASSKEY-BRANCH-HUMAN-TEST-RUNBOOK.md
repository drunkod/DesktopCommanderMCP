# Human runbook — test the passkey device branch

Applies to branch: `feat/passkey-only-registration`

Purpose: manually validate the current DesktopCommanderMCP passkey-device implementation against a real non-production control plane and browser/OS passkey ceremony.

This is a **human acceptance runbook**, not a replacement for `npm test` or the P0/P1/P8A/P9A release gates.

## 1. Current implementation boundary

The branch currently implements the DesktopCommanderMCP/device side of the passkey OAuth flow, including:

- immutable issuer/resource identity;
- RFC 8628 device authorization;
- exact `device:sync offline_access` scope;
- JWT/JWKS access-token verification;
- OS-vault persistence with issuer/resource binding;
- refresh rotation and refresh-token revocation;
- durable cleanup obligations when revocation temporarily fails;
- tunnel OAuth/resource health checks;
- bounded/strict OAuth and control-plane responses.

The **central account/passkey UI and first-party device-client provisioning/bootstrap service are external to this repository**. A normal development/production run therefore needs a pre-provisioned `DC_REMOTE_DEVICE_CLIENT_ID`. Public DCR is intentionally test-profile-only.
## 2. Safety rules

Use only a disposable/non-production issuer, account, device client, tunnel, and resource while this branch is uncommitted.

Never print, paste, or capture:

- access or refresh tokens;
- Keychain/Secret Service/DPAPI credential payloads;
- `device_code` values;
- complete callback URLs containing OAuth state/code values;
- private JWKs or passkey credential material.

Do **not** manually delete individual macOS Keychain chunk entries. The vault uses a manifest + chunk generation and a monotonic clear-generation tombstone; partial deletion is treated as corruption.

Do not test issuer/resource mismatch by pointing the persistent vault at a different live identity. Use the automated test suite for malformed/mismatched stored sessions.

For a human “fresh authorization every start” test, prefer `--no-persist-session` instead of damaging the native vault.

## 3. Capture the exact test baseline

From the repository root:

```bash
pwd
git branch --show-current
git rev-parse HEAD
git status --short
```

Expected branch: `feat/passkey-only-registration`.
Record the HEAD and note that the working tree may contain intentional uncommitted passkey changes. Do not claim a commit contains the tested behavior unless those changes have actually been committed.

## 4. Run deterministic gates first

Use the repository Nix shell so the test environment is reproducible:

```bash
nix develop -c just bootstrap
nix develop -c just check
nix develop -c node test/test-passkey-device-mvp.js
nix develop -c just remote-gate
nix develop -c just test
```

Pass criteria:

- build succeeds;
- `test-passkey-device-mvp.js` prints `✓ passkey device MVP contract cases passed`;
- remote safety/supervision/tunnel unit gates pass;
- the main runner reports zero failed test files.

The main test runner discovers `test*.js` dynamically, so use “all discovered tests passed” as the criterion rather than hard-coding a test count.

Optional broader gate:

```bash
nix develop -c just full-gate
```

Do not start live browser testing after a deterministic regression failure.
## 5. External control-plane prerequisites

Before a live run, the non-production control plane must already provide all of the following for the exact issuer/resource pair:

- authorization-server discovery;
- authorization endpoint;
- RFC 8628 device-authorization endpoint;
- token endpoint;
- JWKS endpoint;
- revocation endpoint;
- browser verification route `/device`;
- protected-resource metadata for the exact public MCP resource;
- `/api/device/**` control-plane routes;
- a first-party desktop OAuth client already provisioned for this resource.

Required metadata capabilities include:

```text
authorization_code
urn:ietf:params:oauth:grant-type:device_code
refresh_token
token_endpoint_auth_method = none
response_type = code
PKCE S256
scopes: device:sync, offline_access
```

The protected-resource metadata must advertise exactly one authorization server and the shared-resource scope profile expected by this branch: `mcp:tools` and `device:sync`.
## 6. Create a local non-secret environment file

Create a shell file outside Git, for example `~/.config/desktop-commander/passkey-test.env`, mode `0600`:

```bash
mkdir -p ~/.config/desktop-commander
chmod 700 ~/.config/desktop-commander
cat > ~/.config/desktop-commander/passkey-test.env <<'EOF'
export DC_REMOTE_RUNTIME_PROFILE=development
export DC_REMOTE_AUTH_ISSUER='https://AUTH-ISSUER-EXAMPLE'
export REMOTE_MCP_RESOURCE='https://DEVICE-RESOURCE-EXAMPLE/mcp'
export MCP_SERVER_URL='http://127.0.0.1:3000'
export DC_REMOTE_DEVICE_CLIENT_ID='PREPROVISIONED-PUBLIC-CLIENT-ID'
EOF
chmod 600 ~/.config/desktop-commander/passkey-test.env
```

Replace placeholders with the actual non-production values. The resource must be the exact canonical `/mcp` URL with no trailing slash. `MCP_SERVER_URL` must be literal loopback for the current local-device contract.

Load it without echoing values:

```bash
set -a
source ~/.config/desktop-commander/passkey-test.env
set +a
```

Prefer `DC_REMOTE_AUTH_ISSUER` explicitly even though development mode has compatibility fallbacks. Do not put refresh/access tokens or private keys in this file.
## 7. Verify public identity before starting the device

If a stable tunnel already exists, use it. This is the recommended path for the current branch.

For Tailscale:

```bash
nix develop -c node dist/index.js remote tunnel status --tunnel tailscale
nix develop -c node dist/index.js remote tunnel doctor --tunnel tailscale
```

For zrok, replace `tailscale` with `zrok` and provide the configured namespace/name if required.

Pass criteria for `doctor`:

- local target responds;
- tunnel transport is online;
- stable public identity has not drifted;
- public target responds;
- protected-resource metadata matches `REMOTE_MCP_RESOURCE` exactly;
- `authorization_servers` contains exactly `DC_REMOTE_AUTH_ISSUER`;
- central authorization-server discovery passes.

### New tunnel identity caveat

`remote tunnel prepare` currently health-checks the configured local health path before creating/exposing transport. Do not invent a fake endpoint merely to make preparation green. If creating a new stable tunnel, the selected control-plane health endpoint must already return a legitimate HTTP 200; after the public URL is known, restart/configure the external control plane with that exact public identity and rerun `doctor` before device authorization.
## 8. First authorization — human passkey ceremony

Start the device with persistence enabled:

```bash
nix develop -c node dist/index.js remote --tunnel tailscale --debug
```

Use `--tunnel zrok` instead when testing zrok. For a direct/local transport test, omit the tunnel only when the configured issuer/resource are deliberately reachable without it.

Expected CLI sequence includes:

```text
🚀 Starting MCP Device (Jazz transport)...
⏳ Authorizing with Remote MCP http://127.0.0.1:3000
Open <trusted issuer /device URL>
Enter code <human user code>
```

The browser normally opens automatically. To exercise copy/manual navigation instead:

```bash
DC_DEVICE_NO_BROWSER=1 nix develop -c node dist/index.js remote --tunnel tailscale --debug
```

Human actions:

1. Verify the browser is on the expected non-production passkey RP/issuer.
2. Complete the required browser/OS passkey ceremony.
3. Verify the displayed device request/code corresponds to this CLI attempt.
4. Explicitly approve the device request.
5. Do not approve an unexpected client/resource/account.
Pass criteria after approval:

```text
✅ Device ready:
   - Device ID:    ...
   - Stable ID:    ...
   - Device Name:  ...
```

With a tunnel, the CLI should also print the stable public MCP URL. The process should remain running and heartbeats should stay healthy.

Fail the test if:

- a password/social fallback is presented as the normal new-account credential;
- the browser is sent to an unexpected origin/path;
- `verification_uri_complete` contains a different user code;
- the CLI accepts an issuer/resource/scope mismatch;
- approval is skipped;
- the device becomes ready before authorization completes.

## 9. Verify local persistence without exposing secrets

The ordinary continuity file is safe to inspect:

```bash
cat ~/.desktop-commander-device/device.json
stat -f '%Sp %N' ~/.desktop-commander-device/device.json   # macOS
```

It should contain only a non-secret `stableId` and be mode `0600`.
On macOS, confirm a vault manifest exists **without requesting its secret**:

```bash
security find-generic-password \
  -s com.desktopcommander.remote-mcp \
  -a device-oauth-session:manifest >/dev/null 2>&1 \
  && echo 'native OAuth vault present'
```

Never add `-w` to that diagnostic command and never enumerate/copy the chunk payloads into logs.

Platform storage notes:

- macOS: Keychain service `com.desktopcommander.remote-mcp`, manifest/chunk accounts;
- Linux: Secret Service label `Desktop Commander Remote MCP`;
- Windows: current-user DPAPI file under `%LOCALAPPDATA%\DesktopCommander\jazz-oauth.dpapi`.

## 10. Normal restart — must not open a browser

Stop the running device with one `Ctrl-C` and wait for:

```text
🛑 Shutting down device...
✓ Device shutdown complete
```

Start it again with the same environment and command.

Pass criteria: the persisted V2 credential is rediscovered and cryptographically revalidated against current discovery/JWKS; the device becomes ready **without** printing `Open ...`, `Enter code ...`, or opening the browser.
Fail the restart test if the browser opens without a real authorization reason, if the stored token is used while JWKS verification fails, or if the issuer/resource has silently changed.

## 11. Refresh-path test

Use a non-production issuer configured with a short access-token lifetime so the device reaches its refresh window quickly. The token manager refreshes when less than 60 seconds remain.

Procedure:

1. Complete one successful persisted authorization.
2. Keep the device running, or restart when the access token is inside the final 60-second window.
3. Do not revoke the refresh family for this test.
4. Exercise a normal device heartbeat or safe remote call after refresh.

Pass criteria:

- no browser/passkey ceremony occurs;
- refresh uses the same exact issuer/resource/client;
- scope remains exactly `device:sync offline_access`;
- the device remains ready after refresh rotation.

Do not inspect the refresh token or edit the vault to prove rotation. The automated MVP test owns generation/CAS internals; this human test proves observable continuity.

## 12. Revocation -> same-startup reauthorization

Use the control-plane/operator test tooling to revoke the current device refresh family/client according to the test environment's supported revocation flow. Do not delete random database rows.

For deterministic observation, use a short access-token TTL or wait until the device enters its refresh window.
Then trigger token use/refresh without stopping the process if possible; otherwise restart with the same environment.

Expected behavior when refresh authority is terminally invalid:

```text
stored credential is cleared with generation protection
-> authorization restarts in the same startup
-> CLI prints Open ... and Enter code ...
-> human passkey + explicit approval occurs again
-> new V2 session is saved
```

Pass criteria: there is no token rebinding or silent fallback. If revocation cleanup itself is unavailable, startup must fail closed and preserve a durable cleanup obligation for retry.

## 13. Non-persistent authorization test

This is the safest human way to test repeated first authorization without modifying the native vault:

```bash
nix develop -c node dist/index.js remote --tunnel tailscale --no-persist-session --debug
```

Complete the human ceremony, stop the device, then run the same command again.

Pass criteria: authorization is required on every start and the CLI says session persistence is disabled. The normal persistent credential already in the OS vault must not be consumed by this memory-store run.

## 14. Safe remote-call smoke test

With the device ready, connect the non-production ChatGPT/MCP client to the exact stable `REMOTE_MCP_RESOURCE` and complete its normal explicit OAuth consent.

Start with a harmless control call such as `ping`/`__control.ping`.
Then, if desired, run one read-only Desktop Commander operation against a disposable path.

Pass criteria:

- the call is delivered only to the approved device;
- the device claims authority before any local side effect;
- duplicate delivery does not execute twice;
- completion is persisted before reconnect/shutdown behavior;
- revoked device/account authority causes the remote call to fail closed.

Do not use file deletion, process termination, or other destructive tools for the first smoke test.

## 15. Tunnel operational checks

While the device is running, record a sanitized doctor report:

```bash
nix develop -c node dist/index.js remote tunnel doctor --tunnel tailscale
```

Test a controlled transport stop/restart only in the disposable environment:

```bash
nix develop -c node dist/index.js remote tunnel stop --tunnel tailscale
nix develop -c node dist/index.js remote tunnel restart --tunnel tailscale
nix develop -c node dist/index.js remote tunnel doctor --tunnel tailscale
```

Stopping a Tailscale share should retain stable identity. Do not use zrok `delete-name` as normal cleanup; that is intentionally destructive and requires `--confirm`.
## 16. Safe persistent OAuth reset and repair

Use the public credential commands for operator cleanup. Keep the normal test identity environment loaded and build first.

For a healthy persisted credential that you intentionally want to revoke and clear:

```bash
nix develop -c npm run build
nix develop -c node dist/index.js remote credentials clear
```

`credentials clear` uses `DeviceTokenManager.clearExplicitly()`: it advances the clear-generation tombstone and attempts refresh-token revocation. If revocation fails, cleanup authority is retained as a durable encrypted obligation and the command fails closed. Restore issuer connectivity and retry normal startup or `credentials clear` so cleanup can be replayed safely.

Use legacy repair only when the CLI reports that the native vault requires explicit repair **and** server-side/operator revocation has already removed any remaining OAuth authority:

```bash
nix develop -c node dist/index.js remote credentials repair --confirm --force
```

The repair command deliberately requires both `--confirm` and `--force`. It repairs/resets structurally unrecoverable legacy vault state; it is not a substitute for normal OAuth revocation.

Do **not** manually delete or edit Keychain, Secret Service, DPAPI, manifest, or chunk state. Developer-only fallback should be limited to debugging an older build that predates the public credential commands; use the same `DeviceTokenManager.clearExplicitly()` / `NativeCredentialStore.repairLegacyCredential()` code paths rather than deleting vault payloads directly.

Deleting `~/.desktop-commander-device/device.json` is a separate action: it resets the non-secret stable device ID. Do that only when intentionally testing a brand-new local device association, after OAuth authority has been cleaned up.
## 17. Expected failure messages and what they mean

| Message / symptom | Meaning / action |
| --- | --- |
| `A pre-provisioned device client ID is required` | `DC_REMOTE_DEVICE_CLIENT_ID` is missing; provision a first-party test client externally. Do not enable generic production DCR. |
| `Device client provisioning requires the control-plane bootstrap boundary` | Expected fail-closed behavior outside test profile. |
| `Public MCP/OAuth identity is not ready` | Run tunnel `doctor`; fix resource metadata or authorization-server discovery before retrying. |
| `Provider key discovery failed` | JWKS endpoint unavailable/non-200; do not bypass verification. |
| `Provider access-token issuer is invalid` | Token `iss` differs from configured issuer; stop and fix identity. |
| `Provider access-token audience is invalid` | Token audience is not exactly the one configured MCP resource. |
| `OAuth token scope set is not exactly the requested device scope` | Provider returned scope drift/expansion; fail closed. |
| `Device credential vault requires explicit repair` | Native vault tombstone/manifest is too corrupt to recover safely. After authoritative server-side/operator revocation, run `remote credentials repair --confirm --force`; do not delete or edit vault chunks manually. |
| `device authorization cleanup failed; retry is required` | Revocation failed; a durable cleanup obligation should be stored. Restore issuer connectivity and retry startup. |
| `Control-plane request failed: remote_error` | Server returned an unknown/untrusted error code; inspect server logs, not attacker-controlled response text. |
| Browser opens on every normal persisted restart | Investigate vault load, token verification, issuer/JWKS reachability, expiration, or client revocation. |
| Browser never opens on a truly fresh persistent session | Check whether a valid vault entry already exists; otherwise pairing/client configuration is likely failing earlier. |

## 18. Corruption and mismatch tests

Do not create real vault corruption by hand for routine acceptance.

The following security cases are owned by `test/test-passkey-device-mvp.js` and should be accepted only when that file is green:

- unsupported/unversioned/mismatched persisted sessions;
- extra or missing device scopes;
- malformed OAuth metadata and verification URLs;
- invalid JWT signature/issuer/audience/expiry/scope;
- corrupt clear-generation recovery;
- clear-vs-pair/refresh races;
- durable loser-cleanup obligations;
- oversized/non-JSON/non-UTF-8/compressed OAuth responses.
## 19. Evidence to retain

For each human run, keep only non-secret evidence:

```text
date/time + tester
branch + HEAD + working-tree note
macOS/Windows/Linux version
browser + version
authenticator type: platform or cross-platform
tunnel provider
issuer hostname and MCP resource hostname/path (no query secrets)
pre-provisioned client ID identifier if policy allows
Nix/build/test gate result
first authorization result
normal restart no-browser result
refresh result
revocation/reauthorization result
remote ping/read-only call result
tunnel doctor result
failures + sanitized error class
```

Screenshots must not contain device codes, OAuth state, tokens, Keychain values, or private credential data.

## 20. Human acceptance checklist

- [ ] Correct branch/HEAD recorded.
- [ ] `nix develop -c just check` passes.
- [ ] `test/test-passkey-device-mvp.js` passes.
- [ ] `nix develop -c just remote-gate` passes.
- [ ] `nix develop -c just test` reports zero failures.
- [ ] External issuer/resource/client prerequisites verified.
- [ ] Tunnel doctor passes with exact resource + issuer.
- [ ] Fresh start requires human passkey ceremony + explicit device approval.
- [ ] Browser origin/path and user code are correct.
- [ ] Device reaches `✅ Device ready` only after approval.
- [ ] Local `device.json` contains only `stableId`.
- [ ] Native OAuth vault exists without exposing secret material.
- [ ] Normal persisted restart opens no browser.
- [ ] Short-TTL refresh succeeds without browser authorization.
- [ ] Revoked refresh authority causes fail-closed reauthorization, not rebinding.
- [ ] `--no-persist-session` requires authorization on every start.
- [ ] ChatGPT/MCP consent remains explicit.
- [ ] Remote ping/read-only call succeeds only through the approved device.
- [ ] Claim-before-side-effect behavior remains intact.
- [ ] Tunnel stop/restart preserves intended stable identity.
- [ ] No logs/screenshots contain tokens, codes, credential material, or vault payloads.
- [ ] Cleanup/reset uses public `remote credentials clear`; explicit legacy repair uses `remote credentials repair --confirm --force` only after authoritative server-side/operator revocation, never manual vault deletion.

## 21. Stop/cleanup after a successful test

1. Stop the device with `Ctrl-C` and wait for clean shutdown.
2. Stop the disposable tunnel share if desired; keep stable identity when the next run should reuse it.
3. Leave the native OAuth credential in place when testing normal restart continuity later.
4. If the test environment must be reset, run `remote credentials clear` from section 16 before deleting the non-secret stable-ID file; use explicit legacy repair only for the documented corrupt-vault case after authoritative revocation.
5. Revoke/delete disposable server-side test accounts, grants, device clients, and resources using the control-plane's authoritative cleanup tooling.
6. Remove the local environment file when the test campaign is complete.

## 22. Out of scope / still gated

A green human run of this branch does **not** by itself prove production readiness. The external control-plane/bootstrap implementation, server-enforced passkey UV/account-model compatibility, durable production datastore decisions, deployment-state gates, release thresholds, and full platform/security matrix remain separate acceptance gates documented by the passkey task pack.

## 23. Live acceptance record — 2026-09-07

This record captures the non-secret results of the first complete passkey/device run on `feat/passkey-only-registration`.

- DesktopCommander HEAD: `19addf3c7fb5af82bb36424ccca3c003030c4832` with the passkey worktree changes under test.
- Public origin / RP: `tests-macbook-air.tail70b8a.ts.net`.
- Passkey enrollment: **PASS** using the one-use development enrollment bridge.
- Passkey authentication: **PASS** with live request options and server verification both requiring user verification.
- Password sign-in during the human flow: **not used**.
- RFC 8414 pathful discovery: **PASS**.
- RFC 9728 protected-resource metadata: **PASS** for the exact MCP resource and API scope profile.
- First-party public device client/resource link: **PASS**, provisioned through Better Auth's authoritative admin API.
- Explicit device approval: **PASS**.
- Device OAuth token issuer/audience/exact scope verification: **PASS** after separating resource API scopes from the authorization-server `offline_access` policy.
- Native credential persistence: **PASS**; two subsequent starts reached `Device ready` without a browser or device-code prompt.
- Jazz device registration: **PASS** (`/api/device/register` returned success).
- Jazz heartbeat: **PASS** with repeated successful heartbeat writes and an independently visible `online` device row.
- Safe durable remote call: **PASS**; `__control.ping` completed through Jazz after claim/completion convergence handling was fixed.
- Targeted Desktop passkey/tunnel/Jazz/supervision gates: **PASS**.
- Control-plane TypeScript and passkey-UV patch checks: **PASS**.
- Initial DesktopCommander runner reported **53/53 PASS**; a follow-up integrity audit found one stale `edit_block` assertion whose direct-run path incorrectly exited 0. See section 24 for the corrected final gate.

The following checklist items were **not** exercised as additional destructive/re-authorization steps in this live campaign and remain covered by automated tests or a future dedicated human run:

- deliberately short-lived access-token refresh;
- explicit server-side refresh revocation followed by browser reauthorization;
- `--no-persist-session` repeated-authorization behavior;
- separate ChatGPT/MCP `mcp:tools` consent/connector authorization;
- destructive tunnel stop/recreate testing.

The live bridge binds a passkey to the existing development operator. It does not close the separate production gate for brand-new email-less account creation.

## 24. Follow-up integrity and integration validation — 2026-09-07

A post-run audit corrected the initial dynamic-suite result and closed two unrelated test/integration defects discovered while validating the passkey branch.

- `test-edit-block-occurrences.js` had stale assertions from before exact-match edits began returning file previews; those assertions now match the current preview contract and still verify disk contents.
- Its direct-run path now sets a nonzero exit status when `runTests()` returns false, preventing a false-green outer suite.
- The empty-`old_string` case now asserts the current fail-fast Zod validation path instead of the superseded result-message contract.
- A new `test-fuzzy-search-core.js` regression covers near-start and near-end approximate matches plus bounded anchorless fallback behavior.
- Large-file fuzzy matching now tries bounded q-gram-anchored candidates before the existing recursive fallback, fixing a real false-negative where whole-half Levenshtein comparisons discarded a strong near-match.
- The worker-thread responsiveness contract remains green: the deliberate large absent-query scan completed with 27 concurrent pings and 1–2 ms maximum observed ping latency in repeated runs.
- `nix develop -c just check`: **PASS**.
- `nix develop -c just remote-gate`: **PASS**; the named recipe ended with `Remote Jazz migration gate passed`.
- `nix develop -c just test`: **54/54 PASS**, zero failures; the new fuzzy regression was discovered and executed by the normal runner.
- `nix develop -c just integration`: **3/3 runnable PASS**, with the Tailscale Funnel and zrok external E2Es explicitly skipped unless `DC_TUNNEL_E2E=1` is set.
- Direct tunnel E2E scripts remain fail-closed when invoked without their explicit opt-in; the safe default integration runner no longer misclassifies that refusal as a product failure.
- `git diff --check`: **PASS** in both the DesktopCommander repository and control-plane workspace.

No external tunnel state, persisted OAuth credential, device binding, or passkey enrollment was altered during this follow-up validation.

## 25. Full device-path human rerun — 2026-09-08

This rerun repeated the deterministic and live passkey/device acceptance path on `feat/passkey-only-registration` at HEAD `19addf3c7fb5af82bb36424ccca3c003030c4832`, preserving the dirty passkey worktree under test.

- Repaired legacy boolean-result test footers were exercised before the live run; a forced temporary `false` result exited nonzero as intended.
- `nix develop -c just check`: **PASS**.
- `test/test-passkey-device-mvp.js`: **PASS**.
- `nix develop -c just remote-gate`: **PASS**.
- `nix develop -c just test`: **54/54 PASS**, zero failures with the repaired harness.
- `nix develop -c just integration`: **3/3 runnable PASS**, two external tunnel E2Es skipped behind their explicit opt-in.
- Control-plane passkey UV check, TypeScript check, and production Next build: **PASS**.
- RFC 8414 / RFC 9728 metadata and exact public issuer/resource identity: **PASS**.
- Unauthenticated dynamic client registration remains blocked: advertised registration endpoint returned **401** to an unauthenticated probe.
- Tailscale `remote tunnel doctor`: **PASS** before and after the live authorization/refresh work.
- Local `device.json`: **PASS**, only `stableId`, mode `0600`.
- Native OAuth vault presence was verified without exposing credential material.
- Normal persisted restart with `DC_DEVICE_NO_BROWSER=1`: **PASS**, reaching `Device ready` without a new device-code flow.
- `--no-persist-session` was run twice: **PASS**. Each start required a fresh human passkey ceremony and explicit device approval, and the normal native vault remained intact afterward.
- Explicit refresh-token revocation was exercised against the persisted session. The client generation-cleared the revoked session and preserved a durable cleanup obligation when Better Auth returned HTTP 400 for an already-revoked refresh token.
- Better Auth 1.7.1 was confirmed to return `400 invalid_request` for both already-revoked and missing refresh tokens after no refresh authority remains. The control plane now normalizes only those two provider results to idempotent revocation success while preserving all other failures.
- The revocation wrapper was live-probed: nonexistent refresh token -> **200**; missing-token malformed request -> **400**. Control-plane typecheck and production build remained green with the route included.
- Existing durable cleanup replay: **PASS**. The obligation count returned to zero and the same running device process progressed to a fresh authorization rather than rebinding or silently continuing.
- Fresh persistent reauthorization after revocation: **PASS** with human passkey + explicit approval; the saved V2 session retained exact issuer/resource binding and exact `device:sync offline_access` scope.
- Post-reauthorization browser-disabled restart: **PASS** with the same device/stable IDs and no device-code flow.
- Short-TTL refresh continuity: **PASS**. The five-minute test access token naturally entered the `<60s` refresh window, `/api/auth/oauth2/token` returned 200, the following heartbeat returned 200, the persisted generation advanced, and no browser ceremony occurred.
- Durable safe ping: **PASS**. The running control plane logged `claim 200`, device ping route 200, and `complete 200`, preserving claim-before-side-effect semantics.
- Repeated authenticated heartbeats remained **200** throughout healthy phases.
- `git diff --check`: **PASS** in both DesktopCommanderMCP and the control-plane workspace.

Not re-exercised in this pass:

- Tailscale stop/restart was intentionally skipped because stopping the active Funnel could sever the same remote-control path used to execute this run; stable identity was instead revalidated repeatedly with `doctor`.
- Separate external ChatGPT/MCP `mcp:tools` consent was not repeated; this rerun focused on the device `device:sync` authorization path.
- No manual vault deletion, Keychain editing, or device stable-ID reset was performed.
- No device codes, OAuth tokens, refresh tokens, passkey challenge material, or vault payloads are recorded in this runbook section.
