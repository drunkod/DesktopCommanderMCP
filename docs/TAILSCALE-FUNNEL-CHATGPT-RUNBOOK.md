# Tailscale Funnel + ChatGPT acceptance runbook

This is the manual gate for enabling the Tailscale provider in production. Unit
and repository tests do not prove ChatGPT OAuth, MCP transport, or Jazz
compatibility.

## Preconditions

- A disposable/test Tailscale account/device with Funnel enabled.
- A dedicated `DC_TAILSCALE_STATE_PATH` containing `e2e`, `test`, or
  `disposable`; the E2E harness refuses the normal identity-store path.
- A healthy HTTP MCP/control-plane target and its known-200 readiness path.
- ChatGPT development connector access.
- `MCP_SERVER_URL` remains the private local/control-plane origin; do not replace
  it with the public Funnel URL.
- Configure the RemoteMCP-Jazz control plane with the Funnel origin before
  starting the device. The control plane reads this configuration at process
  startup; setting an environment variable inside Desktop Commander cannot
  reconfigure an already-running server:

  ```bash
  # RemoteMCP-Jazz control plane
  APP_ORIGIN=https://<device>.<tailnet>.ts.net
  REMOTE_MCP_RESOURCE=https://<device>.<tailnet>.ts.net/mcp

  # Desktop Commander device transport
  MCP_SERVER_URL=http://127.0.0.1:3000
  ```

  The public protected-resource metadata must advertise the resource and
  `${APP_ORIGIN}/api/auth`; authorization-server metadata must advertise the
  same issuer and public endpoint origins. Verify these before configuring
  ChatGPT.

## First connection

First reserve/verify the durable Tailscale identity:

```bash
desktop-commander remote tunnel prepare --tunnel tailscale
```

Apply the printed `APP_ORIGIN` and `REMOTE_MCP_RESOURCE` to the
RemoteMCP-Jazz control-plane environment and restart that process. Then start
the device sidecar:

```bash
MCP_SERVER_URL=http://127.0.0.1:3000 \
APP_ORIGIN=https://<device>.<tailnet>.ts.net \
REMOTE_MCP_RESOURCE=https://<device>.<tailnet>.ts.net/mcp \
desktop-commander remote --tunnel tailscale \
  --tunnel-target http://127.0.0.1:3000 \
  --tunnel-health-path /.well-known/oauth-protected-resource/mcp
```

The command prints the stable URL only after tunnel transport, public OAuth
metadata, and local device registration are ready. Record the one printed
`https://<device>.<tailnet>.ts.net/mcp` URL, configure it once in ChatGPT, and
complete OAuth. Verify `list_devices`,
`__control.ping`, `get_config`, and a harmless `start_process` call.

## Recovery matrix

Run each case and verify the URL is byte-for-byte unchanged and that a new
ChatGPT tool call succeeds after recovery:

1. Restart the Funnel configuration.
2. `tailscale down`, then `tailscale up`.
3. Restart Desktop Commander.
4. Disconnect/reconnect Wi-Fi.
5. Reboot macOS.
6. Kill the local backend and restore it; verify the tunnel does not advertise
   readiness while the backend is down.
7. Run concurrent and long-lived MCP calls.

Finally revoke the device/session authorization and prove the old session
cannot cause a local side effect. Record command output and timestamps for each
case before enabling the provider for non-test users.
