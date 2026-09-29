import { dispatchRemoteCall } from "../../../../../lib/call-router";
import { requireDashboardSubject } from "../../../../../lib/dashboard-auth";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const subject = await requireDashboardSubject(request);
    const call = await dispatchRemoteCall(subject, {
      deviceId: id,
      toolName: "__control.ping",
      toolArgs: {},
      timeoutMs: 15_000,
    });
    return Response.json({ ok: call.status === "completed", call });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
