import { auth } from "../../../../../lib/auth";

export async function POST(request: Request) {
  const url = new URL(request.url);
  url.pathname = "/api/auth/device/code";
  return auth.handler(new Request(url, request));
}
