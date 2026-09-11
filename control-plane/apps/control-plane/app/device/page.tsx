"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { authClient } from "../../lib/auth-client";

function DeviceCodeContent() {
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState(params.get("user_code") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const normalized = code.trim().replaceAll("-", "").toUpperCase();
    try {
      const response = await authClient.device({ query: { user_code: normalized } });
      if (response.error || !response.data) {
        setError(response.error?.error_description ?? "Unknown or expired device code");
        return;
      }
      router.push(`/device/approve?user_code=${encodeURIComponent(normalized)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main style={{ maxWidth: 420, margin: "72px auto", padding: 24 }}>
      <h1>Pair Desktop Commander</h1>
      <p>Enter the code printed by the headless device process.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          maxLength={9}
          required
          style={{ textTransform: "uppercase", fontFamily: "monospace", fontSize: 22 }}
        />
        {error && <div style={{ color: "#ff8c8c" }}>{error}</div>}
        <button disabled={busy} type="submit">
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
      <p style={{ marginTop: 24, opacity: 0.7 }}>
        Approval binds the OAuth client to this user; the device receives only
        the <code>device:sync</code> scope and the MCP resource audience.
      </p>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<main style={{ padding: 32 }}>Loading device pairing…</main>}>
      <DeviceCodeContent />
    </Suspense>
  );
}
