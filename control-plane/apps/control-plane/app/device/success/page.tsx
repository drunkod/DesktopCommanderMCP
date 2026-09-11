export default function DeviceSuccessPage() {
  return (
    <main style={{ maxWidth: 520, margin: "72px auto", padding: 24 }}>
      <h1>Device approved</h1>
      <p>
        The device may now exchange its one-time code for a resource-bound OAuth
        token and connect to Jazz with <code>device:sync</code> permissions.
      </p>
      <a href="/dashboard/devices">Open device dashboard</a>
    </main>
  );
}
