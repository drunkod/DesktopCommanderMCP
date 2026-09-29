import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const temp = mkdtempSync(path.join(tmpdir(), "dc-passkey-account-"));
const dbPath = path.join(temp, "auth.sqlite");
const testEnv = {
  ...process.env,
  APP_ORIGIN: "http://127.0.0.1:3000",
  BETTER_AUTH_SECRET: "step8-test-secret-step8-test-secret-0001",
  BETTER_AUTH_DB_PATH: dbPath,
  JAZZ_APP_ID: "step8-test-app",
  JAZZ_SERVER_URL: "ws://127.0.0.1:1625",
  JAZZ_INTERNAL_SERVER_URL: "ws://127.0.0.1:1625",
  JAZZ_ADMIN_SECRET: "step8-admin",
  JAZZ_BACKEND_SECRET: "step8-backend",
  JAZZ_JWKS_URL: "http://127.0.0.1:3000/.well-known/jazz-jwks",
  JAZZ_TOKEN_PRIVATE_JWK_B64: "e30",
  JAZZ_TOKEN_PUBLIC_JWK_B64: "e30",
  REMOTE_MCP_RESOURCE: "http://127.0.0.1:3000/mcp",
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: testEnv, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} failed with ${result.status}`);
  }
  return result.stdout;
}
try {
  run("./node_modules/.bin/auth", ["migrate", "--config", "./lib/auth-migration-config.ts", "--yes"]);

  const db = new DatabaseSync(dbPath);
  const userColumns = db.prepare("PRAGMA table_info('user')").all();
  const emailColumn = userColumns.find((column) => column.name === "email");
  assert.equal(emailColumn?.notnull, 0, "user.email must be nullable");

  const passkeyIndexes = db.prepare("PRAGMA index_list('passkey')").all();
  const credentialUnique = passkeyIndexes.some((index) => {
    if (!index.unique) return false;
    const escaped = String(index.name).replaceAll("'", "''");
    const columns = db.prepare(`PRAGMA index_info('${escaped}')`).all().map((column) => column.name);
    return columns.length === 1 && columns[0] === "credentialID";
  });
  assert.equal(credentialUnique, true, "passkey credentialID must be DB-unique");
  db.close();

  const runtime = run("./node_modules/.bin/tsx", ["-e", `
    import { DatabaseSync } from "node:sqlite";
    import { auth } from "./lib/auth.ts";
    import { oauthScopes } from "./lib/auth-plugins.ts";
    import {
      createPasskeyAccountRegistrationIntent,
      resolvePasskeyEnrollmentIntent,
      consumePasskeyEnrollmentIntent,
    } from "./lib/passkey-enrollment.ts";
    (async () => {
      if (oauthScopes.includes("email")) throw new Error("email scope must not be advertised");
      const context = await createPasskeyAccountRegistrationIntent();
      const intent = await resolvePasskeyEnrollmentIntent(context);
      if (intent.kind !== "account-registration") throw new Error("wrong intent kind");
      const ctx = await auth.$context;
      if (await ctx.internalAdapter.findUserById(intent.id)) throw new Error("intent pre-created a user");
      const user = await ctx.internalAdapter.createUser({
        id: intent.id,
        name: intent.name,
        email: undefined as unknown as string,
        emailVerified: false,
      }, { method: "passkey" });
      const session = await ctx.internalAdapter.createSession(intent.id);
      await consumePasskeyEnrollmentIntent(context, intent.id);
      let replayRejected = false;
      try { await resolvePasskeyEnrollmentIntent(context); } catch { replayRejected = true; }
      const sql = new DatabaseSync(process.env.BETTER_AUTH_DB_PATH!);
      const row = sql.prepare("SELECT email FROM user WHERE id=?").get(intent.id) as {email:null|string};
      console.log(JSON.stringify({
        userCreated: user.id === intent.id,
        sessionCreated: session.userId === intent.id,
        emailNull: row.email === null,
        replayRejected,
      }));
    })().catch((error) => { console.error(error); process.exit(1); });
  `]);
  const lastLine = runtime.trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(lastLine, "runtime proof produced no result");
  const proof = JSON.parse(lastLine);
  assert.equal(proof.userCreated, true, "no-email Better Auth user was not created");
  assert.equal(proof.sessionCreated, true, "session was not created for no-email user");
  assert.equal(proof.emailNull, true, "a synthetic email identity was persisted");
  assert.equal(proof.replayRejected, true, "consumed registration intent was replayable");

  console.log("PASS passkey-only account schema, runtime identity, session, and intent replay contract");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
