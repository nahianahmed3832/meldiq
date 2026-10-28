import type { DB } from "../db.js";
import { type TableSpec, tableSpecs } from "./catalog.js";
import { domainTables, type Logger, MeldiqMongo } from "./client.js";
import { MONGO_DOMAINS, type MongoConfig, type MongoDomain } from "./config.js";
import { authorityOf, setAuthority } from "./migrate.js";

export { MeldiqMongo } from "./client.js";
export type { MongoConfig, MongoDomain } from "./config.js";

/** Rows the SQLite tables of [tables] hold. */
function sqliteRows(db: DB, tables: TableSpec[]): number {
  return tables.reduce((n, t) => n + (db.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as { n: number }).n, 0);
}

/**
 * Connects to MongoDB for the server and refuses to start in a state that could split a domain's data between the two
 * stores (docs/MONGODB.md › Authority):
 * - a domain in MONGODB_DOMAINS must have been migrated (`admin mongo-migrate`), unless SQLite has nothing for it yet;
 * - a domain migrated to MongoDB can't silently go back to SQLite's stale copy (`admin mongo-rollback` moves it back).
 */
export async function openMongo(config: MongoConfig, db: DB, log?: Logger): Promise<MeldiqMongo> {
  checkReferences(tableSpecs(), config.domains);
  const mongo = await MeldiqMongo.connect(config, domainTables(config.domains), log);
  try {
    for (const domain of MONGO_DOMAINS) await checkAuthority(mongo, db, domain);
  } catch (e) {
    await mongo.close();
    throw e;
  }
  return mongo;
}

/**
 * SQLite enforces foreign keys: a SQLite table can't reference a table whose rows live in MongoDB (new rows there would
 * be missing in SQLite). So a domain moves only once everything that references it in SQLite moves too (identity, which
 * almost everything references, last). MongoDB's rows don't enforce references to other stores, so the other way is fine.
 */
export function checkReferences(tables: readonly TableSpec[], inMongo: ReadonlySet<string>): void {
  const domainOf = new Map(tables.map((t) => [t.name, t.domain]));
  const needed = new Map<string, Set<string>>();
  for (const t of tables) {
    if (inMongo.has(t.domain)) continue;
    for (const fk of t.foreignKeys) {
      const target = domainOf.get(fk.table);
      if (target && target !== t.domain && inMongo.has(target)) {
        if (!needed.has(target)) needed.set(target, new Set());
        needed.get(target)!.add(t.domain);
      }
    }
  }
  if (needed.size) {
    const why = [...needed].map(([d, from]) => `"${d}" is referenced from ${[...from].map((f) => `"${f}"`).join(", ")} in SQLite`).join("; ");
    throw new Error(`MONGODB_DOMAINS: ${why}. Move those to MongoDB too (list them in MONGODB_DOMAINS), or keep "${[...needed.keys()][0]}" in SQLite`);
  }
}

async function checkAuthority(mongo: MeldiqMongo, db: DB, domain: MongoDomain): Promise<void> {
  const authority = await authorityOf(mongo, domain);
  if (mongo.owns(domain)) {
    if (authority === "mongodb") return;
    const rows = sqliteRows(db, domainTables([domain]));
    if (rows > 0) {
      throw new Error(
        `MONGODB_DOMAINS includes "${domain}", but its ${rows} row(s) are still only in SQLite. Stop writes and run: node dist/admin.js mongo-migrate ${domain}`,
      );
    }
    await setAuthority(mongo, domain, "mongodb", "empty in SQLite when first used");
  } else if (authority === "mongodb") {
    throw new Error(
      `"${domain}" lives in MongoDB since its migration. Keep it in MONGODB_DOMAINS, or move it back first: node dist/admin.js mongo-rollback ${domain}`,
    );
  }
}
