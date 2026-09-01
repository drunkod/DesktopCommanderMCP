#!/usr/bin/env node

import { RemoteChannel, type RemoteCallPayload } from './remote-channel.js';
import { DesktopCommanderIntegration } from './desktop-commander-integration.js';
import { DeviceStatusArbiter } from './device-status-arbiter.js';
import { DeviceTokenManager } from './token-manager.js';
import { MemoryCredentialStore } from './credential-store.js';
import { NativeCredentialStore } from './native-credential-store.js';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { captureRemote } from '../utils/capture.js';

export interface MCPDeviceOptions {
    persistSession?: boolean;
}

const SEEN_CALL_IDS_MAX = 2000;

export class MCPDevice {
    private baseServerUrl: string;
    private remoteChannel: RemoteChannel;
    private tokens: DeviceTokenManager;
    private deviceId?: string;
    private stableId?: string;
    private isShuttingDown = false;
    private configPath: string;
    private persistSession: boolean;    private desktop: DesktopCommanderIntegration;
    private statusArbiter: DeviceStatusArbiter;
    private recoveringLocalMcp = false;
    private localRestartAttempt = 0;
    private localMcpStableSince = 0;
    private seenCallIds: Set<string> = new Set();

    constructor(options: MCPDeviceOptions = {}) {
        this.baseServerUrl = (process.env.MCP_SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
        process.env.MCP_SERVER_URL = this.baseServerUrl;
        process.env.REMOTE_MCP_RESOURCE ||= `${this.baseServerUrl}/mcp`;
        this.persistSession = options.persistSession ?? true;
        const credentialStore = this.persistSession
            ? new NativeCredentialStore()
            : new MemoryCredentialStore();
        this.tokens = new DeviceTokenManager(credentialStore);
        this.remoteChannel = new RemoteChannel(this.tokens);
        this.configPath = path.join(os.homedir(), '.desktop-commander-device', 'device.json');
        this.desktop = new DesktopCommanderIntegration();
        this.statusArbiter = new DeviceStatusArbiter({
            write: async (status) => {
                if (!this.deviceId) return;
                await this.remoteChannel.setOnlineStatus(this.deviceId, status);
            },
        });
        this.setupShutdownHandlers();
    }

    private setupShutdownHandlers(): void {
        const handleShutdown = async (signal: string) => {            if (this.isShuttingDown) {
                console.log(`\n${signal} received while shutdown is already in progress`);
                process.exit(1);
                return;
            }
            const forceExit = setTimeout(() => process.exit(1), 5000);
            try {
                await this.shutdown();
                clearTimeout(forceExit);
                process.exit(0);
            } catch (error) {
                await captureRemote('remote_device_shutdown_handler_error', { error });
                process.exit(1);
            }
        };
        process.on('SIGINT', () => void handleShutdown('SIGINT'));
        process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
    }

    async start(): Promise<void> {
        try {
            console.log('🚀 Starting MCP Device (Jazz transport)...');
            await this.loadPersistedConfig();
            // Rewrite legacy config immediately: it may still contain obsolete
            // access/refresh tokens from the pre-Jazz transport. Device secrets
            // now belong exclusively in the OS credential vault.
            await this.savePersistedConfig();
            await this.desktop.initialize();
            this.desktop.onDisconnect((reason) => void this.handleLocalMcpLoss(reason));
            this.statusArbiter.report('child', true);
            console.log(`⏳ Authorizing with Remote MCP ${this.baseServerUrl}`);
            await this.tokens.initialize();
            this.remoteChannel.setChannelHealthReporter((ready) =>
                this.statusArbiter.report('channel', ready),
            );            const deviceName = os.hostname();
            this.deviceId = await this.remoteChannel.registerDevice(
                await this.desktop.listClientTools(),
                this.stableId!,
                deviceName,
                (payload) => this.handleNewToolCall(payload),
            );
            await this.savePersistedConfig();
            this.statusArbiter.sync();
            this.remoteChannel.startHeartbeat(this.deviceId);

            console.log('✅ Device ready:');
            console.log(`   - Device ID:    ${this.deviceId}`);
            console.log(`   - Stable ID:    ${this.stableId}`);
            console.log(`   - Device Name:  ${deviceName}`);
        } catch (error: any) {
            console.error(' - ❌ Device startup failed:', error?.message ?? error);
            await captureRemote('remote_device_startup_failed', { error });
            await this.shutdown();
            throw error;
        }
    }

    /** Non-secret continuity only. OAuth refresh credentials live in the OS vault. */
    async loadPersistedConfig(): Promise<void> {
        try {
            const data = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
            this.stableId = typeof data?.stableId === 'string' ? data.stableId : undefined;
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {                console.warn('⚠️ Failed to load device config:', error.message);
                await captureRemote('remote_device_config_load_error', { error });
            }
        }
        // Never reuse the legacy remote row id as a Jazz authorization identity.
        this.stableId ||= crypto.randomUUID();
    }

    async savePersistedConfig(): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
            const temp = `${this.configPath}.tmp-${process.pid}`;
            await fs.writeFile(temp, JSON.stringify({ stableId: this.stableId }, null, 2), { mode: 0o600 });
            await fs.rename(temp, this.configPath);
            await fs.chmod(this.configPath, 0o600);
        } catch (error: any) {
            await captureRemote('remote_device_config_save_error', { error });
            throw error;
        }
    }

    private rememberCallId(callId: string): void {
        this.seenCallIds.add(callId);
        if (this.seenCallIds.size > SEEN_CALL_IDS_MAX) {
            const oldest = this.seenCallIds.values().next().value;
            if (oldest !== undefined) this.seenCallIds.delete(oldest);
        }
    }

    private async handleLocalMcpLoss(reason: string): Promise<void> {
        if (this.recoveringLocalMcp || this.isShuttingDown) return;        this.recoveringLocalMcp = true;
        try {
            this.statusArbiter.report('child', false);
            const baseMs = Number(process.env.DC_LOCAL_RESTART_BACKOFF_BASE_MS) || 2000;
            const stableMs = Number(process.env.DC_LOCAL_RESTART_STABLE_UPTIME_MS) || 60000;
            const ceilingMs = 300000;
            if (Date.now() - this.localMcpStableSince > stableMs) this.localRestartAttempt = 0;

            while (!this.isShuttingDown) {
                const delay = Math.min(baseMs * 2 ** this.localRestartAttempt, ceilingMs);
                this.localRestartAttempt++;
                await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * delay * 0.15));
                if (this.isShuttingDown) return;
                try {
                    await this.desktop.ensureReady();
                    this.localMcpStableSince = Date.now();
                    this.statusArbiter.report('child', true);
                    console.log(`♻️ Local Desktop Commander MCP restarted (attempt ${this.localRestartAttempt})`);
                    return;
                } catch (error) {
                    await captureRemote('remote_device_local_mcp_restart_failed', {
                        error,
                        reason,
                        attempt: this.localRestartAttempt,
                    });
                }
            }
        } finally {
            this.recoveringLocalMcp = false;
        }
    }
    async handleNewToolCall(payload: RemoteCallPayload): Promise<void> {
        const toolCall = payload.new;
        const {
            id: callId,
            tool_name: toolName,
            tool_args: toolArgs,
            device_id: deviceId,
            metadata = {},
        } = toolCall;

        if (!this.deviceId || deviceId !== this.deviceId) return;
        if (this.seenCallIds.has(callId)) return;

        // Authority claim MUST precede every local side effect and fail closed.
        let claimed = false;
        try {
            claimed = await this.remoteChannel.markCallExecuting(callId);
        } catch (error) {
            console.error(`❌ Could not claim ${callId}; refusing execution:`, error);
            await captureRemote('remote_device_call_claim_failed', { error, callId });
            return;
        }
        if (!claimed) return;
        // Remember only after a successful claim. Pre-claim transport failures
        // remain eligible for a later pending-row delivery.
        this.rememberCallId(callId);

        let afterCommit: (() => void) | undefined;
        try {
            let result: unknown;            if (toolName === '__control.ping' || toolName === 'ping') {
                result = {
                    content: [{ type: 'text', text: `pong ${new Date().toISOString()}` }],
                };
            } else if (toolName === '__control.reconnect') {
                result = {
                    content: [{ type: 'text', text: `Reconnect accepted at ${new Date().toISOString()}` }],
                };
                afterCommit = () => setTimeout(
                    () => void this.remoteChannel.forceReconnect('remote control request'),
                    250,
                );
            } else if (toolName === '__control.shutdown' || toolName === 'shutdown') {
                result = {
                    content: [{ type: 'text', text: `Shutdown accepted at ${new Date().toISOString()}` }],
                };
                afterCommit = () => setTimeout(
                    () => void this.shutdown().finally(() => process.exit(0)),
                    250,
                );
            } else {
                result = await this.desktop.callClientTool(toolName, toolArgs, metadata);
            }

            // Completion must be durable before reconnect/shutdown destroys transport.
            await this.remoteChannel.updateCallResult(callId, 'completed', result);
            afterCommit?.();
        } catch (error: any) {
            console.error(`❌ Tool call ${toolName} failed:`, error?.message ?? error);
            await captureRemote('remote_device_tool_call_failed', { error, tool_name: toolName });            // If execution happened but completion cannot be persisted, never replay.
            // The server-side cleanup path turns stale executing calls indeterminate.
            await this.remoteChannel.updateCallResult(
                callId,
                'failed',
                null,
                error?.message ?? String(error),
            ).catch((reportError) => {
                console.error(`❌ Could not persist failure for ${callId}:`, reportError);
            });
        }
    }

    async shutdown(): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        console.log('\n🛑 Shutting down device...');
        try {
            await this.remoteChannel.shutdown();
        } finally {
            await this.desktop.shutdown().catch(() => undefined);
        }
        console.log('✓ Device shutdown complete');
    }
}

const isMainModule = process.argv[1] && (
    import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === process.argv[1] ||
    process.argv[1].endsWith('desktop-commander-device') ||
    process.argv[1].endsWith('desktop-commander-device.js')
);
if (isMainModule) {
    const args = process.argv.slice(2);
    const options = { persistSession: !args.includes('--no-persist-session') };
    if (!options.persistSession) {
        console.log('🔓 OAuth credential persistence disabled — re-authorization required on every start');
    }
    const device = new MCPDevice(options);
    device.start().catch(() => process.exit(1));
}
