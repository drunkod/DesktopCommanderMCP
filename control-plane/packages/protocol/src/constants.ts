export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_SCOPE = "openid profile email offline_access device:sync";
export const MCP_SCOPE = "mcp:tools";
export const DASHBOARD_SCOPE = "dashboard";

export const CALL_STATUS = {
  pending: "pending",
  executing: "executing",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  indeterminate: "indeterminate",
} as const;

export const CONTROL_TOOL = {
  ping: "__control.ping",
  reconnect: "__control.reconnect",
  shutdown: "__control.shutdown",
} as const;

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALE_MS = 45_000;
export const EXECUTION_STALE_GRACE_MS = 30_000;
