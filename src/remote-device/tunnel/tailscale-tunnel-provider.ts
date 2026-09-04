import { TailscaleCli } from "./tailscale-cli.js";
import { TailscaleIdentityStore } from "./tailscale-identity-store.js";
import { checkAuthorizationServerMetadata, checkHttpEndpoint, checkProtectedResourceMetadata, joinHttpUrl, makeDoctorReport, publicMcpUrl } from "./tunnel-health.js";
import type { TunnelDoctorCheck, TunnelProvider, TunnelProviderOptions, TunnelState } from "./types.js";


type TailscaleCliLike = Pick<TailscaleCli, "preflight" | "status" | "funnelStatus" | "enableFunnel" | "disableFunnel" | "console">;

export class TailscaleTunnelProvider implements TunnelProvider {
  readonly name = "tailscale" as const;
  private current: TunnelState;
  private startedAt?: string;
  private enabledByThisStart = false;
  private funnelWasAbsentAtStart = false;

  constructor(
    private readonly options: TunnelProviderOptions,
    private readonly cli: TailscaleCliLike = new TailscaleCli(),
    private readonly store = new TailscaleIdentityStore(options.statePath),
  ) {
    this.current = emptyState(this.name, options.localTarget);
  }

  async start(): Promise<TunnelState> {
    this.enabledByThisStart = false;
    this.funnelWasAbsentAtStart = false;
    const localTarget = validateHttpUrl(this.options.localTarget);
    const localCheck = await checkHttpEndpoint(
      joinHttpUrl(localTarget, healthPath(this.options.healthPath)),
      "local-target",
    );
    if (!localCheck.ok) throw new Error(`Local tunnel target is unhealthy: ${localCheck.detail}`);

    await this.cli.preflight();
    const machine = await this.cli.status();
    if (!machine.online) {
      throw new Error(`Tailscale is not online${machine.backendState ? ` (${machine.backendState})` : ""}`);
    }

    let funnel = await this.cli.funnelStatus(localTarget);
    if (funnel.enabled && funnel.targetMatches !== true) {
      throw new Error("Tailscale Funnel port 443 is already configured for another or unknown target. Use the explicit tunnel restart command with --force only if replacing it is intentional.");
    }

    if (!funnel.enabled) {
      this.funnelWasAbsentAtStart = true;
      try {
        await this.cli.enableFunnel(localTarget);
      } catch (error) {
        await this.capturePostEnableOwnership(localTarget);
        throw error;
      }
      funnel = await this.cli.funnelStatus(localTarget);
      if (funnel.enabled && funnel.targetMatches === true) {
        this.enabledByThisStart = true;
      }
    }

    if (!funnel.enabled || funnel.targetMatches !== true) {
      throw new Error("Tailscale Funnel did not become active for the expected target");
    }

    this.startedAt ??= new Date().toISOString();
    return this.status();
  }

  async restart(): Promise<void> {
    const localTarget = validateHttpUrl(this.options.localTarget);
    const localCheck = await checkHttpEndpoint(
      joinHttpUrl(localTarget, healthPath(this.options.healthPath)),
      "local-target",
    );
    if (!localCheck.ok) throw new Error(`Cannot repair Funnel while local target is unhealthy: ${localCheck.detail}`);

    const machine = await this.cli.status();
    if (!machine.online) throw new Error("Cannot repair Funnel while Tailscale is offline");

    const before = await this.cli.funnelStatus(localTarget);
    if (before.enabled && before.targetMatches !== true && !this.options.force) {
      throw new Error("Refusing to repair Tailscale Funnel: port 443 is owned by another or unknown target. Use --force to replace it explicitly.");
    }

    // Reapply the same mapping. Tailscale retains the node/DNS identity; this
    // repairs a stale or missing Funnel configuration without resetting it.
    await this.cli.enableFunnel(localTarget);
    const after = await this.cli.funnelStatus(localTarget);
    if (!after.enabled || after.targetMatches !== true) {
      throw new Error("Funnel repair did not restore the expected mapping");
    }
  }

