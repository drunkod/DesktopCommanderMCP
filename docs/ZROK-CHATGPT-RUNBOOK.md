# zrok named share + ChatGPT acceptance runbook

This is the manual gate for enabling the zrok provider in production. A
reserved name, not an ordinary ephemeral share, is required for the URL to
survive share-process restarts.

## First connection

Use a provisioned disposable test namespace/name, an isolated zrok state path,
and a known-200 local readiness endpoint. First establish the durable name:

```bash
desktop-commander remote tunnel prepare --tunnel zrok \
  --tunnel-namespace <test-namespace> \
  --tunnel-name desktop-commander-test
```

Configure/restart the RemoteMCP-Jazz control plane with the printed public
identity. It reads these values when it starts; Desktop Commander cannot
reconfigure a separate running server:

```bash
# RemoteMCP-Jazz control plane
APP_ORIGIN=https://<reserved-name>.<zrok-domain>
REMOTE_MCP_RESOURCE=https://<reserved-name>.<zrok-domain>/mcp

# Desktop Commander device transport
MCP_SERVER_URL=http://127.0.0.1:3000
DC_ZROK_NAMESPACE=<test-namespace>
DC_ZROK_NAME=desktop-commander-test
DC_ZROK_STATE_PATH=$HOME/.config/desktop-commander/zrok-e2e.json

MCP_SERVER_URL=http://127.0.0.1:3000 \
APP_ORIGIN=https://<reserved-name>.<zrok-domain> \
REMOTE_MCP_RESOURCE=https://<reserved-name>.<zrok-domain>/mcp \
desktop-commander remote --tunnel zrok \
  --tunnel-namespace "$DC_ZROK_NAMESPACE" \
  --tunnel-name "$DC_ZROK_NAME" \
  --tunnel-target http://127.0.0.1:3000 \
  --tunnel-health-path /.well-known/oauth-protected-resource/mcp
```

Do not set `DC_TUNNEL_E2E=1` for the normal CLI run; that opt-in is reserved
for the integration-test command. Before configuring ChatGPT, verify that
protected-resource metadata advertises the `/mcp` resource and the public
`/api/auth` authorization server, and that authorization-server endpoint URLs
use the same public origin.

The command prints the stable URL only after tunnel transport, public OAuth
metadata, and local device registration are ready. Record the printed
`https://<reserved-name>.../mcp` URL, configure it once in ChatGPT, and verify `list_devices`, `__control.ping`, `get_config`, and a
harmless `start_process` call.

## Recovery matrix

Verify the same URL and successful tool behavior after:

1. Killing and restarting the named share.
2. Killing/restarting the zrok agent.
3. Restarting Desktop Commander.
4. Rebooting/logging into macOS (after the explicit
   `desktop-commander remote tunnel install-agent --tunnel zrok` setup if
   LaunchAgent supervision is part of the test).
5. Disconnecting/reconnecting the network.
6. Killing/restoring the local backend; readiness must fail closed.
7. Concurrent and long-lived MCP calls.

The normal `stop`/shutdown path must retain the reserved name. Use
`remote tunnel install-agent --tunnel zrok` and
`remote tunnel uninstall-agent --tunnel zrok` only for local supervision;
neither changes the reserved identity. Only run `remote tunnel delete-name
--tunnel zrok --confirm` against a disposable test name. Revoke the
device/session authorization and verify that the old session cannot execute a
local side effect.

Agent remoting is not required for this gate and must remain disabled unless a
separate security review approves its independent credential and revocation
path.
