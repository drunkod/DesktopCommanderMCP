import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env";

declare global {
  var __remoteMcpBetterAuthDb: DatabaseSync | undefined;
}

function resolveDatabasePath(value: string): string {
  if (value === ":memory:") return value;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function authDatabase(): DatabaseSync {
  if (globalThis.__remoteMcpBetterAuthDb) {
    return globalThis.__remoteMcpBetterAuthDb;
  }

  const databasePath = resolveDatabasePath(env.betterAuthDbPath);
  if (databasePath !== ":memory:") {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 5000;");

  globalThis.__remoteMcpBetterAuthDb = database;
  return database;
}
