import assert from "node:assert/strict";
import {
  fetchOAuthClientMetadataResource,
  isChatGptCimdResourceUrl,
} from "../lib/cimd-fetch";

const originalFetch = globalThis.fetch;
const observed: Request[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  observed.push(request);
  return new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

try {
  for (const url of [
    "https://chatgpt.com/oauth/client.json",
    "https://chatgpt.com/oauth/jwks.json",
  ]) {
    assert.equal(isChatGptCimdResourceUrl(url), true);
    const response = await fetchOAuthClientMetadataResource(url, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
    assert.equal(response.status, 200);
  }

  assert.equal(observed.length, 2);
  for (const request of observed) {
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("accept"), "application/json");
  }

  assert.equal(
    isChatGptCimdResourceUrl("https://chatgpt.com/oauth/other.json"),
    false,
  );
  assert.equal(
    isChatGptCimdResourceUrl("https://example.com/oauth/client.json"),
    false,
  );

  await assert.rejects(
    () => Promise.resolve(fetchOAuthClientMetadataResource("https://198.18.0.1/oauth/client.json", {
      redirect: "error",
    })),
    /public-routable/,
    "arbitrary reserved-address clients must still use the hardened CIMD transport",
  );

  console.log("CIMD transport integration: ok (exact ChatGPT exception, generic SSRF guard preserved)");
} finally {
  globalThis.fetch = originalFetch;
}
