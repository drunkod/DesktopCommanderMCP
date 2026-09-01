import type { DeviceOAuthSession } from "./device-oauth.js";

export interface DeviceCredentialStore {
  load(): Promise<DeviceOAuthSession | null>;
  save(session: DeviceOAuthSession): Promise<void>;
  clear(): Promise<void>;
}

/** Used only for --no-persist-session and tests. Production uses the OS vault. */
export class MemoryCredentialStore implements DeviceCredentialStore {
  private session: DeviceOAuthSession | null = null;

  async load(): Promise<DeviceOAuthSession | null> { return this.session; }
  async save(session: DeviceOAuthSession): Promise<void> { this.session = session; }
  async clear(): Promise<void> { this.session = null; }
}
