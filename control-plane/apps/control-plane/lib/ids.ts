import crypto from "node:crypto";

/**
 * Produce a stable RFC-4122-compatible UUID from an application-domain key.
 * Jazz row ids are UUIDs, so deterministic convergence must stay inside that
 * representation rather than using prefixed hash strings.
 */
export function deterministicUuid(domain: string, value: string): string {
  const bytes = crypto.createHash("sha256").update(`${domain}\0${value}`).digest().subarray(0, 16);

  // Mark the digest as a name-based UUID (version 5) with RFC-4122 variant.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
