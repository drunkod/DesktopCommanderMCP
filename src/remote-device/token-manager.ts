import {
  applyVerifiedAccessTokenExpiry,
  isSessionBoundTo,
  OAuthProtocolError,
  RejectedOAuthTokenResponseError,
  pairDevice,
  requestRefreshDeviceSessionCandidate,
  revokeDeviceSession,
  verifyPersistedDeviceAccessToken,
  type DeviceOAuthSession,
  type ProviderTokenVerifier,
} from "./device-oauth.js";
import type { DeviceCredentialSnapshot, DeviceCredentialStore } from "./credential-store.js";
import { createRemoteIdentity, loadRemoteIdentityFromEnv, type RemoteIdentityConfig } from "./remote-identity.js";

const REFRESH_SKEW_MS = 60_000;
const MAX_STABLE_LOAD_ATTEMPTS = 4;

export class ReauthorizationRequiredError extends Error {
  constructor(message = "Device authorization must be repeated", readonly cause?: unknown) {
    super(message);
    this.name = "ReauthorizationRequiredError";
  }
}

type AuthorizeDevice = (signal?: AbortSignal) => Promise<DeviceOAuthSession>;
type DisposeLosingSession = (session: DeviceOAuthSession) => Promise<void>;

function terminalReauth(error: unknown): boolean {
  return error instanceof ReauthorizationRequiredError
    || (error instanceof OAuthProtocolError && ["invalid_grant", "invalid_token", "invalid_target", "invalid_client", "expired_token"].includes(error.code));
}

function cleanupIdentity(session: DeviceOAuthSession, current: RemoteIdentityConfig): RemoteIdentityConfig {
  return createRemoteIdentity({
    runtimeProfile: current.runtimeProfile,
    authorizationServerIssuer: session.issuer,
    publicMcpResource: session.resource,
    internalDeviceApiOrigin: current.internalDeviceApiOrigin,
  });
}

export class DeviceTokenManager {
  private session: DeviceOAuthSession | null = null;
  private verifiedGeneration: number | null = null;
  private epoch = 0;
  private pairingInFlight: Promise<DeviceOAuthSession> | null = null;
  private refreshInFlight: Promise<DeviceOAuthSession | null | undefined> | null = null;

  constructor(
    private readonly store: DeviceCredentialStore,
    private readonly identity: RemoteIdentityConfig = loadRemoteIdentityFromEnv(),
    private readonly verifier?: ProviderTokenVerifier,
    private readonly authorize: AuthorizeDevice = (signal) => pairDevice(identity, undefined, signal),
    private readonly disposeLosingSession: DisposeLosingSession = identity.runtimeProfile === "test"
      ? async () => undefined
      : (session) => revokeDeviceSession(session, cleanupIdentity(session, identity)),
  ) {
    if (identity.runtimeProfile !== "test" && !verifier) {
      throw new Error("A provider token verifier is required outside isolated test fixtures");
    }
  }

  async initialize(signal?: AbortSignal): Promise<DeviceOAuthSession> {
    await this.reconcileCleanupObligations();
    return (await this.loadOrRefreshAndVerify(signal)) ?? this.pairOutsideVaultLock(signal);
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    await this.reconcileCleanupObligations();
    return ((await this.loadOrRefreshAndVerify(signal)) ?? await this.pairOutsideVaultLock(signal)).accessToken;
  }

  async clearExplicitly(): Promise<void> {
    this.epoch += 1;
    this.session = null;
    this.verifiedGeneration = null;
    let previous: DeviceOAuthSession | null = null;
    await this.store.runExclusive(async (locked) => {
      previous = (await locked.load()).session;
      await locked.clearExplicitly();
    });
    if (previous) await this.disposeOrFail(previous);
  }

  /** Compatibility alias for existing callers; explicit clear is epoch-safe. */
  async clear(): Promise<void> {
    await this.clearExplicitly();
  }

