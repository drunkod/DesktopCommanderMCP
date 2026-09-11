import http from "node:http";
import https from "node:https";

export class RawHttpBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`HTTP response exceeded ${limit} raw body bytes`);
    this.name = "RawHttpBodyTooLargeError";
  }
}

export type OAuthHttpTransport = (
  url: string,
  init: RequestInit,
  maxRawBytes: number,
) => Promise<Response>;

function requestBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("Unsupported OAuth HTTP request body type");
}
function responseHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

export const rawOAuthHttpTransport: OAuthHttpTransport = async (url, init, maxRawBytes) => {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
  if (!client) throw new Error("OAuth HTTP transport supports only HTTP(S)");
  const body = requestBody(init.body);
  const headers = new Headers(init.headers);
  headers.set("accept-encoding", "identity");
  if (body && !headers.has("content-length")) headers.set("content-length", String(body.length));

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = client.request(target, {
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal ?? undefined,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const error = new Error("OAuth HTTP redirects are not allowed");
        // Never drain an attacker-controlled redirect body. Destroying the
        // IncomingMessage closes the underlying response/socket immediately.
        response.once("error", () => undefined);
        response.destroy(error);
        finishReject(error);
        return;
      }
      const resultHeaders = responseHeaders(response.headers);
      const declared = Number(resultHeaders.get("content-length"));
      if (Number.isFinite(declared) && declared > maxRawBytes) {
        response.destroy();
        finishReject(new RawHttpBodyTooLargeError(maxRawBytes));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let ended = false;
      let terminalBodyError: Error | null = null;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxRawBytes) {
          terminalBodyError = new RawHttpBodyTooLargeError(maxRawBytes);
          response.destroy(terminalBodyError);
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("end", () => {
        ended = true;
        if (settled) return;
        settled = true;
        resolve(new Response(Buffer.concat(chunks), { status, headers: resultHeaders }));
      });
      response.once("aborted", () => finishReject(terminalBodyError ?? new Error("OAuth HTTP response was aborted")));
      response.once("error", (error) => finishReject(terminalBodyError ?? error));
      response.once("close", () => {
        if (!ended && !settled) finishReject(new Error("OAuth HTTP response terminated before completion"));
      });
    });
    request.once("error", finishReject);
    if (body) request.end(body);
    else request.end();
  });
};

let activeTransport: OAuthHttpTransport = rawOAuthHttpTransport;

export function installOAuthHttpTransportForTests(transport: OAuthHttpTransport): void {
  activeTransport = transport;
}

export function resetOAuthHttpTransportForTests(): void {
  activeTransport = rawOAuthHttpTransport;
}

export function oauthHttpRequest(url: string, init: RequestInit, maxRawBytes: number): Promise<Response> {
  return activeTransport(url, init, maxRawBytes);
}
