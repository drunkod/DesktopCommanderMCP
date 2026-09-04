import type { TunnelProviderName } from "../remote-device/tunnel/types.js";

export type RemoteTunnelCommand = "run" | "prepare" | "status" | "doctor" | "console" | "stop" | "disable" | "restart" | "install-agent" | "uninstall-agent" | "delete-name";

export type RemoteOptions = {
  tunnel?: TunnelProviderName;
  tunnelCommand: RemoteTunnelCommand;
  tunnelTarget: string;
  tunnelTargetExplicit: boolean;
  tunnelName?: string;
  tunnelNamespace?: string;
  tunnelHealthPath: string;
  installTunnelAgent: boolean;
  disableNoSleep: boolean;
  debug: boolean;
  persistSession: boolean;
  confirm: boolean;
  force: boolean;
};

const providers = new Set(["tailscale", "zrok", "none"]);
const operatorCommands = new Set<RemoteTunnelCommand>(["prepare", "status", "doctor", "console", "stop", "disable", "restart", "install-agent", "uninstall-agent", "delete-name"]);

export function parseRemoteOptions(argv: string[] = process.argv.slice(3)): RemoteOptions {
  let tunnel: TunnelProviderName | undefined;
  let tunnelCommand: RemoteTunnelCommand = "run";
  let tunnelTargetExplicit = process.env.DC_TUNNEL_TARGET !== undefined;
  let tunnelTarget = process.env.DC_TUNNEL_TARGET ?? "http://127.0.0.1:3000";
  let tunnelName = process.env.DC_ZROK_NAME;
  let tunnelNamespace = process.env.DC_ZROK_NAMESPACE ?? process.env.ZROK_NAMESPACE;
  let tunnelHealthPath = process.env.DC_TUNNEL_HEALTH_PATH ?? "/.well-known/oauth-protected-resource/mcp";
  let installTunnelAgent = process.env.DC_TUNNEL_INSTALL_AGENT === "1";
  let persistSession = true;
  let debug = false;
  let disableNoSleep = false;
  let confirm = false;
  let force = false;
  let tunnelKeywordPending = false;

  const valueFor = (arg: string, index: number): [string, number] => {
    const equals = arg.indexOf("=");
    if (equals >= 0) {
      const value = arg.slice(equals + 1);
      if (!value) throw new Error(`${arg} requires a value`);
      return [value, index];
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    return [value, index + 1];
  };

  const setProvider = (value: string): void => {
    if (!providers.has(value)) throw new Error(`Unknown tunnel provider: ${value}`);
    tunnel = value === "none" ? undefined : value as TunnelProviderName;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "tunnel") {
      if (tunnelKeywordPending) throw new Error("Duplicate tunnel command");
      tunnelKeywordPending = true;
      continue;
    }
    if (tunnelKeywordPending) {
      if (operatorCommands.has(arg as RemoteTunnelCommand)) {
        tunnelCommand = arg as RemoteTunnelCommand;
        tunnelKeywordPending = false;
        continue;
      }
      if (providers.has(arg)) {
        setProvider(arg);
        tunnelKeywordPending = false;
        continue;
      }
      throw new Error(`Expected tunnel provider or command after "tunnel", got: ${arg}`);
    }
    if (operatorCommands.has(arg as RemoteTunnelCommand)) {
      tunnelCommand = arg as RemoteTunnelCommand;
      continue;
    }
    if (arg === "--tunnel" || arg.startsWith("--tunnel=")) {
      const [value, next] = valueFor(arg, i); i = next; setProvider(value); continue;
    }
    if (arg === "--tunnel-target" || arg.startsWith("--tunnel-target=")) {
      [tunnelTarget, i] = valueFor(arg, i); tunnelTargetExplicit = true; continue;
    }
    if (arg === "--tunnel-name" || arg.startsWith("--tunnel-name=")) {
      [tunnelName, i] = valueFor(arg, i); continue;
    }
    if (arg === "--tunnel-namespace" || arg.startsWith("--tunnel-namespace=")) {
      [tunnelNamespace, i] = valueFor(arg, i); continue;
    }
    if (arg === "--tunnel-health-path" || arg.startsWith("--tunnel-health-path=")) {
      [tunnelHealthPath, i] = valueFor(arg, i); continue;
    }
    if (arg === "--tunnel-install-agent") { installTunnelAgent = true; continue; }
    if (arg === "--debug") { debug = true; continue; }
    if (arg === "--disable-no-sleep") { disableNoSleep = true; continue; }
    if (arg === "--no-persist-session") { persistSession = false; continue; }
    if (arg === "--persist-session") { persistSession = true; continue; }
    if (arg === "--confirm") { confirm = true; continue; }
    if (arg === "--force") { force = true; continue; }
    if (arg === "--tunnel-status") { tunnelCommand = "status"; continue; }
    if (arg === "--tunnel-doctor") { tunnelCommand = "doctor"; continue; }
    if (arg === "--tunnel-console") { tunnelCommand = "console"; continue; }
    if (arg === "--tunnel-stop") { tunnelCommand = "stop"; continue; }
    if (arg === "--tunnel-restart") { tunnelCommand = "restart"; continue; }
    throw new Error(`Unknown remote option: ${arg}`);
  }

  if (tunnelKeywordPending) throw new Error('"remote tunnel" requires a provider or operator command');
  if (tunnelCommand !== "run" && !tunnel) throw new Error("Tunnel provider is required for operator commands");

  return { tunnel, tunnelCommand, tunnelTarget, tunnelTargetExplicit, tunnelName, tunnelNamespace, tunnelHealthPath, installTunnelAgent, disableNoSleep, debug, persistSession, confirm, force };
}
