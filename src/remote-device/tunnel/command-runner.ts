import { execFile, spawn } from "node:child_process";

export type CommandResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  safeStdout: string;
  safeStderr: string;
  code: number;
};

export type CommandRunOptions = {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type CommandRunnerLike = {
  run(command: string, args?: string[], options?: CommandRunOptions): Promise<CommandResult>;
  runDetached(command: string, args?: string[], options?: Omit<CommandRunOptions, "timeoutMs">): Promise<number>;
};

const SECRET_FLAGS = new Set([
  "--token", "--access-token", "--refresh-token", "--api-key",
  "--password", "--secret", "--enrollment-token", "--auth-token",
]);

export class CommandError extends Error {
  constructor(message: string, readonly result?: Partial<CommandResult>) {
    super(message);
    this.name = "CommandError";
  }
}

/** Executes tunnel CLIs without a shell, so user-controlled names never become shell code. */
export class CommandRunner implements CommandRunnerLike {
  async run(command: string, args: string[] = [], options: CommandRunOptions = {}): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        const code = error?.code === "ETIMEDOUT" ? -1 : typeof error?.code === "number" ? error.code : 0;
        const result: CommandResult = {
          command,
          args,
          stdout: String(stdout),
          stderr: String(stderr),
          safeStdout: redactSensitive(String(stdout)),
          safeStderr: redactSensitive(String(stderr)),
          code,
        };
        if (error || code !== 0) {
          const safeResult = safeCommandResult(result);
          reject(new CommandError(
            `${command} ${redactArgs(args).join(" ")} failed${code === -1 ? " (timed out)" : ` (exit ${code})`}: ${safeResult.stderr || safeResult.stdout}`.trim(),
            safeResult,
          ));
          return;
        }
        resolve(result);
      });
      child.once("error", (error) => reject(new CommandError(
        `${command} could not be started: ${redactSensitive(error.message)}`,
        { command, args: redactArgs(args) },
      )));
    });
  }

  async runDetached(command: string, args: string[] = [], options: Omit<CommandRunOptions, "timeoutMs"> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (error) => reject(new CommandError(
        `${command} could not be started: ${redactSensitive(error.message)}`,
        { command, args: redactArgs(args) },
      )));
      child.once("spawn", () => { child.unref(); resolve(child.pid ?? -1); });
    });
  }
}

export function redactSensitive(value: string): string {
  return value
    .replace(/((?:["']?\bauthorization\b["']?\s*[:=]\s*["']?bearer\s+))[^\s,;&"'}]+/gi, "$1[REDACTED]")
    .replace(/((?:["']?\b(?:access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key|enrollment[_-]?token|auth[_-]?token)\b["']?\s*[=:]\s*["']?))[^\s,;&"'}]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_token|refresh_token|token|key|secret|api_key)=)[^&\s#]+/gi, "$1[REDACTED]");
}

export function redactArgs(args: string[]): string[] {
  const safe: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (SECRET_FLAGS.has(arg.toLowerCase())) {
      safe.push(arg);
      if (i + 1 < args.length) safe.push("[REDACTED]"), i++;
      continue;
    }
    const lowerArg = arg.toLowerCase();
    const flag = [...SECRET_FLAGS].find((candidate) => lowerArg.startsWith(`${candidate}=`));
    safe.push(flag ? `${arg.slice(0, flag.length)}=[REDACTED]` : redactSensitive(arg));
  }
  return safe;
}

export function safeCommandResult(result: CommandResult): CommandResult {
  return {
    ...result,
    args: redactArgs(result.args),
    stdout: result.safeStdout,
    stderr: result.safeStderr,
    safeStdout: result.safeStdout,
    safeStderr: result.safeStderr,
  };
}

export function parseJsonOutput<T>(output: string): T | null {
  const text = output.trim();
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { /* scan for a complete trailing document below */ }

  // Some CLIs prefix machine-readable JSON with warnings or informational
  // text. Scan candidate *outer* delimiters from left to right instead of
  // using lastIndexOf(), which lands on an innermost nested object.
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "{" && char !== "[") continue;
    try { return JSON.parse(text.slice(index)) as T; } catch { /* try the next candidate */ }
  }
  return null;
}
