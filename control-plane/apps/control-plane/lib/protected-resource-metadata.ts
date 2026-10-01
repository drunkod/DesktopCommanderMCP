import { env } from "./env";

const metadata = {
  resource: env.remoteResource,
  authorization_servers: [env.authIssuer],
  bearer_methods_supported: ["header"],
  // ChatGPT discovers this document for the MCP endpoint and needs only the
  // MCP tool scope. The authorization server still supports device:sync for
  // the separately bootstrapped headless-device OAuth flow.
  scopes_supported: ["mcp:tools"],
};

export function protectedResourceMetadata(head = false): Response {
  return new Response(head ? null : JSON.stringify(metadata), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
