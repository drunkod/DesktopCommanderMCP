import { auth } from "./auth";

export type OAuthClientState = {
  clientId: string;
  disabled: boolean;
};

type RawOAuthClient = {
  clientId?: unknown;
  disabled?: unknown;
};

async function findOAuthClient(clientId: string): Promise<RawOAuthClient | null> {
  const context = await auth.$context;
  const row = await context.adapter.findOne({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  return row as RawOAuthClient | null;
}

export async function requireActiveOAuthClient(
  clientId: string,
): Promise<OAuthClientState> {
  const row = await findOAuthClient(clientId);
  if (!row || row.clientId !== clientId) {
    throw new Error("OAuth client is unknown");
  }
  if (row.disabled === true) {
    throw new Error("OAuth client is disabled");
  }
  return { clientId, disabled: false };
}

export async function disableOAuthClient(clientId: string): Promise<void> {
  const row = await findOAuthClient(clientId);
  if (!row) return;
  if (row.disabled === true) return;

  // @better-auth/oauth-provider 1.7.1 exposes `disabled` on oauthClient but its
  // admin update endpoint does not accept that field. Keep this pinned adapter
  // workaround isolated here so it can be deleted when the public API catches up.
  const context = await auth.$context;
  await context.adapter.update({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
    update: { disabled: true },
  });
}
