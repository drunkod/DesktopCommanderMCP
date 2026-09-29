import open from "open";
import { auth } from "../lib/auth";
import { env } from "../lib/env";
import { createPasskeyEnrollmentIntent } from "../lib/passkey-enrollment";

if (process.env.NODE_ENV === "production") throw new Error("Development passkey enrollment is disabled in production");
const ctx = await auth.$context;
const users = await ctx.adapter.findMany({ model: "user", where: [{ field: "name", value: "MVP Test Operator" }] });
if (!users || users.length !== 1) throw new Error(`Expected exactly one MVP Test Operator, found ${users?.length ?? 0}`);
const user = users[0] as { id: string; name: string; email?: string };
const ticket = await createPasskeyEnrollmentIntent({ id: user.id, name: user.name, displayName: user.name });
const url = `${env.appOrigin}/passkey/enroll#ticket=${encodeURIComponent(ticket)}`;
await open(url);
console.log("Opened one-use passkey enrollment in the browser (ticket not logged).");