  private async loadOrRefreshAndVerify(signal?: AbortSignal): Promise<DeviceOAuthSession | null> {
    for (let attempt = 0; attempt < MAX_STABLE_LOAD_ATTEMPTS; attempt += 1) {
      const startEpoch = this.epoch;
      const snapshot = await this.store.runExclusive((locked) => locked.load());
      const current = snapshot.session;
      if (!current) {
        this.session = null;
        this.verifiedGeneration = null;
        return null;
      }

      if (!isSessionBoundTo(current, this.identity)) {
        const cleared = await this.clearSnapshotIfCurrent(snapshot);
        if (!cleared) continue;
        this.assertEpoch(startEpoch);
        this.session = null;
        this.verifiedGeneration = null;
        await this.disposeOrFail(current);
        return null;
      }

      if (current.expiresAt - Date.now() <= REFRESH_SKEW_MS) {
        const refreshed = await this.refreshSerialized(snapshot, current, startEpoch, signal);
        if (refreshed === undefined) continue;
        return refreshed;
      }

      const alreadyVerifiedInThisProcess =
        this.verifiedGeneration === current.generation
        && this.session?.generation === current.generation
        && this.session.accessToken === current.accessToken;

      let effective = alreadyVerifiedInThisProcess && this.session ? this.session : current;
      if (!alreadyVerifiedInThisProcess && this.verifier) {
        try {
          const verified = await verifyPersistedDeviceAccessToken(current, this.identity, this.verifier, signal);
          if (verified) effective = applyVerifiedAccessTokenExpiry(current, verified);
        } catch (error) {
          if (!terminalReauth(error)) throw error;
          const cleared = await this.clearSnapshotIfCurrent(snapshot);
          if (!cleared) continue;
          this.session = null;
          this.verifiedGeneration = null;
          await this.disposeOrFail(current, error);
          return null;
        }

        if (effective.expiresAt !== current.expiresAt) {
          const narrowed = await this.store.runExclusive(async (locked) => locked.saveExpected({
            session: effective,
            expectedClearGeneration: snapshot.clearGeneration,
            expectedSessionGeneration: current.generation,
          }));
          if (!narrowed) continue;
        }
        // Verification may reveal that the JWT expires much sooner than the
        // token response claimed. Never return a verified token that is already
        // inside the refresh window; persist the narrowed expiry and loop so the
        // serialized refresh path owns the next mutation.
        if (effective.expiresAt - Date.now() <= REFRESH_SKEW_MS) continue;
      }

      const stable = await this.store.runExclusive(async (locked) => {
        const now = await locked.load();
        if (now.clearGeneration !== snapshot.clearGeneration
          || now.session?.generation !== current.generation
          || now.session?.accessToken !== current.accessToken
          || !isSessionBoundTo(now.session, this.identity)) return null;
        return now.session;
      });
      if (!stable) continue;

      this.assertEpoch(startEpoch);
      this.session = stable;
      this.verifiedGeneration = stable.generation;
      return stable;
    }
    throw new ReauthorizationRequiredError("credential changed repeatedly while validating persisted authorization");
  }

