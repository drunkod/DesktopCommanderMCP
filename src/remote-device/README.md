# Desktop Commander Remote Device

The **Desktop Commander Remote Device** connects a local computer to a RemoteMCP-Jazz control plane. It keeps the existing Jazz/device path private and can optionally expose the control plane through a stable HTTPS Tailscale Funnel or zrok reserved named share for ChatGPT or another MCP client.

## How It Works

There are two independent paths:

1. **Device transport:** Desktop Commander talks to the local control plane through the private `MCP_SERVER_URL` and the existing Jazz/device lifecycle.
2. **Client-facing MCP transport:** ChatGPT reaches the same control plane through the stable public HTTPS tunnel at `/mcp`. The control plane's OAuth issuer and resource audience use this public origin.

The tunnel is a transport sidecar, not an authorization boundary. The control plane must continue to enforce OAuth and the MCP resource audience before exposing any Desktop Commander tools.

The origins must be configured separately:

```bash
# RemoteMCP-Jazz control plane, loaded when that process starts
APP_ORIGIN=https://<stable-public-host>
REMOTE_MCP_RESOURCE=https://<stable-public-host>/mcp

# Desktop Commander device transport
MCP_SERVER_URL=http://127.0.0.1:3000
```

## 📋 Prerequisites

Before running the device, ensure you have:

1.  **Node.js**: Version 18 or higher installed.
2.  **Desktop Commander MCP Server**: Installed and capable of running.
    *   **Global Install (Recommended)**:
        ```bash
        npm install -g @wonderwhy-er/desktop-commander
        ```
    *   **Local Build**: If you are developing locally, the device can also find the server in `../../dist/index.js`.

## 🛠️ Installation

### Option 1: Global Installation (Recommended)

Install the module globally to run it from anywhere:

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/wonderwhy-er/DesktopCommanderMCP.git
    cd DesktopCommanderMCP/src/remote-device
    ```

2.  **Install Dependencies**:
    ```bash
    npm install
    ```

3.  **Install Globally**:
    ```bash
    npm install -g .
    ```
    
    Or for development (creates a symlink):
    ```bash
    npm link
    ```

4.  **Run from anywhere**:
    ```bash
    desktop-commander-device
    ```

### Option 2: Local Installation

Run from the project repository without global installation:

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/wonderwhy-er/DesktopCommanderMCP.git
    cd DesktopCommanderMCP
    ```

2.  **Install Dependencies**:
    Navigate to the root directory and install the required packages:
    ```bash
    npm run device:install
    ```

## 🚦 Usage

### 1. Start the Device

**If installed globally**:
```bash
desktop-commander-device
```

### Optional stable public tunnel

The main CLI can supervise a stable Tailscale Funnel or zrok named share as a
sidecar to the existing Jazz device connection. First establish the durable
external identity, then configure/restart the separately running control plane
with that identity:

```bash
desktop-commander remote tunnel prepare --tunnel tailscale
# or:
desktop-commander remote tunnel prepare --tunnel zrok \
  --tunnel-namespace public --tunnel-name desktop-commander-alice

# Configure RemoteMCP-Jazz using the printed values, then restart it:
APP_ORIGIN=https://<stable-host>
REMOTE_MCP_RESOURCE=https://<stable-host>/mcp

# Finally start the private device sidecar:
MCP_SERVER_URL=http://127.0.0.1:3000 \
desktop-commander remote --tunnel tailscale
```

The normal run verifies local backend health, public HTTPS reachability, OAuth
metadata, and device startup before printing one stable URL ending in `/mcp`.
Configure that URL once in the remote client. Tailscale uses its `.ts.net`
identity and persistent Funnel configuration; zrok uses a reserved named share
stored in `~/.config/desktop-commander/zrok.json` (mode `0600`). Normal
restarts do not delete the reserved zrok name. This remains experimental until
the real OAuth/MCP/Jazz acceptance gate passes.

