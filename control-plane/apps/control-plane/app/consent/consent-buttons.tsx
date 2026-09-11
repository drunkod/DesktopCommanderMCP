"use client";

import { useState } from "react";
import { authClient } from "../../lib/auth-client";

export function ConsentButtons() {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    setBusy(accept ? "allow" : "deny");
    setError(null);
    try {
      const response = await authClient.oauth2.consent({ accept });
      if (response.error) {
        setError(response.error.message ?? "Consent failed");
        return;
      }
      if (response.data?.redirect && response.data.url) {
        window.location.assign(response.data.url);
        return;
      }
      setError("Authorization server returned no redirect URL");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <button disabled={busy !== null} onClick={() => void decide(false)}>
        {busy === "deny" ? "Cancelling…" : "Cancel"}
      </button>
      <button disabled={busy !== null} onClick={() => void decide(true)}>
        {busy === "allow" ? "Authorizing…" : "Authorize"}
      </button>
      {error && <span style={{ color: "#ff8c8c" }}>{error}</span>}
    </div>
  );
}
