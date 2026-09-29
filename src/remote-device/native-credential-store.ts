import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { DeviceOAuthSession } from "./device-oauth-session.js";
import { parseDeviceOAuthSessionStructure } from "./device-oauth-session.js";
import type { DeviceCredentialSnapshot, DeviceCredentialStore, LockedDeviceCredentialStore, PairingLease, RefreshLease } from "./credential-store.js";
import { loadRemoteIdentityFromEnv, type RemoteIdentityConfig } from "./remote-identity.js";

export type NativeCredentialConfig = Readonly<{
  service: string;
  account: string;
  vaultLockPath: string;
  pairingLockPath: string;
  refreshLockPath: string;
  dpapiPath: string;
}>;

const DEFAULT_SERVICE = "com.desktopcommander.remote-mcp";
const DEFAULT_ACCOUNT = "device-oauth-session";

function resolveIdentifier(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value.trim() === "" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function resolveAbsolutePath(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value.trim() === "" || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

export function resolveNativeCredentialConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): NativeCredentialConfig {
  const stateDir = path.join(home, ".desktop-commander-device");
  const localAppDataValue = env.LOCALAPPDATA?.trim();
  const localAppData = localAppDataValue ? localAppDataValue : home;
  if (localAppDataValue && !path.isAbsolute(localAppDataValue)) {
    throw new Error("LOCALAPPDATA must be an absolute path");
  }
  return {
    service: resolveIdentifier(env, "DC_DEVICE_CREDENTIAL_SERVICE", DEFAULT_SERVICE),
    account: resolveIdentifier(env, "DC_DEVICE_CREDENTIAL_ACCOUNT", DEFAULT_ACCOUNT),
    vaultLockPath: resolveAbsolutePath(env, "DC_DEVICE_VAULT_LOCK_PATH", path.join(stateDir, "device-oauth.lock")),
    pairingLockPath: resolveAbsolutePath(env, "DC_DEVICE_PAIRING_LOCK_PATH", path.join(stateDir, "device-oauth-pairing.lock")),
    refreshLockPath: resolveAbsolutePath(env, "DC_DEVICE_REFRESH_LOCK_PATH", path.join(stateDir, "device-oauth-refresh.lock")),
    dpapiPath: resolveAbsolutePath(env, "DC_DEVICE_DPAPI_PATH", path.join(localAppData, "DesktopCommander", "jazz-oauth.dpapi")),
  };
}

const NATIVE_CREDENTIAL_CONFIG = resolveNativeCredentialConfig();
const SERVICE = NATIVE_CREDENTIAL_CONFIG.service;
const ACCOUNT = NATIVE_CREDENTIAL_CONFIG.account;
const VAULT_LOCK_PATH = NATIVE_CREDENTIAL_CONFIG.vaultLockPath;
const PAIRING_LOCK_PATH = NATIVE_CREDENTIAL_CONFIG.pairingLockPath;
const REFRESH_LOCK_PATH = NATIVE_CREDENTIAL_CONFIG.refreshLockPath;
const VAULT_LOCK_TIMEOUT_MS = 15_000;
const VAULT_LOCK_RETRY_MS = 50;
const PAIRING_LEASE_TTL_MS = 30_000;
const PAIRING_LEASE_RENEW_MS = 10_000;
const REFRESH_LEASE_TTL_MS = 30_000;
const REFRESH_LEASE_RENEW_MS = 10_000;

type RunOptions = {
  input?: string;
  env?: NodeJS.ProcessEnv;
  allowNotFound?: boolean;
};

type PersistedCredentialStateV1 = {
  version: 1;
  clearGeneration: number;
  session: unknown | null;
  cleanupObligations?: unknown;
};

function isPersistedCredentialStateV1(value: unknown): value is PersistedCredentialStateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.clearGeneration === "number"
    && Number.isSafeInteger(record.clearGeneration)
    && record.clearGeneration >= 0
    && record.clearGeneration < Number.MAX_SAFE_INTEGER
    && Object.prototype.hasOwnProperty.call(record, "session");
}

