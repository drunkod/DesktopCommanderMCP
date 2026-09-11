import { definePermissions } from "jazz-tools/permissions";
import { app } from "@remote-dc/protocol";

const jazzAppId = requiredEnv("JAZZ_APP_ID");
const remoteResource = requiredEnv("REMOTE_MCP_RESOURCE");
const appOrigin = requiredEnv("APP_ORIGIN").replace(/\/$/, "");
const capabilityIssuer = `${appOrigin}/.well-known/jazz-capability`;
const capabilityAudience = `urn:remote-mcp:jazz:${jazzAppId}`;

const appPermissions = definePermissions(
  app,
  ({ policy, session, allOf, anyOf }) => {
    const owned = { ownerId: session.user_id };
    // Jazz authenticates against a dedicated capability-only ES256 key.
    // Keep policy context checks minimal and deterministic on alpha.53.
    const dashboard = session.where({
      "claims.token_use": "jazz-dashboard",
      "claims.jazz_audience": capabilityAudience,
    });
    const device = session.where({
      "claims.token_use": "jazz-device",
      "claims.jazz_audience": capabilityAudience,
    });
    const userControl = dashboard;
    const activeDeviceCredential = {
      id: session["claims.device_id"],
      oauthClientId: session["claims.client_id"],
      revokedAt: null,
    };

    policy.devices.allowRead.where(() =>
      anyOf([
        allOf([owned, userControl]),
        allOf([owned, activeDeviceCredential, device]),
      ]),
    );
    policy.devices.allowInsert.never();
    policy.devices.allowUpdate.never();
    policy.devices.allowDelete.never();

    policy.remoteCalls.allowRead.where((call) =>
      anyOf([
        allOf([owned, userControl]),
        allOf([
          owned,
          device,
          { deviceId: session["claims.device_id"] },
          policy.devices.exists.where({
            id: call.deviceId,
            oauthClientId: session["claims.client_id"],
            revokedAt: null,
          }),
        ]),
      ]),
    );
    policy.remoteCalls.allowInsert.never();
    policy.remoteCalls.allowUpdate.never();
    policy.remoteCalls.allowDelete.never();

    // MVP queue state is server-owned. MCP/chat HTTP handlers use the trusted
    // backend context; no browser/device Jazz principal may mutate queue rows.
    policy.workerSessions.allowRead.never();
    policy.workerSessions.allowInsert.never();
    policy.workerSessions.allowUpdate.never();
    policy.workerSessions.allowDelete.never();

    policy.chatJobs.allowRead.never();
    policy.chatJobs.allowInsert.never();
    policy.chatJobs.allowUpdate.never();
    policy.chatJobs.allowDelete.never();

    policy.auditEvents.allowRead.where(allOf([owned, userControl]));
    policy.auditEvents.allowInsert.never();
    policy.auditEvents.allowUpdate.never();
    policy.auditEvents.allowDelete.never();
  },
);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required while compiling Jazz permissions`);
  return value;
}

export default appPermissions;
