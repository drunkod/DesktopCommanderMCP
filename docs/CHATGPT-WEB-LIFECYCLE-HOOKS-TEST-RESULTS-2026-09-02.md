# ChatGPT Web lifecycle hooks — acceptance test results

Date: 2026-09-02
Branch: `feat/jazz-remote-device`
Candidate commit: `4d79166418bcd8782383a060bbfd981e61f158ec`
Runbook: `docs/CHATGPT-WEB-LIFECYCLE-HOOKS-HUMAN-RUNBOOK.md`

## Current decision

**Lifecycle implementation:** PASS for the accelerated real-server acceptance checks completed below.

**Full ChatGPT Web routing acceptance:** PENDING. This ChatGPT session is currently routed through an older globally installed Desktop Commander remote stack, not the repository candidate. Do not interpret the candidate `current.json` staying unchanged during those Web calls as a lifecycle failure.

## Environment preflight

PASS:

- Jazz authority listening on `127.0.0.1:1625`.
- Local control plane listening on `127.0.0.1:3000`.
- Touchpoint MCP proxy listening on `127.0.0.1:8081/mcp`.
- Touchpoint diagnostics report macOS AX, input, and Helium CDP initialized.
- Touchpoint sees the ChatGPT project page and localhost device dashboard.
- `nix develop` is available and used for build/test execution.
## Code and lifecycle checks

PASS:

- `npm run build` under `nix develop`.
- `node test/test-work-lifecycle.js` under `nix develop`.
- First real SDK `get_config` call creates a `running` window with `completedOperations: 1`.
- Checkpoint marker appears once at ~32.15 s.
- Warning marker appears once at ~47.15 s.
- Critical marker appears once at ~62.15 s.
- At ~77.0 s, before another tool call, state is `interrupted` with `interruptionReason: budget_expired` and pending `expired` notice.
- The next tool result carries the expired marker and starts a fresh work-window ID.
- Restart rehydration preserves a still-running work ID; operation count advanced from 1 to 2 after server restart.

Observed marker order:

```text
checkpoint -> warning -> critical -> expired
```

The accelerated profile used 30/45/60/75 seconds, matching the human runbook.
## Process-survival invariant

PASS:

- A real `start_process` call launched `sleep 20` and returned PID `4396`.
- The lifecycle subsequently persisted `status: interrupted` with `interruptionReason: budget_expired`.
- After expiry, `list_sessions` still reported `PID: 4396, Blocked: true, Runtime: 11s`.
- The same `list_sessions` result carried `[DCMCP_WORK_BUDGET expired]`.

Therefore budget expiry does not terminate the running terminal child.

Test-harness note: an initial 6-second synthetic budget was inspected after only 7 seconds and was still `running`. The background lifecycle poll interval is 5 seconds, so that budget is observed on the next poll near 10 seconds. This is expected timer resolution. The runbook's 30/45/60/75-second profile is aligned to the 5-second poll interval.

Another test-harness note: reading `current.json` immediately after an ordinary successful tool result can race the queued persistence write. Allow roughly 100-250 ms, or wait for the runbook's 2-second monitor refresh, before comparing the newly persisted work ID.

## Candidate remote device

PASS:

- Repository candidate restarted from the built tree with accelerated lifecycle environment.
- Stored authorization was reused; no new browser pairing was required.
- Candidate registered and reached `Device ready`.
## Web/Touchpoint finding

PENDING / routing issue:

- Two remote-device stacks were running at the same time.
- This ChatGPT session's Remote Desktop Commander calls are being handled by the older global `@wonderwhy-er/desktop-commander@latest remote` stack.
- The repository candidate is a separate device process, so those Web calls do not advance the candidate lifecycle file.
- The runbook now includes Step 0 to prove routing before trusting lifecycle state.

Touchpoint debugging result:

- Touchpoint MCP transport is healthy and can enumerate the ChatGPT and localhost dashboard pages through Helium CDP.
- AX/CDP page snapshots for those background Helium tabs did not expose useful matching page nodes during this run, so Touchpoint could verify page presence but did not safely switch the ChatGPT app/device route.

## Remaining acceptance work

1. Route a ChatGPT development MCP app to the repository candidate device/control plane.
2. Repeat Steps 8-15 from ChatGPT Web and confirm candidate `current.json` changes on each call.
3. Run the production 20/23/24/25-minute soak once.
4. Keep ChatGPT Web Stop/cancellation exploratory until the Jazz remote bridge propagates cancellation to the local MCP call.

Do not mark the full Web runbook GO until item 1 is resolved and the candidate state file demonstrably changes from a ChatGPT Web tool call.
