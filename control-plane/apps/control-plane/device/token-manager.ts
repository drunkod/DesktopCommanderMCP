import {
  pairDevice,
  refreshDeviceSession,
  type DeviceOAuthSession,
} from "./device-auth";
import type { DeviceCredentialStore } from "./credential-store";

const REFRESH_SKEW_MS = 60_000;

export class ReauthorizationRequiredError extends Error {
  constructor(message = "Device authorization must be repeated") {
    super(message);
    this.name = "ReauthorizationRequiredError";
  }
}

export class DeviceTokenManager {
  private session: DeviceOAuthSession | null = null;
  private refreshInFlight: Promise<DeviceOAuthSession> | null = null;

  constructor(private readonly store: DeviceCredentialStore) {}

  async initialize(): Promise<DeviceOAuthSession> {
    this.session = await this.store.load();
    if (!this.session) {
      this.session = await pairDevice();
      await this.store.save(this.session);
    }
    return this.getValidSession();
  }

  async getAccessToken(): Promise<string> {
    return (await this.getValidSession()).accessToken;
  }

  async forceRefresh(): Promise<DeviceOAuthSession> {
    if (!this.session) throw new ReauthorizationRequiredError();
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshAndPersist(this.session)
        .finally(() => {
          this.refreshInFlight = null;
        });
    }
    this.session = await this.refreshInFlight;
    return this.session;
  }

  async clear(): Promise<void> {
    this.session = null;
    await this.store.clear();
  }

  private async getValidSession(): Promise<DeviceOAuthSession> {
    if (!this.session) throw new ReauthorizationRequiredError();
    if (this.session.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return this.session;
    }
    return this.forceRefresh();
  }

  private async refreshAndPersist(
    current: DeviceOAuthSession,
  ): Promise<DeviceOAuthSession> {
    try {
      const next = await refreshDeviceSession(current);
      await this.store.save(next);
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/invalid_grant|invalid_token|revoked/i.test(message)) {
        await this.clear();
        throw new ReauthorizationRequiredError(message);
      }
      throw error;
    }
  }
}
