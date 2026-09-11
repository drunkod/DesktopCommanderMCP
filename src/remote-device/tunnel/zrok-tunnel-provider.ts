import { ZrokCli, type ZrokAgentStatus, type ZrokShare } from "./zrok-cli.js";
import { defaultZrokName, ZrokNameStore, type ZrokStoredIdentity } from "./zrok-name-store.js";
import { checkAuthorizationServerMetadata, checkHttpEndpoint, checkProtectedResourceMetadata, joinHttpUrl, makeDoctorReport, publicMcpUrl } from "./tunnel-health.js";
import { MacosLaunchAgent } from "./macos-launch-agent.js";
import type { TunnelDoctorCheck, TunnelProvider, TunnelProviderOptions, TunnelState } from "./types.js";

type ZrokCliLike = Pick<ZrokCli, "findName" | "createName" | "agentStatus" | "startAgent" | "sharePublic" | "releaseShare" | "deleteName" | "console"> & { preflight?: () => Promise<void> };

export class ZrokTunnelProvider implements TunnelProvider {
  readonly name = "zrok" as const;
  private current: TunnelState;
  private identity: ZrokStoredIdentity | null = null;
  private shareStartedByThisStart = false;
  private shareWasAbsentAtStart = false;

  constructor(
    private readonly options: TunnelProviderOptions,
    private readonly cli: ZrokCliLike = new ZrokCli(),
    private readonly store = new ZrokNameStore(options.statePath),
    private readonly launchAgent = new MacosLaunchAgent(),
  ) {
    this.current = emptyState(this.name, options.localTarget);
  }

  async start(): Promise<TunnelState> {
    this.shareStartedByThisStart = false;
    this.shareWasAbsentAtStart = false;
    const stored = await this.store.load();
    const localTarget = this.resolveStartupTarget(stored);
    await assertLocalHealth(localTarget, this.options.healthPath);
    await this.cli.preflight?.();

    let recoveredExistingName = false;
    if (stored) {
      assertIdentityOptions(stored, this.options);
      this.identity = { ...stored, localTarget };
    } else {
      const namespace = this.options.namespace;
      if (!namespace) throw new Error("A zrok namespace is required on first setup. Use --tunnel-namespace or DC_ZROK_NAMESPACE.");
      const name = this.options.name ?? defaultZrokName();
      const existing = await this.cli.findName(namespace, name);
      if (existing && existing.reserved !== true) {
        throw new Error(`zrok name ${namespace}:${name} exists but its reserved status cannot be proven`);
      }
      if (existing) recoveredExistingName = true;
      const authoritative = existing ?? await this.cli.createName(namespace, name);
      if (authoritative.namespace !== namespace || authoritative.name !== name) {
        throw new Error(`zrok returned unexpected identity ${authoritative.namespace}:${authoritative.name}; expected ${namespace}:${name}`);
      }
      if (authoritative.reserved !== true) {
        throw new Error(`zrok identity ${namespace}:${name} is not proven reserved`);
      }
      this.identity = {
        provider: this.name,
        namespace: authoritative.namespace,
        name: authoritative.name,
        publicBaseUrl: normalizeBaseUrl(authoritative.publicUrl),
        localTarget,
      };
    }

    const durableIdentityAlreadyExisted = Boolean(stored) || recoveredExistingName;
    let agent = await this.cli.agentStatus().catch(() => ({ running: false, shares: [], raw: null }));
    if (!agent.running) {
      await this.cli.startAgent();
      agent = await this.waitForAgent();
    }

    let existing = findShare(agent.shares, this.identity!);
    if (!existing && durableIdentityAlreadyExisted) {
      // A restarted agent may report running before it restores named shares.
      existing = await this.waitForNamedShare(this.identity!).catch(() => undefined);
    }
    this.shareWasAbsentAtStart = !existing;
    if (existing && !sameTarget(existing.target, localTarget)) {
      throw new Error(`Reserved zrok share ${this.identity!.namespace}:${this.identity!.name} points at ${existing.target ?? "<unknown>"} instead of ${localTarget}. Use the explicit restart command to repair it.`);
    }

    let publicUrl = existing?.publicUrl ?? this.identity!.publicBaseUrl;
    if (!existing) {
      try {
        const shared = await this.cli.sharePublic(localTarget, this.identity!.namespace, this.identity!.name);
        const observed = await this.waitForNamedShare(this.identity!);
        if (sameTarget(observed.target, localTarget)) this.shareStartedByThisStart = true;
        publicUrl = observed.publicUrl ?? shared.publicUrl;
      } catch (error) {
        // share public may have succeeded remotely before the CLI lost its reply.
        const observed = await this.waitForNamedShare(this.identity!, 2_000).catch(() => undefined);
        if (observed && sameTarget(observed.target, localTarget)) this.shareStartedByThisStart = true;
        throw error;
      }
    }

    if (!publicUrl) throw new Error("zrok did not expose a public URL for the reserved name");
    const normalizedPublicUrl = requireHttpsBaseUrl(publicUrl);
    if (this.identity!.publicBaseUrl && !sameBaseUrl(this.identity!.publicBaseUrl, normalizedPublicUrl)) {
      // Preserve the durable identity; status() will report the dedicated drift state.
      await this.store.save(this.identity!);
    } else {
      this.identity = { ...this.identity!, publicBaseUrl: normalizedPublicUrl, localTarget };
      await this.store.save(this.identity);
    }
    return this.status();
  }

