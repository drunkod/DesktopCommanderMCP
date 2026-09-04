export type TunnelProviderName = "tailscale" | "zrok";

export type TunnelState = {
  provider: TunnelProviderName;
  status: "starting" | "online" | "offline" | "degraded";
  /** End-to-end readiness: transport, local backend, and public path. */
  healthy: boolean;
  /** Provider infrastructure is connected and mapped to the expected target. */
  transportHealthy: boolean;
  /** Local HTTP control-plane readiness endpoint responds with HTTP 200. */
  backendHealthy: boolean;
  /** Public HTTPS readiness and protected-resource metadata are healthy. */
  publicHealthy: boolean;
  identity?: string;
  publicBaseUrl?: string;
  publicMcpUrl?: string;
  identityDrift?: boolean;
  expectedPublicBaseUrl?: string;
  observedPublicBaseUrl?: string;
  localTarget: string;
  detail?: string;
  startedAt?: string;
};

export type TunnelDoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type TunnelDoctorReport = {
  provider: TunnelProviderName;
  ok: boolean;
  checks: TunnelDoctorCheck[];
  state?: TunnelState;
};

export interface TunnelProvider {
  readonly name: TunnelProviderName;
  start(): Promise<TunnelState>;
  status(): Promise<TunnelState>;
  /** Explicit repair that preserves durable identity. */
  restart(): Promise<void>;
  /** Explicit runtime stop that preserves durable identity. */
  stop(): Promise<void>;
  doctor(): Promise<TunnelDoctorReport>;
  /** Undo only runtime state created by the immediately preceding startup attempt. */
  rollbackStartup?(): Promise<void>;
  installAgent?(): Promise<string>;
  uninstallAgent?(): Promise<void>;
  console?(): Promise<string>;
  deleteName?(): Promise<void>;
}

export type TunnelProviderOptions = {
  localTarget: string;
  localTargetExplicit?: boolean;
  healthPath?: string;
  name?: string;
  namespace?: string;
  statePath?: string;
  installAgentService?: boolean;
  force?: boolean;
};