export function parsePersistedCredentialPayload(raw: string): { snapshot: DeviceCredentialSnapshot; needsEnvelopeMigration: boolean } {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Device credential vault requires explicit repair; encrypted payload was preserved"); }

  if (isPersistedCredentialStateV1(value)) {
    const session = value.session === null ? null : parseDeviceOAuthSessionStructure(value.session);
    if (value.session !== null && session === null) {
      throw new Error("Device credential vault contains an unsupported session; encrypted payload was preserved for repair");
    }
    const rawObligations = value.cleanupObligations === undefined ? [] : value.cleanupObligations;
    if (!Array.isArray(rawObligations)) {
      throw new Error("Device credential vault contains invalid cleanup obligations; encrypted payload was preserved for repair");
    }
    const cleanupObligations: DeviceOAuthSession[] = [];
    for (const item of rawObligations) {
      const obligation = parseDeviceOAuthSessionStructure(item);
      if (!obligation) {
        throw new Error("Device credential vault contains a malformed cleanup obligation; encrypted payload was preserved for repair");
      }
      cleanupObligations.push(obligation);
    }
    return { snapshot: { clearGeneration: value.clearGeneration, session, cleanupObligations }, needsEnvelopeMigration: false };
  }

  const rawV2 = parseDeviceOAuthSessionStructure(value);
  if (rawV2) {
    return { snapshot: { clearGeneration: 0, session: rawV2, cleanupObligations: [] }, needsEnvelopeMigration: true };
  }
  throw new Error("Device credential vault contains a legacy credential that requires explicit repair; encrypted payload was preserved");
}

export function recoverCorruptCredentialGeneration(raw: string): number {
  let parsed: { clearGeneration?: unknown };
  try {
    parsed = JSON.parse(raw) as { clearGeneration?: unknown };
  } catch {
    throw new Error("Device credential vault requires explicit repair; its clear-generation tombstone is unavailable");
  }
  if (typeof parsed?.clearGeneration !== "number"
    || !Number.isSafeInteger(parsed.clearGeneration)
    || parsed.clearGeneration < 0
    || parsed.clearGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Device credential vault requires explicit repair; its clear-generation tombstone is unavailable");
  }
  return parsed.clearGeneration + 1;
}

