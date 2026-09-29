import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function resolveAuthDatabasePath(): string {
  const configured = process.env.BETTER_AUTH_DB_PATH?.trim();
  if (!configured || configured === ":memory:") {
    throw new Error("Cutover owner verification requires a file-backed BETTER_AUTH_DB_PATH");
  }
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

export function expectedOwnerExistsInAuthDb(ownerId: string): boolean {
  const database = new DatabaseSync(resolveAuthDatabasePath(), { readOnly: true });
  try {
    const row = database
      .prepare('SELECT 1 AS present FROM "user" WHERE id = ? LIMIT 1')
      .get(ownerId) as { present?: number } | undefined;
    return row?.present === 1;
  } finally {
    database.close();
  }
}
