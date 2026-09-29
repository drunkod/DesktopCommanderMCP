import { env } from "./env";

const metadata = {
  resource: env.remoteResource,
  authorization_servers: [env.authIssuer],
  bearer_methods_supported: ["header"],
  // One protected resource serves both MCP tool traffic and device control.
  // Route handlers still enforce their own exact required scope.
  scopes_supported: ["mcp:tools", "device:sync"],
};

export function protectedResourceMetadata(head = false): Response {
  return new Response(head ? null : JSON.stringify(metadata), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
