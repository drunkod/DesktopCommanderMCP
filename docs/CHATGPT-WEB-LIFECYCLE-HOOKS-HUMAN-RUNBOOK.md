# ChatGPT Web lifecycle hooks — human acceptance runbook

Status: practical manual acceptance test for `feat/jazz-remote-device` at/after lifecycle commit `4d79166`.

This runbook proves the lifecycle hooks from a real **ChatGPT Web -> remote MCP -> Jazz device -> local Desktop Commander MCP** path.

It is written for a human tester. Follow the numbered steps in order and record PASS/FAIL before moving on.

## What this runbook proves

- a real ChatGPT Web tool call starts a durable work window;
- later tool calls update `lastTool`, path, request ID, and completed-operation count;
- checkpoint/warning/critical/expired budget markers reach the next tool result;
- each budget marker is one-shot;
- state survives a Desktop Commander child/device restart;
- budget expiry persists an interruption without killing unrelated child processes.

## Important current limitation

The current remote-device bridge calls the local MCP child with `client.callTool(...)` but does **not** forward a remote `AbortSignal`.
Therefore pressing **Stop** in ChatGPT Web is an exploratory test only: it is not yet a reliable end-to-end proof of `mcp_cancelled` in the local lifecycle manager.
The core cancellation behavior is covered by `test/test-work-lifecycle.js`; remote cancellation propagation is a later integration task.
## ChatGPT Web requirements as of 2026-09-02

For the full Desktop Commander read/write/process path, use ChatGPT **Business, Enterprise, or Edu** with developer mode/custom MCP apps enabled.
ChatGPT Pro can currently connect custom MCPs for read/fetch use, but full write/modify MCP support is not available there.
Custom MCP apps are tested in **ChatGPT Web**.

Current OpenAI setup flow:

1. Enable developer mode for the workspace/account.
2. Open **Settings / Workspace settings -> Apps -> Create**.
3. Provide the MCP endpoint and authentication settings.
4. Click **Scan Tools** and complete OAuth if requested.
5. Click **Create**.
6. Start a new chat and select the draft app from the tools menu, or mention the app in the prompt.

Important: app selection applies to the message that uses it. Re-select or mention the app on a later message when you need another tool call.
Write/modify operations can require an explicit confirmation in ChatGPT.

Reference: OpenAI Help Center, “Developer mode and MCP apps in ChatGPT”.
https://help.openai.com/en/articles/12584461

## Network rule: localhost is not enough

ChatGPT Web cannot connect directly to `http://127.0.0.1:3000/mcp`.
Use either a deployed HTTPS control-plane MCP endpoint or OpenAI Secure MCP Tunnel for a private/local MCP endpoint.
## Test topology

Use this mental model while debugging:

```text
ChatGPT Web
  -> custom MCP app
  -> control plane /mcp
  -> Jazz remote-call delivery
  -> desktop-commander remote process
  -> local Desktop Commander MCP child
  -> CallToolRequestSchema lifecycle wrapper
  -> real tool handler
  -> result + optional DCMCP_WORK_BUDGET marker
```

The lifecycle state is written by the **local Desktop Commander MCP child**, not by ChatGPT and not by the control plane.
The durable file is:

```text
~/.claude-server-commander/work-state/current.json
```

## Before you start

Open four Terminal tabs and one ChatGPT Web browser window.
Use the existing Jazz/control-plane manual runbook first if the remote device has never been paired.

Repository locations used below:

```text
Control plane: ~/Documents/RemoteMCP-Jazz/implementation
Device repo:   ~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
```
## Step 0 — prove ChatGPT is routed to the candidate build

Before testing lifecycle state, make sure the ChatGPT app is not silently using an older globally installed Desktop Commander remote stack. Multiple remote-device processes can coexist and make `current.json` look stale even when ChatGPT tool calls succeed.

On the Mac run:

```bash
ps -axo pid,ppid,lstart,command | \
  egrep 'desktop-commander.*remote|DesktopCommanderMCP/dist/index.js|dist/index.js remote' | \
  grep -v egrep
```

For this repository test, the candidate chain must include the repository paths:

```text
.../RemoteMCP-Jazz/repositories/DesktopCommanderMCP/dist/index.js remote ...
  -> .../RemoteMCP-Jazz/repositories/DesktopCommanderMCP/dist/index.js
```

