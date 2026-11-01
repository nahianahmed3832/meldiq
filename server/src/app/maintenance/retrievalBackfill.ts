import { MongoClient } from "mongodb";
import { loadConfig } from "../config.js";
import { backfillRetrieval } from "../../modules/messaging/store/retrievalMeta.js";

// Maintenance only: loads configuration but never starts HTTP, schedulers or any billing action.
const config = loadConfig();
if (!config.mongo?.domains.has("history")) console.log(JSON.stringify({ backend: "sqlite", updated: 0 }));
else {
  const client = new MongoClient(config.mongo.uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 15_000 });
  try {
    await client.connect();
    const result = await backfillRetrieval(client.db(config.mongo.dbName));
    console.log(JSON.stringify({ backend: "mongodb", ...result }));
    if (result.remaining) process.exitCode = 2;
  } catch { console.error("Retrieval backfill failed; production source events are unchanged."); process.exitCode = 1; }
  finally { await client.close(); }
}
