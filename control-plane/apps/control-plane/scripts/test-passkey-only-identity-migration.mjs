import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const temp = mkdtempSync(path.join(tmpdir(), "dc-step8-migration-"));
const dbPath = path.join(temp, "legacy.sqlite");

function runMigration(...args) {
  const result = spawnSync(process.execPath, [
    "./scripts/migrate-passkey-only-identity.mjs",
    "--db", dbPath,
    ...args,
  ], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`migration exited ${result.status}`);
  }
  return result.stdout.trim();
}

try {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE "user" (
      "id" text not null primary key,
      "name" text not null,
      "email" text not null unique,
      "emailVerified" integer not null,
      "image" text,
      "createdAt" date not null,
      "updatedAt" date not null
    );
    CREATE TABLE "session" (
      "id" text not null primary key,
      "userId" text not null references "user"("id") on delete cascade
    );
  `);  db.exec(`
    CREATE TABLE "passkey" (
      "id" text not null primary key,
      "name" text,
      "publicKey" text not null,
      "userId" text not null references "user"("id") on delete cascade,
      "credentialID" text not null,
      "counter" integer not null,
      "deviceType" text not null,
      "backedUp" integer not null,
      "transports" text,
      "createdAt" date,
      "aaguid" text
    );
    CREATE INDEX "passkey_userId_idx" ON "passkey"("userId");
    CREATE INDEX "passkey_credentialID_idx" ON "passkey"("credentialID");
    INSERT INTO "user" VALUES (
      'user-1','Legacy User','legacy@example.test',1,NULL,
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
    );
    INSERT INTO "session" VALUES ('session-1','user-1');
    INSERT INTO "passkey" VALUES (
      'passkey-1','Legacy key','public-key','user-1','credential-1',0,
      'singleDevice',0,'internal','2026-01-01T00:00:00.000Z',NULL
    );
  `);
  db.close();

  assert.match(runMigration("--apply"), /PASS passkey-only identity schema migration applied/);

  const migrated = new DatabaseSync(dbPath);
  const email = migrated.prepare("PRAGMA table_info('user')").all().find((row) => row.name === "email");
  assert.equal(email?.notnull, 0, "email must be nullable after explicit migration");
  const uniqueCredential = migrated.prepare("PRAGMA index_list('passkey')").all().some((index) => {
    if (!index.unique) return false;
    const name = String(index.name).replaceAll("'", "''");
    const cols = migrated.prepare(`PRAGMA index_info('${name}')`).all().map((row) => row.name);
    return cols.length === 1 && cols[0] === "credentialID";
  });
  assert.equal(uniqueCredential, true, "credentialID must be unique after migration");
  const user = migrated.prepare("SELECT id,name,email FROM user WHERE id='user-1'").get();
  assert.equal(user.id, "user-1");
  assert.equal(user.name, "Legacy User");
  assert.equal(user.email, "legacy@example.test");
  assert.equal(migrated.prepare("SELECT COUNT(*) AS c FROM session").get().c, 1);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS c FROM passkey").get().c, 1);
  assert.equal(migrated.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(migrated.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  migrated.close();

  assert.match(runMigration("--apply"), /PASS passkey-only identity schema already applied/);
  console.log("PASS explicit passkey-only identity migration preserves legacy rows and is idempotent");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
