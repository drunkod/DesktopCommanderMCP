import * as z from "zod";
import { app } from "../../../../../../schema";
import { createDeviceProtectedHandler } from "../../../../../../lib/device-request-auth";
import { jazzAuthorityDb } from "../../../../../../lib/jazz-authority";
import { toJsonValue } from "../../../../../../lib/json";

const bodySchema = z.discriminatedUnion("status", [
  z.object({
    deviceId: z.string().uuid(),
    status: z.literal("completed"),
    result: z.unknown(),
  }).strict(),
  z.object({
    deviceId: z.string().uuid(),
    status: z.literal("failed"),
    error: z.string().min(1).max(2_000),
  }).strict(),
]);
const POST = createDeviceProtectedHandler(async (request, principal) => {
  const callId = callIdFromRequest(request);
  const parsed = bodySchema.safeParse(await readJson(request));
  if (!callId || !parsed.success) {
    return Response.json({ ok: false, error: "Invalid completion request" }, { status: 400 });
  }

  const backend = await jazzAuthorityDb();
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
  const completion = await backend.transaction(async (tx) => {
    const current = await tx.one(app.remoteCalls.where({ id: callId }));
    if (!current || current.deviceId !== parsed.data.deviceId) return "missing" as const;
    if (
      (current.status === "completed" || current.status === "failed")
      && current.claimedByClientId === principal.clientId
    ) {
      return "already_terminal" as const;
    }
    if (
      current.status !== "executing"
      || current.claimedByClientId !== principal.clientId
    ) {
      return "not_claimed" as const;
    }

    const completedAt = new Date();
    if (parsed.data.status === "completed") {
      tx.update(app.remoteCalls, callId, {
        status: "completed",
        result: toJsonValue(parsed.data.result, "remote call result"),
        error: undefined,
        completedAt,
      });
      if (current.toolName === "__control.reconnect") {
        tx.update(app.devices, parsed.data.deviceId, {
          status: "reconnecting",
          reconnectRequestedAt: completedAt,
        });
      }
    } else {
      tx.update(app.remoteCalls, callId, {
        status: "failed",
        result: undefined,
        error: parsed.data.error,
        completedAt,
      });
    }
    return "completed" as const;
  });

  const outcome = await completion.wait({ tier: "global" });
  if (outcome === "missing") {
    return Response.json({ ok: false, error: "Remote call not found" }, { status: 404 });
  }
  if (outcome === "not_claimed") {
    return Response.json({ ok: false, error: "Remote call is not claimed by this device" }, { status: 409 });
  }
  return Response.json({ ok: true, completed: true, outcome });
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
