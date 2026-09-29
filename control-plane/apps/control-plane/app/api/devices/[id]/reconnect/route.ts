import { requestReconnect } from "../../../../../lib/device-admin";
import { requireDashboardSubject } from "../../../../../lib/dashboard-auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const subject = await requireDashboardSubject(request);
    await requestReconnect(subject, id);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
