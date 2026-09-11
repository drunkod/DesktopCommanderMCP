export default function DeviceDeniedPage() {
  return (
    <main style={{ maxWidth: 520, margin: "72px auto", padding: 24 }}>
      <h1>Device denied</h1>
      <p>No OAuth token was issued. The terminal request must start a new device-code flow.</p>
      <a href="/device">Enter another code</a>
    </main>
  );
}
