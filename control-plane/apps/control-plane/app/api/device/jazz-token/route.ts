import * as z from "zod";
import { app } from "../../../../schema";
import { createDeviceProtectedHandler } from "../../../../lib/device-request-auth";
import { jazzBackendDb } from "../../../../lib/jazz-principal";
import { mintJazzDeviceToken } from "../../../../lib/jazz-capability";

const schema = z.object({ deviceId: z.string().uuid() }).strict();

const POST = createDeviceProtectedHandler(async (request, principal) => {
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid Jazz token request" }, { status: 400 });
  }

  const db = jazzBackendDb();
  const device = await db.one(app.devices.where({ id: parsed.data.deviceId }), { tier: "global" });
  if (!device || device.ownerId !== principal.subject || device.revokedAt || device.oauthClientId !== principal.clientId) {
    return Response.json({ ok: false, error: "Device is not active" }, { status: 403 });
  }

  const jazzToken = await mintJazzDeviceToken(principal.subject, principal.clientId, device.id);
  return Response.json({ ok: true, jazzToken, expiresIn: 90 });
});
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export { POST };