  async restart(): Promise<void> {
    const identity = this.identity ?? await this.store.load();
    if (!identity) throw new Error("No reserved zrok identity exists");
    const localTarget = this.options.localTargetExplicit
      ? validateHttpUrl(this.options.localTarget)
      : validateHttpUrl(identity.localTarget);
    await assertLocalHealth(localTarget, this.options.healthPath);

    let agent = await this.cli.agentStatus().catch(() => ({ running: false, shares: [], raw: null }));
    if (!agent.running) {
      await this.cli.startAgent();
      agent = await this.waitForAgent();
    }
    let existing = findShare(agent.shares, identity);
    if (!existing) existing = await this.waitForNamedShare(identity).catch(() => undefined);
    if (existing) await this.cli.releaseShare(requireShareToken(existing, "restart"));

    let observed: ZrokShare;
    try {
      await this.cli.sharePublic(localTarget, identity.namespace, identity.name);
      observed = await this.waitForNamedShare(identity);
    } catch (error) {
      const partial = await this.waitForNamedShare(identity, 2_000).catch(() => undefined);
      if (!partial || !sameTarget(partial.target, localTarget)) throw error;
      observed = partial;
    }
    if (!sameTarget(observed.target, localTarget)) {
      throw new Error(`zrok repair restored an unexpected target ${observed.target ?? "<unknown>"}`);
    }
    const publicUrl = requireHttpsBaseUrl(observed.publicUrl);
    if (identity.publicBaseUrl && !sameBaseUrl(identity.publicBaseUrl, publicUrl)) {
      throw new Error(`zrok repair changed the stable public identity: expected ${identity.publicBaseUrl}, observed ${publicUrl}`);
    }

    const updated = {
      ...identity,
      localTarget,
      publicBaseUrl: identity.publicBaseUrl ?? publicUrl,
    };
    await this.store.save(updated);
    this.identity = updated;
    const state = await this.status();
    if (!state.transportHealthy || state.identityDrift) throw new Error(state.detail ?? "zrok share repair failed");
  }

  async rollbackStartup(): Promise<void> {
    if (!this.shareWasAbsentAtStart && !this.shareStartedByThisStart) return;
    this.shareWasAbsentAtStart = false;
    this.shareStartedByThisStart = false;
    const identity = this.identity ?? await this.store.load();
    if (!identity) return;
    const observed = await this.cli.agentStatus().then((agent) => findShare(agent.shares, identity)).catch(() => undefined);
    if (observed && sameTarget(observed.target, validateHttpUrl(identity.localTarget))) {
      await this.cli.releaseShare(requireShareToken(observed, "startup rollback")).catch(() => undefined);
      this.current = offlineState(identity.localTarget, "Share created by failed startup was removed; reserved name retained");
    }
  }

