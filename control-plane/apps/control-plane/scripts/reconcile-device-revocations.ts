import { app } from "../schema";
import { disableOAuthClient } from "../lib/authorization-service";
import { jazzContext } from "../lib/jazz-context";

async function main(): Promise<void> {
  const db = jazzContext().asBackend(app);
  const rows = await db.all(app.devices, { tier: "global" });
  const pending = rows.filter(
    (device) => device.revokedAt && device.authRevocationState !== "completed",
  );
  const counters = { scanned: rows.length, pending: pending.length, completed: 0, failed: 0 };

  for (const device of pending) {
    try {
      await disableOAuthClient(device.oauthClientId);
      const write = db.update(app.devices, device.id, {
        authRevocationState: "completed",
        authRevocationLastAttemptAt: new Date(),
        authRevocationError: undefined,
      });
      await write.wait({ tier: "global" });
      counters.completed += 1;
    } catch (error) {
      const message = safeError(error);
      const write = db.update(app.devices, device.id, {
        authRevocationState: "error",
        authRevocationLastAttemptAt: new Date(),
        authRevocationError: message,
      });
      await write.wait({ tier: "global" }).catch(() => undefined);
      counters.failed += 1;
    }
  }

  console.log(JSON.stringify(counters));
  if (counters.failed > 0) process.exitCode = 1;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
