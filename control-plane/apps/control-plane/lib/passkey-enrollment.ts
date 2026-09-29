import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

const INTENT_TTL_MS = 5 * 60_000;
const INTENT_DIR = path.join(path.dirname(env.betterAuthDbPath), "passkey-enrollment-intents");

type EnrollmentKind = "existing-user-enrollment" | "account-registration";

type EnrollmentIntent = {
  version: 2;
  kind: EnrollmentKind;
  userId: string;
  userName: string;
  displayName: string;
  expiresAt: number;
};

type LegacyEnrollmentIntent = {
  version: 1;
  userId: string;
  userName: string;
  displayName: string;
  expiresAt: number;
};

function digest(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}
function intentPath(ticket: string): string {
  return path.join(INTENT_DIR, `${digest(ticket)}.json`);
}

function validateCoreFields(v: Record<string, unknown>): void {
  if (
    typeof v.userId !== "string" || !v.userId ||
    typeof v.userName !== "string" || !v.userName ||
    typeof v.displayName !== "string" || !v.displayName ||
    typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)
  ) {
    throw new Error("Invalid passkey enrollment intent");
  }
}

function validateIntent(value: unknown): EnrollmentIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid passkey enrollment intent");
  }
  const v = value as Record<string, unknown>;
  validateCoreFields(v);
  if (v.version === 1) {
    const legacy = v as unknown as LegacyEnrollmentIntent;
    return {
      version: 2,
      kind: "existing-user-enrollment",
      userId: legacy.userId,
      userName: legacy.userName,
      displayName: legacy.displayName,
      expiresAt: legacy.expiresAt,
    };
  }
  if (v.version !== 2 || (v.kind !== "existing-user-enrollment" && v.kind !== "account-registration")) {
    throw new Error("Invalid passkey enrollment intent");
  }
  return v as EnrollmentIntent;
}
async function loadIntent(ticket: string): Promise<EnrollmentIntent> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error("Invalid passkey enrollment ticket");
  const value = validateIntent(JSON.parse(await readFile(intentPath(ticket), "utf8")));
  if (value.expiresAt <= Date.now()) throw new Error("Passkey enrollment ticket expired");
  return value;
}

async function writeIntent(value: EnrollmentIntent): Promise<string> {
  const ticket = randomBytes(32).toString("base64url");
  await mkdir(INTENT_DIR, { recursive: true, mode: 0o700 });
  await writeFile(intentPath(ticket), JSON.stringify(value), { mode: 0o600, flag: "wx" });
  return ticket;
}

export async function createPasskeyEnrollmentIntent(user: { id: string; name: string; displayName?: string }): Promise<string> {
  return writeIntent({
    version: 2,
    kind: "existing-user-enrollment",
    userId: user.id,
    userName: user.name,
    displayName: user.displayName || user.name,
    expiresAt: Date.now() + INTENT_TTL_MS,
  });
}

export async function createPasskeyAccountRegistrationIntent(): Promise<string> {
  const userId = randomUUID();
  const displayName = `Desktop Commander ${userId.slice(0, 8)}`;
  return writeIntent({
    version: 2,
    kind: "account-registration",
    userId,
    userName: displayName,
    displayName,
    expiresAt: Date.now() + INTENT_TTL_MS,
  });
}
export async function resolvePasskeyEnrollmentIntent(ticket: string | null | undefined) {
  if (!ticket) throw new Error("Passkey enrollment ticket is required");
  const value = await loadIntent(ticket);
  return {
    id: value.userId,
    name: value.userName,
    displayName: value.displayName,
    kind: value.kind,
  };
}

export async function consumePasskeyEnrollmentIntent(ticket: string | null | undefined, expectedUserId: string): Promise<void> {
  if (!ticket) throw new Error("Passkey enrollment ticket is required");
  const value = await loadIntent(ticket);
  if (value.userId !== expectedUserId) throw new Error("Passkey enrollment user binding mismatch");
  const source = intentPath(ticket);
  const used = `${source}.used`;
  await rename(source, used);
  const expected = Buffer.from(digest(ticket), "hex");
  const observed = Buffer.from(path.basename(used, ".json.used"), "hex");
  if (expected.length !== observed.length || !timingSafeEqual(expected, observed)) {
    throw new Error("Passkey enrollment intent integrity failure");
  }
}
