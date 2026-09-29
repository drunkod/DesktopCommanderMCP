"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient } from "../../../lib/auth-client";

export default function PasskeyEnrollPage() {
  const router = useRouter();
  const [ticket, setTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const value = fragment.get("ticket");
    window.history.replaceState(null, "", window.location.pathname);
    setTicket(value);
  }, []);

  async function enroll() {
    if (!ticket) return setError("Enrollment ticket is missing or already cleared.");
    setBusy(true); setError(null);
    try {
      const result = await authClient.passkey.addPasskey({ context: ticket, createSession: true, name: "Tests-MacBook-Air" });
      if (result.error) return setError(result.error.message ?? "Passkey enrollment failed");
      await authClient.signOut();
      router.replace("/sign-in?setup=passkey-ready");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return <main style={{ maxWidth: 480, margin: "72px auto", padding: 24 }}>
    <h1>Create your Desktop Commander passkey</h1>
    <p>This one-use development enrollment is bound to the local MVP Test Operator. No password is requested or exposed.</p>
    {error && <p style={{ color: "#ff8c8c" }}>{error}</p>}
    <button disabled={busy || !ticket} onClick={() => void enroll()}>{busy ? "Creating passkey…" : "Create passkey"}</button>
  </main>;
}
