import { auth } from "./auth";

export async function requireDashboardSubject(request: Request): Promise<string> {
  const session = await auth.api.getSession({ headers: request.headers });
  const subject = session?.user?.id;
  if (!subject) throw new Error("Dashboard session is required");
  return subject;
}