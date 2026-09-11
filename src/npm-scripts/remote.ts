import { MCPDevice } from '../remote-device/device.js';
import os from 'node:os';
import { parseRemoteOptions, type RemoteOptions } from './remote-options.js';
import { createTunnelProvider } from '../remote-device/tunnel/create-tunnel-provider.js';
import { TunnelSupervisor } from '../remote-device/tunnel/tunnel-provider.js';
import { checkAuthorizationServerMetadata, checkProtectedResourceMetadata } from '../remote-device/tunnel/tunnel-health.js';
import { loadRemoteIdentityFromEnv } from '../remote-device/remote-identity.js';
import { NativeCredentialStore } from '../remote-device/native-credential-store.js';
import { DeviceTokenManager } from '../remote-device/token-manager.js';
import { JwksProviderTokenVerifier } from '../remote-device/device-oauth.js';

export async function runRemote() {
    const options = parseRemoteOptions();
    if (options.credentialCommand) {
        await runCredentialCommand(options);
        return;
    }
    if (options.tunnelCommand !== 'run') {
        await runTunnelCommand(options);
        return;
    }
    const remoteIdentity = loadRemoteIdentityFromEnv();

    if (!options.persistSession) {
        console.log('🔓 Session persistence disabled — re-authorization required on every start');
    }
    console.debug('[DEBUG] Verbose mode: ', options.debug);
    if (!options.debug) console.debug = () => { };
    console.debug('[DEBUG] Platform:', os.platform());

    if (options.installTunnelAgent) {
        throw new Error('LaunchAgent setup is explicit: run `desktop-commander remote tunnel install-agent --tunnel zrok` first');
    }

    // A tunnel is deliberately a sidecar. MCP_SERVER_URL remains the private
    // control-plane origin used by OAuth/Jazz; the provider only exposes the
    // explicitly configured HTTP target.
    let tunnel: TunnelSupervisor | undefined;
    try {
        if (options.tunnel) {
            const provider = createTunnelProvider(options.tunnel, {
                localTarget: options.tunnelTarget,
                healthPath: options.tunnelHealthPath,
                name: options.tunnelName,
                namespace: options.tunnelNamespace,
                localTargetExplicit: options.tunnelTargetExplicit,
                force: options.force,
                remoteIdentity,
            });
            tunnel = new TunnelSupervisor(provider, {
                onState: (state) => console.debug('[DEBUG] Tunnel state:', JSON.stringify(state)),
            });
            const state = await tunnel.start();
            if (!state.publicBaseUrl || !state.publicMcpUrl || !state.transportHealthy) {
                throw new Error('Tunnel provider did not expose a stable, connected public MCP URL');
            }

            // The tunnel is only transport. OAuth/Jazz device traffic stays on
            // MCP_SERVER_URL, while browser/ChatGPT identity uses the public
            // origin. The already-running control plane must have been started
            // with APP_ORIGIN and REMOTE_MCP_RESOURCE; changing this process's
            // environment cannot reconfigure that separate server.
            const resourceCheck = await checkProtectedResourceMetadata(state.publicBaseUrl, remoteIdentity);
            const authorizationCheck = await checkAuthorizationServerMetadata(remoteIdentity);
            if (!resourceCheck.ok || !authorizationCheck.ok) {
                throw new Error(`Public MCP/OAuth identity is not ready: ${resourceCheck.ok ? authorizationCheck.detail : resourceCheck.detail}`);
            }
        }

        await startNoSleep(options);
        const device = new MCPDevice({ persistSession: options.persistSession });
        await device.start();

        if (tunnel) {
            const state = tunnel.currentState;
            if (!state?.publicBaseUrl || !state.publicMcpUrl || !state.healthy) {
                throw new Error('Remote MCP device started, but end-to-end public MCP readiness was not established');
            }
            console.log(`🌐 Stable remote MCP URL: ${state.publicMcpUrl}`);
            console.log('   Public OAuth metadata and local device registration are ready; retain this URL in ChatGPT.');
        }
    } catch (error) {
        // A failed startup may have already mutated Funnel/share state. Tear down
        // only this failed startup; normal process shutdown merely closes the
        // supervisor and preserves persistent provider identity.
        await tunnel?.rollbackStartup().catch(() => undefined);
        throw error;
    }
}