export class NativeCredentialStore implements DeviceCredentialStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly identity: RemoteIdentityConfig = loadRemoteIdentityFromEnv()) {}

  async runPairingExclusive<T>(operation: (lease: PairingLease) => Promise<T>): Promise<T> {
    const lease = await acquireRenewableLease(PAIRING_LOCK_PATH, "Pairing", PAIRING_LEASE_TTL_MS);
    const renewal = setInterval(() => { void lease.renew().catch(() => undefined); }, PAIRING_LEASE_RENEW_MS);
    try {
      await lease.assertHeld();
      return await operation(lease);
    } finally {
      clearInterval(renewal);
      await lease.release().catch(() => undefined);
    }
  }

  async runRefreshExclusive<T>(operation: (lease: RefreshLease) => Promise<T>): Promise<T> {
    const lease = await acquireRenewableLease(REFRESH_LOCK_PATH, "Refresh", REFRESH_LEASE_TTL_MS);
    const renewal = setInterval(() => { void lease.renew().catch(() => undefined); }, REFRESH_LEASE_RENEW_MS);
    try {
      await lease.assertHeld();
      return await operation(lease);
    } finally {
      clearInterval(renewal);
      await lease.release().catch(() => undefined);
    }
  }

  async repairLegacyCredential(operatorRevocationConfirmed: boolean): Promise<"empty" | "migrated-v2" | "reset-legacy"> {
    if (!operatorRevocationConfirmed) throw new Error("Legacy credential repair requires confirmed server-side/operator revocation");
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let releaseProcessLock: (() => Promise<void>) | undefined;
    try {
      releaseProcessLock = await acquireVaultProcessLock();
      const backend = platformBackend();
      const raw = await backend.load();
      if (raw === null) return "empty";
      try {
        const parsed = parsePersistedCredentialPayload(raw);
        if (parsed.needsEnvelopeMigration) {
          await this.writeSnapshot(backend, parsed.snapshot);
          return "migrated-v2";
        }
        throw new Error("Credential vault is already structurally valid; use `remote credentials clear` instead");
      } catch (error) {
        if (error instanceof Error && error.message.includes("already structurally valid")) throw error;
        await this.writeSnapshot(backend, { clearGeneration: 1, session: null, cleanupObligations: [] });
        return "reset-legacy";
      }
    } finally {
      await releaseProcessLock?.().catch(() => undefined);
      release();
    }
  }

  async runExclusive<T>(operation: (locked: LockedDeviceCredentialStore) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let releaseProcessLock: (() => Promise<void>) | undefined;
    try {
      releaseProcessLock = await acquireVaultProcessLock();
      const backend = platformBackend();
      const locked: LockedDeviceCredentialStore = {
        load: async () => this.readSnapshot(backend),
        saveExpected: async ({ session, expectedClearGeneration, expectedSessionGeneration }) => {
          if (session.issuer !== this.identity.authorizationServerIssuer || session.resource !== this.identity.publicMcpResource) return false;
          const current = await this.readSnapshot(backend);
          if (current.clearGeneration !== expectedClearGeneration || (current.session?.generation ?? null) !== expectedSessionGeneration) return false;
          await this.writeSnapshot(backend, { clearGeneration: current.clearGeneration, session, cleanupObligations: current.cleanupObligations });
          return true;
        },
        clearExpected: async ({ expectedClearGeneration, expectedSessionGeneration }) => {
          const current = await this.readSnapshot(backend);
          if (current.clearGeneration !== expectedClearGeneration || current.session?.generation !== expectedSessionGeneration) return false;
          await this.writeSnapshot(backend, { clearGeneration: current.clearGeneration + 1, session: null, cleanupObligations: current.cleanupObligations });
          return true;
        },
        clearExplicitly: async () => {
          const current = await this.readSnapshot(backend);
          const clearGeneration = current.clearGeneration + 1;
          await this.writeSnapshot(backend, { clearGeneration, session: null, cleanupObligations: current.cleanupObligations });
          return clearGeneration;
        },
        addCleanupObligation: async (session) => {
          const current = await this.readSnapshot(backend);
          if (current.cleanupObligations.some((item) => item.refreshToken === session.refreshToken && item.clientId === session.clientId && item.issuer === session.issuer && item.resource === session.resource)) return;
          await this.writeSnapshot(backend, {
            clearGeneration: current.clearGeneration,
            session: current.session,
            cleanupObligations: [...current.cleanupObligations, session],
          });
        },
        removeCleanupObligation: async (session) => {
          const current = await this.readSnapshot(backend);
          const next = current.cleanupObligations.filter((item) => item.refreshToken !== session.refreshToken || item.clientId !== session.clientId || item.issuer !== session.issuer || item.resource !== session.resource);
          if (next.length === current.cleanupObligations.length) return false;
          await this.writeSnapshot(backend, { clearGeneration: current.clearGeneration, session: current.session, cleanupObligations: next });
          return true;
        },
      };
      return await operation(locked);
    } finally {
      await releaseProcessLock?.().catch(() => undefined);
      release();
    }
  }

  private async readSnapshot(backend: VaultBackend): Promise<DeviceCredentialSnapshot> {
    const raw = await backend.load();
    if (raw === null) return { clearGeneration: 0, session: null, cleanupObligations: [] };
    const parsed = parsePersistedCredentialPayload(raw);
    if (parsed.needsEnvelopeMigration) await this.writeSnapshot(backend, parsed.snapshot);
    return parsed.snapshot;
  }

  private async writeSnapshot(backend: VaultBackend, snapshot: DeviceCredentialSnapshot): Promise<void> {
    const envelope: PersistedCredentialStateV1 = {
      version: 1,
      clearGeneration: snapshot.clearGeneration,
      session: snapshot.session,
      cleanupObligations: snapshot.cleanupObligations,
    };
    await backend.save(JSON.stringify(envelope));
  }
}

