import { auth } from "../../../../../lib/auth";
import { authDatabase } from "../../../../../lib/auth-db";
import {
  handleIdempotentRefreshRevocation,
  inspectPersistedPublicRefresh,
} from "../../../../../lib/oauth-revocation";

export async function POST(request: Request) {
  return handleIdempotentRefreshRevocation(request, {
    provider: (providerRequest) => auth.handler(providerRequest),
    inspect: async (token, clientId) =>
      inspectPersistedPublicRefresh(authDatabase(), token, clientId),
  });
}
