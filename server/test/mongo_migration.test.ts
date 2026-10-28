import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { describeTables, EXCLUDED_TABLES, indexesFor, TABLE_DOMAINS, validatorFor } from "../src/infrastructure/database/mongo/catalog.js";
import { domainTables, MeldiqMongo } from "../src/infrastructure/database/mongo/client.js";
import { mongoConfig, redactUri } from "../src/infrastructure/database/mongo/config.js";
import { openMongo } from "../src/infrastructure/database/mongo/index.js";
import { authorityOf, exportToSqlite, migrateToMongo, setAuthority, verify } from "../src/infrastructure/database/mongo/migrate.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";
import { testDbName } from "./support/mongo.js";

/**
 * MongoDB as a store (docs/MONGODB.md): the catalog derived from the SQLite schema, validators and indexes, and the
 * migration on synthetic data (copy, verify, re-run, resume, prune, rollback, authority guards). Uses the test run's
 * local replica set only (test/support/mongoGlobal.ts).
 */
const uri = inject("mongoUri");
const mailer = new MemoryMailer();
let h: Harness;
let alice: GriipClient, bob: GriipClient;
let raw: MongoClient;
const opened: MeldiqMongo[] = [];

const cfg = (dbName: string, domains: string[] = []) => mongoConfig({ MONGODB_URI: uri, MONGODB_DB: dbName, MONGODB_DOMAINS: domains.join(",") }, "development", (_n, d) => d)!;
async function connectAll(dbName = testDbName("mig")) {
  const m = await MeldiqMongo.connect(cfg(dbName), describeTables(h.ctx.db));
  opened.push(m);
  return m;
}