type VaultBackend = {
  load(): Promise<string | null>;
  save(secret: string): Promise<void>;
  clear(): Promise<void>;
};

type LeaseRecord = { nonce: string; pid: number; revision: number; expiresAt: number };

function parseLeaseRecord(raw: string): LeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LeaseRecord>;
    if (typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce)) return null;
    if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
    return value as LeaseRecord;
  } catch { return null; }
}

async function acquireRenewableLease(lockPath: string, leaseLabel: string, ttlMs: number): Promise<PairingLease> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + VAULT_LOCK_TIMEOUT_MS;
  const nonce = randomBytes(16).toString("hex");
  while (Date.now() < deadline) {
    const record: LeaseRecord = { nonce, pid: process.pid, revision: 1, expiresAt: Date.now() + ttlMs };
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      const initial = Buffer.from(JSON.stringify(record), "utf8");
      await handle.write(initial, 0, initial.length, 0);
      await handle.truncate(initial.length);
      const ownedStat = await handle.stat();
      let released = false;

      const pathStillOwned = async (): Promise<boolean> => {
        try {
          const pathStat = await fs.stat(lockPath);
          return pathStat.dev === ownedStat.dev && pathStat.ino === ownedStat.ino;
        } catch (error: any) {
          if (error?.code === "ENOENT") return false;
          throw error;
        }
      };
      const readOwned = async (): Promise<LeaseRecord> => {
        if (released || !(await pathStillOwned())) throw new Error(`${leaseLabel} lease ownership was lost`);
        const current = parseLeaseRecord(await fs.readFile(lockPath, "utf8"));
        if (!current || current.nonce !== nonce || current.pid !== process.pid || current.expiresAt <= Date.now()) {
          throw new Error(`${leaseLabel} lease ownership was lost`);
        }
        return current;
      };
      return {
        assertHeld: async () => { await readOwned(); },
        renew: async () => {
          const current = await readOwned();
          const next = { ...current, revision: current.revision + 1, expiresAt: Date.now() + ttlMs };
          const bytes = Buffer.from(JSON.stringify(next), "utf8");
          await handle.write(bytes, 0, bytes.length, 0);
          await handle.truncate(bytes.length);
          const after = await readOwned();
          if (after.revision !== next.revision) throw new Error(`${leaseLabel} lease ownership was lost during renewal`);
        },
        release: async () => {
          if (released) return;
          try {
            if (await pathStillOwned()) {
              const current = parseLeaseRecord(await fs.readFile(lockPath, "utf8"));
              if (current?.nonce === nonce && current.pid === process.pid) await fs.rm(lockPath);
            }
          } finally {
            released = true;
            await handle.close().catch(() => undefined);
          }
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      let staleStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        staleStat = await fs.stat(lockPath);
        const current = parseLeaseRecord(await fs.readFile(lockPath, "utf8"));
        stale = !current || current.expiresAt <= Date.now();
      } catch (readError: any) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (stale && staleStat) {
        try {
          const now = await fs.stat(lockPath);
          if (now.dev === staleStat.dev && now.ino === staleStat.ino) await fs.rm(lockPath);
        } catch (removeError: any) {
          if (removeError?.code !== "ENOENT") throw removeError;
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, VAULT_LOCK_RETRY_MS));
    }
  }
  throw new Error(`Timed out acquiring the device ${leaseLabel.toLowerCase()} lease`);
}

async function acquireVaultProcessLock(lockPath = VAULT_LOCK_PATH): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + VAULT_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      await handle.close();
      return async () => { await fs.rm(lockPath, { force: true }); };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (await isStaleVaultLock(lockPath)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, VAULT_LOCK_RETRY_MS));
    }
  }
  throw new Error("Timed out acquiring the device credential vault lock");
}

async function isStaleVaultLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const value = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
    if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
      try {
        process.kill(value.pid, 0);
        return false;
      } catch (error: any) {
        if (error?.code !== "ESRCH") return false;
        return true;
      }
    }
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > VAULT_LOCK_TIMEOUT_MS;
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
}

