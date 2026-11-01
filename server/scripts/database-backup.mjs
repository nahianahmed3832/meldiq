import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createGzip, createGunzip } from "node:zlib";
import { BSON, MongoClient } from "mongodb";

// Stream only to a restricted file/encryption pipe; stdout contains sensitive application records.
// Restore is deliberately limited to EMPTY local scratch databases, never a production URI.
const MOD = 1n << 256n;
const stable = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, stable(value[k])]),
      )
    : Array.isArray(value)
      ? value.map(stable)
      : value;
const hash = (doc) => {
  const canonical = JSON.stringify(
    stable(JSON.parse(BSON.EJSON.stringify(doc, { relaxed: false }))),
  );
  return BigInt("0x" + createHash("sha256").update(canonical).digest("hex"));
};
const hex = (n) => n.toString(16).padStart(64, "0");
const mode = process.argv[2] || "dump";
async function dump() {
  const client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 5000,
  });
  const gzip = createGzip();
  gzip.pipe(process.stdout);
  const write = async (value) => {
    if (!gzip.write(JSON.stringify(value) + "\n")) await once(gzip, "drain");
  };
  let session;
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "meldiq");
    const collections = await db.listCollections().toArray();
    const definitions = [];
    for (const collection of collections) {
      if (collection.type === "view")
        throw new Error("Views require an explicit backup adapter");
      definitions.push({
        name: collection.name,
        options: collection.options,
        indexes: await db.collection(collection.name).listIndexes().toArray(),
      });
    }
    await write({
      type: "header",
      format: "meldiq-ejson-snapshot-v1",
      createdAt: new Date().toISOString(),
      collections: definitions,
    });
    // Snapshot sessions pin atClusterTime across collections without a transaction lifetime ceiling.
    session = client.startSession({ snapshot: true, causalConsistency: false });
    const totals = [];
    for (const { name } of definitions) {
      let count = 0,
        sum = 0n;
      for await (const doc of db
        .collection(name)
        .find(
          {},
          {
            session,
            batchSize: 5000,
            promoteLongs: false,
            promoteValues: false,
          },
        )) {
        await write({
          type: "document",
          collection: name,
          ejson: BSON.EJSON.stringify(doc, { relaxed: false }),
        });
        count++;
        sum = (sum + hash(doc)) % MOD;
      }
      totals.push({ collection: name, count, checksum: hex(sum) });
    }
    await write({ type: "complete", totals });
    const ended = once(gzip, "end");
    gzip.end();
    await ended;
  } finally {
    await session?.endSession();
    await client.close();
  }
}
async function restore() {
  const uri = process.env.RESTORE_MONGODB_URI || "";
  const name = process.env.RESTORE_MONGODB_DB || "";
  if (
    !/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(uri) ||
    !/^meldiq_restore_[a-zA-Z0-9_]+$/.test(name)
  )
    throw new Error("Restore requires an explicit local scratch database");
  const client = new MongoClient(uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(name);
    if ((await db.listCollections({}, { nameOnly: true }).toArray()).length)
      throw new Error("Restore destination is not empty");
    const input = process.stdin.pipe(createGunzip());
    const lines = createInterface({ input, crlfDelay: Infinity });
    let header, complete;
    let collection = "",
      batch = [];
    const flush = async () => {
      if (batch.length) {
        await db.collection(collection).insertMany(batch, { ordered: true });
        batch = [];
      }
    };
    for await (const line of lines) {
      if (complete) throw new Error("Trailing backup data");
      const record = JSON.parse(line);
      if (record.type === "header") {
        if (header || record.format !== "meldiq-ejson-snapshot-v1")
          throw new Error("Invalid backup header");
        header = record;
        for (const definition of header.collections) {
          const { validator, validationLevel, validationAction, collation } =
            definition.options || {};
          await db.createCollection(definition.name, {
            ...(validator
              ? { validator, validationLevel, validationAction }
              : {}),
            ...(collation ? { collation } : {}),
          });
        }
      } else if (record.type === "document" && header) {
        if (!header.collections.some((c) => c.name === record.collection))
          throw new Error("Unknown collection");
        if (collection !== record.collection) {
          await flush();
          collection = record.collection;
        }
        batch.push(BSON.EJSON.parse(record.ejson, { relaxed: false }));
        if (batch.length === 500) await flush();
      } else if (record.type === "complete" && header) {
        await flush();
        complete = record;
      } else throw new Error("Invalid backup stream");
    }
    if (!complete || complete.totals.length !== header.collections.length)
      throw new Error("Incomplete backup");
    const report = [];
    for (const expected of complete.totals) {
      let count = 0,
        sum = 0n;
      for await (const doc of db
        .collection(expected.collection)
        .find(
          {},
          { batchSize: 500, promoteLongs: false, promoteValues: false },
        )) {
        count++;
        sum = (sum + hash(doc)) % MOD;
      }
      if (count !== expected.count || hex(sum) !== expected.checksum)
        throw new Error("Restore checksum mismatch");
      const definition = header.collections.find(
        (c) => c.name === expected.collection,
      );
      const indexes = definition.indexes
        .filter((index) => index.name !== "_id_")
        .map(({ v, ns, ...index }) => index);
      if (indexes.length)
        await db.collection(expected.collection).createIndexes(indexes);
      report.push({
        collection: expected.collection,
        count,
        checksum: hex(sum),
      });
    }
    console.log(JSON.stringify({ verified: true, collections: report }));
  } finally {
    await client.close();
  }
}
(mode === "dump"
  ? dump()
  : mode === "restore"
    ? restore()
    : Promise.reject(new Error("Unknown backup command"))
).catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      errorType: error.name,
      message:
        "Backup or restore failed; incomplete output must not be treated as a verified backup",
    }),
  );
  process.exitCode = 1;
});