  async status(): Promise<TunnelState> {
    const identity = this.identity ?? await this.store.load();
    if (!identity) {
      return { ...this.current, status: "offline", healthy: false, transportHealthy: false, backendHealthy: false, publicHealthy: false, detail: "No reserved zrok identity has been created" };
    }
    this.identity = identity;
    const localTarget = validateHttpUrl(identity.localTarget);
    try {
      const agent = await this.cli.agentStatus();
      const share = findShare(agent.shares, identity);
      const observedPublicBaseUrl = normalizeBaseUrl(share?.publicUrl);
      const expectedPublicBaseUrl = normalizeBaseUrl(identity.publicBaseUrl);
      const identityDrift = Boolean(expectedPublicBaseUrl && observedPublicBaseUrl && !sameBaseUrl(expectedPublicBaseUrl, observedPublicBaseUrl));
      const publicBaseUrl = expectedPublicBaseUrl ?? observedPublicBaseUrl;
      const transportHealthy = agent.running && Boolean(share) && sameTarget(share?.target, localTarget);
      if (!expectedPublicBaseUrl && observedPublicBaseUrl && transportHealthy) {
        const updated = { ...identity, publicBaseUrl: observedPublicBaseUrl };
        await this.store.save(updated);
        this.identity = updated;
      }
      const expectedMcpUrl = publicBaseUrl ? publicMcpUrl(publicBaseUrl) : undefined;
      const backendCheck = await checkHttpEndpoint(joinHttpUrl(localTarget, healthPath(this.options.healthPath)), "local-target");
      const publicCheck = publicBaseUrl
        ? await checkHttpEndpoint(joinHttpUrl(publicBaseUrl, healthPath(this.options.healthPath)), "public-target")
        : failedCheck("public-target", "No stable public URL");
      const metadataCheck = publicBaseUrl && expectedMcpUrl && this.options.remoteIdentity
        ? await checkProtectedResourceMetadata(publicBaseUrl, this.options.remoteIdentity)
        : failedCheck("public-oauth-resource", this.options.remoteIdentity ? "No stable public DNS identity" : "No immutable remote identity configured");
      const authorizationCheck = publicBaseUrl && this.options.remoteIdentity
        ? await checkAuthorizationServerMetadata(this.options.remoteIdentity)
        : failedCheck("public-oauth-authorization-server", this.options.remoteIdentity ? "No stable public DNS identity" : "No immutable remote identity configured");
      const publicHealthy = !identityDrift && publicCheck.ok && metadataCheck.ok && authorizationCheck.ok;
      const healthy = transportHealthy && backendCheck.ok && publicHealthy;
      const detail = identityDrift
        ? `zrok public identity drift: expected ${expectedPublicBaseUrl}, observed ${observedPublicBaseUrl ?? "<missing>"}`
        : !agent.running
          ? "zrok agent is not running"
          : !share
            ? "Named zrok share is not present"
            : !sameTarget(share.target, localTarget)
              ? `Named share target is ${share.target ?? "unknown"}, expected ${localTarget}`
              : !backendCheck.ok
                ? backendCheck.detail
                : !publicCheck.ok
                  ? publicCheck.detail
                  : !metadataCheck.ok
                    ? metadataCheck.detail
                    : !authorizationCheck.ok
                      ? authorizationCheck.detail
                      : undefined;
      this.current = {
        ...this.current,
        status: !transportHealthy ? "offline" : healthy ? "online" : "degraded",
        healthy,
        transportHealthy,
        backendHealthy: backendCheck.ok,
        publicHealthy,
        identity: `${identity.namespace}:${identity.name}`,
        publicBaseUrl,
        publicMcpUrl: expectedMcpUrl,
        identityDrift: identityDrift || undefined,
        expectedPublicBaseUrl: identityDrift ? expectedPublicBaseUrl : undefined,
        observedPublicBaseUrl: identityDrift ? observedPublicBaseUrl : undefined,
        localTarget,
        detail,
      };
    } catch (error) {
      this.current = { ...this.current, status: "offline", healthy: false, transportHealthy: false, backendHealthy: false, publicHealthy: false, identity: `${identity.namespace}:${identity.name}`, publicBaseUrl: identity.publicBaseUrl, publicMcpUrl: identity.publicBaseUrl ? publicMcpUrl(identity.publicBaseUrl) : undefined, localTarget, detail: String(error) };
    }
    return this.current;
  }

