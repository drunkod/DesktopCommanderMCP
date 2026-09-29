import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const rawPath = process.env.BETTER_AUTH_DB_PATH;
if (!rawPath) throw new Error("BETTER_AUTH_DB_PATH is required");
const dbPath = rawPath === ":memory:" ? rawPath : path.resolve(process.cwd(), rawPath);
const db = new DatabaseSync(dbPath);
const tables = db.prepare(
  "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
).all().map((row) => row.name);
console.log("TABLES", tables.join(","));
for (const table of [
  "user", "session", "oauthClient", "oauthResource", "oauthAccessToken",
  "oauthRefreshToken", "oauthConsent", "deviceCode", "jwks",
]) {
  const columns = db.prepare(`pragma table_info(${table})`).all();
  console.log(`${table}:${columns.length}`);
}