If an older `@wonderwhy-er/desktop-commander@latest remote` stack is also running, do not assume ChatGPT selected the candidate. Route the ChatGPT development app to the candidate/control-plane device explicitly, or stop the old stack only if it is safe to do so.

**PASS:** one harmless ChatGPT Desktop Commander call updates the candidate lifecycle file timestamp and `lastTool`.

**FAIL:** ChatGPT calls succeed but `~/.claude-server-commander/work-state/current.json` does not change. Treat this first as a routing mismatch, not as a lifecycle implementation failure.

## Step 1 — start Jazz and the control plane when testing localhost

Skip this step if you already use a deployed staging/production control plane.

In **Terminal A**:

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
nix develop
just jazz
```

In **Terminal B**:

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
nix develop
just web
```

Open `http://127.0.0.1:3000/dashboard/devices` and sign in.

**PASS:** Jazz stays running, the dashboard loads, and your test device can appear online.

If this is a localhost-only setup, configure Secure MCP Tunnel so ChatGPT Web can reach the local `/mcp` endpoint.
Do not enter `http://127.0.0.1:3000/mcp` directly into ChatGPT and expect it to work.
## Step 2 — build the exact lifecycle candidate

In **Terminal C**:

```bash
cd ~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
nix develop
npm run build
node test/test-work-lifecycle.js
```

Expected final focused-test line:

```text
work lifecycle tests passed
```

**PASS:** build and focused lifecycle test both exit zero.

For a release acceptance run, also run:

```bash
npm test
```

Current reviewed baseline: 49/49 project tests passed.

Do not continue with a Web acceptance run against an unbuilt source tree.
## Step 3 — use accelerated lifecycle timings for manual testing

The production defaults are 20/23/24/25 minutes. Do not wait that long for every manual test.
Before starting the remote device, set this accelerated profile in **Terminal C**:

```bash
export DC_WORK_CHECKPOINT_MINUTES=0.50
export DC_WORK_WARNING_MINUTES=0.75
export DC_WORK_CRITICAL_MINUTES=1.00
export DC_WORK_BUDGET_MINUTES=1.25
```

This means:

```text
checkpoint = 30 seconds
warning    = 45 seconds
critical   = 60 seconds
expired    = 75 seconds
```

The remote device spawns the local Desktop Commander MCP child from the same environment, so these variables reach the lifecycle manager.

The lifecycle background timer polls every 5 seconds by default. Keep manual thresholds comfortably above that interval and preferably aligned to 5-second boundaries. The 30/45/60/75-second profile above is intentionally aligned. A synthetic budget shorter than the poll interval may not be observed until the next poll; that is expected timer resolution, not a missed expiry.

**PASS:** after restart, the local child is running with this environment and no lifecycle error is printed.

Do not change these variables while the same local child is still running; restart the remote device after changing them.
## Step 4 — start from a clean lifecycle state

Before the Web test, preserve any previous state instead of deleting it.
In **Terminal D**:

```bash
STATE_DIR="$HOME/.claude-server-commander/work-state"
mkdir -p "$STATE_DIR"
if [ -f "$STATE_DIR/current.json" ]; then
  mv "$STATE_DIR/current.json" \
    "$STATE_DIR/current.json.before-web-test-$(date +%Y%m%d-%H%M%S)"
fi
```

Confirm the active state file is now absent:

```bash
test ! -f "$STATE_DIR/current.json" && echo "CLEAN STATE: PASS"
```

Expected:

```text
CLEAN STATE: PASS
```

This prevents an old `running` or `interrupted` work window from confusing the manual timing test.
## Step 5 — start the real remote device with the accelerated profile

Back in **Terminal C**, load the control-plane environment without printing it:

```bash
set -a
source ~/Documents/RemoteMCP-Jazz/implementation/apps/control-plane/.env.local
set +a
export MCP_SERVER_URL="$APP_ORIGIN"
```

Do not paste `.env.local` contents into chat, screenshots, test notes, or commits.

Start the device:

```bash
node dist/index.js remote --debug --disable-no-sleep
```

On the first run, complete the browser device authorization flow. On later runs, Keychain persistence should normally avoid a new approval.

**PASS:** Terminal C reaches `Device ready`, shows the same paired device identity, and remains running.

Refresh the device dashboard.

