import { createDb, type Db } from 'jazz-tools';
import { app } from './jazz-schema.js';
import type { DeviceTokenManager } from './token-manager.js';
import { DeviceHeartbeat } from './heartbeat.js';
import { ReconnectSupervisor } from './reconnect-supervisor.js';
import {
    claimRemoteCall,
    completeRemoteCall,
    getJazzDeviceToken,
    registerDeviceWithControlPlane,
    sendDeviceHeartbeat,
} from './control-plane-client.js';
import { toJsonValue } from './json.js';
import { VERSION } from '../version.js';

const NUL_CHAR = String.fromCharCode(0);
const NUL_RE = new RegExp(NUL_CHAR, 'g');

/** Preserve the existing remote-result sanitization contract across transports. */
export function stripNullBytes<T>(value: T): T {
    if (typeof value === 'string') {
        return (value.includes(NUL_CHAR) ? value.replace(NUL_RE, '') : value) as T;
    }
    if (Array.isArray(value)) return value.map((item) => stripNullBytes(item)) as T;
    if (value && typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) return value;
        const out: Record<string, any> = {};
        for (const [key, item] of Object.entries(value as Record<string, any>)) {
            const cleanKey = key.includes(NUL_CHAR) ? key.replace(NUL_RE, '') : key;
            out[cleanKey] = stripNullBytes(item);
        }
        return out as T;
    }
    return value;
}

export type RemoteCallPayload = {
    new: {
        id: string;
        tool_name: string;
        tool_args: unknown;
        device_id: string;
        metadata?: unknown;
    };
};

/**
 * Jazz-backed remote transport.
 *
 * Security boundary:
 * - Better Auth OAuth access tokens are used only against strict control-plane HTTP APIs.
 * - Jazz receives only the short-lived jazz:device capability returned by the server.
 * - The Jazz connection is read/subscription-only by policy.
 * - pending -> executing claim and terminal completion are server-mediated HTTP operations.
 */
export class RemoteChannel {
    private db: Db | null = null;
    private deviceId: string | null = null;
    private stableId: string | null = null;
    private deviceName: string | null = null;
    private unsubscribeCalls: (() => void) | null = null;
    private onToolCall: ((payload: RemoteCallPayload) => void | Promise<void>) | null = null;
    private channelHealthReporter: ((ready: boolean) => void) | null = null;
    private shuttingDown = false;
    private capabilities: unknown = { tools: [] };
    private heartbeat: DeviceHeartbeat;
    private reconnect: ReconnectSupervisor;

    constructor(private readonly tokens: DeviceTokenManager) {
        this.heartbeat = new DeviceHeartbeat(
            async () => {
                if (!this.deviceId) throw new Error('Device is not registered');
                const accessToken = await this.tokens.getAccessToken();
                await sendDeviceHeartbeat(accessToken, {
                    deviceId: this.deviceId,
                    status: 'online',
                });
            },
            {
                onUnhealthy: (reason) => {
                    this.reportChannelHealth(false);
                    void this.reconnect.request(reason);
                },
            },
        );
        this.reconnect = new ReconnectSupervisor({
            disconnect: () => this.disconnectOnce(),
            connect: () => this.connectOnce(),
            onState: (state, reason) => {
                if (state === 'online') this.reportChannelHealth(true);
                if (state === 'connecting' || state === 'offline') this.reportChannelHealth(false);
                console.log(`[remote] ${state}: ${reason}`);
            },
        });
    }

    setChannelHealthReporter(reporter: (ready: boolean) => void): void {
        this.channelHealthReporter = reporter;
    }

    private reportChannelHealth(ready: boolean): void {
        this.channelHealthReporter?.(ready);
    }

    /** Register the server-owned device row, connect Jazz and subscribe to calls. */
    async registerDevice(
        capabilities: unknown,
        stableId: string,
        deviceName: string,
        onToolCall: (payload: RemoteCallPayload) => void | Promise<void>,
    ): Promise<string> {
        this.stableId = stableId;
        this.deviceName = deviceName;
        this.capabilities = capabilities;
        this.onToolCall = onToolCall;
        this.shuttingDown = false;
        await this.connectOnce(capabilities);
        if (!this.deviceId) throw new Error('Control plane did not assign a device row ID');
        return this.deviceId;
    }

