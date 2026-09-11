"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { authClient } from "../../../lib/auth-client";

type DeviceRequest = {
  client_id?: string;
  scope?: string;
  resource?: string | string[];
};

function ApproveDeviceContent() {
  const router = useRouter();
  const params = useSearchParams();
  const userCode = params.get("user_code") ?? "";
  const session = authClient.useSession();
  const [request, setRequest] = useState<DeviceRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    if (session.isPending) return;
    if (!session.data) {
      const callback = `/device/approve?user_code=${encodeURIComponent(userCode)}`;
      router.replace(`/sign-in?callbackURL=${encodeURIComponent(callback)}`);
      return;
    }
    void loadRequest();
  }, [session.isPending, session.data, userCode]);
  async function loadRequest() {
    try {
      const response = await authClient.device({ query: { user_code: userCode } });
      if (response.error || !response.data) {
        setError(response.error?.error_description ?? "Device request expired");
        return;
      }
      setRequest(response.data as DeviceRequest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function decide(approve: boolean) {
    setBusy(approve ? "approve" : "deny");
    setError(null);
    try {
      const response = approve
        ? await authClient.device.approve({ userCode })
        : await authClient.device.deny({ userCode });
      if (response.error) {
        setError(response.error.error_description ?? "Device decision failed");
        return;
      }
      router.replace(approve ? "/device/success" : "/device/denied");
    } finally {
      setBusy(null);
    }
  }
  if (session.isPending || (!request && !error)) {
    return <main style={{ padding: 32 }}>Loading authorization request…</main>;
  }

  return (
    <main style={{ maxWidth: 520, margin: "72px auto", padding: 24 }}>
      <h1>Approve device</h1>
      <p>Signed in as <strong>{session.data?.user.name}</strong>.</p>
      <dl style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 8 }}>
        <dt>Code</dt><dd><code>{userCode}</code></dd>
        <dt>OAuth client</dt><dd><code>{request?.client_id ?? "unknown"}</code></dd>
        <dt>Scope</dt><dd>{request?.scope ?? "unknown"}</dd>
        <dt>Resource</dt><dd>{JSON.stringify(request?.resource ?? "unknown")}</dd>
      </dl>
      {error && <p style={{ color: "#ff8c8c" }}>{error}</p>}
      <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
        <button disabled={busy !== null} onClick={() => void decide(false)}>
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
        <button disabled={busy !== null} onClick={() => void decide(true)}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
      </div>
      <p style={{ opacity: 0.7 }}>
        Verify the code matches the terminal before approving.
      </p>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<main style={{ padding: 32 }}>Loading device approval…</main>}>
      <ApproveDeviceContent />
    </Suspense>
  );
}
