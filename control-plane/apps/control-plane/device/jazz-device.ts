import os from "node:os";
import { createDb, type Db, type JsonValue } from "jazz-tools";
import { app, type RemoteCall } from "../schema";
import type { DeviceTokenManager } from "./token-manager";
import { DeviceHeartbeat } from "./heartbeat";
import {
  claimRemoteCall,
  completeRemoteCall,
  getJazzDeviceToken,
  registerDeviceWithControlPlane,
  sendDeviceHeartbeat,
} from "./control-plane-client";
import { ReconnectSupervisor } from "./reconnect-supervisor";
import type { LocalMcpSupervisor } from "./local-mcp-supervisor";
import { toJsonValue } from "../lib/json";

type CallExecution = {
  result: JsonValue;
  afterCommit?: () => void;
};

export class JazzDeviceChannel {
  private db: Db | null = null;
  private deviceRowId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly seen = new Set<string>();
  private shuttingDown = false;
  private readonly heartbeat: DeviceHeartbeat;
  private readonly reconnect: ReconnectSupervisor;

  constructor(
    private readonly tokens: DeviceTokenManager,
    private readonly oauthClientId: string,
    private readonly stableId: string,
    private readonly localMcp: LocalMcpSupervisor,
  ) {
    this.heartbeat = new DeviceHeartbeat(
      async () => {
        if (!this.deviceRowId) throw new Error("Device is not registered");
        const accessToken = await this.tokens.getAccessToken();
        await sendDeviceHeartbeat(accessToken, {
          deviceId: this.deviceRowId,
          status: "online",
        });
      },
      { onUnhealthy: (reason) => void this.reconnect.request(reason) },
    );
    this.reconnect = new ReconnectSupervisor({
      disconnect: () => this.disconnectOnce(),
      connect: () => this.connectOnce(),
      onState: (state, reason) => console.log(`[remote] ${state}: ${reason}`),
    });
  }

  async start(): Promise<void> {
    this.shuttingDown = false;
    await this.localMcp.start();
    await this.connectOnce();
  }

  async forceReconnect(reason = "manual"): Promise<void> {
    await this.reconnect.request(reason);
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    this.reconnect.stop();
    this.heartbeat.stop();
    await this.markOffline().catch(() => undefined);
    await this.disconnectOnce();
    await this.localMcp.stop();
  }

  private async connectOnce(): Promise<void> {
    const oauthToken = await this.tokens.getAccessToken();
    const tools = await this.localMcp.listTools();
    const registration = await registerDeviceWithControlPlane(oauthToken, {
      stableId: this.stableId,
      name: os.hostname(),
      platform: process.platform,
      appVersion: process.env.APP_VERSION ?? "dev",
      capabilities: tools,
    });
    if (registration.oauthClientId !== this.oauthClientId) {
      throw new Error("Control plane returned an unexpected OAuth client identity");
    }

    this.db = await createDb({
      appId: process.env.JAZZ_APP_ID!,
      serverUrl: process.env.JAZZ_SERVER_URL!,
      jwtToken: registration.jazzToken,
    });

    this.db.onAuthChanged((state) => {
      if (state.error !== "expired" || this.shuttingDown) return;
      void this.tokens.getAccessToken()
        .then((accessToken) => getJazzDeviceToken(accessToken, registration.deviceId))
        .then((jazzToken) => this.db?.updateAuthToken(jazzToken))
        .catch((error) =>
          this.reconnect.request(`Jazz capability refresh failed: ${String(error)}`),
        );
    });

    const device = await this.db.one(
      app.devices.where({ id: registration.deviceId }),
      { tier: "global" },
    );
    if (!device || device.revokedAt) {
      throw new Error("Registered device is not visible or has been revoked");
    }
    if (device.oauthClientId !== this.oauthClientId || device.stableId !== this.stableId) {
      throw new Error("Registered device identity does not match this credential");
    }

    this.deviceRowId = device.id;
    this.subscribeToCalls();
    this.heartbeat.start();
  }

  private async markOffline(): Promise<void> {
    if (!this.deviceRowId) return;
    const accessToken = await this.tokens.getAccessToken();
    await sendDeviceHeartbeat(accessToken, {
      deviceId: this.deviceRowId,
      status: "offline",
    });
  }

  private async disconnectOnce(): Promise<void> {
    this.heartbeat.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const db = this.db;
    this.db = null;
    this.deviceRowId = null;
    await db?.shutdown().catch(() => undefined);
  }

  private subscribeToCalls(): void {
    if (!this.db || !this.deviceRowId) throw new Error("Device is not connected");
    const query = app.remoteCalls.where({
      deviceId: this.deviceRowId,
      status: "pending",
    });
    this.unsubscribe = this.db.subscribeAll(
      query,
      (delta) => {
        for (const call of delta.all) void this.handleCall(call);
      },
      { tier: "global" },
    );
  }

  private remember(callId: string): boolean {
    if (this.seen.has(callId)) return false;
    this.seen.add(callId);
    if (this.seen.size > 2_000) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }

  private async handleCall(call: RemoteCall): Promise<void> {
    if (!this.db || !this.deviceRowId || !this.remember(call.id)) return;

    const claimToken = await this.tokens.getAccessToken();
    const claimed = await claimRemoteCall(claimToken, {
      callId: call.id,
      deviceId: this.deviceRowId,
    });
    if (!claimed) return;

    try {
      const execution = await this.executeCall(call);
      const completionToken = await this.tokens.getAccessToken();
      await completeRemoteCall(completionToken, {
        callId: call.id,
        deviceId: this.deviceRowId,
        status: "completed",
        result: execution.result,
      });
      execution.afterCommit?.();
    } catch (error) {
      const completionToken = await this.tokens.getAccessToken().catch(() => null);
      if (completionToken) {
        await completeRemoteCall(completionToken, {
          callId: call.id,
          deviceId: this.deviceRowId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
    }
  }

  private async executeCall(call: RemoteCall): Promise<CallExecution> {
    if (call.toolName === "__control.ping") {
      return { result: { pong: new Date().toISOString() } };
    }
    if (call.toolName === "__control.reconnect") {
      return {
        result: { reconnecting: true, at: new Date().toISOString() },
        afterCommit: () => {
          setTimeout(() => void this.forceReconnect("remote control request"), 250);
        },
      };
    }
    if (call.toolName === "__control.shutdown") {
      return {
        result: { shuttingDown: true, at: new Date().toISOString() },
        afterCommit: () => {
          setTimeout(() => void this.close(), 250);
        },
      };
    }

    return {
      result: toJsonValue(
        await this.localMcp.callTool(call.toolName, call.toolArgs, call.metadata),
        `tool result: ${call.toolName}`,
      ),
    };
  }
}
