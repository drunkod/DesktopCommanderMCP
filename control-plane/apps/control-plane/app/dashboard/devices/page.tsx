"use client";

import { createDb, type Db } from "jazz-tools";
import { useEffect, useMemo, useState } from "react";
import { app, type Device } from "../../../schema";
import { authClient, getDashboardJazzToken } from "../../../lib/auth-client";

const appId = process.env.NEXT_PUBLIC_JAZZ_APP_ID!;
const serverUrl = process.env.NEXT_PUBLIC_JAZZ_SERVER_URL!;

export default function DevicesPage() {
  const session = authClient.useSession();
  const [db, setDb] = useState<Db | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (session.isPending || !session.data) return;
    let disposed = false;
    let currentDb: Db | null = null;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      const token = await getDashboardJazzToken();
      if (disposed) return;
      currentDb = await createDb({
        appId,
        serverUrl,
        jwtToken: token,
        // The dashboard is a transient control surface. Avoid Jazz's persistent
        // browser broker/SharedWorker path, which Next.js 15 cannot resolve
        // correctly for this alpha build.
        driver: { type: "memory" },
      });
      if (disposed) return void currentDb.shutdown();
      setDb(currentDb);
      currentDb.onAuthChanged((state) => {
        if (state.error !== "expired" || disposed) return;
        void getDashboardJazzToken()
          .then((fresh) => currentDb?.updateAuthToken(fresh))
          .catch((error) => setMessage(String(error)));
      });
      unsubscribe = currentDb.subscribeAll(
        app.devices,
        (delta) => setDevices(delta.all),
        { tier: "global" },
      );
    })().catch((error) => setMessage(String(error)));

    return () => {
      disposed = true;
      unsubscribe?.();
      void currentDb?.shutdown();
      setDb(null);
    };
  }, [session.isPending, session.data?.user.id]);

  const ordered = useMemo(
    () => [...devices].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()),
    [devices],
  );

  if (!session.isPending && !session.data) {
    return (
      <main style={{ padding: 32 }}>
        <p>You must sign in before opening the device dashboard.</p>
        <a href="/sign-in?callbackURL=/dashboard/devices">Sign in</a>
      </main>
    );
  }
  async function action(device: Device, name: "ping" | "reconnect" | "revoke") {
    if (name === "revoke" && !window.confirm(`Revoke ${device.name}?`)) return;
    setMessage(`${name} ${device.name}…`);
    const response = await fetch(`/api/devices/${encodeURIComponent(device.id)}/${name}`, {
      method: "POST",
      credentials: "same-origin",
    });
    const body = await response.json() as { ok?: boolean; error?: string };
    setMessage(body.ok ? `${name} accepted` : body.error ?? `${name} failed`);
  }

  return (
    <main style={{ maxWidth: 960, margin: "48px auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1>Your devices</h1>
          <p style={{ opacity: 0.7 }}>{session.data?.user.name}</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <a href="/device">Add device</a>
          <button onClick={() => void authClient.signOut().then(() => { window.location.href = "/sign-in"; })}>Sign out</button>
        </div>
      </div>
      {message && <p>{message}</p>}
      {!db && <p>Connecting to Jazz…</p>}
      <div style={{ display: "grid", gap: 12 }}>
        {ordered.map((device) => (
          <DeviceCard key={device.id} device={device} onAction={action} />
        ))}
      </div>
    </main>
  );
}
function DeviceCard({
  device,
  onAction,
}: {
  device: Device;
  onAction: (device: Device, action: "ping" | "reconnect" | "revoke") => Promise<void>;
}) {
  const heartbeatFresh = Date.now() - device.lastSeenAt.getTime() < 45_000;
  const online = !device.revokedAt && heartbeatFresh && device.status === "online";
  return (
    <article style={{ border: "1px solid #323842", borderRadius: 8, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <strong>{device.name}</strong>
          <div><code>{device.stableId}</code></div>
          <small>{device.platform} · {device.appVersion}</small>
        </div>
        <strong>{device.revokedAt ? "revoked" : online ? "online" : "offline"}</strong>
      </div>
      <p>Last authority heartbeat: {device.lastSeenAt.toLocaleString()}</p>
      {device.lastError && <p style={{ color: "#ffb08c" }}>{device.lastError}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={!online} onClick={() => void onAction(device, "ping")}>Ping</button>
        <button disabled={!online} onClick={() => void onAction(device, "reconnect")}>Reconnect</button>
        <button disabled={Boolean(device.revokedAt)} onClick={() => void onAction(device, "revoke")}>Revoke</button>
      </div>
    </article>
  );
}
