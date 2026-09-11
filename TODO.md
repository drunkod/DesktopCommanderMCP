# Passkey / Remote MCP Audit TODO

Source: user research/audit from 2026-09-08 plus live runbook evidence.

## Work-window rule

- One connection/work window executes exactly one numbered step.
- Finish that step completely: implementation, focused tests, named gates, evidence update.
- Do not start the next numbered step in the same window.
- Preserve the dirty worktrees; no reset/rebase/clean.
- Never print OAuth tokens, refresh tokens, passkey challenges, vault payloads, or auth cookies.

## Ordered plan

### 1. [DONE 2026-09-08] Serialize rotating refresh across callers/processes

Problem: two callers can refresh the same generation before CAS decides the winner.

Required implementation:
- add an in-process `refreshInFlight` single-flight;
- add a renewable cross-process refresh/session-mutation lease;
- after acquiring the lease, reload the snapshot and use an already-advanced winner;
- only call the token endpoint when the loaded generation is still current;
- verify/narrow the candidate while holding refresh ownership;
- assert lease ownership before CAS-save;
- if ownership is lost after issuance, revoke or durably queue the candidate.

Acceptance:
- concurrent managers sharing one expiring generation cause exactly one refresh request;
- one successor generation persists;
- waiter converges on winner and never revokes winner authority;
- native cross-process refresh lease blocks a second process until release;
- focused passkey tests + build + remote gate pass.

Evidence from work window 1:
- added `refreshInFlight` single-flight to `DeviceTokenManager`;
- added renewable `runRefreshExclusive()` to memory/native credential stores;
- native refresh lock uses a separate `device-oauth-refresh.lock`;
- refresh reloads the vault after lease acquisition and skips provider refresh when another process already advanced the generation;
- lease ownership is asserted immediately before CAS-save; losing candidates still follow revocation/durable-cleanup semantics;
- `test/test-passkey-refresh-lease.js` proves same-manager single-flight, two-manager one-request convergence, no winner revocation, and real cross-process lease serialization;
- `npm run build`: PASS;
- focused passkey/OAuth/pairing/refresh tests: PASS;
- `just remote-gate`: PASS (`Remote Jazz migration gate passed`);
- full `just test`: **55/55 PASS**, zero failures;
- `git diff --check`: PASS.

### 2. [DONE 2026-09-08] Re-evaluate JWT-narrowed expiry before returning

After persisted-token verification narrows `expiresAt`, loop again when the effective lifetime is already inside `REFRESH_SKEW_MS`. Cover newly authorized/rotated candidates too. Add a `<60s` JWT-exp regression.

Evidence from work window 2:
- persisted sessions whose verified JWT expiry narrows into the `<60s` window are persisted with the narrowed expiry and immediately loop into serialized refresh before use;
- rotated refresh candidates narrowed into the refresh window are saved safely, then refreshed again before being returned;
- newly authorized candidates narrowed into the refresh window are saved once and immediately refreshed through the normal persisted-session path, avoiding a second human authorization ceremony;
- added `test/test-passkey-expiry-window.js` covering persisted, rotated, and newly authorized near-expiry cases;
- `just check`: PASS;
- focused passkey MVP, refresh-lease, and expiry-window tests: PASS;
- `just remote-gate`: PASS (`Remote Jazz migration gate passed`);
- full `just test`: **56/56 PASS**, zero failures;
- `git diff --check`: PASS.

### 3. [DONE 2026-09-08] Terminate forbidden redirect bodies immediately

Replace redirect-body draining with immediate socket/response destruction. Add a 302 server fixture with a continuing oversized body and assert prompt termination.

Evidence from work window 3:
- `rawOAuthHttpTransport()` no longer calls `response.resume()` for 3xx responses;
- forbidden redirects create the protocol error, attach a one-shot response error sink, and immediately `destroy()` the `IncomingMessage`, closing the underlying response/socket instead of draining attacker-controlled bytes;
- `test/test-passkey-oauth-http.js` now serves a 302 whose body continuously streams 8 KiB chunks until the client disconnects;
- the regression asserts redirect rejection, observes the server-side close within 500 ms, and verifies the redirect body cannot continue draining substantially;
- existing chunked, declared-size, compressed, truncated, and exact-boundary OAuth response tests remain green;
- `just check`: PASS;
- focused passkey MVP, OAuth HTTP, refresh-lease, and expiry-window tests: PASS;
- `just remote-gate`: PASS (`Remote Jazz migration gate passed`);
- full `just test`: **56/56 PASS**, zero failures;
- `git diff --check`: PASS.

### 4. [DONE 2026-09-08] Harden and fully test idempotent revocation wrapper

Control-plane tests must cover active token, repeated revoke, nonexistent token, missing/empty/duplicate token, wrong/missing client ID, cross-client token, unsupported type, malformed body, provider/database failure, and failed transaction. Normalize only a trusted no-authority-remains result.