  async rollbackStartup(): Promise<void> {
    if (!this.funnelWasAbsentAtStart && !this.enabledByThisStart) return;
    this.funnelWasAbsentAtStart = false;
    this.enabledByThisStart = false;

    // A provider command can mutate Funnel and then lose its response. Query
    // current state before undoing anything, and only remove our exact mapping.
    const localTarget = validateHttpUrl(this.options.localTarget);
    const observed = await this.cli.funnelStatus(localTarget).catch(() => null);
    if (observed?.enabled && observed.targetMatches === true) {
      await this.cli.disableFunnel().catch(() => undefined);
      this.current = offlineState(localTarget, "Funnel created by failed startup was removed");
    }
  }

  async status(): Promise<TunnelState> {
    const localTarget = validateHttpUrl(this.options.localTarget);
    try {
      const [machine, funnel, stored] = await Promise.all([
        this.cli.status(),
        this.cli.funnelStatus(localTarget),
        this.store.load(),
      ]);
      const observedDnsName = machine.dnsName ?? extractDnsName(funnel.output);
      const observedPublicBaseUrl = observedDnsName ? `https://${observedDnsName}` : undefined;

      if (!stored && observedDnsName) {
        await this.store.save({
          provider: this.name,
          dnsName: observedDnsName,
          publicBaseUrl: observedPublicBaseUrl!,
        });
      }

      const canonical = stored ?? (observedDnsName && observedPublicBaseUrl
        ? { provider: this.name, dnsName: observedDnsName, publicBaseUrl: observedPublicBaseUrl }
        : null);
      const identityDrift = Boolean(
        stored && observedDnsName && stored.dnsName !== observedDnsName,
      );
      const publicBaseUrl = canonical?.publicBaseUrl;
      const expectedMcpUrl = publicBaseUrl ? publicMcpUrl(publicBaseUrl) : undefined;
      const transportHealthy = machine.online && funnel.enabled && funnel.targetMatches === true && Boolean(canonical);
      const backendCheck = await checkHttpEndpoint(
        joinHttpUrl(localTarget, healthPath(this.options.healthPath)),
        "local-target",
      );
      const publicCheck = publicBaseUrl
        ? await checkHttpEndpoint(joinHttpUrl(publicBaseUrl, healthPath(this.options.healthPath)), "public-target")
        : failedCheck("public-target", "No stable public DNS identity");
      const metadataCheck = publicBaseUrl && expectedMcpUrl
        ? await checkProtectedResourceMetadata(publicBaseUrl, expectedMcpUrl)
        : failedCheck("public-oauth-resource", "No stable public DNS identity");
      const authorizationCheck = publicBaseUrl
        ? await checkAuthorizationServerMetadata(publicBaseUrl)
        : failedCheck("public-oauth-authorization-server", "No stable public DNS identity");
      const publicHealthy = !identityDrift && publicCheck.ok && metadataCheck.ok && authorizationCheck.ok;
      const healthy = transportHealthy && backendCheck.ok && publicHealthy;
      const detail = identityDrift
        ? `Tailscale public identity drift: expected ${stored!.publicBaseUrl}, observed ${observedPublicBaseUrl ?? "<missing>"}`
        : !transportHealthy
          ? "Tailscale/Funnel transport unavailable or mapped to an unexpected target"
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
        identity: canonical?.dnsName,
        publicBaseUrl,
        publicMcpUrl: expectedMcpUrl,
        identityDrift: identityDrift || undefined,
        expectedPublicBaseUrl: identityDrift ? stored!.publicBaseUrl : undefined,
        observedPublicBaseUrl: identityDrift ? observedPublicBaseUrl : undefined,
        localTarget,
        startedAt: this.startedAt,
        detail,
      };
    } catch (error) {
      this.current = {
        ...this.current,
        status: "offline",
        healthy: false,
        transportHealthy: false,
        backendHealthy: false,
        publicHealthy: false,
        localTarget,
        detail: String(error),
      };
    }
    return this.current;
  }

  async stop(): Promise<void> {
    const localTarget = validateHttpUrl(this.options.localTarget);
    const current = await this.cli.funnelStatus(localTarget);
    if (!current.enabled) {
      this.current = offlineState(localTarget, "HTTPS Funnel already disabled");
      return;
    }
    if (current.targetMatches !== true && !this.options.force) {
      throw new Error("Refusing to disable Tailscale Funnel: port 443 is not provably mapped to this configured target. Use --force for an explicit destructive override.");
    }
    await this.cli.disableFunnel();
    this.current = offlineState(localTarget, "HTTPS Funnel disabled");
  }

  async doctor() {
    const state = await this.status();
    const checks: TunnelDoctorCheck[] = [];
    try {
      await this.cli.preflight();
      checks.push({ name: "tailscale-cli", ok: true, detail: "Modern Funnel CLI is available and authenticated" });
    } catch (error) {
      checks.push({ name: "tailscale-cli", ok: false, detail: String(error) });
    }

    const machine = await this.cli.status().catch(() => null);
    checks.push({
      name: "tailscale-node-online",
      ok: machine?.online === true,
      detail: machine?.backendState ?? "Tailscale status unavailable",
    });

    const funnel = await this.cli.funnelStatus(state.localTarget).catch(() => null);
    checks.push({
      name: "funnel-enabled",
      ok: funnel?.enabled === true,
      detail: funnel?.enabled === true ? "HTTPS Funnel is enabled" : "HTTPS Funnel is disabled or unavailable",
    });
    checks.push({
      name: "funnel-target",
      ok: funnel?.targetMatches === true,
      detail: funnel?.targetMatches === true ? `Maps to ${state.localTarget}` : "Expected Funnel target is not proven",
    });
    checks.push({
      name: "stable-public-identity",
      ok: state.identityDrift !== true && Boolean(state.publicBaseUrl),
      detail: state.identityDrift === true
        ? state.detail ?? "Public identity drift detected"
        : state.publicBaseUrl ?? "No persisted public identity",
    });
    checks.push(await checkHttpEndpoint(joinHttpUrl(state.localTarget, healthPath(this.options.healthPath)), "local-backend"));
    if (state.publicBaseUrl && state.publicMcpUrl) {
      checks.push(await checkHttpEndpoint(joinHttpUrl(state.publicBaseUrl, healthPath(this.options.healthPath)), "public-http"));
      checks.push(await checkProtectedResourceMetadata(state.publicBaseUrl, state.publicMcpUrl));
      checks.push(await checkAuthorizationServerMetadata(state.publicBaseUrl));
    } else {
      checks.push(failedCheck("public-http", "No stable public identity"));
      checks.push(failedCheck("public-oauth-resource", "No stable public identity"));
      checks.push(failedCheck("public-oauth-authorization-server", "No stable public identity"));
    }
    return makeDoctorReport(this.name, state, checks);
  }

  async console(): Promise<string> { return this.cli.console(); }

  private async capturePostEnableOwnership(localTarget: string): Promise<void> {
    if (!this.funnelWasAbsentAtStart) return;
    const observed = await this.cli.funnelStatus(localTarget).catch(() => null);
    if (observed?.enabled && observed.targetMatches === true) this.enabledByThisStart = true;
  }
}

function emptyState(provider: "tailscale", localTarget: string): TunnelState {
  return { provider, status: "offline", healthy: false, transportHealthy: false, backendHealthy: false, publicHealthy: false, localTarget };
}
function offlineState(localTarget: string, detail: string): TunnelState {
  return { provider: "tailscale", status: "offline", healthy: false, transportHealthy: false, backendHealthy: false, publicHealthy: false, localTarget, detail };
}
function failedCheck(name: string, detail: string): TunnelDoctorCheck {
  return { name, ok: false, detail };
}
function validateHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Tunnel target must be HTTP(S): ${value}`);
  return url.toString().replace(/\/$/, "");
}
function healthPath(value = "/.well-known/oauth-protected-resource/mcp"): string { return value.startsWith("/") ? value : `/${value}`; }
function extractDnsName(output: string): string | undefined { return output.match(/https:\/\/([^/\s"']+)/i)?.[1]?.replace(/[),.;]+$/, ""); }
