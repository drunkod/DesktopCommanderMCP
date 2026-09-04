import { CommandRunner, parseJsonOutput, type CommandResult, type CommandRunnerLike } from "./command-runner.js";

export type ZrokAgentStatus = { running: boolean; shares: ZrokShare[]; raw: unknown };
export type ZrokShare = {
  token: string;
  namespace?: string;
  name?: string;
  publicUrl?: string;
  target?: string;
  shareMode?: string;
  backendMode?: string;
  raw?: unknown;
};
export type ZrokNameInfo = {
  namespace: string;
  namespaceName?: string;
  name: string;
  shareToken?: string;
  publicUrl?: string;
  reserved?: boolean;
};
export type ZrokShareSummary = {
  token: string;
  frontendEndpoints: string[];
  target?: string;
  shareMode?: string;
  backendMode?: string;
  raw?: unknown;
};

export class ZrokCli {
  constructor(private readonly runner: CommandRunnerLike = new CommandRunner(), private readonly command = process.env.ZROK_BIN ?? "zrok2") {}

  async preflight(): Promise<void> {
    const result = await this.runner.run(this.command, ["version"], { timeoutMs: 10_000 });
    const version = parseVersion(result.stdout);
    if (!version || version[0] !== 2) {
      throw new Error(`Unsupported zrok2 version ${version?.join(".") ?? "unknown"}; this adapter requires zrok2 v2.x`);
    }
    // Validate only released machine-readable commands before mutation.
    await this.listNamespaces();
    await this.listNames();
    await this.listShares();
    // Agent status itself is a human table in zrok v2; success means the local
    // agent socket is reachable. It may legitimately fail before first start.
    await this.runner.run(this.command, ["agent", "status"], { timeoutMs: 10_000 }).catch(() => undefined);
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
      // zrok v2's Name model uses namespaceToken/namespaceName/shareToken.
      const namespaceToken = stringField(record, "namespaceToken", "NamespaceToken");
      const namespaceName = stringField(record, "namespaceName", "NamespaceName");
      const name = stringField(record, "name", "Name");
      if (!namespaceToken || !name) return [];
      const shareToken = stringField(record, "shareToken", "ShareToken");
      const reserved = booleanField(record, "reserved", "Reserved");
      return [{
        namespace: namespaceToken,
        namespaceName,
        name,
        shareToken,
        publicUrl: deriveNameUrl(name, namespaceName),
        reserved,
      }];
    });
  }

  async findName(namespace: string, name: string): Promise<ZrokNameInfo | null> {
    validatePart(namespace, "namespace"); validatePart(name, "name");
    return (await this.listNames(namespace)).find((value) => value.namespace === namespace && value.name === name) ?? null;
  }

  async listShares(): Promise<ZrokShareSummary[]> {
    const result = await this.runner.run(this.command, ["list", "shares", "--json"]);
    const raw = parseJsonOutput<any>(result.stdout);
    const values = Array.isArray(raw) ? raw : raw?.shares ?? raw?.Shares ?? [];
    if (!Array.isArray(values)) return [];
    return values.flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const token = stringField(record, "shareToken", "ShareToken", "token", "Token");
      if (!token) return [];
      return [{
        token,
        frontendEndpoints: stringArrayField(record, "frontendEndpoints", "FrontendEndpoints"),
        target: stringField(record, "target", "Target"),
        shareMode: stringField(record, "shareMode", "ShareMode"),
        backendMode: stringField(record, "backendMode", "BackendMode"),
        raw: record,
      }];
    });
  }

  async agentStatus(): Promise<ZrokAgentStatus> {
    // zrok v2.0.x does not implement `agent status --json`. Use the supported
    // status command for local-agent liveness and `list shares --json` plus
    // `list names --json` as the machine-readable source for share details.
    const status = await this.runner.run(this.command, ["agent", "status"], { timeoutMs: 10_000 });
    const localTokens = parseZrokAgentShareTokens(status.stdout);
    if (localTokens.length === 0) return { running: true, shares: [], raw: { agentStatus: status.stdout } };
    const [shareSummaries, names] = await Promise.all([this.listShares(), this.listNames()]);
    return parseZrokAgentStatus(status.stdout, shareSummaries, names);
  }

  async startAgent(): Promise<number> { return this.runner.runDetached(this.command, ["agent", "start"]); }

  async createName(namespace: string, name: string): Promise<ZrokNameInfo> {
    validatePart(namespace, "namespace"); validatePart(name, "name");
    await this.runner.run(this.command, ["create", "name", "-n", namespace, name]);
    const created = await this.findName(namespace, name);
    if (!created) throw new Error(`zrok did not confirm the reserved identity ${namespace}:${name} after creation`);
    return created;
  }

  async sharePublic(target: string, namespace: string, name: string): Promise<{ result: CommandResult; publicUrl?: string; token?: string }> {
    validateTarget(target); validatePart(namespace, "namespace"); validatePart(name, "name");
    // Force agent mode so this command submits the share and exits instead of
    // accidentally becoming a long-running local/headless share process.
    const result = await this.runner.run(this.command, ["share", "public", target, "--force-agent", "-n", `${namespace}:${name}`]);
    return { result, publicUrl: extractPublicUrls(result.stdout)[0], token: extractShareToken(result.stdout) };
  }

  async releaseShare(token: string): Promise<void> {
    validateShareToken(token);
    await this.runner.run(this.command, ["agent", "release", "share", token]);
  }

  async deleteName(namespace: string, name: string): Promise<void> {
    validatePart(namespace, "namespace"); validatePart(name, "name");
    await this.runner.run(this.command, ["delete", "name", "-n", namespace, name]);
  }
  async console(): Promise<string> { const result = await this.runner.run(this.command, ["agent", "console"]); return result.stdout || result.stderr; }
}