**PASS:** the device becomes **online** and Ping succeeds.
## Step 6 — connect the MCP app in ChatGPT Web

Use the same authenticated control plane that owns the paired device.

For a deployed environment, use the HTTPS MCP route:

```text
https://<your-control-plane-host>/mcp
```

For localhost, use Secure MCP Tunnel and target the local route:

```text
http://127.0.0.1:3000/mcp
```

In ChatGPT Web:

1. Enable developer mode if it is not already enabled.
2. Open **Apps -> Create** from the appropriate user/workspace settings.
3. Configure the MCP connection and authentication.
4. Click **Scan Tools**.
5. Complete OAuth if ChatGPT opens an authorization flow.
6. Click **Create** and keep the app as a development/draft app for this acceptance test.

**PASS:** the app appears in ChatGPT with a `Dev`/development indication and its Desktop Commander remote tools are visible.

The lifecycle patch adds no new MCP tool schemas, so an already-configured app normally does not need a tool refresh solely for these hooks.
## Step 7 — monitor lifecycle state while ChatGPT works

In **Terminal D** run:

```bash
STATE="$HOME/.claude-server-commander/work-state/current.json"
while true; do
  clear
  date
  if [ -f "$STATE" ]; then
    jq '{id,status,startedAt,lastActivityAt,deadlineAt,lastTool,lastFile,lastPath,lastRequestId,completedOperations,noticesSent,pendingNoticeLevel,interruptionReason,interruptionDetail}' "$STATE"
  else
    echo "waiting for first lifecycle state..."
  fi
  sleep 2
done
```

Keep this monitor running for the rest of the test.

Before the first real local Desktop Commander call you should see:

```text
waiting for first lifecycle state...
```

The first state should appear only after a non-UI tool reaches the local MCP child.
## Step 8 — first ChatGPT Web call: prove lifecycle start

Open a **new normal ChatGPT chat**. Do not use agent mode for this test.
Select the Desktop Commander development app for the message.

Send:

```text
Use the Desktop Commander app. List my devices, choose the online MacBook,
then call get_config on that device. Do not change any configuration.
If the tool result contains a marker beginning [DCMCP_WORK_BUDGET,
copy that marker verbatim in your final answer.
```

**PASS in ChatGPT:** `get_config` succeeds.

**PASS in Terminal C:** you see the remote call claimed, the local `get_config` dispatch, and completion persisted.

**PASS in Terminal D:** `current.json` now shows approximately:

```text
status: running
lastTool: get_config
completedOperations: 1
lastRequestId: <non-empty when supplied by MCP SDK>
noticesSent: []
```

Record the `id`. That is the work-window ID used for the restart-recovery check.
## Step 9 — prove restart rehydration

Do this immediately, before the 75-second accelerated budget expires.
In Terminal D capture the work ID:

```bash
jq -r .id "$HOME/.claude-server-commander/work-state/current.json"
```

In **Terminal C**, stop the remote device with **Ctrl-C**, then restart it with the same environment:

```bash
node dist/index.js remote --debug --disable-no-sleep
```

The device should return online without a new pairing if Keychain persistence is healthy.

In ChatGPT Web, select/mention the app again and send:

```text
Use Desktop Commander to call get_config on the same online device.
Do not modify anything.
```

**PASS:** the lifecycle `id` remains the same and `completedOperations` increases.

A new ID is expected only if the prior work window was already completed/interrupted/expired.
## Step 10 — reset for a deterministic warning sequence

The restart test consumes unpredictable seconds, so start the timing sequence from a fresh state.
Stop the remote device with **Ctrl-C**.

In Terminal D:

```bash
STATE_DIR="$HOME/.claude-server-commander/work-state"
if [ -f "$STATE_DIR/current.json" ]; then
  mv "$STATE_DIR/current.json" \
    "$STATE_DIR/current.json.before-warning-test-$(date +%Y%m%d-%H%M%S)"
fi
```

Restart the remote device in Terminal C with the same accelerated variables still exported:

```bash
node dist/index.js remote --debug --disable-no-sleep
```

Wait until the device is online again.

Do not send any Desktop Commander tool call from ChatGPT yet.
The warning clock starts on the first local non-UI tool call, not when the device process starts.
## Step 11 — establish T0 and prove path capture

In ChatGPT Web, select/mention the app and send:

