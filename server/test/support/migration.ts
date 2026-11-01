import { inject } from "vitest";
import { openDatabase } from "../../src/infrastructure/database/db.js";
import { MeldiqMongo } from "../../src/infrastructure/database/mongo/client.js";
import { mongoConfig } from "../../src/infrastructure/database/mongo/config.js";
import { testDbName } from "./mongo.js";

/** Offline migration destination: no API writer or authority marker exists before source data is verified. */
export async function migrationTarget() {
  const config = mongoConfig(
    { MONGODB_URI: inject("mongoUri"), MONGODB_DB: testDbName("migration") },
    "development",
    (_name, fallback) => fallback,
  )!;
  const mongo = await MeldiqMongo.connect(config, []);
  const db = openDatabase(":memory:");
  return {
    mongo,
    db,
    close: async () => {
      try { await mongo.db.dropDatabase(); } finally { await mongo.close(); db.close(); }
    },
  };
}
