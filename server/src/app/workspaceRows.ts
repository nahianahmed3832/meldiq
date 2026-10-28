import type { DB } from "../infrastructure/database/db.js";
import { describeTables } from "../infrastructure/database/mongo/catalog.js";
import type { MeldiqMongo } from "../infrastructure/database/mongo/client.js";
import { MongoRows, type Rows, SqliteRows } from "../infrastructure/database/rows/index.js";

/**
 * Communities and conversations (the "workspace" and "conversations" domains, which move together: authorisation reads
 * both on every request). Their rows live in SQLite, or in MongoDB with an in-memory copy when MONGODB_DOMAINS includes
 * them (src/infrastructure/database/rows).
 */
export const WORKSPACE_DOMAINS = ["workspace", "conversations"] as const;

export async function openWorkspaceRows(db: DB, mongo?: MeldiqMongo, log?: { error(obj: object, msg?: string): void }): Promise<Rows> {
  const specs = describeTables(db).filter((t) => (WORKSPACE_DOMAINS as readonly string[]).includes(t.domain));
  return mongo?.owns("workspace") ? MongoRows.open(mongo, specs, { db, log }) : new SqliteRows(db, specs);
}
