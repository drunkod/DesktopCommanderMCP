import { fetchClientMetadataResource as fetchHardenedClientMetadataResource } from "@better-auth/cimd/node";

const CHATGPT_CIMD_RESOURCE_URLS = new Set([
  "https://chatgpt.com/oauth/client.json",
  "https://chatgpt.com/oauth/jwks.json",
]);

/**
 * Preserve Better Auth's resolve-once/pinned SSRF transport for arbitrary CIMD
 * clients. ChatGPT is an explicit exception because some local proxy DNS modes
 * synthesize 198.18.0.0/15 addresses for chatgpt.com; the hardened transport
 * correctly rejects that reserved range even though the local proxy can route
 * the request. These two exact HTTPS resources are fixed OpenAI endpoints.
 */
export const fetchOAuthClientMetadataResource: typeof fetchHardenedClientMetadataResource = async (
  input,
  init,
) => {
  const request = new Request(input, init);
  if (!CHATGPT_CIMD_RESOURCE_URLS.has(request.url)) {
    return fetchHardenedClientMetadataResource(input, init);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TypeError("ChatGPT CIMD compatibility transport supports only GET and HEAD");
  }

  // The caller supplies redirect: "error"; constructing a Request preserves it.
  // Standard fetch is intentional here so the host's transparent proxy can
  // translate its synthetic DNS address while TLS still authenticates chatgpt.com.
  return fetch(request);
};

export function isChatGptCimdResourceUrl(value: string): boolean {
  return CHATGPT_CIMD_RESOURCE_URLS.has(value);
}
