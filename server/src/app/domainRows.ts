import type { DB } from "../infrastructure/database/db.js";
import { type TableDomain, tableSpecs } from "../infrastructure/database/mongo/catalog.js";
import type { MeldiqMongo } from "../infrastructure/database/mongo/client.js";
import type { MongoDomain } from "../infrastructure/database/mongo/config.js";
import { MongoRows, type Rows, SqliteRows } from "../infrastructure/database/rows/index.js";

/**
 * One domain's rows (docs/MONGODB.md › Rows): its tables in SQLite, or in MongoDB with an in-memory copy when
 * MONGODB_DOMAINS includes it. Reads are synchronous either way; writes are units.
 */
export async function openDomainRows(db: DB, domain: MongoDomain & TableDomain, mongo?: MeldiqMongo, log?: { error(obj: object, msg?: string): void }): Promise<Rows> {
  const specs = tableSpecs().filter((t) => t.domain === domain);
  return mongo?.owns(domain) ? MongoRows.open(mongo, specs, { db, log }) : new SqliteRows(db, specs);
}