```text
Use Desktop Commander to read only the first 10 lines of:
/Users/test/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP/README.md
Do not modify the file. If the tool result contains a marker beginning
[DCMCP_WORK_BUDGET, copy that marker verbatim in your final answer.
```

The moment the local `read_file` call starts is **T0** for this warning sequence.

**PASS in Terminal D:** the new state shows:

```text
status: running
lastTool: read_file
lastFile: /Users/test/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP/README.md
lastPath: /Users/test/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP/README.md
completedOperations: 1
```

There should be no budget marker yet because less than 30 seconds has elapsed.
## Step 12 — checkpoint marker at 30 seconds

Wait until about **35 seconds after T0**, but before 45 seconds.
Then select/mention the app and send:

```text
Use Desktop Commander to call get_config on the same device.
Do not modify anything. If the tool result contains a marker beginning
[DCMCP_WORK_BUDGET, copy that marker verbatim in your final answer.
```

Expected marker:

```text
[DCMCP_WORK_BUDGET checkpoint] action=save_progress_and_record_next_step
```

**PASS in Terminal D:** `noticesSent` contains `checkpoint` and `pendingNoticeLevel` is absent after the result is consumed.

Immediately repeat the same harmless tool call once.

**PASS:** the checkpoint marker is **not** returned a second time.

If you wait past 45 seconds before consuming checkpoint, the higher pending notice may replace it; restart Step 10 if you need to prove every level individually.
## Step 13 — warning marker at 45 seconds

Wait until about **50 seconds after T0**, but before 60 seconds.
Send another harmless `get_config` call with the same instruction to copy any budget marker verbatim.

Expected marker:

```text
[DCMCP_WORK_BUDGET warning] action=avoid_starting_large_new_operation
```

**PASS:** ChatGPT/tool details show the warning marker once.

**PASS in Terminal D:** `noticesSent` now contains both:

```text
checkpoint
warning
```

Immediately repeat `get_config` once.

**PASS:** the warning marker is not duplicated.

Interpretation: the model has now been told not to start a large new operation in this work window.
## Step 14 — critical marker at 60 seconds

Wait until about **65 seconds after T0**, but before 75 seconds.
Send another harmless `get_config` call and ask ChatGPT to copy any budget marker verbatim.

Expected marker:

```text
[DCMCP_WORK_BUDGET critical] action=checkpoint_now_and_finish_current_atomic_operation
```

**PASS:** the marker appears once.

**PASS in Terminal D:** `noticesSent` contains:

```text
checkpoint
warning
critical
```

Immediately repeat a harmless tool call once.

**PASS:** `critical` is not duplicated.

Interpretation: at this point a model should checkpoint immediately and avoid beginning another large operation.
## Step 15 — expired marker at 75 seconds

Now **do not call another tool immediately**. Wait until at least **80 seconds after T0**.
Watch Terminal D first.

Before any new ChatGPT tool call, the persisted state should become:

```text
status: interrupted
interruptionReason: budget_expired
interruptionDetail: Configured defensive work budget reached
pendingNoticeLevel: expired
```

**PASS:** the lifecycle marks the work window interrupted without terminating the remote device or unrelated child processes.

Then send one harmless `get_config` call from ChatGPT Web.
Expected marker:

```text
[DCMCP_WORK_BUDGET expired] action=checkpoint_now_and_resume_in_a_new_work_window
```

After this call, a **new** work-window ID is expected because the previous window was interrupted by budget expiry.

State writes are serialized and asynchronous for ordinary tool completion. When verifying the new ID from `current.json` immediately after the tool result, allow a short settle (about 100-250 ms) or simply wait for the 2-second Terminal D monitor refresh before comparing IDs.

**PASS:** the expired notice is delivered once and the next tool call begins a fresh `running` work window.
## Step 16 — repeat once with real production timings

After the accelerated sequence passes, stop the remote device and remove the test overrides:

```bash
unset DC_WORK_CHECKPOINT_MINUTES
unset DC_WORK_WARNING_MINUTES
unset DC_WORK_CRITICAL_MINUTES
unset DC_WORK_BUDGET_MINUTES
```

Back up `current.json` again, then restart the remote device.
The production defaults are:

```text
checkpoint = 20 minutes
warning    = 23 minutes
critical   = 24 minutes
expired    = 25 minutes
```

