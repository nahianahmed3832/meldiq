import { MongoClient } from "mongodb";
import { inject } from "vitest";
import type { MongoConfig } from "../../src/infrastructure/database/mongo/config.js";

let n = 0;

/** A database name nobody else in this run uses. */
export function testDbName(prefix = "t"): string {
  return `${prefix}_${process.pid}_${++n}_${Date.now().toString(36)}`;
}

/** Databases an earlier test server of this worker emptied, ready for the next (see [releaseTestDatabase]). */
const emptied: string[] = [];
const POOLED = "pool_";

/**
 * A database for a test server: one an earlier server of this worker left empty, else a new one. Creating the ~170
 * collections with their validators and indexes takes MongoDB seconds; emptying them takes milliseconds.
 */
function serverDbName(): string {
  return emptied.pop() ?? testDbName(`${POOLED}${process.pid}`);
}

/**
 * The MongoDB settings a test server gets: none, unless the test asks for MongoDB domains itself or the run sets
 * MELDIQ_TEST_MONGO_DOMAINS (then every suite runs with those domains in MongoDB). Always the run's local replica set.
 */
export function testMongoEnv(env: Record<string, string>): Record<string, string> {
  const domains = env.MONGODB_DOMAINS ?? process.env.MELDIQ_TEST_MONGO_DOMAINS;
  if (!domains && !env.MONGODB_URI) return {};
  return { MONGODB_URI: env.MONGODB_URI ?? inject("mongoUri"), MONGODB_DB: env.MONGODB_DB ?? serverDbName(), MONGODB_DOMAINS: domains ?? "" };
}

/** Done with a test server's database: a pooled one is emptied for the next server, any other dropped. */
export async function dropTestDatabase(cfg: MongoConfig): Promise<void> {
  const c = await MongoClient.connect(cfg.uri);
  try {
    const db = c.db(cfg.dbName);
    if (!cfg.dbName.startsWith(POOLED)) {
      await db.dropDatabase();
      return;
    }
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    await Promise.all(collections.map((col) => db.collection(col.name).deleteMany({})));
    emptied.push(cfg.dbName);
  } finally {
    await c.close();
  }
}