  async stop(): Promise<void> {
    const identity = this.identity ?? await this.store.load();
    if (identity) {
      const agent = await this.cli.agentStatus().catch((error) => {
        throw new Error(`Refusing to stop zrok share without inspecting current ownership: ${String(error)}`);
      });
      const share = findShare(agent.shares, identity);
      if (share && !sameTarget(share.target, identity.localTarget) && !this.options.force) {
        throw new Error(`Refusing to stop zrok share: ${identity.namespace}:${identity.name} points at ${share.target ?? "<unknown>"}, not ${identity.localTarget}. Use --force for an explicit override.`);
      }
      if (share) await this.cli.releaseShare(requireShareToken(share, "stop"));
    }
    this.current = offlineState(identity?.localTarget ?? this.options.localTarget, "Share stopped; reserved name retained");
  }

  async deleteName(): Promise<void> {
    const identity = this.identity ?? await this.store.load();
    if (!identity) throw new Error("No reserved zrok identity exists");
    const agent = await this.cli.agentStatus().catch((error) => {
      throw new Error(`Refusing to delete zrok name without inspecting current agent shares: ${String(error)}`);
    });
    const share = findShare(agent.shares, identity);
    if (share) await this.cli.releaseShare(requireShareToken(share, "delete-name"));
    await this.cli.deleteName(identity.namespace, identity.name);
    await this.store.remove();
    this.identity = null;
    this.current = emptyState(this.name, this.options.localTarget);
    this.current.detail = "Reserved name deleted";
  }

  async doctor() {
    const state = await this.status();
    const checks: TunnelDoctorCheck[] = [];
    try {
      await this.cli.preflight?.();
      checks.push({ name: "zrok-cli", ok: true, detail: "zrok2 v2 CLI is available" });
    } catch (error) {
      checks.push({ name: "zrok-cli", ok: false, detail: String(error) });
    }
    const identity = this.identity ?? await this.store.load();
    const agent = await this.cli.agentStatus().catch(() => null);
    const share = identity && agent ? findShare(agent.shares, identity) : undefined;
    const name = identity ? await this.cli.findName(identity.namespace, identity.name).catch(() => null) : null;
    checks.push({ name: "zrok-agent", ok: agent?.running === true, detail: agent?.running === true ? "Agent is running" : "Agent is unavailable" });
    checks.push({ name: "reserved-name", ok: name?.reserved === true, detail: name?.reserved === true ? `${name.namespace}:${name.name} is reserved` : "Reserved identity is not proven" });
    checks.push({ name: "named-share-present", ok: Boolean(share), detail: share ? `${share.namespace}:${share.name} is registered with the agent` : "Expected named share is not present" });
    checks.push({ name: "named-share-target", ok: Boolean(share && identity && sameTarget(share.target, identity.localTarget)), detail: share?.target ?? "Expected share target is not proven" });
    checks.push({ name: "stable-public-identity", ok: state.identityDrift !== true && Boolean(state.publicBaseUrl), detail: state.identityDrift === true ? state.detail ?? "Public identity drift detected" : state.publicBaseUrl ?? "No persisted public identity" });
    checks.push(await checkHttpEndpoint(joinHttpUrl(state.localTarget, healthPath(this.options.healthPath)), "local-backend"));
    if (state.publicBaseUrl && state.publicMcpUrl) {
      checks.push(await checkHttpEndpoint(joinHttpUrl(state.publicBaseUrl, healthPath(this.options.healthPath)), "public-http"));
      if (this.options.remoteIdentity) {
        checks.push(await checkProtectedResourceMetadata(state.publicBaseUrl, this.options.remoteIdentity));
        checks.push(await checkAuthorizationServerMetadata(this.options.remoteIdentity));
      } else {
        checks.push(failedCheck("public-oauth-resource", "No immutable remote identity configured"));
        checks.push(failedCheck("public-oauth-authorization-server", "No immutable remote identity configured"));
      }
    } else {
      checks.push(failedCheck("public-http", "No stable public identity"));
      checks.push(failedCheck("public-oauth-resource", "No stable public identity"));
      checks.push(failedCheck("public-oauth-authorization-server", "No stable public identity"));
    }
    return makeDoctorReport(this.name, state, checks);
  }

  async installAgent(): Promise<string> { return this.launchAgent.install(); }
  async uninstallAgent(): Promise<void> { await this.launchAgent.uninstall(); }
  async console(): Promise<string> { return this.cli.console(); }

