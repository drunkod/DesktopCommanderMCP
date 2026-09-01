import { toJsonValue } from "./json.js";

const APP_ORIGIN = (process.env.MCP_SERVER_URL ?? process.env.APP_ORIGIN ?? "http://127.0.0.1:3000").replace(/\/$/, "");

export type DeviceRegistration = {
  deviceId: string;
  oauthClientId: string;
  jazzToken: string;
  expiresIn: number;
};

export async function registerDeviceWithControlPlane(
  accessToken: string,
  input: {
    stableId: string;
    name: string;
    platform: string;
    appVersion: string;
    capabilities: unknown;
  },
): Promise<DeviceRegistration> {
  return post<DeviceRegistration>("/api/device/register", accessToken, {
    ...input,
    capabilities: toJsonValue(input.capabilities, "device capabilities"),
  });
}

export async function getJazzDeviceToken(
  accessToken: string,
  deviceId: string,
): Promise<string> {
  const response = await post<{ jazzToken: string; expiresIn: number }>(
    "/api/device/jazz-token",
    accessToken,
    { deviceId },
  );
  return response.jazzToken;
}

export async function sendDeviceHeartbeat(
  accessToken: string,
  input: {
    deviceId: string;
    status: "online" | "offline";
    lastError?: string | null;
  },
): Promise<void> {
  await post<Record<string, never>>("/api/device/heartbeat", accessToken, input);
}

export async function claimRemoteCall(
  accessToken: string,
  input: { callId: string; deviceId: string },
): Promise<boolean> {
  const response = await post<{ claimed: boolean }>(
    `/api/device/calls/${encodeURIComponent(input.callId)}/claim`,
    accessToken,
    { deviceId: input.deviceId },
  );
  return response.claimed === true;
}

export async function completeRemoteCall(
  accessToken: string,
  input:
    | { callId: string; deviceId: string; status: "completed"; result: unknown }
    | { callId: string; deviceId: string; status: "failed"; error: string },
): Promise<void> {
  const { callId, ...body } = input;
  await post<Record<string, never>>(
    `/api/device/calls/${encodeURIComponent(callId)}/complete`,
    accessToken,
    body,
  );
}

async function post<T>(path: string, accessToken: string, body: unknown): Promise<T> {
  const response = await fetch(`${APP_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as
    | ({ ok?: boolean; error?: string } & Partial<T>)
    | null;
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error ?? `Control-plane request failed: HTTP ${response.status}`);
  }
  return data as T;
}
