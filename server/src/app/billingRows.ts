import type { DB } from "../infrastructure/database/db.js";
import { describeTables } from "../infrastructure/database/mongo/catalog.js";
import type { MeldiqMongo } from "../infrastructure/database/mongo/client.js";
import { MongoRows, type Rows, SqliteRows } from "../infrastructure/database/rows/index.js";

/**
 * Billing (the "billing" domain: plans, checkouts, subscriptions, invoices, provider events, free periods, Meldiq Spark
 * and gifts; docs/BILLING.md, docs/MOJO.md). Its rows live in SQLite, or in MongoDB with an in-memory copy when
 * MONGODB_DOMAINS includes "billing" (src/infrastructure/database/rows).
 */
export async function openBillingRows(db: DB, mongo?: MeldiqMongo, log?: { error(obj: object, msg?: string): void }): Promise<Rows> {
  const specs = describeTables(db).filter((t) => t.domain === "billing");
  return mongo?.owns("billing") ? MongoRows.open(mongo, specs, { db, log }) : new SqliteRows(db, specs);
}
