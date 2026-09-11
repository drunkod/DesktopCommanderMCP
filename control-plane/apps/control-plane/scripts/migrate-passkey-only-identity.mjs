import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  let dbPath = process.env.BETTER_AUTH_DB_PATH?.trim();
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--db") dbPath = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!dbPath) throw new Error("BETTER_AUTH_DB_PATH or --db is required");
  return { dbPath: dbPath === ":memory:" ? dbPath : resolve(dbPath), apply };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableNames(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => String(row.name));
}

function rowCounts(db) {
  return Object.fromEntries(tableNames(db).map((name) => [
    name,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get().count),
  ]));
}
function emailIsNullable(db) {
  const column = db.prepare("PRAGMA table_info('user')").all().find((row) => row.name === "email");
  return column?.notnull === 0;
}

function credentialIdIsUnique(db) {
  return db.prepare("PRAGMA index_list('passkey')").all().some((index) => {
    if (!index.unique) return false;
    const name = String(index.name).replaceAll("'", "''");
    const columns = db.prepare(`PRAGMA index_info('${name}')`).all().map((row) => row.name);
    return columns.length === 1 && columns[0] === "credentialID";
  });
}

function assertNoDuplicateCredentialIds(db) {
  const duplicate = db.prepare(`
    SELECT credentialID, COUNT(*) AS count
    FROM passkey
    GROUP BY credentialID
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get();
  if (duplicate) throw new Error("Cannot add credentialID uniqueness: duplicate credential IDs exist");
}

function assertIntegrity(db, expectedCounts) {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`foreign_key_check failed with ${violations.length} violation(s)`);
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error("SQLite integrity_check failed");
  }
  const observedCounts = rowCounts(db);
  if (JSON.stringify(observedCounts) !== JSON.stringify(expectedCounts)) {
    throw new Error("Application table row counts changed during migration");
  }
}
function applyMigration(db) {
  const before = rowCounts(db);
  assertNoDuplicateCredentialIds(db);

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec("BEGIN IMMEDIATE;");
    db.exec(`
      CREATE TABLE "user__step8_new" (
        "id" text not null primary key,
        "name" text not null,
        "email" text unique,
        "emailVerified" integer not null,
        "image" text,
        "createdAt" date not null,
        "updatedAt" date not null
      );
      INSERT INTO "user__step8_new"
        ("id","name","email","emailVerified","image","createdAt","updatedAt")
      SELECT "id","name","email","emailVerified","image","createdAt","updatedAt" FROM "user";
      CREATE TEMP TABLE "passkey__step8_data" AS SELECT * FROM "passkey";
      DROP TABLE "passkey";
      DROP TABLE "user";
      ALTER TABLE "user__step8_new" RENAME TO "user";
    `);

    db.exec(`
      CREATE TABLE "passkey" (
        "id" text not null primary key,
        "name" text,
        "publicKey" text not null,
        "userId" text not null references "user" ("id") on delete cascade,
        "credentialID" text not null unique,
        "counter" integer not null,
        "deviceType" text not null,
        "backedUp" integer not null,
        "transports" text,
        "createdAt" date,
        "aaguid" text
      );
      INSERT INTO "passkey"
        ("id","name","publicKey","userId","credentialID","counter","deviceType","backedUp","transports","createdAt","aaguid")
      SELECT "id","name","publicKey","userId","credentialID","counter","deviceType","backedUp","transports","createdAt","aaguid"
      FROM "passkey__step8_data";
      CREATE INDEX "passkey_userId_idx" ON "passkey" ("userId");
      CREATE INDEX "passkey_credentialID_idx" ON "passkey" ("credentialID");
      DROP TABLE "passkey__step8_data";
    `);

    assertIntegrity(db, before);
    db.exec("COMMIT;");
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  assertIntegrity(db, before);
}
const { dbPath, apply } = parseArgs(process.argv.slice(2));
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");

try {
  const alreadyApplied = emailIsNullable(db) && credentialIdIsUnique(db);
  if (alreadyApplied) {
    const counts = rowCounts(db);
    assertIntegrity(db, counts);
    console.log("PASS passkey-only identity schema already applied");
  } else if (!apply) {
    console.log("NEEDS_MIGRATION passkey-only identity schema");
    process.exitCode = 2;
  } else {
    applyMigration(db);
    if (!emailIsNullable(db)) throw new Error("user.email is still NOT NULL after migration");
    if (!credentialIdIsUnique(db)) throw new Error("passkey.credentialID is still not unique after migration");
    console.log("PASS passkey-only identity schema migration applied");
  }
} finally {
  db.close();
}