    private async connectOnce(capabilities?: unknown): Promise<void> {
        if (!this.stableId || !this.deviceName || !this.onToolCall) {
            throw new Error('Remote channel registration parameters are missing');
        }
        const accessToken = await this.tokens.getAccessToken();
        const registration = await registerDeviceWithControlPlane(accessToken, {
            stableId: this.stableId,
            name: this.deviceName,
            platform: process.platform,
            appVersion: VERSION,
            capabilities: capabilities ?? this.capabilities,
        });

        const jazzAppId = process.env.JAZZ_APP_ID;
        const jazzServerUrl = process.env.JAZZ_SERVER_URL;
        if (!jazzAppId || !jazzServerUrl) {
            throw new Error('JAZZ_APP_ID and JAZZ_SERVER_URL are required for remote mode');
        }

        const db = await createDb({
            appId: jazzAppId,
            serverUrl: jazzServerUrl,
            jwtToken: registration.jazzToken,
            // The device uses Jazz only as a transient read/subscription channel.
            // Keep local-first persistence disabled so stale local branches cannot
            // be replayed under the short-lived read-only device capability.
            driver: { type: 'memory' },
        });
        this.db = db;
        this.deviceId = registration.deviceId;

        db.onAuthChanged((state) => {
            if (state.error !== 'expired' || this.shuttingDown || !this.deviceId) return;
            const id = this.deviceId;
            void this.tokens.getAccessToken()
                .then((oauthToken) => getJazzDeviceToken(oauthToken, id))
                .then((jazzToken) => db.updateAuthToken(jazzToken))
                .catch((error) => void this.reconnect.request(`Jazz capability refresh failed: ${String(error)}`));
        });

        const row = await db.one(app.devices.where({ id: registration.deviceId }), { tier: 'global' });
        if (!row || row.revokedAt) {
            await db.shutdown().catch(() => undefined);
            this.db = null;
            throw new Error('Registered device is not visible or is revoked');
        }
        if (row.stableId !== this.stableId || row.oauthClientId !== registration.oauthClientId) {
            await db.shutdown().catch(() => undefined);
            this.db = null;
            throw new Error('Registered device identity does not match OAuth credential');
        }

        this.subscribeToCalls();
        this.heartbeat.start();
        this.reportChannelHealth(true);
    }

    private subscribeToCalls(): void {
        if (!this.db || !this.deviceId || !this.onToolCall) throw new Error('Remote channel is not connected');
        const callback = this.onToolCall;
        const deviceId = this.deviceId;
        this.unsubscribeCalls = this.db.subscribeAll(
            app.remoteCalls.where({ deviceId, status: 'pending' }),
            (delta) => {
                for (const call of delta.all) {
                    const payload: RemoteCallPayload = {
                        new: {
                            id: call.id,
                            tool_name: call.toolName,
                            tool_args: call.toolArgs,
                            device_id: deviceId,
                            metadata: call.metadata,
                        },
                    };
                    try {
                        const result = callback(payload);
                        if (result instanceof Promise) {
                            result.catch((error) => console.error('[remote] tool callback rejected:', error));
                        }
                    } catch (error) {
                        console.error('[remote] tool callback threw:', error);
                    }
                }
            },
            { tier: 'global' },
        );
    }

    /** Fail closed: a network/auth error throws and the tool MUST NOT execute. */
    async markCallExecuting(callId: string): Promise<boolean> {
        if (!this.deviceId) throw new Error('Device is not registered');
        const accessToken = await this.tokens.getAccessToken();
        return claimRemoteCall(accessToken, { callId, deviceId: this.deviceId });
    }

    async updateCallResult(
        callId: string,
        status: string,
        result: unknown = null,
        errorMessage: string | null = null,
    ): Promise<void> {
        if (!this.deviceId) throw new Error('Device is not registered');
        if (status !== 'completed' && status !== 'failed') {
            throw new Error(`Unsupported terminal call status: ${status}`);
        }
        const accessToken = await this.tokens.getAccessToken();
        if (status === 'completed') {
            await completeRemoteCall(accessToken, {
                callId,
                deviceId: this.deviceId,
                status: 'completed',
                result: toJsonValue(stripNullBytes(result), 'remote tool result'),
            });
            return;
        }
        await completeRemoteCall(accessToken, {
            callId,
            deviceId: this.deviceId,
            status: 'failed',
            error: stripNullBytes(errorMessage ?? 'Remote tool failed'),
        });
    }

    /** Jazz row subscriptions make result doorbells unnecessary. */
    async notifyResult(_callId: string): Promise<void> { }

    startHeartbeat(_deviceId: string): void {
        this.heartbeat.start();
    }

    stopHeartbeat(): void {
        this.heartbeat.stop();
    }

    async setOnlineStatus(deviceId: string, status: 'online' | 'offline'): Promise<void> {
        const accessToken = await this.tokens.getAccessToken();
        await sendDeviceHeartbeat(accessToken, { deviceId, status });
    }

    async setOffline(deviceId?: string): Promise<void> {
        const id = deviceId ?? this.deviceId;
        if (!id) return;
        await this.setOnlineStatus(id, 'offline');
    }

    async forceReconnect(reason = 'manual'): Promise<void> {
        await this.reconnect.request(reason);
    }

    async unsubscribe(): Promise<void> {
        await this.disconnectOnce();
    }

    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        this.reconnect.stop();
        this.heartbeat.stop();
        await this.setOffline().catch(() => undefined);
        await this.disconnectOnce();
        this.reportChannelHealth(false);
    }

    private async disconnectOnce(): Promise<void> {
        this.heartbeat.stop();
        const unsubscribe = this.unsubscribeCalls;
        this.unsubscribeCalls = null;
        // alpha.53 can panic if unsubscribe is called re-entrantly from a WASM callback.
        if (unsubscribe) await new Promise<void>((resolve) => queueMicrotask(() => { unsubscribe(); resolve(); }));
        const db = this.db;
        this.db = null;
        await db?.shutdown().catch(() => undefined);
    }
}