The default tunnel target is `http://127.0.0.1:3000`; override it with
`--tunnel-target` when the HTTP control-plane service is listening elsewhere.
This target is separate from the device's private `MCP_SERVER_URL` setting.
The control plane reads `APP_ORIGIN` at process startup; changing an
environment variable inside Desktop Commander cannot reconfigure an already
running control-plane process.

Useful operator commands:

```bash
desktop-commander remote tunnel status --tunnel tailscale
desktop-commander remote tunnel doctor --tunnel zrok
desktop-commander remote tunnel console --tunnel zrok
desktop-commander remote tunnel restart --tunnel zrok
desktop-commander remote tunnel disable --tunnel zrok
desktop-commander remote tunnel stop --tunnel zrok
# Tailscale refuses to disable an unproven mapping unless explicitly forced:
desktop-commander remote tunnel stop --tunnel tailscale --force
# Remove only local zrok agent supervision; retain the reserved name:
desktop-commander remote tunnel uninstall-agent --tunnel zrok
# Destructive and confirmation-gated:
desktop-commander remote tunnel delete-name --tunnel zrok --confirm
```

`doctor` checks the local target and, when an identity is available, the public
known-200 readiness path (`/.well-known/oauth-protected-resource/mcp` by
default; change it with `--tunnel-health-path`). An opt-in macOS LaunchAgent
keeps the zrok agent alive across login/reboot; install it as a separate
explicit operation:
`desktop-commander remote tunnel install-agent --tunnel zrok`. A successful provider command is not by itself proof that the MCP protocol or
Jazz behavior is compatible; exercise a real client before production use.

**Without session persistence** (opt out):
```bash
desktop-commander-device --no-persist-session
```

> **Note**: The device ID and authentication tokens are persisted by default to `~/.desktop-commander-device/device.json` (mode 0600), so the device reconnects without re-authorization. Pass `--no-persist-session` to keep tokens in memory only — the device then requires a full browser re-authorization on every start, and each one leaves a live server-side session behind.

**If using local installation** from the project root directory:

```bash
npm run device:start
```

*(Or direct from `src/remote-device`: `npm run device`)*

### 2. Authenticate

On first run, the device uses the **OAuth 2.0 Device Authorization Flow** for secure authentication:

1. **Request Device Code**: The device requests a unique verification code from the server.
2. **User Verification**: 
   - A browser window will automatically open to the verification page
   - If the browser doesn't open, you'll see a URL to visit manually
   - Enter the displayed code when prompted (e.g., `BLPU-9E9R`)
3. **Authorization**: Sign in with your account and authorize the device
4. **Automatic Connection**: The device polls the server and automatically connects once you've authorized

**Example Output**:
```
🔐 Starting device authorization flow...
   - 📡 Requesting device code...
   - ✅ Device code received

📋 Please complete authentication:
   1. Open this URL in your browser:
      https://test.acidpictures.org/device/verify
   2. Enter this code when prompted:
      BLPU-9E9R
   Code expires in 15 minutes.
   - ⏳ Waiting for authorization...
   - ✅ Authorization successful!
```

> **Note**: This flow works in all environments (desktop, server, container) without requiring a local callback server. The device simply polls the server until you complete authentication in your browser.

### 3. Connect your AI

Once the device is running and authenticated:
1.  Navigate to **[https://mcp.desktopcommander.app](https://mcp.desktopcommander.app)**.
2.  Use the interface to connect to the **Remote MCP** using available connectors.
3.  Authorize the connection when prompted.
4.  Your AI (ChatGPT/Claude) will now be able to see your connected device and execute commands!

## 🔧 Development & Debugging

For developers contributing to the device or debugging issues:

**Run with Debug Logging**:
```bash
npm run device:dev
```
This enables verbose logging and ensures the device picks up usage of a local MCP server build if available.


## 🔒 Security

*   **You are in control**: The device runs on *your* machine. You can stop it at any time (`Ctrl+C`) to cut off access.
*   **Local Execution**: Commands are executed locally under your user permissions.
*   **Audit Logs**: The local MCP server logs all actions (see the main Desktop Commander README for log locations).

---
*Powered by Desktop Commander MCP*
