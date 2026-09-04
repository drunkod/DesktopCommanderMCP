import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TailscaleStoredIdentity = {
  provider: "tailscale";
  dnsName: string;
  publicBaseUrl: string;
};

export class TailscaleIdentityStore {
  constructor(
    private readonly filePath = process.env.DC_TAILSCALE_STATE_PATH ??
      path.join(os.homedir(), ".config", "desktop-commander", "tailscale.json"),
  ) {}

  async load(): Promise<TailscaleStoredIdentity | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<TailscaleStoredIdentity>;
      if (value.provider !== "tailscale" || !validPart(value.dnsName) || !validHttpsUrl(value.publicBaseUrl)) return null;
      return value as TailscaleStoredIdentity;
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.warn(`⚠️ Could not read Tailscale identity store: ${error?.message ?? error}`);
      return null;
    }
  }

  async save(identity: TailscaleStoredIdentity): Promise<void> {
    if (!validPart(identity.dnsName) || !validHttpsUrl(identity.publicBaseUrl)) throw new Error("Invalid Tailscale identity");
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  get path(): string { return this.filePath; }
}

function validPart(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(value);
}
function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
