import * as z from "zod";
import { app } from "../../../../schema";
import { jazzAuthorityDb } from "../../../../lib/jazz-authority";
import { createDeviceProtectedHandler } from "../../../../lib/device-request-auth";

const heartbeatSchema = z.object({
  deviceId: z.string().min(1).max(200),
  status: z.enum(["online", "offline"]).default("online"),
  lastError: z.string().max(500).nullable().optional(),
}).strict();

const POST = createDeviceProtectedHandler(async (request, principal) => {
  const parsed = heartbeatSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid heartbeat" }, { status: 400 });
  }

  const backend = await jazzAuthorityDb();
  const device = await backend.one(
    app.devices.where({ id: parsed.data.deviceId }),
    { tier: "global" },
  );
  if (
    !device
    || device.ownerId !== principal.subject
    || device.revokedAt
    || device.oauthClientId !== principal.clientId
  ) {
    return Response.json({ ok: false, error: "Device is not active" }, { status: 403 });
  }

  const write = backend.update(app.devices, device.id, {
    status: parsed.data.status,
    lastSeenAt: new Date(),
    lastError: parsed.data.lastError ?? undefined,
  });
  await write.wait({ tier: "global" });
  return Response.json({ ok: true });
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export { POST };
