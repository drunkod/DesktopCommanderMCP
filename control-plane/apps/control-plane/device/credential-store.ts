import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DeviceOAuthSession } from "./device-auth";

export interface DeviceCredentialStore {
  load(): Promise<DeviceOAuthSession | null>;
  save(session: DeviceOAuthSession): Promise<void>;
  clear(): Promise<void>;
}

export class FileCredentialStore implements DeviceCredentialStore {
  constructor(
    private readonly filePath = path.join(
      os.homedir(),
      ".desktop-commander-device",
      "jazz-oauth.json",
    ),
  ) {}

  async load(): Promise<DeviceOAuthSession | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as DeviceOAuthSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async save(session: DeviceOAuthSession): Promise<void> {
    const dir = path.dirname(this.filePath);
    const temp = `${this.filePath}.tmp-${process.pid}`;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(temp, JSON.stringify(session, null, 2), {
      mode: 0o600,
    });
    await fs.rename(temp, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}

// Fastest-MVP storage is a chmod-0600 file because DesktopCommander already
// persists device configuration this way. Replace this implementation behind
// the interface with Keychain/Credential Manager/libsecret before production.
// Never persist Jazz admin/backend secrets on a device.
