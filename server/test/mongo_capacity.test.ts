import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Config } from "../src/app/config.js";
import { runMongoCommand } from "../src/infrastructure/database/mongo/admin.js";
import { checkCapacity, estimateStorage, projectCapacity, type StorageEstimate } from "../src/infrastructure/database/mongo/capacity.js";
import { describeTables } from "../src/infrastructure/database/mongo/catalog.js";
import { domainTables, MeldiqMongo } from "../src/infrastructure/database/mongo/client.js";
import { mongoConfig } from "../src/infrastructure/database/mongo/config.js";
import { authorityOf, migrateToMongo } from "../src/infrastructure/database/mongo/migrate.js";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";
import { testDbName } from "./support/mongo.js";

/**
 * Capacity before a migration (docs/MONGODB.md › 7a): the estimate matches what MongoDB stores, a re-run isn't counted
 * twice, and mongo-migrate / mongo-dryrun refuse up front when a Free cluster's limit would be passed.
 */
const uri = inject("mongoUri");
let h: Harness;
let alice: GriipClient;
const opened: MeldiqMongo[] = [];
const MIB = 1024 * 1024;

const cfg = (dbName: string, extra: Record<string, string> = {}) =>
  mongoConfig({ MONGODB_URI: uri, MONGODB_DB: dbName, ...extra }, "development", (n, d) => (extra[n] ? Number(extra[n]) : d))!;

beforeAll(async () => {
  h = await startServer({ MONGODB_DOMAINS: "" });
  alice = await h.client("alice");
  const bob = await h.client("bob");
  const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  for (let i = 0; i < 5; i++) await alice.send(dm, { text: `capacity ${i}` });
});

afterAll(async () => {
  for (const m of opened) {
    await m.db.dropDatabase().catch(() => undefined);
    await m.close();
  }
  await h.close();
});

const estimateOf = (tables: { table: string; rows: number; dataBytes: number; indexBytes: number }[]): StorageEstimate => {
  const full = tables.map((t) => ({ ...t, domain: "relay" as const }));
  const dataBytes = full.reduce((n, t) => n + t.dataBytes, 0);
  const indexBytes = full.reduce((n, t) => n + t.indexBytes, 0);
  return { tables: full, dataBytes, indexBytes, totalBytes: dataBytes + indexBytes };
};

describe("checkCapacity", () => {
  it("refuses a copy that would pass 70% of the limit", () => {
    const estimate = estimateOf([{ table: "a", rows: 10, dataBytes: 300 * MIB, indexBytes: 20 * MIB }]);
    const check = checkCapacity(512 * MIB, 50 * MIB, estimate, new Map());
    expect(check.projectedBytes).toBe(370 * MIB);
    expect(check.ok).toBe(false);
  });

  it("accepts a copy that leaves headroom", () => {
    const estimate = estimateOf([{ table: "a", rows: 10, dataBytes: 100 * MIB, indexBytes: 10 * MIB }]);
    expect(checkCapacity(512 * MIB, 50 * MIB, estimate, new Map()).ok).toBe(true);
  });

  it("doesn't count documents a re-run overwrites twice", () => {
    const estimate = estimateOf([{ table: "a", rows: 100, dataBytes: 200 * MIB, indexBytes: 0 }]);
    // Half of the table is already in MongoDB (100 MiB of the 150 MiB used).
    const check = checkCapacity(512 * MIB, 150 * MIB, estimate, new Map([["a", 50]]));
    expect(check.replacedBytes).toBe(100 * MIB);
    expect(check.projectedBytes).toBe(250 * MIB);
    expect(check.ok).toBe(true);
  });
});

describe("estimateStorage", { timeout: 60_000 }, () => {
  it("measures the documents exactly as MongoDB stores them", async () => {
    const tables = describeTables(h.ctx.db);
    const estimate = estimateStorage(h.ctx.db, tables);
    expect(estimate.dataBytes).toBeGreaterThan(0);
    expect(estimate.indexBytes).toBeGreaterThan(0);
    const mongo = await MeldiqMongo.connect(cfg(testDbName("cap")), tables);
    opened.push(mongo);
    await migrateToMongo(h.ctx.db, mongo, tables);
    for (const t of estimate.tables.filter((e) => e.rows > 0)) {
      const [stats] = await mongo.db.collection(t.table).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      expect({ table: t.table, bytes: stats.storageStats.size }).toEqual({ table: t.table, bytes: t.dataBytes });
    }
  });

  it("projects against the live deployment", async () => {
    const tables = domainTables(["relay"]);
    const mongo = await MeldiqMongo.connect(cfg(testDbName("cap")), tables);
    opened.push(mongo);
    const estimate = estimateStorage(h.ctx.db, tables);
    const before = await projectCapacity(mongo, estimate, 512 * MIB);
    expect(before.replacedBytes).toBe(0);
    await migrateToMongo(h.ctx.db, mongo, tables);
    const after = await projectCapacity(mongo, estimate, 512 * MIB);
    expect(after.replacedBytes).toBeCloseTo(estimate.totalBytes, 0);
    expect(after.ok).toBe(true);
  });
});

describe("guards", { timeout: 60_000 }, () => {
  function config(dbName: string, limitMb: string): Config {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-cap-"));
    return { mongo: cfg(dbName, { MONGODB_STORAGE_LIMIT_MB: limitMb }), databasePath: path.join(dir, "db.sqlite") } as Config;
  }

  it("mongo-migrate refuses before copying when the limit would be passed", async () => {
    const dbName = testDbName("cap");
    // 1 MiB: less than the empty collections and their indexes already take.
    const code = await runMongoCommand("mongo-migrate", ["relay", "--yes"], config(dbName, "1"), h.ctx.db);
    expect(code).toBe(1);
    const mongo = await MeldiqMongo.connect(cfg(dbName), []);
    opened.push(mongo);
    expect(await mongo.db.collection("delivery_queue").countDocuments()).toBe(0);
    expect(await authorityOf(mongo, "relay")).toBeNull();
  });

  it("mongo-dryrun refuses into a named database and leaves nothing behind", async () => {
    const dbName = testDbName("cap");
    const code = await runMongoCommand("mongo-dryrun", ["--db", dbName], config(testDbName("cap"), "1"), h.ctx.db);
    expect(code).toBe(1);
    const mongo = await MeldiqMongo.connect(cfg(dbName), []);
    opened.push(mongo);
    const names = (await mongo.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names.filter((n) => n !== "orbit_meta")).toEqual([]);
  });

  it("mongo-dryrun copies, verifies and then empties its database collection by collection", async () => {
    const dbName = testDbName("cap");
    // A snapshot, as in production: the live test server's timers may write between the two runs.
    const snapshot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-cap-")), "snapshot.sqlite");
    await h.ctx.db.backup(snapshot);
    const code = await runMongoCommand("mongo-dryrun", ["--snapshot", snapshot, "--db", dbName], config(testDbName("cap"), "512"), h.ctx.db);
    expect(code).toBe(0);
    const mongo = await MeldiqMongo.connect(cfg(dbName), []);
    opened.push(mongo);
    const names = (await mongo.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names.filter((n) => n !== "orbit_meta")).toEqual([]);
  });

  it("mongo-migrate copies when there is room", async () => {
    const dbName = testDbName("cap");
    const code = await runMongoCommand("mongo-migrate", ["relay", "--yes"], config(dbName, "512"), h.ctx.db);
    expect(code).toBe(0);
    const mongo = await MeldiqMongo.connect(cfg(dbName), []);
    opened.push(mongo);
    expect(await authorityOf(mongo, "relay")).toBe("mongodb");
  });
});