  private async refreshSerialized(
    expectedSnapshot: DeviceCredentialSnapshot,
    expectedSession: DeviceOAuthSession,
    startEpoch: number,
    signal?: AbortSignal,
  ): Promise<DeviceOAuthSession | null | undefined> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const refresh = this.store.runRefreshExclusive(async (lease) => {
      const snapshot = await this.store.runExclusive((locked) => locked.load());
      const current = snapshot.session;

      if (snapshot.clearGeneration !== expectedSnapshot.clearGeneration
        || current?.generation !== expectedSession.generation
        || current?.accessToken !== expectedSession.accessToken) return undefined;
      if (!current || !isSessionBoundTo(current, this.identity)) return undefined;
      if (current.expiresAt - Date.now() > REFRESH_SKEW_MS) return undefined;

      this.assertEpoch(startEpoch);
      await lease.assertHeld();

      let candidate: DeviceOAuthSession;
      try {
        candidate = await requestRefreshDeviceSessionCandidate(current, this.identity, signal);
      } catch (error) {
        if (error instanceof RejectedOAuthTokenResponseError) {
          await this.disposeOrFail(error.cleanupSession, error);
        }
        if (!terminalReauth(error)) throw error;
        const cleared = await this.clearSnapshotIfCurrent(snapshot);
        if (!cleared) return undefined;
        this.session = null;
        this.verifiedGeneration = null;
        await this.disposeOrFail(current, error);
        return null;
      }

      try {
        if (this.verifier) {
          const verified = await verifyPersistedDeviceAccessToken(candidate, this.identity, this.verifier, signal);
          if (verified) candidate = applyVerifiedAccessTokenExpiry(candidate, verified);
        }
      } catch (error) {
        const cleared = await this.clearSnapshotIfCurrent(snapshot);
        await this.disposeOrFail(candidate, error);
        if (!cleared) return undefined;
        this.session = null;
        this.verifiedGeneration = null;
        return null;
      }

      let saved: boolean;
      try {
        this.assertEpoch(startEpoch);
        await lease.assertHeld();
        if (candidate.generation !== current.generation + 1) {
          throw new Error("credential generation invariant failed");
        }
        saved = await this.store.runExclusive(async (locked) => {
          await lease.assertHeld();
          return locked.saveExpected({
            session: candidate,
            expectedClearGeneration: snapshot.clearGeneration,
            expectedSessionGeneration: current.generation,
          });
        });
      } catch (error) {
        await this.disposeOrFail(candidate, error);
        throw error;
      }
      if (!saved) {
        await this.disposeOrFail(candidate);
        return undefined;
      }

      this.assertEpoch(startEpoch);
      this.session = candidate;
      this.verifiedGeneration = candidate.generation;
      // A rotated candidate can also be narrowed by JWT verification into the
      // refresh window. It is already persisted safely, so loop and refresh that
      // successor generation instead of handing a near-expiry token to callers.
      if (candidate.expiresAt - Date.now() <= REFRESH_SKEW_MS) return undefined;
      return candidate;
    });

    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }
  }

  private async pairOutsideVaultLock(signal?: AbortSignal): Promise<DeviceOAuthSession> {
    if (this.pairingInFlight) return this.pairingInFlight;
    this.pairingInFlight = this.store.runPairingExclusive(async (lease) => {
      const existing = await this.loadOrRefreshAndVerify(signal);
      if (existing) return existing;
      const before = await this.store.runExclusive((locked) => locked.load());
      const startEpoch = this.epoch;
      let candidate: DeviceOAuthSession | null = null;
      let candidateDisposed = false;
      try {
        candidate = await this.authorize(signal);
        this.assertEpoch(startEpoch);
        if (this.verifier) {
          const verified = await verifyPersistedDeviceAccessToken(candidate, this.identity, this.verifier, signal);
          if (verified) candidate = applyVerifiedAccessTokenExpiry(candidate, verified);
        }
        await lease.assertHeld();
        const decision = await this.store.runExclusive(async (locked) => {
          const current = await locked.load();
          if (current.clearGeneration !== before.clearGeneration) return { kind: "cleared" as const };
          if (current.session && isSessionBoundTo(current.session, this.identity)) return { kind: "winner" as const, session: current.session };
          if (current.session) throw new ReauthorizationRequiredError("unexpected credential binding appeared during pairing");
          const saved = await locked.saveExpected({
            session: candidate!,
            expectedClearGeneration: before.clearGeneration,
            expectedSessionGeneration: null,
          });
          return saved ? { kind: "saved" as const, session: candidate! } : { kind: "cleared" as const };
        });
        if (decision.kind === "cleared") {
          candidateDisposed = true;
          await this.disposeOrFail(candidate);
          throw new ReauthorizationRequiredError("authorization was cleared while pairing; candidate authority was revoked");
        }
        if (decision.kind === "winner") {
          candidateDisposed = true;
          await this.disposeOrFail(candidate);
          const winner = await this.loadOrRefreshAndVerify(signal);
          if (!winner) throw new ReauthorizationRequiredError("winning credential disappeared during pairing");
          return winner;
        }
        const savedSession = decision.session;
        this.assertEpoch(startEpoch);
        this.session = savedSession;
        this.verifiedGeneration = savedSession.generation;
        if (savedSession.expiresAt - Date.now() <= REFRESH_SKEW_MS) {
          // The authorization ceremony succeeded, so keep its authority in the
          // vault and refresh it immediately rather than forcing another human
          // ceremony. From here, cleanup responsibility belongs to the normal
          // persisted-session refresh path.
          candidateDisposed = true;
          const refreshed = await this.loadOrRefreshAndVerify(signal);
          if (!refreshed) {
            throw new ReauthorizationRequiredError("new authorization could not be refreshed before use");
          }
          return refreshed;
        }
        return savedSession;
      } catch (error) {
        if (candidate && !candidateDisposed) await this.disposeOrFail(candidate, error);
        else if (error instanceof RejectedOAuthTokenResponseError) await this.disposeOrFail(error.cleanupSession, error);
        throw error;
      }
    });
    try {
      return await this.pairingInFlight;
    } finally {
      this.pairingInFlight = null;
    }
  }

  private async clearSnapshotIfCurrent(snapshot: DeviceCredentialSnapshot): Promise<boolean> {
    if (!snapshot.session) return false;
    return this.store.runExclusive(async (locked) => {
      const now = await locked.load();
      if (now.clearGeneration !== snapshot.clearGeneration
        || now.session?.generation !== snapshot.session?.generation
        || now.session?.accessToken !== snapshot.session?.accessToken) return false;
      return locked.clearExpected({
        expectedClearGeneration: snapshot.clearGeneration,
        expectedSessionGeneration: snapshot.session!.generation,
      });
    });
  }

  private async reconcileCleanupObligations(): Promise<void> {
    const snapshot = await this.store.runExclusive((locked) => locked.load());
    for (const obligation of snapshot.cleanupObligations) {
      await this.disposeOrFail(obligation);
      await this.store.runExclusive((locked) => locked.removeCleanupObligation(obligation));
    }
  }

  private async disposeOrFail(session: DeviceOAuthSession, cause?: unknown): Promise<void> {
    try {
      await this.disposeLosingSession(session);
    } catch (error) {
      try {
        await this.store.runExclusive((locked) => locked.addCleanupObligation(session));
      } catch (recordError) {
        throw new ReauthorizationRequiredError("device authorization cleanup failed and could not be recorded", recordError ?? error ?? cause);
      }
      throw new ReauthorizationRequiredError("device authorization cleanup failed; retry is required", error ?? cause);
    }
  }

  private assertEpoch(expected: number): void {
    if (this.epoch !== expected) throw new ReauthorizationRequiredError("authorization changed during operation");
  }
}