export function parseZrokAgentStatus(
  statusOutput: string,
  shareSummaries: ZrokShareSummary[] = [],
  names: ZrokNameInfo[] = [],
): ZrokAgentStatus {
  const localTokens = parseZrokAgentShareTokens(statusOutput);
  const shares: ZrokShare[] = [];
  for (const token of localTokens) {
    const summary = shareSummaries.find((share) => share.token === token);
    const matchingNames = names.filter((name) => name.shareToken === token);
    if (matchingNames.length === 0) {
      shares.push({
        token,
        publicUrl: summary?.frontendEndpoints[0],
        target: summary?.target,
        shareMode: summary?.shareMode,
        backendMode: summary?.backendMode,
        raw: summary?.raw,
      });
      continue;
    }
    for (const name of matchingNames) {
      shares.push({
        token,
        namespace: name.namespace,
        name: name.name,
        publicUrl: chooseNameEndpoint(summary?.frontendEndpoints ?? [], name) ?? name.publicUrl,
        target: summary?.target,
        shareMode: summary?.shareMode,
        backendMode: summary?.backendMode,
        raw: summary?.raw,
      });
    }
  }
  return { running: true, shares, raw: { agentStatus: statusOutput, shareSummaries, names } };
}

/** Parse only the local agent's share tokens from its supported human table. */
export function parseZrokAgentShareTokens(output: string): string[] {
  const text = stripAnsi(output);
  const tokens: string[] = [];
  let inShares = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^SHARES$/i.test(trimmed)) { inShares = true; continue; }
    if (!inShares || !trimmed) continue;
    if (/^\d+\s+(?:active|retrying|failed)/i.test(trimmed) || /^total:/i.test(trimmed)) break;

    let cells: string[];
    if (line.includes("│")) {
      cells = line.split("│").slice(1, -1).map((cell) => cell.trim());
    } else {
      if (/^[╭├╰┼─]+$/.test(trimmed)) continue;
      cells = trimmed.split(/\s{2,}/).map((cell) => cell.trim());
    }
    const token = cells[0];
    if (!token || /^share token$/i.test(token) || /^token$/i.test(token)) continue;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(token) && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

export function extractShareToken(output: string): string | undefined {
  return output.match(/\btoken:\s*"([^"]+)"/i)?.[1] ?? output.match(/\btoken\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1];
}
export function extractPublicUrls(output: string): string[] {
  const values = [...output.matchAll(/frontendEndpoints:\s*"([^"]+)"/gi)].map((match) => match[1]);
  if (values.length > 0) return [...new Set(values)];
  return [...new Set([...output.matchAll(/https:\/\/[^\s"']+/gi)].map((match) => match[0].replace(/[),.;]+$/, "")))];
}
export function extractPublicUrl(output: string): string | undefined { return extractPublicUrls(output)[0]; }

function chooseNameEndpoint(endpoints: string[], name: ZrokNameInfo): string | undefined {
  const expectedHost = name.namespaceName ? `${name.name}.${name.namespaceName}`.toLowerCase() : undefined;
  if (expectedHost) {
    const exact = endpoints.find((endpoint) => {
      try { return new URL(endpoint).hostname.toLowerCase() === expectedHost; } catch { return false; }
    });
    if (exact) return exact;
  }
  if (endpoints.length === 1) return endpoints[0];
  return endpoints.find((endpoint) => {
    try { return new URL(endpoint).hostname.toLowerCase().startsWith(`${name.name.toLowerCase()}.`); } catch { return false; }
  });
}
function deriveNameUrl(name: string, namespaceName?: string): string | undefined {
  if (!namespaceName || !/^[A-Za-z0-9.-]+$/.test(namespaceName)) return undefined;
  return `https://${name}.${namespaceName}`;
}
function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined { for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string; return undefined; }
function stringArrayField(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) if (Array.isArray(record[key])) return (record[key] as unknown[]).filter((value): value is string => typeof value === "string");
  return [];
}
function booleanField(record: Record<string, unknown>, ...keys: string[]): boolean | undefined { for (const key of keys) if (typeof record[key] === "boolean") return record[key] as boolean; return undefined; }
function parseVersion(output: string): [number, number, number] | null { const match = output.match(/\bv?(\d+)\.(\d+)(?:\.(\d+))?\b/); return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null; }
function validatePart(value: string, label: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(value)) throw new Error(`Invalid zrok ${label}`); }
function validateShareToken(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("Invalid zrok share token"); }
function validateTarget(value: string): void { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`zrok target must be HTTP(S): ${value}`); }
function stripAnsi(value: string): string { return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""); }
