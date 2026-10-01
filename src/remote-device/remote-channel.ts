import { createDb, type Db } from 'jazz-tools';
import { app } from './jazz-schema.js';
import type { DeviceTokenManager } from './token-manager.js';
import { DeviceHeartbeat } from './heartbeat.js';
import { ReconnectSupervisor } from './reconnect-supervisor.js';
import type { DeviceControlPlaneClient, DevicePendingCall } from './control-plane-client.js';
import { toJsonValue } from './json.js';
import { VERSION } from '../version.js';

const NUL_CHAR = String.fromCharCode(0);
const NUL_RE = new RegExp(NUL_CHAR, 'g');
const CALL_POLL_INTERVAL_MS = 500;
const CALL_POLL_RECONNECT_THRESHOLD = 3;

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
 * Remote transport with Jazz-backed device identity and HTTP call delivery.
 *
 * Security boundary:
 * - Better Auth OAuth access tokens are used only against strict control-plane HTTP APIs.
 * - Jazz receives only the short-lived jazz:device capability returned by the server.
 * - The Jazz connection validates the server-owned device identity row only.
 * - Pending-call discovery, claim-before-execution, and terminal completion are server-mediated HTTP operations.
 */
export class RemoteChannel {
    private db: Db | null = null;
    private deviceId: string | null = null;
    private stableId: string | null = null;
    private deviceName: string | null = null;
    private callPollTimer: NodeJS.Timeout | null = null;
    private callPollInFlight = false;
    private callPollFailures = 0;
    private readonly deliveringCallIds = new Set<string>();
    private onToolCall: ((payload: RemoteCallPayload) => void | Promise<void>) | null = null;
    private channelHealthReporter: ((ready: boolean) => void) | null = null;
    private shuttingDown = false;
    private capabilities: unknown = { tools: [] };
    private heartbeat: DeviceHeartbeat;
    private reconnect: ReconnectSupervisor;

    constructor(
        private readonly tokens: DeviceTokenManager,
        private readonly controlPlane: DeviceControlPlaneClient,
    ) {
        this.heartbeat = new DeviceHeartbeat(
            async () => {
                if (!this.deviceId) throw new Error('Device is not registered');
                const accessToken = await this.tokens.getAccessToken();
                await this.controlPlane.heartbeat(accessToken, {
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
        const registration = await this.controlPlane.register(accessToken, {
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
            // alpha.53 logs expected subscription branch-materialization rejects
            // as WARN even though this client never writes through Jazz. Keep the
            // runtime quiet, but surface any real local mutation rejection below.
            logLevel: 'error',
        });
        db.onMutationError((event) => {
            console.error('[remote] unexpected Jazz mutation rejected: ' + event.code + ': ' + event.reason);
        });
        this.db = db;
        this.deviceId = registration.deviceId;

        db.onAuthChanged((state) => {
            if (state.error !== 'expired' || this.shuttingDown || !this.deviceId) return;
            const id = this.deviceId;
            void this.tokens.getAccessToken()
                .then((oauthToken) => this.controlPlane.getJazzToken(oauthToken, id))
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

        this.startCallPolling();
        this.heartbeat.start();
        this.reportChannelHealth(true);
    }

    private startCallPolling(): void {
        this.stopCallPolling();
        this.callPollFailures = 0;
        void this.pollPendingCalls();
    }

    private stopCallPolling(): void {
        if (this.callPollTimer) clearTimeout(this.callPollTimer);
        this.callPollTimer = null;
    }

    private scheduleCallPoll(): void {
        if (this.shuttingDown || !this.db || !this.deviceId || this.callPollTimer) return;
        this.callPollTimer = setTimeout(() => {
            this.callPollTimer = null;
            void this.pollPendingCalls();
        }, CALL_POLL_INTERVAL_MS);
    }

    private async pollPendingCalls(): Promise<void> {
        if (this.callPollInFlight || this.shuttingDown || !this.db || !this.deviceId || !this.onToolCall) return;
        this.callPollInFlight = true;
        let reconnectReason: string | null = null;
        try {
            const accessToken = await this.tokens.getAccessToken();
            const calls = await this.controlPlane.listPendingCalls(accessToken, { deviceId: this.deviceId });
            this.callPollFailures = 0;
            for (const call of calls) this.deliverPendingCall(call);
        } catch (error) {
            this.callPollFailures += 1;
            const reason = `pending call poll failed: ${error instanceof Error ? error.message : String(error)}`;
            console.error(`[remote] ${reason}`);
            if (this.callPollFailures >= CALL_POLL_RECONNECT_THRESHOLD) {
                this.callPollFailures = 0;
                reconnectReason = reason;
            }
        } finally {
            this.callPollInFlight = false;
            if (reconnectReason) void this.reconnect.request(reconnectReason);
            else this.scheduleCallPoll();
        }
    }

    private deliverPendingCall(call: DevicePendingCall): void {
        if (!this.deviceId || !this.onToolCall || this.deliveringCallIds.has(call.id)) return;
        const deviceId = this.deviceId;
        const callback = this.onToolCall;
        this.deliveringCallIds.add(call.id);
        const payload: RemoteCallPayload = {
            new: {
                id: call.id,
                tool_name: call.toolName,
                tool_args: call.toolArgs,
                device_id: deviceId,
                metadata: call.metadata,
            },
        };
        void Promise.resolve()
            .then(() => callback(payload))
            .catch((error) => console.error('[remote] tool callback rejected:', error))
            .finally(() => this.deliveringCallIds.delete(call.id));
    }

    /** Fail closed: a network/auth error throws and the tool MUST NOT execute. */
    async markCallExecuting(callId: string): Promise<boolean> {
        if (!this.deviceId) throw new Error('Device is not registered');
        const accessToken = await this.tokens.getAccessToken();
        return this.controlPlane.claim(accessToken, { callId, deviceId: this.deviceId });
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
            await this.controlPlane.complete(accessToken, {
                callId,
                deviceId: this.deviceId,
                status: 'completed',
                result: toJsonValue(stripNullBytes(result), 'remote tool result'),
            });
            return;
        }
        await this.controlPlane.complete(accessToken, {
            callId,
            deviceId: this.deviceId,
            status: 'failed',
            error: stripNullBytes(errorMessage ?? 'Remote tool failed'),
        });
    }

    /** HTTP polling discovers pending calls; explicit result doorbells are unnecessary. */
    async notifyResult(_callId: string): Promise<void> { }

    startHeartbeat(_deviceId: string): void {
        this.heartbeat.start();
    }

    stopHeartbeat(): void {
        this.heartbeat.stop();
    }

    async setOnlineStatus(deviceId: string, status: 'online' | 'offline'): Promise<void> {
        const accessToken = await this.tokens.getAccessToken();
        await this.controlPlane.heartbeat(accessToken, { deviceId, status });
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
        this.stopCallPolling();
        const db = this.db;
        this.db = null;
        await db?.shutdown().catch(() => undefined);
    }
}
