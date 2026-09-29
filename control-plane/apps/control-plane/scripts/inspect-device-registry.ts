import { runWorkerCliWithExitCode } from "./worker-cli";

await runWorkerCliWithExitCode(async () => {
  const [{ app }, { jazzBackendDb }] = await Promise.all([
    import("../schema"),
    import("../lib/jazz-principal"),
  ]);

  const devices = await jazzBackendDb().all(
    app.devices.orderBy("lastSeenAt", "asc"),
    { tier: "global" },
  );

  console.log(JSON.stringify(devices.map((device) => ({
    id: device.id,
    ownerId: device.ownerId,
    stableId: device.stableId,
    oauthClientId: device.oauthClientId,
    name: device.name,
    platform: device.platform,
    appVersion: device.appVersion,
    status: device.status,
    lastSeenAt: device.lastSeenAt.toISOString(),
    revokedAt: device.revokedAt?.toISOString() ?? null,
    authRevocationState: device.authRevocationState ?? null,
  })), null, 2));

  return 0;
});
