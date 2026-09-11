"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { authClient } from "../../lib/auth-client";

function SignInContent() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sign-in" | "create" | null>(null);
  const callbackURL = safeCallbackURL(params.get("callbackURL"));

  async function signInWithPasskey() {
    setBusy("sign-in"); setError(null);
    try {
      const response = await authClient.signIn.passkey();
      if (response.error) return setError(response.error.message ?? "Passkey authentication failed");
      router.push(callbackURL); router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  }

  async function createAccountWithPasskey() {
    setBusy("create"); setError(null);
    try {
      const intentResponse = await fetch("/api/passkey/registration-intent", {
        method: "POST",
        credentials: "same-origin",
      });
      const intent = await intentResponse.json() as { ok?: boolean; context?: string; error?: string };
      if (!intentResponse.ok || !intent.ok || !intent.context) {
        return setError(intent.error ?? "Unable to start passkey registration");
      }
      const result = await authClient.passkey.addPasskey({
        context: intent.context,
        createSession: true,
        name: "Primary passkey",
      });
      if (result.error) return setError(result.error.message ?? "Passkey registration failed");
      router.push(callbackURL); router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  }

  return <main style={{ maxWidth: 460, margin: "72px auto", padding: 24 }}>
    <h1>Desktop Commander</h1>
    <p style={{ opacity: 0.72 }}>Passkeys only. No email address or password is required.</p>
    {params.get("setup") === "passkey-ready" && <p>Your passkey is ready. Sign in once to verify it.</p>}
    {error && <div style={{ color: "#ff8c8c", marginBottom: 12 }}>{error}</div>}
    <div style={{ display: "grid", gap: 12 }}>
      <button disabled={busy !== null} onClick={() => void signInWithPasskey()}>
        {busy === "sign-in" ? "Waiting for passkey…" : "Sign in with passkey"}
      </button>
      <button disabled={busy !== null} onClick={() => void createAccountWithPasskey()}>
        {busy === "create" ? "Creating passkey…" : "Create account with passkey"}
      </button>
    </div>
  </main>;
}

function safeCallbackURL(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/dashboard/devices";
  return value;
}

export default function Page() {
  return <Suspense fallback={<main style={{ padding: 32 }}>Loading sign in…</main>}><SignInContent /></Suspense>;
}
