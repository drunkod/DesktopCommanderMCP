export type RuntimeProfile = "production" | "development" | "test";
export type TrustedHttpUrlClass = "publicOAuth" | "publicResource" | "internalLoopback";

export type TrustedHttpUrlOptions = Readonly<{
  urlClass: TrustedHttpUrlClass;
  profile: RuntimeProfile;
  allowQuery?: boolean;
  allowFragment?: boolean;
  requireOrigin?: string;
}>;

export function isApprovedLiteralLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

export function parseTrustedHttpUrl(raw: string, label: string, options: TrustedHttpUrlOptions): URL {
  if (raw.length === 0 || raw !== raw.trim() || /\s/.test(raw)) {
    throw new Error(`${label} must be nonempty and contain no whitespace`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.username !== "" || url.password !== "") throw new Error(`${label} must not contain credentials`);

  const literalLoopback = isApprovedLiteralLoopbackHost(url.hostname);
  if (options.urlClass === "internalLoopback") {
    if (!literalLoopback) throw new Error(`${label} must use a literal loopback host`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${label} must use HTTP or HTTPS on literal loopback`);
    }
  } else {
    const explicitNonProductionLoopback = options.profile !== "production"
      && url.protocol === "http:"
      && literalLoopback;
    if (url.protocol !== "https:" && !explicitNonProductionLoopback) {
      throw new Error(`${label} must use HTTPS; HTTP loopback requires an explicit non-production profile`);
    }
  }

  if (!options.allowQuery && url.search !== "") throw new Error(`${label} must not contain a query`);
  if (!options.allowFragment && url.hash !== "") throw new Error(`${label} must not contain a fragment`);
  if (options.requireOrigin !== undefined && url.origin !== options.requireOrigin) {
    throw new Error(`${label} has an unexpected origin`);
  }
  return url;
}
