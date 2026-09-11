import { requireDashboardSubject } from "../../../../lib/dashboard-auth";
import { mintJazzDashboardToken } from "../../../../lib/jazz-capability";

export async function POST(request: Request): Promise<Response> {
  try {
    const subject = await requireDashboardSubject(request);
    const token = await mintJazzDashboardToken(subject);
    return Response.json({ ok: true, token, expiresIn: 120 });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 401 },
    );
  }
}