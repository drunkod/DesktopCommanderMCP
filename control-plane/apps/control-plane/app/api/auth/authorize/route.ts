import { auth } from "../../../../lib/auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  url.pathname = "/api/auth/oauth2/authorize";
  return auth.handler(new Request(url, request));
}
