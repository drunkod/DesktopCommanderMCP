import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { DeviceOAuthSession } from "./device-oauth.js";
import type { DeviceCredentialStore } from "./credential-store.js";

const SERVICE = "com.desktopcommander.remote-mcp";
const ACCOUNT = "device-oauth-session";

type RunOptions = {
  input?: string;
  env?: NodeJS.ProcessEnv;
  allowNotFound?: boolean;
};

export class NativeCredentialStore implements DeviceCredentialStore {
  async load(): Promise<DeviceOAuthSession | null> {
    const backend = platformBackend();
    const raw = await backend.load();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DeviceOAuthSession;
    } catch (error) {
      // A partial/corrupt vault entry cannot be refreshed safely. Clear it and
      // fall back to the normal pairing path instead of crashing startup.
      await backend.clear();
      console.warn(`Ignoring corrupt persisted OAuth session: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async save(session: DeviceOAuthSession): Promise<void> {
    await platformBackend().save(JSON.stringify(session));
  }

  async clear(): Promise<void> {
    await platformBackend().clear();
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
    const manifest = parseMacManifest(manifestRaw);
    if (manifest) {
      const chunks: string[] = [];
      for (let index = 0; index < manifest.chunks; index += 1) {
        const chunk = await loadMacKeychainSecret(macChunkAccount(manifest.generation, index));
        if (chunk === null) return null;
        chunks.push(chunk);
      }
      return Buffer.from(chunks.join(""), "base64").toString("utf8");
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

const dpapiPath = path.join(
  process.env.LOCALAPPDATA ?? os.homedir(),
  "DesktopCommander",
  "jazz-oauth.dpapi",
);
const windowsDpapi = {
  async load() {
    try {
      await fs.access(dpapiPath);
    } catch {
      return null;
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
