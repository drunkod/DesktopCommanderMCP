export default function HomePage() {
  return (
    <main style={{ maxWidth: 760, margin: "80px auto", padding: 24 }}>
      <h1>Remote Desktop Commander — Jazz MVP</h1>
      <p>
        This example hosts Better Auth, the OAuth-protected MCP endpoint,
        the Jazz-backed device dashboard, and device-code approval UI.
      </p>
      <nav style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <a href="/sign-in">Sign in</a>
        <a href="/device">Pair a device</a>
        <a href="/dashboard/devices">Device dashboard</a>
      </nav>
      <p style={{ marginTop: 32, opacity: 0.7 }}>
        MCP endpoint: <code>/mcp</code> · OAuth issuer: <code>/api/auth</code>
      </p>
    </main>
  );
}
