import Database from "better-sqlite3";
import { afterAll, describe, expect, inject, it } from "vitest";
import { type TableSpec } from "../src/infrastructure/database/mongo/catalog.js";
import { MeldiqMongo } from "../src/infrastructure/database/mongo/client.js";
import {
  mongoConfig,
  MONGO_DOMAINS,
} from "../src/infrastructure/database/mongo/config.js";
import {
  migrateToMongo,
  setAuthority,
  verify,
} from "../src/infrastructure/database/mongo/migrate.js";
import { MongoRows } from "../src/infrastructure/database/rows/mongoRows.js";
import { databaseMode, loadConfig } from "../src/app/config.js";
import { validateRelationships } from "../src/infrastructure/database/mongo/validate.js";
import { testDbName } from "./support/mongo.js";

const opened: MeldiqMongo[] = [];
const sources: Database.Database[] = [];
const uri = inject("mongoUri");
const spec: TableSpec = {
  name: "migration_records",
  domain: "preferences",
  columns: [
    { name: "id", type: "TEXT", notNull: true },
    { name: "value", type: "TEXT", notNull: true },
    { name: "created_at", type: "INTEGER", notNull: true },
  ],
  primaryKey: ["id"],
  indexes: [],
  foreignKeys: [],
  autoincrement: false,
};
async function fixture(n = 7) {
  const db = new Database(":memory:");
  sources.push(db);
  db.exec(
    "CREATE TABLE migration_records (id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  const insert = db.prepare("INSERT INTO migration_records VALUES (?,?,?)");
  for (let i = 0; i < n; i++) insert.run(`id_${i}`, `value_${i}`, 1234 + i);
  const cfg = mongoConfig(
    { MONGODB_URI: uri, MONGODB_DB: testDbName("safety") },
    "development",
    (_n, d) => d,
  )!;
  const mongo = await MeldiqMongo.connect(cfg, [spec]);
  opened.push(mongo);
  return { db, mongo };
}
afterAll(async () => {
  for (const m of opened) {
    await m.db.dropDatabase();
    await m.close();
  }
  for (const s of sources) s.close();
});

describe("migration data-loss guards", () => {
  it("resumes checkpoints and reruns idempotently with bounded batches and preserved timestamps", async () => {
    const { db, mongo } = await fixture(1001);
    let batches = 0;
    await expect(
      migrateToMongo(db, mongo, [spec], {
        batchSize: 17,
        onProgress: () => {
          if (++batches === 2) throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");
    const [resumed] = await migrateToMongo(db, mongo, [spec], {
      batchSize: 17,
    });
    expect(resumed).toMatchObject({
      ok: true,
      sourceCount: 1001,
      destCount: 1001,
    });
    const [repeated] = await migrateToMongo(db, mongo, [spec], {
      batchSize: 23,
    });
    expect(repeated.destChecksum).toBe(resumed.destChecksum);
    expect(repeated.written).toBe(0);
    expect(
      await mongo.db.collection(spec.name).findOne({ _id: "id_0" as never }),
    ).toMatchObject({ id: "id_0", created_at: 1234 });
  });
  it("writes only the final delta and archives changes from an immutable pre-copy without transferring authority", async () => {
    const { db, mongo } = await fixture(20);
    const [initial] = await migrateToMongo(db, mongo, [spec], { batchSize: 7 });
    expect(initial.written).toBe(20);
    db.prepare("UPDATE migration_records SET value = ? WHERE id = ?").run("final", "id_0");
    db.prepare("INSERT INTO migration_records VALUES (?,?,?)").run("new", "new", 9999);
    db.prepare("DELETE FROM migration_records WHERE id = ?").run("id_1");
    await expect(migrateToMongo(db, mongo, [spec])).rejects.toThrow(/conflicts require review/);
    const [delta] = await migrateToMongo(db, mongo, [spec], { batchSize: 7, conflictPolicy: "archive", prune: true });
    expect(delta).toMatchObject({ ok: true, written: 2, sourceCount: 20, destCount: 20 });
    expect(await mongo.db.collection("database_migration_conflicts").countDocuments()).toBe(2);
    expect(await mongo.db.collection("orbit_meta").findOne({ _id: "authority:preferences" as never })).toBeNull();
    expect((await migrateToMongo(db, mongo, [spec]))[0]).toMatchObject({ ok: true, written: 0 });
  });
  it("refuses stale SQLite replacement after Atlas becomes authoritative", async () => {
    const { db, mongo } = await fixture();
    await migrateToMongo(db, mongo, [spec]);
    await setAuthority(
      mongo,
      "preferences",
      "mongodb",
      "verified test cutover",
    );
    await mongo.db
      .collection(spec.name)
      .updateOne(
        { _id: "id_0" as never },
        { $set: { value: "new Atlas value" } },
      );
    await expect(
      migrateToMongo(db, mongo, [spec], { prune: true }),
    ).rejects.toThrow(/already authoritative/);
    expect(
      (await mongo.db.collection(spec.name).findOne({ _id: "id_0" as never }))!
        .value,
    ).toBe("new Atlas value");
  });
  it("requires explicit conflict review and keeps the original destination version before replacing it", async () => {
    const { db, mongo } = await fixture();
    await migrateToMongo(db, mongo, [spec]);
    await mongo.db
      .collection(spec.name)
      .updateOne(
        { _id: "id_0" as never },
        { $set: { value: "conflicting target" } },
      );
    await expect(migrateToMongo(db, mongo, [spec])).rejects.toThrow(
      /conflicts require review/,
    );
    expect(
      (
        await migrateToMongo(db, mongo, [spec], { conflictPolicy: "archive" })
      )[0].ok,
    ).toBe(true);
    expect(
      await mongo.db
        .collection("database_migration_conflicts")
        .countDocuments(),
    ).toBe(1);
    expect(
      (await mongo.db.collection("database_migration_conflicts").findOne({}))!
        .original.value,
    ).toBe("conflicting target");
  });
  it("preserves AUTOINCREMENT high-water marks even when the highest rows were deleted", async () => {
    const { db, mongo } = await fixture();
    db.exec(
      "CREATE TABLE counter_records (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL); INSERT INTO counter_records (id,value) VALUES (500,'removed'); DELETE FROM counter_records",
    );
    const counter: TableSpec = {
      ...spec,
      name: "counter_records",
      autoincrement: true,
      columns: [
        { name: "id", type: "INTEGER", notNull: true },
        { name: "value", type: "TEXT", notNull: true },
      ],
    };
    await mongo.ensureSchema([counter]);
    await migrateToMongo(db, mongo, [counter]);
    const rows = await MongoRows.open(mongo, [counter]);
    try {
      expect(
        (await rows.write((w) => w.insert("counter_records", { value: "new" })))
          .id,
      ).toBe(501);
    } finally {
      await rows.close();
    }
  });
  it("detects IDs whose document primary key was tampered with", async () => {
    const { db, mongo } = await fixture();
    await migrateToMongo(db, mongo, [spec]);
    await mongo.db
      .collection(spec.name)
      .updateOne({ _id: "id_0" as never }, { $set: { id: "wrong-id" } });
    expect((await verify(db, mongo, [spec]))[0]).toMatchObject({
      ok: false,
      differing: 1,
    });
  });
  it("prunes only explicit extras in bounded batches and rejects invalid batch sizes", async () => {
    const { db, mongo } = await fixture();
    await migrateToMongo(db, mongo, [spec]);
    await mongo.db
      .collection(spec.name)
      .insertOne({
        _id: "extra" as never,
        id: "extra",
        value: "extra",
        created_at: 1,
      });
    expect((await verify(db, mongo, [spec]))[0]).toMatchObject({
      extra: 1,
      ok: false,
    });
    expect(
      (await migrateToMongo(db, mongo, [spec], { prune: true }))[0].ok,
    ).toBe(true);
    await expect(
      migrateToMongo(db, mongo, [spec], { batchSize: 0 }),
    ).rejects.toThrow(/batchSize/);
    await expect(
      migrateToMongo(db, mongo, [spec], { batchDelayMs: -1 }),
    ).rejects.toThrow(/batchDelayMs/);
  });
  it("requires all domains and TLS certificate validation for explicit Atlas mode", () => {
    expect(() => databaseMode({ DATABASE_MODE: "atlas" })).toThrow(
      /every active domain/,
    );
    expect(() =>
      databaseMode({
        DATABASE_MODE: "atlas",
        MONGODB_URI: uri,
        MONGODB_DOMAINS: MONGO_DOMAINS.join(","),
        NODE_ENV: "production",
      }),
    ).toThrow(/REDIS_URL/);
    for (const option of [
      "tls=false",
      "ssl=false",
      "tlsAllowInvalidCertificates=true",
      "tlsAllowInvalidHostnames=true",
      "tlsInsecure=true",
    ]) {
      expect(() =>
        mongoConfig(
          { MONGODB_URI: `mongodb+srv://u:secret@cluster.example/?${option}` },
          "production",
          (_n, d) => d,
        ),
      ).toThrow();
    }
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        MONGODB_URI: "mongodb://u:secret@remote.example/",
      }),
    ).toThrow(/TLS/);
  });
  it("finds cross-community foreign keys without exposing records or changing them", async () => {
    const { mongo } = await fixture();
    await mongo.db
      .collection("parents")
      .insertOne({ id: "parent", org_id: "community_a" });
    await mongo.db
      .collection("children")
      .insertOne({ parent_id: "parent", org_id: "community_b" });
    const parent: TableSpec = {
      ...spec,
      name: "parents",
      columns: [
        { name: "id", type: "TEXT", notNull: true },
        { name: "org_id", type: "TEXT", notNull: true },
      ],
    };
    const child: TableSpec = {
      ...spec,
      name: "children",
      columns: [
        { name: "parent_id", type: "TEXT", notNull: true },
        { name: "org_id", type: "TEXT", notNull: true },
      ],
      foreignKeys: [
        {
          columns: ["parent_id"],
          table: "parents",
          references: ["id"],
          onDelete: "CASCADE",
        },
      ],
    };
    expect(await validateRelationships(mongo.db, [parent, child])).toEqual([
      {
        table: "children",
        parent: "parents",
        columns: ["parent_id"],
        missing: 1,
      },
    ]);
  });
});