async function runCredentialCommand(options: RemoteOptions): Promise<void> {
    const identity = loadRemoteIdentityFromEnv();
    const store = new NativeCredentialStore(identity);
    if (options.credentialCommand === 'clear') {
        const manager = new DeviceTokenManager(store, identity, new JwksProviderTokenVerifier());
        await manager.clearExplicitly();
        console.log('✅ Device OAuth credential cleared; refresh authority was revoked or cleanup was durably queued');
        return;
    }
    if (options.credentialCommand === 'repair') {
        if (!options.confirm || !options.force) {
            throw new Error('Legacy credential repair requires --confirm --force after server-side/operator revocation');
        }
        const result = await store.repairLegacyCredential(true);
        console.log(`✅ Legacy credential repair result: ${result}`);
        return;
    }
    throw new Error(`Unsupported credentials command: ${options.credentialCommand}`);
}

async function runTunnelCommand(options: RemoteOptions): Promise<void> {
    if (!options.tunnel) throw new Error('Tunnel provider is required (use --tunnel tailscale or --tunnel zrok)');
    const provider = createTunnelProvider(options.tunnel, {
        localTarget: options.tunnelTarget,
        healthPath: options.tunnelHealthPath,
        name: options.tunnelName,
        namespace: options.tunnelNamespace,
        localTargetExplicit: options.tunnelTargetExplicit,
        force: options.force,
        ...(["status", "doctor", "restart"].includes(options.tunnelCommand)
            ? { remoteIdentity: loadRemoteIdentityFromEnv() }
            : {}),
    });
    switch (options.tunnelCommand) {
        case 'prepare': {
            try {
                const state = await provider.start();
                if (!state.transportHealthy || !state.publicBaseUrl || !state.publicMcpUrl) {
                    throw new Error(`${options.tunnel} did not establish a stable public transport`);
                }
                console.log('');
                console.log('✅ Stable tunnel identity prepared');
                console.log('');
                console.log(`APP_ORIGIN=${state.publicBaseUrl}`);
                console.log(`REMOTE_MCP_RESOURCE=${state.publicMcpUrl}`);
                console.log(`MCP_SERVER_URL=${state.localTarget}`);
                console.log('');
                console.log('Restart the RemoteMCP-Jazz control plane with APP_ORIGIN and REMOTE_MCP_RESOURCE above.');
                console.log('Then run the device with the same public OAuth identity:');
                console.log(`APP_ORIGIN=${state.publicBaseUrl} REMOTE_MCP_RESOURCE=${state.publicMcpUrl} MCP_SERVER_URL=${state.localTarget} desktop-commander remote --tunnel ${options.tunnel}`);
            } catch (error) {
                await provider.rollbackStartup?.().catch(() => undefined);
                throw error;
            }
            break;
        }
        case 'status':
            console.log(JSON.stringify(await provider.status(), null, 2));
            break;
        case 'doctor':
            console.log(JSON.stringify(await provider.doctor(), null, 2));
            break;
        case 'console':
            console.log(await provider.console?.() ?? 'Provider console is unavailable');
            break;
        case 'install-agent':
            if (options.tunnel !== 'zrok' || !provider.installAgent) {
                throw new Error('The LaunchAgent is available only for zrok');
            }
            console.log(`✅ zrok LaunchAgent installed at ${await provider.installAgent()}`);
            break;
        case 'uninstall-agent':
            if (options.tunnel !== 'zrok' || !provider.uninstallAgent) {
                throw new Error('LaunchAgent removal is available only for zrok');
            }
            await provider.uninstallAgent();
            console.log('✅ zrok LaunchAgent removed; reserved zrok name was not deleted');
            break;
        case 'restart': {
            await provider.restart();
            const state = await provider.status();
            console.log(JSON.stringify(state, null, 2));
            if (!state.transportHealthy) throw new Error(`${options.tunnel} transport is still unhealthy after restart`);
            break;
        }
        case 'stop':
        case 'disable':
            await provider.stop();
            console.log(`✅ ${options.tunnel} tunnel share stopped; stable identity retained`);
            break;
        case 'delete-name':
            if (options.tunnel !== 'zrok' || !options.confirm || !provider.deleteName) {
                throw new Error('Deleting a zrok name requires --tunnel zrok --confirm');
            }
            await provider.deleteName();
            console.log('✅ zrok reserved name deleted');
            break;
        default:
            throw new Error(`Unsupported tunnel command: ${options.tunnelCommand}`);
    }
}

async function startNoSleep(options: RemoteOptions): Promise<void> {
    if (options.disableNoSleep || os.platform() !== 'darwin') return;
    try {
        console.debug('[DEBUG] Start caffeinate', process.pid);
        const { default: caffeinate } = await import('caffeinate');
        caffeinate({ pid: process.pid });
        console.log('☕ No sleep mode enabled');
    } catch (error) {
        console.warn('⚠️ Failed to start caffeinate:', error);
    }
}
