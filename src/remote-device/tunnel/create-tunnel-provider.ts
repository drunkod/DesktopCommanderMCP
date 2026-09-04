import type { CommandRunnerLike } from "./command-runner.js";
import { TailscaleCli } from "./tailscale-cli.js";
import { TailscaleTunnelProvider } from "./tailscale-tunnel-provider.js";
import { TailscaleIdentityStore } from "./tailscale-identity-store.js";
import type { TunnelProvider, TunnelProviderOptions } from "./types.js";
import { ZrokCli } from "./zrok-cli.js";
import { ZrokNameStore } from "./zrok-name-store.js";
import { ZrokTunnelProvider } from "./zrok-tunnel-provider.js";

export type CreateTunnelProviderOptions = TunnelProviderOptions & {
  runner?: CommandRunnerLike;
};

export function createTunnelProvider(name: "tailscale" | "zrok", options: CreateTunnelProviderOptions): TunnelProvider {
  if (name === "tailscale") return new TailscaleTunnelProvider(options, new TailscaleCli(options.runner), new TailscaleIdentityStore(options.statePath));
  return new ZrokTunnelProvider(options, new ZrokCli(options.runner), new ZrokNameStore(options.statePath));
}