Evidence from work window 4:
- replaced `error_description` string matching with authoritative SQLite state inspection in `lib/oauth-revocation.ts`;
- pinned Better Auth OAuth `storeTokens: "hashed"` explicitly so the SHA-256/base64url lookup representation is auditable;
- compatibility specialization is limited to validated public clients (`tokenEndpointAuthMethod=none`), exact `refresh_token` hints, form `client_id`, and no competing Authorization/client-secret credentials;
- missing, foreign, and already-revoked refresh tokens return indistinguishable RFC 7009 success before Better Auth can touch any refresh family;
- active same-client tokens still delegate revocation to Better Auth; a provider 400 is normalized only when the authoritative post-state proves the token is gone/revoked; provider/database 5xx paths are never normalized;
- strict request validation now rejects missing/empty/duplicate security fields, wrong content type, malformed percent encoding, unreadable request bodies, and oversized forms as `invalid_request`;
- added `scripts/test-oauth-revocation-wrapper.ts` and wired it into `pnpm check`; the matrix covers active/repeated/nonexistent/foreign tokens, wrong/missing client ID, confidential/disabled clients, unsupported token hints, malformed requests, post-state normalization independent of provider text, provider outage, database outage, and failed revocation transaction;
- live non-authority probes: nonexistent public refresh -> 200; missing token -> `400 invalid_request`; unknown client -> provider `invalid_client` failure preserved;
- control-plane `pnpm check`: PASS; production `pnpm build`: PASS with `/api/auth/oauth2/revoke` included;
- Desktop focused passkey/OAuth/refresh/expiry tests: PASS; full `just test`: **56/56 PASS**, zero failures;
- first combined build + `remote-gate` run hit a load-sensitive supervision timing assertion; immediate isolated `just remote-gate` rerun passed all 5 supervision cases and ended with `Remote Jazz migration gate passed`;
- `git diff --check` and untracked-file final-newline/trailing-whitespace checks: PASS in both workspaces.

Revalidation work window 4b (2026-09-08):
- reran control-plane `pnpm check`: PASS, including the complete revocation-wrapper matrix and passkey UV check;
- reran production `pnpm build`: PASS with `/api/auth/oauth2/revoke` present;
- safe live probe using a currently enabled public client: nonexistent refresh -> 200; missing token -> `400 invalid_request`;
- the older `~/.config/desktop-commander/passkey-test.env` client ID is no longer present in the current Better Auth DB, so its live nonexistent-token probe correctly delegates and fails client authentication; this is recorded as environment drift and the config was not silently rewritten;
- Desktop build + focused passkey/OAuth/refresh/expiry regressions: PASS; isolated `just remote-gate`: PASS;
- full `just test`: **56/56 PASS**, zero failures;
- no Step 4 product-code changes were required during revalidation.

### 5. [DONE 2026-09-08] Make the exact tested build reproducible

For both repositories record path, branch, HEAD, `git status --short`, staged patch hash, unstaged patch hash, untracked files, lockfile hash, runtime/package versions, and UTC start/end. Prefer reviewable commits before release acceptance.

Evidence from work window 5:
- added `scripts/capture-tested-build-state.mjs` plus `just tested-build-capture` / `just tested-build-verify`;
- generated `docs/PASSKEY-TESTED-BUILD-MANIFEST.json` at mode `0600`, schema `passkey-tested-build-state/v1`;
- manifest records both absolute repo paths, branch/HEAD state, full `git status --short`, staged/unstaged binary patch SHA-256, hashed untracked files, lockfile/flake hashes, package metadata, Nix-shell Node/package-manager/Git versions, and UTC validation start/end;
- DesktopCommander snapshot: branch `feat/passkey-only-registration`, HEAD `19addf3c7fb5af82bb36424ccca3c003030c4832`;
- control-plane workspace is recorded honestly as branch `main`, `head=null`, `headState=unborn` rather than inventing a commit;
- evidence-file contents (`TODO.md` and the generated manifest) are excluded from the source fingerprint so recording results cannot invalidate the tested build; their Git status entries remain visible;
- capture initially detected real concurrent edits to an unrelated untracked architecture document and correctly failed verification; after the workspace stabilized, two consecutive verifies matched;
- final post-hygiene validation window: `2026-09-08T08:00:57.460Z` through `2026-09-08T08:24:13.646Z`;
- control-plane `pnpm check`: PASS; control-plane `pnpm build`: PASS;
- Desktop `just check`: PASS; `just remote-gate`: PASS; full `just test`: **56/56 PASS**, zero failures;
- final hygiene caught a missing newline in `Justfile`; after that one-byte fix, a new baseline was captured and the Desktop gates were rerun from that exact tree;
- the final pre-test manifest verified unchanged after the complete 316-second Desktop rerun, proving the recorded dirty-tree fingerprint is the tree that was tested;
- final build fingerprint: `3e099eaf1c18e7c8f2b1626ccb9e1aad42fcc0bec6e7a6650b52d9d41342a2b0`;
- no commits were created from the intentionally dirty/unborn worktrees; reviewable commit packaging remains recommended before release acceptance.

