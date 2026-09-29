import * as z from "zod";
import { app } from "../../../../../../schema";
import { createDeviceProtectedHandler } from "../../../../../../lib/device-request-auth";
import { jazzBackendDb } from "../../../../../../lib/jazz-principal";

const bodySchema = z.object({ deviceId: z.string().uuid() }).strict();
const POST = createDeviceProtectedHandler(async (request, principal) => {
  const callId = callIdFromRequest(request);
  const parsed = bodySchema.safeParse(await readJson(request));
  if (!callId || !parsed.success) {
    return Response.json({ ok: false, error: "Invalid claim request" }, { status: 400 });
  }

  const backend = jazzBackendDb();
  const visibleCall = await waitForGlobalRow(() => backend.one(
    app.remoteCalls.where({ id: callId }),
    { tier: "global" },
  ));
  if (!visibleCall || visibleCall.ownerId !== principal.subject || visibleCall.deviceId !== parsed.data.deviceId) {
    return Response.json({ ok: false, error: "Remote call not found" }, { status: 404 });
  }
  const visibleDevice = await waitForGlobalRow(() => backend.one(
    app.devices.where({ id: parsed.data.deviceId }),
    { tier: "global" },
  ));
  if (!visibleDevice || visibleDevice.ownerId !== principal.subject || visibleDevice.oauthClientId !== principal.clientId || visibleDevice.revokedAt) {
    return Response.json({ ok: false, error: "Device is not active" }, { status: 403 });
  }

  try {
    const claim = await backend.transaction(async (tx) => {
      const current = await tx.one(app.remoteCalls.where({ id: callId }));
      if (!current || current.deviceId !== parsed.data.deviceId) return "missing" as const;
      if (current.status !== "pending") return "not_pending" as const;
      if (current.expiresAt.getTime() <= Date.now()) {
        tx.update(app.remoteCalls, callId, {
          status: "cancelled",
          error: "Call expired before execution",
          completedAt: new Date(),
        });
        return "expired" as const;
      }
      tx.update(app.remoteCalls, callId, {
        status: "executing",
        claimedByClientId: principal.clientId,
        claimedAt: new Date(),
      });
      return "claimed" as const;
    });
    const outcome = await claim.wait({ tier: "global" });
    return Response.json({
      ok: true,
      claimed: outcome === "claimed",
      outcome,
    });
  } catch (error) {
    if (/transaction_conflict/i.test(String(error))) {
      return Response.json({ ok: true, claimed: false, outcome: "conflict" });
    }
    throw error;
  }
});
async function waitForGlobalRow<T>(
  load: () => Promise<T | null | undefined>,
  timeoutMs = 2_000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let value = await load();
  while (value == null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await load();
  }
  return value ?? null;
}

function callIdFromRequest(request: Request): string | null {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const candidate = parts.at(-2);
  return candidate && z.string().uuid().safeParse(candidate).success ? candidate : null;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export { POST };