beforeAll(async () => {
  raw = await MongoClient.connect(uri);
  // A small synthetic workspace: people, an organisation with channels, encrypted messages in flight, encrypted
  // history (binary), personal preferences and an Orbit 2.0 account.
  h = await startServer({ MONGODB_DOMAINS: "" }, { mailer });
  [alice, bob] = await Promise.all([h.client("alice"), h.client("bob")]);
  const orgId = (await alice.req("POST", "/v1/orgs", { name: "Synthetic Co" })).org.id;
  await bob.req("POST", "/v1/invites/accept", { code: (await alice.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code });
  const ch = (await alice.req("POST", `/v1/orgs/${orgId}/channels`, { name: "general", scope: "ORG" })).channel.id;
  await bob.req("POST", `/v1/conversations/${ch}/join`);
  const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  for (let i = 0; i < 7; i++) await alice.send(i % 2 ? dm : ch, { text: `synthetic ${i}` });
  await alice.req("PUT", "/v1/history/items", {
    items: Array.from({ length: 3 }, (_, i) => ({ tag: crypto.randomBytes(24).toString("base64url"), conv: dm, ts: i + 1, body: crypto.randomBytes(300).toString("base64") })),
  });
  await alice.req("PUT", `/v1/me/preferences/${orgId}`, { baseRev: 0, prefs: { starred: [ch], sections: [{ id: "s_x", name: "X", items: [dm] }] } });
  await AccountClient.ready(h.baseUrl, mailer, "synthetic");
});

afterAll(async () => {
  for (const m of opened) {
    await m.db.dropDatabase().catch(() => undefined);
    await m.close();
  }
  await raw.close();
  await h.close();
});

describe("catalog", () => {
  it("maps every SQLite table to a domain or an explicit exclusion", () => {
    const tables = describeTables(h.ctx.db).map((t) => t.name);
    const all = (h.ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of all) expect(t in EXCLUDED_TABLES || t in TABLE_DOMAINS).toBe(true);
    expect(tables).toContain("accounts");
    expect(tables).toContain("delivery_queue");
    // Short-lived security material is its own domain (copied at the switch, so nobody is signed out); SQLite's own
    // bookkeeping never goes to MongoDB.
    for (const t of ["sessions", "auth_challenges", "pairing_requests", "federation_nonces"]) expect(TABLE_DOMAINS[t]).toBe("ephemeral");
    expect(tables).not.toContain("schema_migrations");
  });

  it("derives validators and indexes from the schema", () => {
    const accounts = describeTables(h.ctx.db).find((t) => t.name === "accounts")!;
    const v = validatorFor(accounts).$jsonSchema as { required: string[]; properties: Record<string, { bsonType: string[] }> };
    expect(v.required).toEqual(expect.arrayContaining(["_id", "email", "password_hash", "created_at"]));
    expect(v.required).not.toContain("user_id");
    expect(v.properties.user_id.bsonType).toContain("null");
    const ix = indexesFor(accounts);
    // email: unique and case-insensitive; user_id: unique only where set (many accounts have none yet).
    expect(ix.find((i) => i.key.email)).toMatchObject({ unique: true, collation: { locale: "en", strength: 2 } });
    expect(ix.find((i) => i.key.user_id)).toMatchObject({ unique: true, partialFilterExpression: { user_id: { $type: "string" } } });
  });
});

// Integration tests that build every collection and copy every table: slower than unit tests, above all when the whole
// suite shares the one local replica set (MELDIQ_TEST_MONGO_DOMAINS runs).
const HEAVY = { timeout: 60_000 };

describe("collections", HEAVY, () => {
  it("refuse documents that break the schema and enforce unique keys", async () => {
    const m = await connectAll();
    const accounts = m.db.collection("accounts");
    const ok = {
      _id: "acc_1", id: "acc_1", email: "a@example.com", name: "A", password_hash: "scrypt$x", password_changed_at: 1, email_verified_at: null, user_id: null,
      legacy_linked_at: null, selected_workspace_id: null, admitted_via: null, created_at: 1, updated_at: 1, disabled_at: null,
    };
    await accounts.insertOne(ok);
    await expect(accounts.insertOne({ ...ok, _id: "acc_2", id: "acc_2", email: undefined })).rejects.toThrow(/validation/i);
    await expect(accounts.insertOne({ ...ok, _id: "acc_3", id: "acc_3", email: "b@example.com", created_at: "yesterday" })).rejects.toThrow(/validation/i);
    // Same address in other letters: one account per address.
    await expect(accounts.insertOne({ ...ok, _id: "acc_4", id: "acc_4", email: "A@Example.com" })).rejects.toThrow(/duplicate key/i);
    // Many accounts without an identity are fine; two with the same identity are not.
    await accounts.insertOne({ ...ok, _id: "acc_5", id: "acc_5", email: "c@example.com" });
    await accounts.insertOne({ ...ok, _id: "acc_6", id: "acc_6", email: "d@example.com", user_id: "u_1" });
    await expect(accounts.insertOne({ ...ok, _id: "acc_7", id: "acc_7", email: "e@example.com", user_id: "u_1" })).rejects.toThrow(/duplicate key/i);
  });

  it("are prepared again at start without collMod unless a validator changed (Atlas readWrite can't collMod)", async () => {
    const m = await connectAll();
    const tables = describeTables(h.ctx.db);
    const commands: string[] = [];
    const command = m.db.command.bind(m.db);
    m.db.command = ((cmd: Record<string, unknown>, ...rest: unknown[]) => {
      commands.push(Object.keys(cmd)[0]);
      return (command as (...a: unknown[]) => unknown)(cmd, ...rest);
    }) as typeof m.db.command;
    await m.ensureSchema(tables);
    expect(commands).not.toContain("collMod");
    // A validator that differs (an older schema) is still brought up to date.
    await command({ collMod: "accounts", validator: { $jsonSchema: { bsonType: "object" } } });
    await m.ensureSchema(tables);
    expect(commands.filter((c) => c === "collMod")).toHaveLength(1);
    const [accounts] = await m.db.listCollections({ name: "accounts" }).toArray();
    expect(JSON.stringify((accounts as { options: { validator: unknown } }).options.validator)).toContain("password_hash");
  });
});

describe("migration", HEAVY, () => {
  it("copies every table and verifies counts, ids and checksums", async () => {
    const m = await connectAll();
    const reports = await migrateToMongo(h.ctx.db, m, describeTables(h.ctx.db), { batchSize: 3 });
    for (const r of reports) expect(r, r.table).toMatchObject({ ok: true, missing: 0, extra: 0, differing: 0 });
    const byTable = Object.fromEntries(reports.map((r) => [r.table, r]));
    expect(byTable.users.sourceCount).toBeGreaterThanOrEqual(3);
    expect(byTable.delivery_queue.sourceCount).toBeGreaterThan(0);
    expect(byTable.history_items.sourceCount).toBe(3);
    // Ciphertext arrives byte for byte: binary history bodies and queued envelopes.
    const item = (await m.db.collection("history_items").findOne({}))!;
    const row = h.ctx.db.prepare("SELECT body FROM history_items WHERE user_id = ? AND tag = ?").get(item.user_id, item.tag) as { body: Buffer };
    expect(Buffer.from(item.body.buffer).equals(row.body)).toBe(true);
    // Preferences are a document, not JSON text.
    expect((await m.db.collection("nav_preferences").findOne({}))!.doc.sections[0].name).toBe("X");
    // Nothing excluded was created.
    const names = (await m.db.listCollections().toArray()).map((c) => c.name);
    for (const t of Object.keys(EXCLUDED_TABLES)) expect(names).not.toContain(t);
  });

  it("can run again without duplicating anything", async () => {
    const m = await connectAll();
    // A snapshot, as in production: the live test server's timers (telemetry) may write between the two runs.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-mig-")), "snapshot.sqlite");
    await h.ctx.db.backup(file);
    const source = openDatabase(file);
    const tables = describeTables(source);
    const first = await migrateToMongo(source, m, tables);
    const second = await migrateToMongo(source, m, tables);
    source.close();
    expect(second.map((r) => [r.table, r.destCount, r.destChecksum])).toEqual(first.map((r) => [r.table, r.destCount, r.destChecksum]));
    expect(second.every((r) => r.ok)).toBe(true);
  });

  it("resumes after an interruption from its checkpoint", async () => {
    const m = await connectAll();
    const queue = describeTables(h.ctx.db).filter((t) => t.name === "delivery_queue");
    let batches = 0;
    await expect(
      migrateToMongo(h.ctx.db, m, queue, {
        batchSize: 2,
        onProgress: () => {
          if (++batches === 2) throw new Error("power cut");
        },
      }),
    ).rejects.toThrow("power cut");
    const cp = await m.db.collection<{ _id: string }>("orbit_meta").findOne({ _id: "migration:delivery_queue" });
    expect(cp).toMatchObject({ copied: 4, finishedAt: null });
    expect((await verify(h.ctx.db, m, queue))[0].ok).toBe(false);
    const [r] = await migrateToMongo(h.ctx.db, m, queue, { batchSize: 2 });
    expect(r).toMatchObject({ ok: true, missing: 0, extra: 0 });
  });

  it("notices rows deleted since the copy and prunes them on request", async () => {
    const m = await connectAll();
    const blocks = describeTables(h.ctx.db).filter((t) => t.name === "user_blocks");
    h.ctx.db.prepare("INSERT INTO user_blocks (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)").run(alice.userId, bob.userId, 1);
    await migrateToMongo(h.ctx.db, m, blocks);
    h.ctx.db.prepare("DELETE FROM user_blocks WHERE user_id = ?").run(alice.userId);
    expect((await verify(h.ctx.db, m, blocks))[0]).toMatchObject({ ok: false, extra: 1, missing: 0 });
    expect((await migrateToMongo(h.ctx.db, m, blocks, { prune: true }))[0]).toMatchObject({ ok: true, extra: 0 });
  });

  it("detects content that changed on one side", async () => {
    const m = await connectAll();
    const orgs = describeTables(h.ctx.db).filter((t) => t.name === "orgs");
    await migrateToMongo(h.ctx.db, m, orgs);
    await m.db.collection("orgs").updateOne({}, { $set: { name: "Tampered" } });
    expect((await verify(h.ctx.db, m, orgs))[0]).toMatchObject({ ok: false, differing: 1 });
  });
});

describe("rollback (MongoDB back to SQLite)", HEAVY, () => {
  it("restores the domain's tables, including writes made after the cutover", async () => {
    const dbName = testDbName("rb");
    const m = await MeldiqMongo.connect(cfg(dbName), domainTables(["preferences"]));
    opened.push(m);
    const tables = domainTables(["preferences"]);
    await migrateToMongo(h.ctx.db, m, tables);
    // After the cutover a new preference was written to MongoDB only.
    await m.db.collection("nav_preferences").insertOne({
      _id: { user_id: bob.userId, workspace_id: "personal" } as never, user_id: bob.userId, workspace_id: "personal",
      doc: { starred: [], sections: [], collapsed: ["dms"], notify: {} }, rev: 1, updated_at: 5,
    });
    const reports = await exportToSqlite(m, h.ctx.db, tables);
    expect(reports[0]).toMatchObject({ ok: true, sourceCount: 2 });
    const back = h.ctx.db.prepare("SELECT doc FROM nav_preferences WHERE user_id = ? AND workspace_id = 'personal'").get(bob.userId) as { doc: string };
    expect(JSON.parse(back.doc).collapsed).toEqual(["dms"]);
  });

  it("refuses a restore that would leave broken references, and changes nothing", async () => {
    const m = await MeldiqMongo.connect(cfg(testDbName("rb")), domainTables(["preferences"]));
    opened.push(m);
    const tables = domainTables(["preferences"]);
    await migrateToMongo(h.ctx.db, m, tables);
    await m.db.collection("nav_preferences").insertOne({
      _id: { user_id: "u_nobody", workspace_id: "personal" } as never, user_id: "u_nobody", workspace_id: "personal",
      doc: { starred: [], sections: [], collapsed: [], notify: {} }, rev: 1, updated_at: 5,
    });
    const before = (h.ctx.db.prepare("SELECT COUNT(*) n FROM nav_preferences").get() as { n: number }).n;
    await expect(exportToSqlite(m, h.ctx.db, tables)).rejects.toThrow(/broken reference/);
    expect((h.ctx.db.prepare("SELECT COUNT(*) n FROM nav_preferences").get() as { n: number }).n).toBe(before);
  });
});

describe("authority guards", () => {
  it("refuses to use MongoDB for a domain whose rows are still only in SQLite, then accepts it once migrated", async () => {
    const config = cfg(testDbName("auth"), ["preferences"]);
    await expect(openMongo(config, h.ctx.db)).rejects.toThrow(/still only in SQLite/);
    const m = await MeldiqMongo.connect(config, domainTables(["preferences"]));
    opened.push(m);
    await migrateToMongo(h.ctx.db, m, domainTables(["preferences"]));
    await setAuthority(m, "preferences", "mongodb", "test");
    const ok = await openMongo(config, h.ctx.db);
    expect(await authorityOf(ok, "preferences")).toBe("mongodb");
    await ok.close();
    // Starting without the domain now would use SQLite's stale copy: refused.
    await expect(openMongo({ ...config, domains: new Set() }, h.ctx.db)).rejects.toThrow(/mongo-rollback/);
  });
});

describe("server with preferences in MongoDB", () => {
  it("keeps them in MongoDB only and reports MongoDB in its health check", async () => {
    const s = await startServer({ MONGODB_DOMAINS: "preferences" });
    try {
      expect(s.ctx.prefs.backend).toBe("mongodb");
      const c = await s.client("carol");
      await c.req("PUT", "/v1/me/preferences/personal", { baseRev: 0, prefs: { collapsed: ["dms"] } });
      const doc = await raw.db(s.ctx.config.mongo!.dbName).collection("nav_preferences").findOne({ user_id: c.userId });
      expect(doc).toMatchObject({ rev: 1, doc: { collapsed: ["dms"] } });
      expect((s.ctx.db.prepare("SELECT COUNT(*) n FROM nav_preferences").get() as { n: number }).n).toBe(0);
      const health = await (await fetch(`${s.baseUrl}/healthz`)).json();
      expect(health).toMatchObject({ ok: true, mongodb: true });
    } finally {
      await s.close();
    }
  });
});

describe("configuration", () => {
  const int = (_n: string, d: number) => d;
  it("needs TLS for a remote production database and never shows the password", () => {
    expect(() => mongoConfig({ MONGODB_URI: "mongodb://orbit:placeholder-not-a-password@db.example.com:27017/" }, "production", int)).toThrow(/TLS/);
    expect(() => mongoConfig({ MONGODB_URI: "mongodb://orbit:placeholder-not-a-password@db.example.com:27017/" }, "production", int)).not.toThrow(/placeholder-not-a-password/);
    expect(mongoConfig({ MONGODB_URI: "mongodb+srv://orbit:placeholder-not-a-password@cluster0.example.net/" }, "production", int)).not.toBeNull();
    expect(mongoConfig({ MONGODB_URI: "mongodb://127.0.0.1:27017/" }, "production", int)).not.toBeNull();
    expect(redactUri("mongodb+srv://orbit:placeholder-not-a-password@cluster0.example.net/")).toBe("mongodb+srv://orbit:***@cluster0.example.net/");
  });

  it("rejects unknown domains and domains without a database", () => {
    expect(() => mongoConfig({ MONGODB_URI: "mongodb://127.0.0.1/", MONGODB_DOMAINS: "messages" }, "development", int)).toThrow(/unknown domain/);
    expect(() => mongoConfig({ MONGODB_DOMAINS: "accounts" }, "development", int)).toThrow(/needs MONGODB_URI/);
    expect(mongoConfig({}, "development", int)).toBeNull();
  });
});
