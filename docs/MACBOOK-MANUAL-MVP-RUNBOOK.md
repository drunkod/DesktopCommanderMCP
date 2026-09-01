# MacBook manual MVP runbook

Status: human acceptance test for the Jazz remote-device MVP.

Use this runbook on the MacBook that will run Desktop Commander. It is intentionally manual: you run the commands, approve the OAuth device request in Safari/Chrome, and verify each visible result before moving on.

## Pass definition

The localhost MVP passes only when all of these are true:

- control plane responds on `http://127.0.0.1:3000`;
- Jazz authority is reachable on `127.0.0.1:1625`;
- the real `desktop-commander remote` CLI pairs through RFC 8628;
- the dashboard shows the device `online`;
- dashboard Ping succeeds;
- a real Desktop Commander tool can be called through the MCP surface;
- restarting the device does not require a new browser approval;
- dashboard Reconnect succeeds and the device comes back online;
- dashboard Revoke prevents the device from resuming operation.

Do not merge/release based only on unit tests if this manual sequence has not passed.

## Before you start

Open **four Terminal tabs/windows** and one browser window.

Repository locations used below:

```text
Control plane: ~/Documents/RemoteMCP-Jazz/implementation
Device repo:   ~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
```
## Step 1 — start Jazz authority

In **Terminal A**:

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
nix develop
just jazz
```

Leave this terminal running.

**PASS:** the Jazz authority starts without a fatal error and stays running.

**FAIL:** the process exits, loops on an error, or port `1625` cannot be opened.

Optional check from another terminal:

```bash
nc -zv 127.0.0.1 1625
```

Expected: connection succeeds.

## Step 2 — start the localhost control plane

In **Terminal B**:

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
nix develop
just web
```
Leave Terminal B running.

In the browser open:

```text
http://127.0.0.1:3000
```

Sign in with the localhost account you want to use for the device test.

Then open:

```text
http://127.0.0.1:3000/dashboard/devices
```

**PASS:** the dashboard loads and shows `Your devices` (an empty list is fine before pairing).

**FAIL:** sign-in loops, the dashboard cannot connect to Jazz, or the page shows a server error.

## Step 3 — build the exact device candidate

In **Terminal C**:

```bash
cd ~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
nix develop
just check
```

**PASS:** the TypeScript/package build completes successfully.

Do not use host Node/npm outside the Nix shell for this acceptance run.
## Step 4 — start the real remote device

Still in **Terminal C**, load the localhost control-plane environment without printing it:

```bash
set -a
source ~/Documents/RemoteMCP-Jazz/implementation/apps/control-plane/.env.local
set +a
export MCP_SERVER_URL="$APP_ORIGIN"
```

Do **not** paste `.env.local` into chat, logs, screenshots, or commits.

Now start the real device:

```bash
node dist/index.js remote --debug --disable-no-sleep
```

You should see the local Desktop Commander child connect, followed by OAuth device authorization text similar to:

```text
Starting MCP Device (Jazz transport)...
Connected to Desktop Commander MCP
Authorizing with Remote MCP http://127.0.0.1:3000
Open http://127.0.0.1:3000/device
Enter code XXXXXXXX
```

Keep Terminal C running while you approve the code.
## Step 5 — approve the device in the browser

If the browser did not open automatically, open:

```text
http://127.0.0.1:3000/device
```

Enter the exact code printed in Terminal C. Continue to the approval page and click **Approve**.

Do this promptly; the device code expires.

**PASS:** Terminal C continues past authorization and prints the registered device information, including an authoritative Device ID / stable identity, without exiting.

**FAIL:** `authorization_pending` is normal while you have not approved. `Device authorization expired`, `Device token exchange failed`, or process exit after approval is a failure.

## Step 6 — verify the device is online

Refresh:

```text
http://127.0.0.1:3000/dashboard/devices
```

Find the device you just paired.

**PASS:** status becomes **online** and the Last authority heartbeat keeps moving forward.

Wait up to one heartbeat interval if the card has just appeared. If it remains offline, inspect Terminal C and Terminal B before continuing.
## Step 7 — test Ping through the durable remote-call path

On the device card click **Ping**.

**PASS:** the dashboard reports `ping accepted`, Terminal C stays healthy, and the device remains online.

This validates the control-plane -> Jazz pending call -> device claim -> completion path without invoking a local filesystem/process tool.

## Step 8 — test one real Desktop Commander tool

The current dashboard has no arbitrary-tool button. The real tool surface is the authenticated MCP endpoint at `/api/mcp`.

If you already have an MCP client connected to the localhost/exposed control plane, call:

```text
list_devices
call_device_tool
  deviceId: <the paired device id>
  toolName: get_config
  toolArgs: {}
```

**PASS:** `get_config` returns the local Desktop Commander configuration and Terminal C logs the local MCP tool dispatch.

If no MCP client/tunnel is configured yet, mark this step **PENDING — MCP client required** rather than pretending the dashboard covers it. Ping still proves the durable remote transport; `get_config` must be repeated before the first external MVP user is invited.

## Step 9 — verify macOS Keychain persistence

In **Terminal D**, check only that the Keychain item exists; do not print its secret:
```bash
security find-generic-password \
  -a device-oauth-session \
  -s com.desktopcommander.remote-mcp \
  >/dev/null && echo "KEYCHAIN ITEM: PASS"
```

Expected:

```text
KEYCHAIN ITEM: PASS
```

Now return to Terminal C and stop the device with **Ctrl-C**. Wait for graceful shutdown to finish.

Start it again with the same environment already loaded:

```bash
node dist/index.js remote --debug --disable-no-sleep
```

**PASS:** the device returns online **without** displaying a new verification URL/user code and without requiring another browser approval.

**FAIL:** it asks you to pair again, cannot read/refresh the Keychain session, or exits during refresh/registration.

Refresh the dashboard and confirm the same device identity returns online.
## Step 10 — test Reconnect

On the online device card click **Reconnect** once.

Watch Terminal C.

**PASS:** the reconnect request returns successfully, the device briefly rebuilds connectivity if needed, then returns/stays online. The dashboard must not report success only after the device process has died.

After reconnect, click **Ping** again.

**PASS:** Ping still succeeds after reconnect.

## Step 11 — test revocation last

Revocation intentionally makes this paired credential unusable, so do it after the other tests.

On the device card click **Revoke**, then confirm the browser dialog.

**PASS:** the card becomes **revoked** and Ping/Reconnect are no longer usable.

Watch Terminal C for the next heartbeat/auth attempt.

**PASS:** the revoked device cannot continue normal heartbeat/call operation with its old OAuth/Jazz credentials.

Stop Terminal C with **Ctrl-C** after you have observed revocation behavior.

Do not immediately re-pair unless you want to create a new test device/client.
## Optional — verify `--no-persist-session`

Use this only after the main persisted-session test passes.

Run:

```bash
node dist/index.js remote --debug --disable-no-sleep --no-persist-session
```

Approve the new pairing. Stop the process, then start the same command again.

**PASS:** it asks for a new pairing again because the session was memory-only.

## Troubleshooting quick map

- Browser never opens: open `http://127.0.0.1:3000/device` manually and enter the terminal code.
- `Device authorization expired`: restart the device command and approve the new code promptly.
- Dashboard says offline: check Terminal C first, then verify Terminal A/B are still running.
- Dashboard says `Connecting to Jazz…`: verify `127.0.0.1:1625` and the control-plane Jazz environment.
- Device asks to pair after a normal restart: treat as a Keychain/refresh failure; do not merge.
- Ping fails while the card is online: treat as a remote-call-path failure; do not merge.
- Reconnect kills the process before the result is accepted: treat as a commit-before-teardown failure; do not merge.
- Revoked device becomes operational again without a fresh pairing: security failure; do not merge.

When recording a failure, save the command used, the visible error, and which numbered step failed. Never paste OAuth/Jazz secrets or `.env.local` contents.
## Human result sheet

Copy this section into your test notes and mark each line.

```text
[ ] Jazz authority starts and stays running
[ ] Control plane loads and dashboard signs in
[ ] Device candidate builds inside nix develop
[ ] Real remote CLI reaches RFC 8628 approval
[ ] Browser approval completes successfully
[ ] Device appears online with fresh heartbeat
[ ] Dashboard Ping succeeds
[ ] get_config succeeds through an MCP client OR is explicitly marked pending
[ ] macOS Keychain item exists
[ ] Normal device restart requires no new pairing
[ ] Device returns online after restart
[ ] Dashboard Reconnect succeeds
[ ] Ping succeeds after Reconnect
[ ] Revoke marks device revoked
[ ] Old revoked credentials cannot resume operation
```

### Merge decision

**GO:** every mandatory line passes, and `get_config` is proven before external users are invited.

**NO-GO:** any auth, Keychain persistence, claim/completion, reconnect ordering, revocation, or device-online correctness check fails.

For the current MVP, do not block launch on UI polish, DCR replacement, Jazz version cleanup, or broad cross-platform CI unless testing exposes a security/correctness failure in one of the checks above.
