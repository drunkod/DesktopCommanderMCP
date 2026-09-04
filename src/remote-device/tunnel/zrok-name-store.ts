import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ZrokStoredIdentity = {
  provider: "zrok";
  namespace: string;
  name: string;
  publicBaseUrl?: string;
  localTarget: string;
};

export class ZrokNameStore {
  constructor(
    private readonly filePath = process.env.DC_ZROK_STATE_PATH ?? path.join(os.homedir(), ".config", "desktop-commander", "zrok.json"),
  ) {}

  async load(): Promise<ZrokStoredIdentity | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<ZrokStoredIdentity>;
      if (value.provider !== "zrok" || !validPart(value.namespace) || !validPart(value.name) || !value.localTarget || (value.publicBaseUrl !== undefined && !validHttpsUrl(value.publicBaseUrl))) return null;
      return value as ZrokStoredIdentity;
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.warn(`⚠️ Could not read zrok identity store: ${error?.message ?? error}`);
      return null;
    }
  }

  async save(identity: ZrokStoredIdentity): Promise<void> {
    if (!validPart(identity.namespace) || !validPart(identity.name) || (identity.publicBaseUrl !== undefined && !validHttpsUrl(identity.publicBaseUrl))) throw new Error("Invalid zrok namespace, name, or public URL");
    const directory = path.dirname(this.filePath);
    // mkdir applies 0700 only when this call creates the directory. Never
    // chmod an existing parent: statePath may intentionally live in a shared
    // caller-owned directory such as /tmp or a test fixture directory.
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(temp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  async remove(): Promise<void> { await fs.rm(this.filePath, { force: true }); }

  get path(): string { return this.filePath; }
}

export function defaultZrokName(hostname = os.hostname()): string {
  const safe = hostname.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 35) || "device";
  return `desktop-commander-${safe}`;
}

function validPart(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(value);
}
function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