function platformBackend() {
  if (process.platform === "darwin") return macKeychain;
  if (process.platform === "linux") return linuxSecretService;
  if (process.platform === "win32") return windowsDpapi;
  throw new Error(`No native credential backend for ${process.platform}`);
}

const MAC_KEYCHAIN_CHUNK_SIZE = 96;
const MAC_KEYCHAIN_MANIFEST_ACCOUNT = `${ACCOUNT}:manifest`;

type MacKeychainManifest = {
  generation: string;
  chunks: number;
};

function macChunkAccount(generation: string, index: number): string {
  return `${ACCOUNT}:${generation}:${index.toString().padStart(3, "0")}`;
}

function parseMacManifest(value: string | null): MacKeychainManifest | null {
  if (!value) return null;
  const match = /^v1:([0-9a-f]{24}):(\d+)$/.exec(value);
  if (!match) return null;
  const chunks = Number(match[2]);
  if (!Number.isSafeInteger(chunks) || chunks < 1 || chunks > 1000) return null;
  return { generation: match[1], chunks };
}

async function loadMacKeychainSecret(account: string): Promise<string | null> {
  const result = await run("security", [
    "find-generic-password", "-a", account, "-s", SERVICE, "-w",
  ], { allowNotFound: true });
  return result.code === 0 ? result.stdout.trimEnd() : null;
}

async function deleteMacKeychainSecret(account: string): Promise<void> {
  await run("security", [
    "delete-generic-password", "-a", account, "-s", SERVICE,
  ], { allowNotFound: true });
}

async function clearMacGeneration(manifest: MacKeychainManifest | null): Promise<void> {
  if (!manifest) return;
  await Promise.all(Array.from({ length: manifest.chunks }, (_, index) =>
    deleteMacKeychainSecret(macChunkAccount(manifest.generation, index))));
}

const macKeychain = {
  async load() {
    const manifestRaw = await loadMacKeychainSecret(MAC_KEYCHAIN_MANIFEST_ACCOUNT);
    if (manifestRaw !== null) {
      const manifest = parseMacManifest(manifestRaw);
      if (!manifest) throw new Error("Device credential keychain manifest is corrupt");
      const chunks: string[] = [];
      for (let index = 0; index < manifest.chunks; index++) {
        const chunk = await loadMacKeychainSecret(macChunkAccount(manifest.generation, index));
        if (chunk === null) throw new Error("Device credential keychain chunks are incomplete");
        chunks.push(chunk);
      }
      const encoded = chunks.join("");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new Error("Device credential keychain chunks are corrupt");
      }
      return Buffer.from(encoded, "base64").toString("utf8");
    }
    // Backward compatibility for the original single-item format. Long values
    // written through the interactive security(1) prompt may be truncated;
    // NativeCredentialStore.load() detects and clears those safely.
    return loadMacKeychainSecret(ACCOUNT);
  },
  async save(secret: string) {
    const previous = parseMacManifest(
      await loadMacKeychainSecret(MAC_KEYCHAIN_MANIFEST_ACCOUNT),
    );
    const generation = randomBytes(12).toString("hex");
    const encoded = Buffer.from(secret, "utf8").toString("base64");
    const chunks = Array.from(
      { length: Math.ceil(encoded.length / MAC_KEYCHAIN_CHUNK_SIZE) },
      (_, index) => encoded.slice(
        index * MAC_KEYCHAIN_CHUNK_SIZE,
        (index + 1) * MAC_KEYCHAIN_CHUNK_SIZE,
      ),
    );
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        await saveMacKeychainSecret(macChunkAccount(generation, index), chunks[index]);
      }
      // Commit the new generation last so an interrupted rotation keeps the
      // previously complete credential readable.
      await saveMacKeychainSecret(
        MAC_KEYCHAIN_MANIFEST_ACCOUNT,
        `v1:${generation}:${chunks.length}`,
      );
    } catch (error) {
      await clearMacGeneration({ generation, chunks: chunks.length });
      throw error;
    }
    await deleteMacKeychainSecret(ACCOUNT);
    if (previous && previous.generation !== generation) {
      await clearMacGeneration(previous);
    }
  },
  async clear() {
    const manifest = parseMacManifest(
      await loadMacKeychainSecret(MAC_KEYCHAIN_MANIFEST_ACCOUNT),
    );
    await clearMacGeneration(manifest);
    await deleteMacKeychainSecret(MAC_KEYCHAIN_MANIFEST_ACCOUNT);
    await deleteMacKeychainSecret(ACCOUNT);
  },
};

