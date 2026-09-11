import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { DeviceOAuthSession } from "./device-auth";
import type { DeviceCredentialStore } from "./credential-store";

const SERVICE = "com.desktopcommander.remote-mcp";
const ACCOUNT = "device-oauth-session";

type RunOptions = {
  input?: string;
  env?: NodeJS.ProcessEnv;
  allowNotFound?: boolean;
};

export class NativeCredentialStore implements DeviceCredentialStore {
  async load(): Promise<DeviceOAuthSession | null> {
    const raw = await platformBackend().load();
    return raw ? JSON.parse(raw) as DeviceOAuthSession : null;
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

const macKeychain = {
  async load() {
    const result = await run("security", [
      "find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w",
    ], { allowNotFound: true });
    return result.code === 0 ? result.stdout.trimEnd() : null;
  },
  async save(secret: string) {
    // `security` documents passing -w without a value as the secure prompt form.
    // Feeding that prompt over stdin avoids leaking the token through argv.
    await run("security", [
      "add-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-U", "-w",
    ], { input: `${secret}\n` });
  },
  async clear() {
    await run("security", [
      "delete-generic-password", "-a", ACCOUNT, "-s", SERVICE,
    ], { allowNotFound: true });
  },
};
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
