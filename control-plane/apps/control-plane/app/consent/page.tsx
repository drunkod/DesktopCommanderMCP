import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "../../lib/auth";
import { ConsentButtons } from "./consent-buttons";

type SearchValue = string | string[] | undefined;
type Props = {
  searchParams: Promise<Record<string, SearchValue>>;
};

export default async function ConsentPage({ searchParams }: Props) {
  const params = await searchParams;
  const clientId = first(params.client_id);
  const scope = first(params.scope) ?? "";
  if (!clientId) throw new Error("Missing OAuth client_id");

  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) {
    const callbackURL = consentCallbackURL(params);
    redirect(`/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`);
  }

  const client = await auth.api.getOAuthClientPublic({
    query: { client_id: clientId },
    headers: requestHeaders,
  });
  const scopes = scope.split(/\s+/).filter(Boolean);

  return (
    <main style={{ maxWidth: 620, margin: "72px auto", padding: 24 }}>
      <h1>Authorize {client.client_name ?? "MCP client"}</h1>
      <p>
        Signed in as <strong>{session.user.name}</strong>. This grant is for the
        Remote Desktop Commander MCP resource, not for the Jazz admin backend.
      </p>
      <section style={{ border: "1px solid #323842", padding: 16, borderRadius: 8 }}>
        <h2>Requested access</h2>
        <ul>
          {scopes.map((requestedScope) => (
            <li key={requestedScope}>{describeScope(requestedScope)}</li>
          ))}
        </ul>
        <ConsentButtons />
      </section>
    </main>
  );
}

function first(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function consentCallbackURL(params: Record<string, SearchValue>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }
  const serialized = query.toString();
  return serialized ? `/consent?${serialized}` : "/consent";
}

function describeScope(scope: string): string {
  const descriptions: Record<string, string> = {
    openid: "Identify your account",
    profile: "Read your basic profile",
    "mcp:tools": "Run Remote Desktop Commander MCP tools",
    "device:sync": "Synchronize a paired Desktop Commander device",
    offline_access: "Refresh authorization without another login",
  };
  return descriptions[scope] ?? scope;
}
