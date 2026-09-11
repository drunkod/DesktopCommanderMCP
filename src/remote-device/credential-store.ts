import type { DeviceOAuthSession } from "./device-oauth-session.js";
import { loadRemoteIdentityFromEnv, type RemoteIdentityConfig } from "./remote-identity.js";

export type DeviceCredentialSnapshot = Readonly<{
  clearGeneration: number;
  session: DeviceOAuthSession | null;
  cleanupObligations: readonly DeviceOAuthSession[];
}>;

export interface LockedDeviceCredentialStore {
  load(): Promise<DeviceCredentialSnapshot>;
  saveExpected(input: {
    session: DeviceOAuthSession;
    expectedClearGeneration: number;
    expectedSessionGeneration: number | null;
  }): Promise<boolean>;
  clearExpected(input: {
    expectedClearGeneration: number;
    expectedSessionGeneration: number;
  }): Promise<boolean>;
  clearExplicitly(): Promise<number>;
  addCleanupObligation(session: DeviceOAuthSession): Promise<void>;
  removeCleanupObligation(session: DeviceOAuthSession): Promise<boolean>;
}

export interface ProcessLease {
  assertHeld(): Promise<void>;
  renew(): Promise<void>;
  release(): Promise<void>;
}

export type PairingLease = ProcessLease;
export type RefreshLease = ProcessLease;

export interface DeviceCredentialStore {
  runExclusive<T>(operation: (locked: LockedDeviceCredentialStore) => Promise<T>): Promise<T>;
  runPairingExclusive<T>(operation: (lease: PairingLease) => Promise<T>): Promise<T>;
  runRefreshExclusive<T>(operation: (lease: RefreshLease) => Promise<T>): Promise<T>;
}

export class MemoryCredentialStore implements DeviceCredentialStore {
  private state: DeviceCredentialSnapshot = { clearGeneration: 0, session: null, cleanupObligations: [] };
  private tail: Promise<void> = Promise.resolve();
  private pairingTail: Promise<void> = Promise.resolve();
  private refreshTail: Promise<void> = Promise.resolve();

  constructor(private readonly identity: RemoteIdentityConfig = loadRemoteIdentityFromEnv()) {}

  async runPairingExclusive<T>(operation: (lease: PairingLease) => Promise<T>): Promise<T> {
    let releaseQueue!: () => void;
    const previous = this.pairingTail;
    this.pairingTail = new Promise<void>((resolve) => { releaseQueue = resolve; });
    await previous;
    let held = true;
    const lease: PairingLease = {
      assertHeld: async () => { if (!held) throw new Error("Pairing lease is no longer held"); },
      renew: async () => { if (!held) throw new Error("Pairing lease is no longer held"); },
      release: async () => { held = false; },
    };
    try { return await operation(lease); } finally { await lease.release(); releaseQueue(); }
  }

  async runRefreshExclusive<T>(operation: (lease: RefreshLease) => Promise<T>): Promise<T> {
    let releaseQueue!: () => void;
    const previous = this.refreshTail;
    this.refreshTail = new Promise<void>((resolve) => { releaseQueue = resolve; });
    await previous;
    let held = true;
    const lease: RefreshLease = {
      assertHeld: async () => { if (!held) throw new Error("Refresh lease is no longer held"); },
      renew: async () => { if (!held) throw new Error("Refresh lease is no longer held"); },
      release: async () => { held = false; },
    };
    try { return await operation(lease); } finally { await lease.release(); releaseQueue(); }
  }

  async runExclusive<T>(operation: (locked: LockedDeviceCredentialStore) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation({
        load: async () => ({
          clearGeneration: this.state.clearGeneration,
          session: this.state.session && { ...this.state.session },
          cleanupObligations: this.state.cleanupObligations.map((obligation) => ({ ...obligation })),
        }),
        saveExpected: async ({ session, expectedClearGeneration, expectedSessionGeneration }) => {
          if (session.issuer !== this.identity.authorizationServerIssuer || session.resource !== this.identity.publicMcpResource) return false;
          const currentGeneration = this.state.session?.generation ?? null;
          if (this.state.clearGeneration !== expectedClearGeneration || currentGeneration !== expectedSessionGeneration) return false;
          this.state = {
            clearGeneration: this.state.clearGeneration,
            session: { ...session },
            cleanupObligations: this.state.cleanupObligations,
          };
          return true;
        },
        clearExpected: async ({ expectedClearGeneration, expectedSessionGeneration }) => {
          if (this.state.clearGeneration !== expectedClearGeneration || this.state.session?.generation !== expectedSessionGeneration) return false;
          this.state = {
            clearGeneration: this.state.clearGeneration + 1,
            session: null,
            cleanupObligations: this.state.cleanupObligations,
          };
          return true;
        },
        clearExplicitly: async () => {
          this.state = {
            clearGeneration: this.state.clearGeneration + 1,
            session: null,
            cleanupObligations: this.state.cleanupObligations,
          };
          return this.state.clearGeneration;
        },
        addCleanupObligation: async (session) => {
          if (this.state.cleanupObligations.some((item) => item.refreshToken === session.refreshToken && item.clientId === session.clientId && item.issuer === session.issuer && item.resource === session.resource)) return;
          this.state = { ...this.state, cleanupObligations: [...this.state.cleanupObligations, { ...session }] };
        },
        removeCleanupObligation: async (session) => {
          const next = this.state.cleanupObligations.filter((item) => item.refreshToken !== session.refreshToken || item.clientId !== session.clientId || item.issuer !== session.issuer || item.resource !== session.resource);
          if (next.length === this.state.cleanupObligations.length) return false;
          this.state = { ...this.state, cleanupObligations: next };
          return true;
        },
      });
    } finally {
      release();
    }
  }
}