  private resolveStartupTarget(stored: ZrokStoredIdentity | null): string {
    const configured = validateHttpUrl(this.options.localTarget);
    if (!stored || !this.options.localTargetExplicit) return stored ? validateHttpUrl(stored.localTarget) : configured;
    const persisted = validateHttpUrl(stored.localTarget);
    if (!sameTarget(configured, persisted)) {
      throw new Error(`Configured target ${configured} conflicts with persisted target ${persisted}. Use the explicit tunnel restart/repair command to change it.`);
    }
    return persisted;
  }

  private async waitForAgent(timeoutMs = 15_000): Promise<ZrokAgentStatus> {
    const deadline = Date.now() + timeoutMs;
    let delay = 200;
    while (Date.now() < deadline) {
      try { const state = await this.cli.agentStatus(); if (state.running) return state; } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(Math.floor(delay * 1.5), 1_500);
    }
    throw new Error("zrok agent did not become ready before timeout");
  }

  private async waitForNamedShare(identity: ZrokStoredIdentity, timeoutMs = 15_000): Promise<ZrokShare> {
    const deadline = Date.now() + timeoutMs;
    let delay = 200;
    while (Date.now() < deadline) {
      const agent = await this.cli.agentStatus().catch(() => null);
      const share = agent && findShare(agent.shares, identity);
      if (share) return share;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(Math.floor(delay * 1.5), 1_500);
    }
    throw new Error("zrok named share did not reappear before timeout");
  }
}

function requireShareToken(share: ZrokShare, operation: string): string {
  if (!share.token) throw new Error(`Cannot ${operation}: zrok agent share token is unavailable`);
  return share.token;
}
function findShare(shares: ZrokShare[], identity: ZrokStoredIdentity): ZrokShare | undefined { return shares.find((share) => share.namespace === identity.namespace && share.name === identity.name); }
function sameTarget(actual: string | undefined, expected: string): boolean { if (!actual) return false; try { return normalizeTarget(actual) === normalizeTarget(expected); } catch { return false; } }
function normalizeTarget(value: string): string { const candidate = /^[a-z]+:\/\//i.test(value) ? value : `http://${value}`; return new URL(candidate).toString().replace(/\/$/, ""); }
function sameBaseUrl(left: string, right: string): boolean { return normalizeBaseUrl(left) === normalizeBaseUrl(right); }
function normalizeBaseUrl(value: string | undefined): string | undefined { return value?.replace(/\/$/, "").replace(/\/mcp$/, ""); }
function requireHttpsBaseUrl(value: string | undefined): string { if (!value) throw new Error("zrok did not expose a public HTTPS URL"); const normalized = normalizeBaseUrl(value)!; if (new URL(normalized).protocol !== "https:") throw new Error(`zrok public URL must use HTTPS: ${value}`); return normalized; }
function validateHttpUrl(value: string): string { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Tunnel target must be HTTP(S): ${value}`); return url.toString().replace(/\/$/, ""); }
function healthPath(value = "/.well-known/oauth-protected-resource/mcp"): string { return value.startsWith("/") ? value : `/${value}`; }
async function assertLocalHealth(target: string, configuredPath?: string): Promise<void> { const result = await checkHttpEndpoint(joinHttpUrl(target, healthPath(configuredPath)), "local-target"); if (!result.ok) throw new Error(`Local tunnel target is unhealthy: ${result.detail}`); }
function assertIdentityOptions(identity: ZrokStoredIdentity, options: TunnelProviderOptions): void { if (options.namespace && options.namespace !== identity.namespace) throw new Error(`Configured namespace ${options.namespace} conflicts with persisted identity ${identity.namespace}`); if (options.name && options.name !== identity.name) throw new Error(`Configured name ${options.name} conflicts with persisted identity ${identity.name}`); }
function failedCheck(name: string, detail: string): TunnelDoctorCheck { return { name, ok: false, detail }; }
function emptyState(provider: "zrok", localTarget: string): TunnelState { return { provider, status: "offline", healthy: false, transportHealthy: false, backendHealthy: false, publicHealthy: false, localTarget }; }
function offlineState(localTarget: string, detail: string): TunnelState { return { provider: "zrok", status: "offline", healthy: false, transportHealthy: false, backendHealthy: false, publicHealthy: false, localTarget, detail }; }
