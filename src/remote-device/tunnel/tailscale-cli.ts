import { CommandRunner, parseJsonOutput, type CommandResult, type CommandRunnerLike } from "./command-runner.js";

export type TailscaleStatus = { online: boolean; dnsName?: string; backendState?: string; raw: unknown };
export type TailscaleFunnelStatus = { enabled: boolean; raw: unknown; output: string; targetMatches?: boolean };

type JsonRecord = Record<string, unknown>;

export class TailscaleCli {
  constructor(
    private readonly runner: CommandRunnerLike = new CommandRunner(),
    private readonly command = process.env.TAILSCALE_BIN ?? "tailscale",
  ) {}

  async preflight(): Promise<void> {
    const version = await this.runner.run(this.command, ["version"], { timeoutMs: 10_000 });
    const hardMinimum: [number, number, number] = [1, 52, 0];
    const requested = parseVersion(process.env.DC_TAILSCALE_MIN_VERSION ?? "1.52.0");
    const minimum: [number, number, number] = requested && compareVersions(requested, hardMinimum) > 0 ? requested : hardMinimum;
    const installed = parseVersion(version.stdout);
    if (!installed || compareVersions(installed, minimum) < 0) {
      throw new Error(`Tailscale ${minimum.join(".")} or newer is required for Funnel (installed: ${installed?.join(".") ?? "unknown"})`);
    }
    try {
      await this.runner.run(this.command, ["funnel", "status", "--json"], { timeoutMs: 10_000 });
    } catch (error) {
      throw new Error(`Installed Tailscale does not provide usable Funnel support or is not authenticated. Run 'tailscale up' and verify Funnel access: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async status(): Promise<TailscaleStatus> {
    const result = await this.runner.run(this.command, ["status", "--json"], { timeoutMs: 10_000 });
    return parseTailscaleStatus(result.stdout);
  }

  async funnelStatus(localTarget?: string): Promise<TailscaleFunnelStatus> {
    const result = await this.runner.run(this.command, ["funnel", "status", "--json"], { timeoutMs: 10_000 });
    const raw = parseJsonOutput<JsonRecord>(result.stdout);
    return {
      enabled: hasHttps443Funnel(raw),
      raw,
      output: result.stdout,
      targetMatches: localTarget === undefined ? undefined : containsConfiguredTarget(raw, localTarget),
    };
  }

  async enableFunnel(localTarget: string): Promise<CommandResult> {
    validateTarget(localTarget);
    return this.runner.run(this.command, ["funnel", "--bg", "--https=443", localTarget], { timeoutMs: 30_000 });
  }

  async disableFunnel(): Promise<void> {
    await this.runner.run(this.command, ["funnel", "--https=443", "off"], { timeoutMs: 30_000 });
  }

  async console(): Promise<string> {
    const result = await this.runner.run(this.command, ["funnel", "status"]);
    return result.stdout || result.stderr;
  }
}

export function parseTailscaleStatus(output: string): TailscaleStatus {
  const raw = parseJsonOutput<Record<string, any>>(output);
  const self = raw?.Self ?? raw?.self ?? {};
  const dnsName = String(self.DNSName ?? self.dnsName ?? raw?.DNSName ?? "").replace(/\.$/, "") || undefined;
  const backendState = String(raw?.BackendState ?? raw?.backendState ?? "");
  return { online: Boolean(self.Online ?? self.online ?? backendState.toLowerCase() === "running"), dnsName, backendState: backendState || undefined, raw };
}

/** True only when the ServeConfig explicitly permits Funnel ingress on HTTPS 443. */
export function isFunnelEnabled(output: string): boolean {
  return hasHttps443Funnel(parseJsonOutput<JsonRecord>(output));
}

/**
 * Match only the Web handler attached to a host:443 entry whose AllowFunnel
 * value is true. A tailnet-only Serve mapping is deliberately not ownership.
 */
export function containsConfiguredTarget(raw: unknown, localTarget: string): boolean {
  const config = asRecord(raw);
  if (!config) return false;
  const allowFunnel = asRecord(config.AllowFunnel ?? config.allowFunnel);
  const web = asRecord(config.Web ?? config.web);
  if (!allowFunnel || !web) return false;

  const expected = normalizeTarget(localTarget);
  for (const [hostPort, allowed] of Object.entries(allowFunnel)) {
    if (allowed !== true || !/:443$/.test(hostPort)) continue;
    const server = asRecord(web[hostPort]);
    const handlers = asRecord(server?.Handlers ?? server?.handlers);
    if (!handlers) continue;
    for (const handlerValue of Object.values(handlers)) {
      const handler = asRecord(handlerValue);
      const proxy = stringField(handler, "Proxy", "proxy");
      if (!proxy) continue;
      try {
        if (normalizeTarget(proxy) === expected) return true;
      } catch {
        // Ignore malformed unrelated handlers rather than claiming ownership.
      }
    }
  }
  return false;
}

export function extractHttpsUrl(output: string): string | undefined {
  return output.match(/https:\/\/[^\s"']+/i)?.[0]?.replace(/[),.;]+$/, "");
}

function hasHttps443Funnel(raw: unknown): boolean {
  const config = asRecord(raw);
  const allowFunnel = asRecord(config?.AllowFunnel ?? config?.allowFunnel);
  return Boolean(allowFunnel && Object.entries(allowFunnel).some(([hostPort, allowed]) => allowed === true && /:443$/.test(hostPort)));
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}
function stringField(record: JsonRecord | null, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return undefined;
}
function parseVersion(output: string): [number, number, number] | null {
  const match = output.match(/\b(\d+)\.(\d+)(?:\.(\d+))?\b/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}
function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
function normalizeTarget(value: string): string {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  return new URL(candidate).toString().replace(/\/$/, "");
}
function validateTarget(target: string): void {
  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Tunnel target must be an HTTP(S) URL: ${target}`);
}
