import { createDb } from "jazz-tools";
import { runWorkerCliWithExitCode } from "./worker-cli";

await runWorkerCliWithExitCode(async () => {
  const [{ app }, { mintJazzDashboardToken, mintJazzDeviceToken }, { jazzBackendDb }] = await Promise.all([
    import("../schema"),
    import("../lib/jazz-capability"),
    import("../lib/jazz-principal"),
  ]);
  const appId = process.env.JAZZ_APP_ID?.trim();
  const serverUrl = process.env.JAZZ_SERVER_URL?.trim();
  if (!appId || !serverUrl) {
    throw new Error("JAZZ_APP_ID and JAZZ_SERVER_URL are required");
  }

  const rows = await jazzBackendDb().all(
    app.devices.orderBy("lastSeenAt", "asc"),
    { tier: "global" },
  );

  const output = [];
  for (const row of rows) {
    const deviceToken = await mintJazzDeviceToken(row.ownerId, row.oauthClientId, row.id);
    const dashboardToken = await mintJazzDashboardToken(row.ownerId);
    const deviceDb = await createDb({
      appId,
      serverUrl,
      jwtToken: deviceToken,
    });
    const dashboardDb = await createDb({
      appId,
      serverUrl,
      jwtToken: dashboardToken,
    });
    try {
      const deviceVisible = await deviceDb.one(
        app.devices.where({ id: row.id }),
        { tier: "global" },
      );
      const dashboardVisible = await dashboardDb.one(
        app.devices.where({ id: row.id }),
        { tier: "global" },
      );
      output.push({
        id: row.id,
        backend: {
          ownerId: row.ownerId,
          stableId: row.stableId,
          oauthClientId: row.oauthClientId,
          status: row.status,
        },
        dashboard: dashboardVisible ? {
          ownerId: dashboardVisible.ownerId,
          stableId: dashboardVisible.stableId,
          oauthClientId: dashboardVisible.oauthClientId,
          status: dashboardVisible.status,
        } : null,
        device: deviceVisible ? {
          ownerId: deviceVisible.ownerId,
          stableId: deviceVisible.stableId,
          oauthClientId: deviceVisible.oauthClientId,
          status: deviceVisible.status,
        } : null,
        matches: {
          dashboardVisible: dashboardVisible !== null,
          dashboardStableId: dashboardVisible?.stableId === row.stableId,
          dashboardOauthClientId: dashboardVisible?.oauthClientId === row.oauthClientId,
          deviceVisible: deviceVisible !== null,
          deviceStableId: deviceVisible?.stableId === row.stableId,
          deviceOauthClientId: deviceVisible?.oauthClientId === row.oauthClientId,
        },
      });
    } finally {
      await dashboardDb.shutdown().catch(() => undefined);
      await deviceDb.shutdown().catch(() => undefined);
    }
  }

  console.log(JSON.stringify(output, null, 2));
  return 0;
});