### 6. [DONE 2026-09-08] Update runbook terminology and credential reset path

Rename “Full human rerun” to “Full device-path human rerun”. Replace internal inline reset scripts with public `remote credentials clear` / `repair --confirm --force`, retaining developer fallback only where needed.

Evidence from work window 6:
- section 25 is now titled `Full device-path human rerun`, avoiding an over-broad product-readiness claim;
- section 16 now uses the public `remote credentials clear` path for normal persisted OAuth revocation/clear and documents its clear-generation + durable-cleanup semantics;
- explicit corrupt-legacy repair now uses `remote credentials repair --confirm --force` only after authoritative server-side/operator revocation;
- the old inline Node reset heredoc was removed; manual Keychain/Secret Service/DPAPI/manifest/chunk deletion is explicitly prohibited;
- developer-only fallback is limited to older builds and must use the same `DeviceTokenManager.clearExplicitly()` / `NativeCredentialStore.repairLegacyCredential()` code paths;
- failure guidance, the human acceptance checklist, and cleanup instructions now point to the public credential CLI;
- runbook structural audit: PASS (no stale `Full human rerun`, no inline reset heredoc, public clear/repair commands present, balanced fences, final newline, no trailing whitespace);
- `nix develop -c just check`: PASS; `test/test-remote-tunnels.js`: PASS; `nix develop -c just remote-gate`: PASS;
- the first reproducibility verification detected concurrent changes in seven unrelated untracked static-tunnel research/diagram files; those edits were preserved, stabilized across three samples, and the Step 6 gates were rerun against the new exact workspace fingerprint;
- final validation window: `2026-09-08T09:34:33Z` through `2026-09-08T09:40:59.578Z`;
- final tested-build fingerprint: `992da9f42f39e66a696362bcb067e90c280deefc888755fc64d28ea4640f9344`.

### 7. [DONE 2026-09-08] Separate unrelated fuzzy-search work

Keep validation-harness fixes if needed for trustworthy gates, but move fuzzy-search behavioral changes to a separate commit/PR from passkey/OAuth changes.

Evidence from work window 7:
- isolated fuzzy behavior to exactly `src/tools/fuzzySearchCore.ts` plus `test/test-fuzzy-search-core.js`; validation-harness edits remain with the passkey worktree;
- created dedicated branch `fix/fuzzy-search-anchored-candidates` from base HEAD `19addf3c7fb5af82bb36424ccca3c003030c4832`;
- committed only those two fuzzy files as `eea5dea269d458bd27335fbf98d719ffe8f3c8b2` (`fix(fuzzy-search): preserve anchored near matches`);
- isolated branch build: PASS; focused fuzzy regression: PASS; `test/integration/edit-block-performance.js`: PASS, including `python-fuzzy-25` and event-loop responsiveness;
- a clean `npm ci` in the isolated worktree was blocked by an external `@vscode/ripgrep` GitHub HTTP 403; validation was rerun against the main repository's already-installed dependency tree with identical lockfile/package metadata, and no dependency files were committed;
- removed the fuzzy source diff and fuzzy-only regression file from `feat/passkey-only-registration` after the dedicated commit was safely created;
- pre-existing passkey staged index remained byte-for-byte unchanged: 46 staged paths, SHA-256 `d4f3d4e6d149d5ec9cf6bc4cf6a4ab087479e063e00b6c77fcbe61df68116314` before and after separation;
- passkey tree after separation: `just check` PASS; `just remote-gate` PASS; full `just test`: **55/55 PASS**, zero failures;
- final validation window: `2026-09-08T10:42:52.795Z` through `2026-09-08T10:51:00.493Z`;
- final passkey-tree tested-build fingerprint: `7f507e1ca61ce6eb42a3347f0569f84f5e8f348deecb6892dfb5b9eb03e51128`.

### 8. [TODO] Prove brand-new passkey-only customer registration

Clean browser/profile, no existing session, no email/password/social fallback. Create exactly one account/passkey, sign out, sign back in with passkey, then exercise negative/replay/UV-denied cases.

### 9. [TODO] Define and prove external MCP client onboarding

Choose exactly one supported mechanism for ChatGPT/external MCP clients: CIMD, pre-provisioned client, or explicitly authorized DCR. Do not reuse the desktop `device:sync` client identity.

### 10. [TODO] Prove real external `mcp:tools` end-to-end usage

External client discovery → passkey sign-in → explicit `mcp:tools` consent → `/mcp` bearer access → durable dispatch → approved device claim → harmless local read → completion returned. Then test controlled write, account isolation, and MCP-consent revocation independence.

### 11. [TODO] Complete remaining live platform/lifecycle matrix

Run stable-identity tunnel stop/restart from an out-of-band control path, plus Windows/Linux native-vault live tests. Never intentionally sever the only active remote-control path.

## Release boundary

Current proven boundary: macOS/Tailscale passkey + `device:sync` device authorization lifecycle is live-proven.

Release acceptance remains blocked until Steps 1–10 are complete; Step 11 is required for the full platform/lifecycle claim.
