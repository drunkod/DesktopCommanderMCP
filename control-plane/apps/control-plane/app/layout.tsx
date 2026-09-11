import type { ReactNode } from "react";

export const metadata = {
  title: "Remote Desktop Commander",
  description: "Jazz-backed Remote MCP control plane",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{
        margin: 0,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        background: "#0b0d10",
        color: "#f6f7f9",
      }}>
        {children}
      </body>
    </html>
  );
}
