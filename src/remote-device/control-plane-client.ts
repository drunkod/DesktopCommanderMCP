import { toJsonValue } from "./json.js";
import { parseTrustedHttpUrl, type RuntimeProfile } from "./trusted-http-url.js";

const CONTROL_PLANE_TIMEOUT_MS = 10_000;
const MAX_CONTROL_PLANE_JSON_BYTES = 256 * 1024;
const CONTROL_PLANE_ERROR_CODES = new Set([
  "unauthorized", "forbidden", "invalid_request", "invalid_token", "device_revoked",
  "device_not_found", "claim_conflict", "not_ready", "rate_limited", "server_error",
  "remote_error",
]);

export type DeviceRegistrationInput = Readonly<{
  stableId: string;
  name: string;
  platform: string;
  appVersion: string;
  capabilities: unknown;
}>;

export type DeviceRegistration = Readonly<{
  deviceId: string;
  oauthClientId: string;
  jazzToken: string;
  expiresIn: number;
}>;

export type DeviceHeartbeatInput = Readonly<{
  deviceId: string;
  status: "online" | "offline";
  lastError?: string | null;
}>;

export type DeviceCallCompletion =
  | Readonly<{ callId: string; deviceId: string; status: "completed"; result: unknown }>
  | Readonly<{ callId: string; deviceId: string; status: "failed"; error: string }>;

export interface DeviceControlPlaneClient {
  register(accessToken: string, input: DeviceRegistrationInput): Promise<DeviceRegistration>;
  getJazzToken(accessToken: string, deviceId: string): Promise<string>;
  heartbeat(accessToken: string, input: DeviceHeartbeatInput): Promise<void>;
  claim(accessToken: string, input: { callId: string; deviceId: string }): Promise<boolean>;
  complete(accessToken: string, input: DeviceCallCompletion): Promise<void>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Control-plane response has invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Control-plane response has invalid ${label}`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Control-plane response has invalid ${label}`);
  }
  return value;
}

function parseRegistration(value: unknown): DeviceRegistration {
  const body = record(value, "registration");
  return {
    deviceId: text(body.deviceId, "deviceId"),
    oauthClientId: text(body.oauthClientId, "oauthClientId"),
    jazzToken: text(body.jazzToken, "jazzToken"),
    expiresIn: positiveNumber(body.expiresIn, "expiresIn"),
  };
}

function parseJazzToken(value: unknown): string {
  const body = record(value, "Jazz token");
  text(body.jazzToken, "jazzToken");
  positiveNumber(body.expiresIn, "expiresIn");
  return body.jazzToken as string;
}

function parseClaim(value: unknown): boolean {
  const body = record(value, "claim");
  if (typeof body.claimed !== "boolean") throw new Error("Control-plane response has invalid claimed");
  return body.claimed;
}

function parseAck(value: unknown): void {
  record(value, "acknowledgement");
}

function parseResponseJson(textValue: string, status: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    throw new Error(`Control-plane response was not valid JSON (HTTP ${status})`);
  }
  return record(parsed, "JSON body");
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type");
  if (!contentType || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new Error(`Control-plane response is not JSON (HTTP ${response.status})`);
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new Error(`Control-plane response must use identity content encoding (HTTP ${response.status})`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTROL_PLANE_JSON_BYTES) {
    throw new Error("Control-plane response is too large");
  }

  if (!response.body) {
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_CONTROL_PLANE_JSON_BYTES) throw new Error("Control-plane response is too large");
    return parseResponseJson(body, response.status);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("Control-plane request cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CONTROL_PLANE_JSON_BYTES) {
        await reader.cancel("Control-plane response is too large").catch(() => undefined);
        throw new Error("Control-plane response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseResponseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), response.status);
}

export class HttpDeviceControlPlaneClient implements DeviceControlPlaneClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, profile: RuntimeProfile = "development") {
    const url = parseTrustedHttpUrl(baseUrl, "internal device API origin", {
      urlClass: "internalLoopback",
      profile,
    });
    if (url.pathname !== "/") throw new Error("internal device API origin must not include a path");
    this.baseUrl = url.origin;
  }

  register(accessToken: string, input: DeviceRegistrationInput): Promise<DeviceRegistration> {
    return this.post("/api/device/register", accessToken, {
      ...input,
      capabilities: toJsonValue(input.capabilities, "device capabilities"),
    }, parseRegistration);
  }

  getJazzToken(accessToken: string, deviceId: string): Promise<string> {
    return this.post("/api/device/jazz-token", accessToken, { deviceId }, parseJazzToken);
  }

  async heartbeat(accessToken: string, input: DeviceHeartbeatInput): Promise<void> {
    await this.post("/api/device/heartbeat", accessToken, input, parseAck);
  }

  claim(accessToken: string, input: { callId: string; deviceId: string }): Promise<boolean> {
    return this.post(`/api/device/calls/${encodeURIComponent(input.callId)}/claim`, accessToken, { deviceId: input.deviceId }, parseClaim);
  }

  async complete(accessToken: string, input: DeviceCallCompletion): Promise<void> {
    const { callId, ...body } = input;
    await this.post(`/api/device/calls/${encodeURIComponent(callId)}/complete`, accessToken, body, parseAck);
  }

  private async post<T>(path: string, accessToken: string, body: unknown, parser: (value: unknown) => T): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("control-plane request deadline exceeded")), CONTROL_PLANE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "accept-encoding": "identity",
        },
        body: JSON.stringify(body),
      });
      const data = await readBoundedJson(response, controller.signal);
      if (!response.ok || data.ok !== true) {
        const rawCode = typeof data.error === "string" ? data.error : "remote_error";
        const code = CONTROL_PLANE_ERROR_CODES.has(rawCode) ? rawCode : "remote_error";
        throw new Error(`Control-plane request failed: ${code} (HTTP ${response.status})`);
      }
      return parser(data);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Control-plane")) throw error;
      if (error instanceof Error && error.message.startsWith("Control-plane request failed")) throw error;
      throw new Error(`Control-plane request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
