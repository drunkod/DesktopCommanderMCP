# Remote Jazz MVP testing

All repository validation must run inside the repo-local Nix shell.

## 1. Enter the reproducible environment

```bash
cd ~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
nix develop
```

Expected toolchain is Node 22 plus npm, Git and `just` from `flake.nix` / `flake.lock`.

## 2. Clean install and static/build gate

Use `npm ci` when validating from a clean checkout:

```bash
just bootstrap
just check
```

`just check` runs the package production build, including TypeScript compilation. Do not run host Node/npm outside `nix develop` when reporting migration failures.

## 3. Remote-device safety gates

```bash
just remote-safety
just supervision
```

Or run both as:

```bash
just remote-gate
```

The Jazz safety suite proves claim-before-execute, fail-closed claim errors, duplicate suppression, no replay after ambiguous completion, and commit-before-reconnect ordering.
## 4. Full Desktop Commander regression

```bash
just test
```

For one command covering build, remote safety, supervision and the full project suite:

```bash
just full-gate
```

## 5. Start the local control-plane dependencies

In separate terminals, use the control-plane repository's Nix shell:

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
nix develop
just jazz
```

and:

```bash
cd ~/Documents/RemoteMCP-Jazz/implementation
nix develop
just web
```

The local endpoints are normally:

```text
control plane: http://127.0.0.1:3000
Jazz:         http://127.0.0.1:1625
```

Do not paste or commit `apps/control-plane/.env.local`; it contains local secrets.
## 6. Run the real headless device

Back in the DesktopCommanderMCP Nix shell, load the local environment **locally** without sharing it:

```bash
set -a
source ~/Documents/RemoteMCP-Jazz/implementation/apps/control-plane/.env.local
set +a
export MCP_SERVER_URL="$APP_ORIGIN"
node dist/index.js remote --debug --disable-no-sleep
```

The device prints an RFC 8628 verification URL and user code. By default it opens the browser as well. For SSH/headless testing, add:

```bash
export DC_DEVICE_NO_BROWSER=1
```

then open the printed verification URL yourself and approve the code.

On successful pairing the agent prints the authoritative Jazz `Device ID`, its local `Stable ID`, and the device name. OAuth refresh state is stored in the native OS credential store; `~/.desktop-commander-device/device.json` contains only the non-secret stable ID.

## 7. Manual MVP acceptance

From the dashboard/MCP control plane, prove in order:

1. device appears online;
2. ping returns a pong;
3. `get_config` executes through the local Desktop Commander child;
4. reconnect returns a result before the transport is recreated;
5. killing the local stdio child makes the device unhealthy until supervision restarts it;
6. restarting the device process does not require browser pairing when credentials are persisted;
7. revocation prevents heartbeat, claim and further call visibility.

For a no-persistence test, run `remote --no-persist-session`; the next process start must pair again.