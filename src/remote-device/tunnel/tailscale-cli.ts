import { CommandRunner, parseJsonOutput, type CommandResult, type CommandRunnerLike } from "./command-runner.js";

export type TailscaleStatus = { online: boolean; dnsName?: string; backendState?: string; raw: unknown };
export type TailscaleFunnelStatus = { enabled: boolean; raw: unknown; output: string; targetMatches?: boolean };

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
    const raw = parseJsonOutput(result.stdout);
    return { enabled: isFunnelEnabled(result.stdout), raw, output: result.stdout, targetMatches: localTarget === undefined ? undefined : containsConfiguredTarget(raw, localTarget) };
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

export function isFunnelEnabled(output: string): boolean {
  const raw = parseJsonOutput<any>(output);
  if (typeof raw?.enabled === "boolean") return raw.enabled;
  if (typeof raw?.Enabled === "boolean") return raw.Enabled;
  if (raw?.Services && Object.keys(raw.Services).length > 0) return true;
  return /https?:\/\/[^\s]+/i.test(output) && !/disabled|off|not running/i.test(output);
}

export function containsConfiguredTarget(raw: unknown, localTarget: string): boolean {
  const expected = normalizeTarget(localTarget);
  const visit = (value: unknown): boolean => {
    if (typeof value === "string") {
      try { return normalizeTarget(value) === expected; } catch { return value.includes(localTarget); }
    }
    if (Array.isArray(value)) return value.some(visit);
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(visit);
    return false;
  };
  return visit(raw);
}

export function extractHttpsUrl(output: string): string | undefined {
  return output.match(/https:\/\/[^\s"']+/i)?.[0]?.replace(/[),.;]+$/, "");
}

function parseJson(output: string): unknown { try { return JSON.parse(output); } catch { return null; } }
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
function normalizeTarget(value: string): string { return new URL(value).toString().replace(/\/$/, ""); }
function validateTarget(target: string): void {
  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Tunnel target must be an HTTP(S) URL: ${target}`);
}
