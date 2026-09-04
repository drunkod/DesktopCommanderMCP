import { CommandRunner, parseJsonOutput, type CommandResult, type CommandRunnerLike } from "./command-runner.js";

export type ZrokAgentStatus = { running: boolean; shares: ZrokShare[]; raw: unknown };
export type ZrokShare = { namespace: string; name: string; publicUrl?: string; target?: string; raw?: unknown };
export type ZrokNameInfo = { namespace: string; name: string; publicUrl?: string; reserved?: boolean };

export class ZrokCli {
  constructor(private readonly runner: CommandRunnerLike = new CommandRunner(), private readonly command = process.env.ZROK_BIN ?? "zrok2") {}

  async preflight(): Promise<void> {
    const result = await this.runner.run(this.command, ["version"], { timeoutMs: 10_000 });
    const version = parseVersion(result.stdout);
    if (!version || version[0] !== 2) {
      throw new Error(`Unsupported zrok2 version ${version?.join(".") ?? "unknown"}; this adapter requires zrok2 v2.x`);
    }
    // Exercise the JSON command forms before any name/share mutation. Agent
    // status is allowed to fail here because first-time setup may not have an
    // agent yet; the provider will start one and poll it later.
    await this.listNamespaces();
    await this.listNames();
    await this.agentStatus().catch(() => undefined);
  }

  async listNamespaces(): Promise<unknown[]> {
    const result = await this.runner.run(this.command, ["list", "namespaces", "--json"]);
    const raw = parseJsonOutput<any>(result.stdout);
    return Array.isArray(raw) ? raw : raw?.namespaces ?? raw?.Namespaces ?? [];
  }

  async listNames(namespace?: string): Promise<ZrokNameInfo[]> {
    const args = ["list", "names", "--json"];
    if (namespace) { validatePart(namespace, "namespace"); args.push("-n", namespace); }
    const result = await this.runner.run(this.command, args);
    const raw = parseJsonOutput<any>(result.stdout);
    const values = Array.isArray(raw) ? raw : raw?.names ?? raw?.Names ?? [];
    if (!Array.isArray(values)) return [];
    return values.flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const qualified = stringField(record, "namespace", "Namespace");
      const name = stringField(record, "name", "Name");
      // Namespace is authoritative identity. Never infer it from the query or
      // fabricate a "default" namespace when the CLI omitted it.
      if (!qualified || !name) return [];
      const publicUrl = stringField(record, "publicUrl", "PublicURL", "url", "URL");
      const reserved = booleanField(record, "reserved", "Reserved");
      return [{ namespace: qualified, name, publicUrl, reserved }];
    });
  }

  async findName(namespace: string, name: string): Promise<ZrokNameInfo | null> {
    validatePart(namespace, "namespace"); validatePart(name, "name");
    return (await this.listNames(namespace)).find((value) => value.namespace === namespace && value.name === name) ?? null;
  }

  async agentStatus(): Promise<ZrokAgentStatus> {
    const result = await this.runner.run(this.command, ["agent", "status", "--json"]);
    return parseZrokAgentStatus(result.stdout);
  }

  async startAgent(): Promise<number> { return this.runner.runDetached(this.command, ["agent", "start"]); }

  async createName(namespace: string, name: string): Promise<ZrokNameInfo> {
    validatePart(namespace, "namespace"); validatePart(name, "name");
    const result = await this.runner.run(this.command, ["create", "name", "-n", namespace, name]);
    const raw = parseJsonOutput<any>(result.stdout);
    const reportedNamespace = raw?.namespace ?? raw?.Namespace;
    const reportedName = raw?.name ?? raw?.Name;
    if (reportedNamespace !== undefined && reportedNamespace !== namespace) throw new Error(`zrok created unexpected namespace ${reportedNamespace}; expected ${namespace}`);
    if (reportedName !== undefined && reportedName !== name) throw new Error(`zrok created unexpected name ${reportedName}; expected ${name}`);
    const created = await this.findName(namespace, name);
    if (!created) throw new Error(`zrok did not confirm the reserved identity ${namespace}:${name} after creation`);
    return created;
  }

  async sharePublic(target: string, namespace: string, name: string): Promise<{ result: CommandResult; publicUrl?: string }> {
    validateTarget(target); validatePart(namespace, "namespace"); validatePart(name, "name");
    const result = await this.runner.run(this.command, ["share", "public", target, "--headless", "-n", `${namespace}:${name}`]);
    return { result, publicUrl: extractPublicUrl(result.stdout) };
  }

  async unshare(namespace: string, name: string): Promise<void> { await this.runner.run(this.command, ["unshare", "-n", `${namespace}:${name}`]); }
  async deleteName(namespace: string, name: string): Promise<void> { validatePart(namespace, "namespace"); validatePart(name, "name"); await this.runner.run(this.command, ["delete", "name", "-n", namespace, name]); }
  async console(): Promise<string> { const result = await this.runner.run(this.command, ["agent", "console"]); return result.stdout || result.stderr; }
}

export function parseZrokAgentStatus(output: string): ZrokAgentStatus {
  const raw = parseJsonOutput<any>(output);
  const sharesRaw = raw?.shares ?? raw?.Shares ?? raw?.endpoints ?? raw?.Endpoints ?? [];
  const shares: ZrokShare[] = Array.isArray(sharesRaw) ? sharesRaw.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const share = parseShare(value as Record<string, unknown>);
    return share ? [share] : [];
  }) : [];
  const running = raw?.running === true || raw?.Running === true || raw?.status === "running" || (typeof output === "string" && /\b(running|started)\b/i.test(output) && !/\bnot running\b|\bstopped\b|\boffline\b/i.test(output));
  return { running, shares, raw };
}

export function parseShare(value: Record<string, unknown>): ZrokShare | null {
  const namespace = stringField(value, "namespace", "Namespace");
  const name = stringField(value, "name", "Name");
  if (!namespace || !name) return null;
  return {
    namespace,
    name,
    publicUrl: stringField(value, "publicUrl", "PublicURL", "url", "URL"),
    target: stringField(value, "target", "Target", "backend", "Backend", "backendEndpoint", "BackendEndpoint"),
    raw: value,
  };
}

export function extractPublicUrl(output: string): string | undefined { return output.match(/https:\/\/[^\s"']+/i)?.[0]?.replace(/[),.;]+$/, ""); }
function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined { for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string; return undefined; }
function booleanField(record: Record<string, unknown>, ...keys: string[]): boolean | undefined { for (const key of keys) if (typeof record[key] === "boolean") return record[key] as boolean; return undefined; }
function parseVersion(output: string): [number, number, number] | null { const match = output.match(/\bv?(\d+)\.(\d+)(?:\.(\d+))?\b/); return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null; }
function validatePart(value: string, label: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(value)) throw new Error(`Invalid zrok ${label}`); }
function validateTarget(value: string): void { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`zrok target must be HTTP(S): ${value}`); }
