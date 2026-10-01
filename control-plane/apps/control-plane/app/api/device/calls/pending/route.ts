import * as z from "zod";
import { app } from "../../../../../schema";
import { createDeviceProtectedHandler } from "../../../../../lib/device-request-auth";
import { jazzAuthorityDb } from "../../../../../lib/jazz-authority";

const bodySchema = z.object({
  deviceId: z.string().uuid(),
}).strict();

const MAX_PENDING_CALLS = 32;

const POST = createDeviceProtectedHandler(async (request, principal) => {
  const parsed = bodySchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid pending-call request" }, { status: 400 });
  }

  const db = await jazzAuthorityDb();
  const device = await db.one(
    app.devices.where({ id: parsed.data.deviceId }),
    { tier: "global" },
  );
  if (
    !device
    || device.ownerId !== principal.subject
    || device.oauthClientId !== principal.clientId
    || device.revokedAt
  ) {
    return Response.json({ ok: false, error: "Device is not active" }, { status: 403 });
  }

  const now = Date.now();
  const rows = await db.all(
    app.remoteCalls.where({
      deviceId: parsed.data.deviceId,
      status: "pending",
    }),
    { tier: "global" },
  );

  const calls = rows
    .filter((call) =>
      call.ownerId === principal.subject
      && call.expiresAt.getTime() > now
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_PENDING_CALLS)
    .map((call) => ({
      id: call.id,
      toolName: call.toolName,
      toolArgs: call.toolArgs,
      metadata: call.metadata,
      expiresAt: call.expiresAt.toISOString(),
    }));

  return Response.json({ ok: true, calls });
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export { POST };
