import { auth } from "../../../../lib/auth";
import { env } from "../../../../lib/env";
import { createPasskeyAccountRegistrationIntent } from "../../../../lib/passkey-enrollment";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== env.appOrigin) {
    return Response.json({ ok: false, error: "origin_not_allowed" }, { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    return Response.json({ ok: false, error: "sign_out_before_registration" }, { status: 409 });
  }

  const context = await createPasskeyAccountRegistrationIntent();
  return Response.json(
    { ok: true, context },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}
