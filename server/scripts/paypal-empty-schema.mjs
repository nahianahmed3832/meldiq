/** One-time offline migration for a readWrite-only deployment with no checkout or gift records.
 * Run with the API stopped, current release image and private production environment.
 * Originals are renamed, never deleted. Refuses any populated collection or existing backup name.
 */
import { MongoClient } from "mongodb";
import { indexesFor, tableSpecs, validatorFor } from "../dist/infrastructure/database/mongo/catalog.js";
if (!process.argv.includes("--api-stopped") || !process.env.MONGODB_URI) throw new Error("Stop the API and supply its private MongoDB environment first");
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
const names = ["billing_checkouts", "mojo_gifts"];
const suffix = "_pre_paypal_20261101";
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "meldiq");
  // Validate all preconditions before touching either collection.
  for (const name of names) {
    if (await db.collection(name).countDocuments({}) !== 0) throw new Error("Migration requires empty payment collections");
    if (await db.listCollections({ name: name + suffix }).hasNext()) throw new Error("Preserved collection already exists; inspect before retrying");
  }
  for (const name of names) {
    const spec = tableSpecs().find((s) => s.name === name);
    if (!spec) throw new Error("Missing schema specification");
    await db.collection(name).rename(name + suffix);
    await db.createCollection(name, { validator: validatorFor(spec), validationLevel: "strict", validationAction: "error" });
    const indexes = indexesFor(spec);
    if (indexes.length) await db.collection(name).createIndexes(indexes);
    console.log(`${name}: empty original preserved; strict release schema created`);
  }
} finally { await client.close(); }