const MAC_KEYCHAIN_EXPECT = String.raw`
set timeout 15
set secret [read stdin]
regsub {\r?\n$} $secret {} secret
set account $env(DC_KEYCHAIN_ACCOUNT)
set service $env(DC_KEYCHAIN_SERVICE)
spawn -noecho security add-generic-password -a $account -s $service -U -w
expect "password data for new item:"
send -- "$secret\r"
expect "retype password for new item:"
send -- "$secret\r"
expect eof
catch wait result
exit [lindex $result 3]
`;

async function saveMacKeychainSecret(account: string, secret: string): Promise<void> {
  // security(1)'s interactive password reader truncates long input (128 bytes
  // on current macOS). Store bounded chunks through a PTY so the secret never
  // appears in argv or the environment.
  await run("/usr/bin/expect", ["-c", MAC_KEYCHAIN_EXPECT], {
    input: `${secret}\n`,
    env: {
      ...process.env,
      DC_KEYCHAIN_ACCOUNT: account,
      DC_KEYCHAIN_SERVICE: SERVICE,
    },
  });
}

const linuxSecretService = {
  async load() {
    const result = await run("secret-tool", [
      "lookup", "service", SERVICE, "account", ACCOUNT,
    ], { allowNotFound: true });
    return result.code === 0 && result.stdout ? result.stdout.trimEnd() : null;
  },
  async save(secret: string) {
    // secret-tool intentionally reads the secret from stdin.
    await run("secret-tool", [
      "store", `--label=Desktop Commander Remote MCP`,
      "service", SERVICE, "account", ACCOUNT,
    ], { input: secret });
  },
  async clear() {
    await run("secret-tool", [
      "clear", "service", SERVICE, "account", ACCOUNT,
    ], { allowNotFound: true });
  },
};

const dpapiPath = NATIVE_CREDENTIAL_CONFIG.dpapiPath;
const windowsDpapi = {
  async load() {
    try {
      await fs.access(dpapiPath);
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Device credential DPAPI file is not accessible: ${error?.code ?? "unknown"}`);
    }
    const result = await runPowerShell(`
      $raw = [IO.File]::ReadAllText($env:DC_CRED_PATH)
      $enc = [Convert]::FromBase64String($raw)
      $plain = [Security.Cryptography.ProtectedData]::Unprotect(
        $enc, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
    `);
    return result.stdout;
  },
  async save(secret: string) {
    await fs.mkdir(path.dirname(dpapiPath), { recursive: true });
    await runPowerShell(`
      $text = [Console]::In.ReadToEnd()
      $bytes = [Text.Encoding]::UTF8.GetBytes($text)
      $enc = [Security.Cryptography.ProtectedData]::Protect(
        $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [IO.File]::WriteAllText($env:DC_CRED_PATH, [Convert]::ToBase64String($enc))
    `, secret);
  },
  async clear() {
    await fs.rm(dpapiPath, { force: true });
  },
};

function runPowerShell(script: string, input?: string) {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input,
      env: { ...process.env, DC_CRED_PATH: dpapiPath },
    },
  );
}

type RunResult = { code: number; stdout: string; stderr: string };

function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const exit = code ?? 1;
      if (exit === 0 || options.allowNotFound) {
        resolve({ code: exit, stdout, stderr });
        return;
      }
      reject(new Error(`${command} failed (${exit}): ${stderr.trim()}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
