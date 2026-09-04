import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CommandRunner, type CommandRunnerLike } from "./command-runner.js";

export class MacosLaunchAgent {
  readonly label = "io.desktop-commander.zrok-agent";
  private readonly plistPath: string;

  constructor(
    plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "io.desktop-commander.zrok-agent.plist"),
    private readonly runner: CommandRunnerLike = new CommandRunner(),
  ) { this.plistPath = plistPath; }

  async install(zrokCommand = process.env.ZROK_BIN ?? "zrok2"): Promise<string> {
    if (process.platform !== "darwin") throw new Error("The zrok LaunchAgent is only supported on macOS");
    const executable = await this.resolveExecutable(zrokCommand);
    const launchAgentDir = path.dirname(this.plistPath);
    await fs.mkdir(launchAgentDir, { recursive: true, mode: 0o700 });
    await fs.chmod(launchAgentDir, 0o700);
    const logDir = path.join(os.homedir(), "Library", "Logs", "DesktopCommander");
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
    await fs.chmod(logDir, 0o700);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(this.label)}</string>\n  <key>ProgramArguments</key><array><string>${xml(executable)}</string><string>agent</string><string>start</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Background</string>\n  <key>StandardOutPath</key><string>${xml(path.join(logDir, "zrok-agent.log"))}</string>\n  <key>StandardErrorPath</key><string>${xml(path.join(logDir, "zrok-agent.error.log"))}</string>\n</dict></plist>\n`;
    await fs.writeFile(this.plistPath, plist, { mode: 0o600 });
    await fs.chmod(this.plistPath, 0o600);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const domain = `gui/${uid}`;
    // bootout is intentionally best-effort: the service may not be loaded yet.
    await this.runner.run("launchctl", ["bootout", domain, this.plistPath]).catch(() => undefined);
    await this.runner.run("launchctl", ["bootstrap", domain, this.plistPath]);
    return this.plistPath;
  }

  private async resolveExecutable(command: string): Promise<string> {
    if (path.isAbsolute(command)) return fs.realpath(command);
    const result = await this.runner.run("/usr/bin/which", [command], { timeoutMs: 10_000 });
    const resolved = result.stdout.trim();
    if (!resolved || !path.isAbsolute(resolved)) throw new Error(`Could not resolve executable: ${command}`);
    return fs.realpath(resolved);
  }

  async uninstall(): Promise<void> {
    if (process.platform !== "darwin") throw new Error("The zrok LaunchAgent is only supported on macOS");
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    await this.runner.run("launchctl", ["bootout", `gui/${uid}`, this.plistPath]).catch(() => undefined);
    await fs.rm(this.plistPath, { force: true });
  }

  get path(): string { return this.plistPath; }
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
