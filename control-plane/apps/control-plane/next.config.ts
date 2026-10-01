import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const isProduction = process.env.NODE_ENV === "production";
const scriptSrc = isProduction
  ? "'self' 'unsafe-inline' 'wasm-unsafe-eval'"
  : "'self' 'unsafe-inline' 'unsafe-eval'";
const jazzLoopbackConnectSources = (() => {
  if (!isProduction || !process.env.NEXT_PUBLIC_JAZZ_SERVER_URL) return "";
  try {
    const jazzUrl = new URL(process.env.NEXT_PUBLIC_JAZZ_SERVER_URL);
    if (jazzUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(jazzUrl.hostname)) return "";
    const jazzWebSocketUrl = new URL(jazzUrl);
    jazzWebSocketUrl.protocol = "ws:";
    return ` ${jazzUrl.origin} ${jazzWebSocketUrl.origin}`;
  } catch {
    return "";
  }
})();
const connectSrc = isProduction
  ? `'self' https: wss:${jazzLoopbackConnectSources}`
  : "'self' http: https: ws: wss:";
const csp = [
  "default-src 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src ${connectSrc}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep standalone/output tracing inside the nested control-plane workspace.
  // Without this, Next sees the repository-root package-lock.json and treats the
  // entire DesktopCommanderMCP checkout as its workspace root.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  serverExternalPackages: ["jazz-tools", "jazz-napi"],
  async headers() {
    const headers = [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ];
    if (isProduction) {
      headers.push({
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      });
    }
    return [{ source: "/(.*)", headers }];
  },
};

export default nextConfig;
