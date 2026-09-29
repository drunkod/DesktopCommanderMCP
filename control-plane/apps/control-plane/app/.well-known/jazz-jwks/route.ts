import { jazzJwks } from "../../../lib/jazz-capability";

export function GET(): Response {
  return Response.json(jazzJwks(), {
    headers: {
      "cache-control": "public, max-age=60",
    },
  });
}