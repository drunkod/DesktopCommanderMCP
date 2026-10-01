import * as z from "zod";
import { deterministicUuid } from "../../../../lib/ids";
import { app } from "../../../../schema";
import { toJsonValue } from "../../../../lib/json";
import { jazzContext } from "../../../../lib/jazz-context";
import { jazzAuthorityDb } from "../../../../lib/jazz-authority";
import { mintJazzDeviceToken } from "../../../../lib/jazz-capability";
import { createDeviceProtectedHandler } from "../../../../lib/device-request-auth";

const registrationSchema = z.object({
  stableId: z.string().min(8).max(200),
  name: z.string().min(1).max(255),
  platform: z.string().min(1).max(100),
  appVersion: z.string().min(1).max(100),
  capabilities: z.unknown(),
}).strict();

const POST = createDeviceProtectedHandler(async (request, principal) => {
  const parsed = registrationSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid device registration" }, { status: 400 });
  }

  const db = await jazzAuthorityDb();
  const byClient = await db.all(
    app.devices.where({ oauthClientId: principal.clientId }),
    { tier: "global" },
  );
  if (byClient.length > 1) {
    return Response.json({ ok: false, error: "Device identity invariant violated" }, { status: 409 });
  }

  const existing = byClient[0];
  if (existing) {
    if (existing.ownerId !== principal.subject || existing.revokedAt) {
      return Response.json({ ok: false, error: "Device registration is not active" }, { status: 403 });
    }
    if (existing.stableId !== parsed.data.stableId) {
      return Response.json({ ok: false, error: "OAuth client is already bound to another device identity" }, { status: 409 });
    }
    await refreshDevice(db, existing.id, parsed.data);
    const jazzToken = await mintJazzDeviceToken(principal.subject, principal.clientId, existing.id);
    return Response.json({ ok: true, deviceId: existing.id, oauthClientId: principal.clientId, jazzToken, expiresIn: 90 });
  }

  const sameStableId = await db.all(
    app.devices.where({ stableId: parsed.data.stableId }),
    { tier: "global" },
  );
  if (sameStableId.some((row) => !row.revokedAt)) {
    return Response.json({ ok: false, error: "Device identity is already registered" }, { status: 409 });
  }

  const rowId = deterministicUuid("device", principal.clientId);
  try {
    const write = db.insert(app.devices, {
      ownerId: principal.subject,
      stableId: parsed.data.stableId,
      oauthClientId: principal.clientId,
      name: parsed.data.name,
      platform: parsed.data.platform,
      appVersion: parsed.data.appVersion,
      capabilities: toJsonValue(parsed.data.capabilities, "device capabilities"),
      status: "online",
      lastSeenAt: new Date(),
      reconnectGeneration: 0,
    }, { id: rowId });
    await write.wait({ tier: "global" });
  } catch (error) {
    const winner = await db.one(app.devices.where({ id: rowId }), { tier: "global" });
    if (!winner) throw error;
    if (
      winner.ownerId !== principal.subject
      || winner.oauthClientId !== principal.clientId
      || winner.stableId !== parsed.data.stableId
      || winner.revokedAt
    ) {
      return Response.json({ ok: false, error: "Device registration conflict" }, { status: 409 });
    }
    await refreshDevice(db, winner.id, parsed.data);
  }

  const jazzToken = await mintJazzDeviceToken(principal.subject, principal.clientId, rowId);
  return Response.json({ ok: true, deviceId: rowId, oauthClientId: principal.clientId, jazzToken, expiresIn: 90 }, { status: 201 });
});

async function refreshDevice(
  db: Awaited<ReturnType<ReturnType<typeof jazzContext>["withAttributionForRequest"]>>,
  rowId: string,
  input: z.infer<typeof registrationSchema>,
): Promise<void> {
  const write = db.update(app.devices, rowId, {
    name: input.name,
    platform: input.platform,
    appVersion: input.appVersion,
    capabilities: toJsonValue(input.capabilities, "device capabilities"),
    status: "online",
    lastSeenAt: new Date(),
    lastError: undefined,
  });
  await write.wait({ tier: "global" });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export { POST };