Run one real ChatGPT work session and keep making ordinary Desktop Commander calls through the same app.
Consume each marker before the next threshold.

**PASS:** the same one-shot sequence appears at real timings and the 25-minute expiry does not kill unrelated child processes.

This long soak is the release-confidence test; the accelerated run is the fast developer acceptance test.
## Step 17 — exploratory ChatGPT Stop/cancellation check

This is **not** a release pass/fail gate yet.
The local lifecycle wrapper understands MCP `AbortSignal`, but the current Jazz remote-device bridge does not forward a remote cancellation signal into `DesktopCommanderIntegration.callClientTool()`.

Exploratory procedure:

1. Start a fresh work window.
2. Ask ChatGPT to start a deliberately long but harmless operation, for example a `start_process` call that sleeps.
3. While the tool is still running, press **Stop** in ChatGPT Web.
4. Watch Terminal C and `current.json`.

Possible current result: ChatGPT stops its response while the local tool keeps running or completes normally.
Do **not** call that a lifecycle-manager failure.

The desired future end-to-end result is:

```text
status: interrupted
interruptionReason: mcp_cancelled
```

Until cancellation is propagated through the remote call transport, verify the core cancellation path with:

```bash
nix develop -c node test/test-work-lifecycle.js
```
## Troubleshooting map

- **No `current.json` after ChatGPT call:** the request likely never reached the local Desktop Commander MCP child. Check device online status, Terminal C, and whether ChatGPT actually selected the custom app.
- **ChatGPT can see the app but cannot reach localhost:** use a deployed remote endpoint or Secure MCP Tunnel; localhost is not directly reachable from ChatGPT Web.
- **`lastTool` is not the tool you expected:** inspect the actual remote call sequence. Control-plane tools such as `list_devices` do not become local lifecycle calls until `call_device_tool` reaches the device.
- **Checkpoint did not appear:** you may have consumed it too late and a higher pending notice replaced it. Reset at Step 10 and hit each timing window promptly.
- **Marker exists in tool output but ChatGPT does not quote it:** open the tool-call details if available and verify the raw result; the prompt explicitly asks ChatGPT to repeat the marker only to make human verification easier.
- **Marker repeats:** fail the one-shot notice test and inspect `noticesSent` / `pendingNoticeLevel` persistence.
- **New work ID after restart:** first check whether the previous state expired or was interrupted. If it was still `running`, rehydration failed.
- **`budget_expired` kills a process:** fail the test. Expiry must persist lifecycle interruption only; it must not terminate unrelated terminal child processes.
- **ChatGPT Stop does not set `mcp_cancelled`:** currently expected as a remote cancellation propagation gap; do not confuse this with failure of the local manager.
- **Device asks to pair again after ordinary restart:** this is a separate OAuth/Keychain persistence failure; use the MacBook MVP runbook.

## Security notes

Never paste `.env.local`, OAuth refresh tokens, Jazz capability tokens, Keychain contents, or full credential-store output into ChatGPT.
Use harmless read-only calls (`get_config`, small `read_file`) for lifecycle timing tests whenever possible.
Only test write/process tools when the workspace permissions and target path are intentionally chosen.
## Human result sheet

Copy this into your test notes and mark every line:

```text
[ ] Build passes inside nix develop
[ ] Focused lifecycle regression test passes
[ ] Remote device is paired and online
[ ] ChatGPT Web custom MCP app connects successfully
[ ] First get_config creates current.json
[ ] Work state is running with lastTool=get_config
[ ] Restart keeps the same running work-window ID
[ ] read_file captures lastFile/lastPath correctly
[ ] 30s checkpoint marker appears once
[ ] 45s warning marker appears once
[ ] 60s critical marker appears once
[ ] 75s state persists budget_expired interruption
[ ] Expired marker appears once on the next tool result
[ ] Next tool starts a new running work-window ID
[ ] Budget expiry does not kill unrelated child processes
[ ] Production 20/23/24/25-minute soak passes
[ ] ChatGPT Stop test recorded as exploratory, not a false gate
```

## Acceptance decision

**GO for lifecycle MVP:** all mandatory boxes above pass except the explicitly exploratory Web cancellation item.

**NO-GO:** durable state is missing/corrupt, warnings repeat, threshold ordering is wrong, restart loses a still-running work ID, or budget expiry terminates unrelated processes.
