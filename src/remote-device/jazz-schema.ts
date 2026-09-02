import { schema as s } from "jazz-tools";

export const applicationSchema = {
  devices: s.table({
    ownerId: s.string(),
    stableId: s.string(),
    oauthClientId: s.string(),
    name: s.string(),
    platform: s.string(),
    appVersion: s.string(),
    capabilities: s.json(),
    status: s.string(),
    lastSeenAt: s.timestamp(),
    lastError: s.string().optional(),
    reconnectGeneration: s.int(),
    reconnectRequestedAt: s.timestamp().optional(),
    revokedAt: s.timestamp().optional(),
    authRevocationState: s.string().optional(),
    authRevocationLastAttemptAt: s.timestamp().optional(),
    authRevocationError: s.string().optional(),
  }),
  remoteCalls: s.table({
    ownerId: s.string(),
    requestId: s.string(),
    requestFingerprint: s.string(),
    deviceId: s.ref("devices"),
    toolName: s.string(),
    toolArgs: s.json(),
    metadata: s.json(),
    status: s.string(),
    result: s.json().optional(),
    error: s.string().optional(),
    claimedByClientId: s.string().optional(),
    claimedAt: s.timestamp().optional(),
    completedAt: s.timestamp().optional(),
    expiresAt: s.timestamp(),
  }),
  auditEvents: s.table({
    ownerId: s.string(),
    kind: s.string(),
    deviceId: s.ref("devices").optional(),
    remoteCallId: s.ref("remoteCalls").optional(),
    summary: s.string(),
    details: s.json(),
    occurredAt: s.timestamp(),
  }),
};

export const applicationOnlyApp = s.defineApp(applicationSchema);

export const app = s.defineApp(applicationSchema);
