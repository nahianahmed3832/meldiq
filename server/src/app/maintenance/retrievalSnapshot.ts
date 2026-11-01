import { MongoClient, BSON, type Db } from "mongodb";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";

/** Snapshot is streamed, transaction-consistent, verified, and never printed or moved off the VPS. */
export async function snapshotHistory(db: Db, directory: string) {
  fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, "message-events.ejson");
  const fd = fs.openSync(file + ".partial", "wx", 0o600);
  const session = db.client.startSession();
  let count = 0;
  try {
    session.startTransaction({ readConcern: { level: "snapshot" } });
    const cursor = db.collection("message_events").find({}, { session, batchSize: 100 }).sort({ _id: 1 });
    try { for await (const doc of cursor) { fs.writeSync(fd, BSON.EJSON.stringify(doc, { relaxed: false }) + "\n"); count++; } }
    finally { await cursor.close(); }
    await session.commitTransaction(); fs.fsyncSync(fd);
  } catch (e) { await session.abortTransaction().catch(() => {}); throw e; }
  finally { fs.closeSync(fd); await session.endSession(); }
  let verified = 0; const digest = crypto.createHash("sha256");
  const lines = readline.createInterface({ input: fs.createReadStream(file + ".partial"), crlfDelay: Infinity });
  for await (const line of lines) { const doc = BSON.EJSON.parse(line); if (!doc._id || typeof doc.payload !== "string") throw new Error("Invalid snapshot record"); digest.update(line + "\n"); verified++; }
  if (count !== verified) throw new Error("Snapshot count mismatch");
  fs.renameSync(file + ".partial", file);
  const indexes = await db.collection("message_events").indexes();
  fs.writeFileSync(path.join(directory, "indexes.json"), JSON.stringify(indexes, null, 2), { mode: 0o600, flag: "wx" });
  const manifest = { count, verified, sha256: digest.digest("hex"), completedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination || !/^\/data\/backups\/retrieval-[A-Za-z0-9_-]+$/.test(destination)) throw new Error("Use a new /data/backups/retrieval-ID directory");
  const config = loadConfig();
  if (!config.mongo?.domains.has("history")) console.log(JSON.stringify({ backend: "sqlite", snapshot: "covered by verified SQLite archive" }));
  else {
    const client = new MongoClient(config.mongo.uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 15_000 });
    try { await client.connect(); console.log(JSON.stringify(await snapshotHistory(client.db(config.mongo.dbName), destination))); }
    catch { console.error("History snapshot failed; no source event was changed."); process.exitCode = 1; }
    finally { await client.close(); }
  }
}
