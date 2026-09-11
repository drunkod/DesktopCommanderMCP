"use client";

import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? undefined : window.location.origin,
  plugins: [
    passkeyClient(),
    oauthProviderClient(),
    deviceAuthorizationClient(),
  ],
});

export async function getDashboardJazzToken(): Promise<string> {
  const response = await fetch("/api/jazz/dashboard-token", {
    method: "POST",
    credentials: "same-origin",
  });
  const body = await response.json() as { ok?: boolean; token?: string; error?: string };
  if (!response.ok || !body.ok || !body.token) {
    throw new Error(body.error ?? "Unable to mint dashboard Jazz capability");
  }
  return body.token;
}