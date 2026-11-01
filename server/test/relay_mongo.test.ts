import { MongoRelayStore } from "../src/modules/messaging/relay/mongoStore.js";
import { migrationTarget } from "./support/migration.js";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeTables } from "../src/infrastructure/database/mongo/catalog.js";
import { migrateToMongo } from "../src/infrastructure/database/mongo/migrate.js";
import { runCleanup } from "../src/modules/administration/jobs.js";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * The message relay kept in MongoDB (MONGODB_DOMAINS relay, src/modules/messaging/relay/mongoStore.ts): a message id is
 * accepted once even when sent in parallel, queue ids keep growing above every id SQLite used, a migrated queue is
 * delivered with its ids, and retention empties it.
 */
let h: Harness;
let alice: GriipClient, bob: GriipClient;
let dm: string;

beforeAll(async () => {
  h = await startServer({ MONGODB_DOMAINS: "relay" });
  alice = await h.client("relayalice");
  bob = await h.client("relaybob");
  dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
});
afterAll(async () => h.close());

describe("relay in MongoDB", () => {
  it("is served from MongoDB", () => {
    expect(h.ctx.relay.backend).toBe("mongodb");
  });

  it("accepts a message id once when the same device sends it in parallel", async () => {
    const id = crypto.randomUUID();
    const answers = await Promise.all(Array.from({ length: 5 }, () => alice.send(dm, { type: "text", text: "once" }, "message", id)));
    expect(answers.filter((a) => !a.duplicate)).toHaveLength(1);
    expect(new Set(answers.map((a) => a.serverTs)).size).toBe(1);
    expect(await h.ctx.mongo!.db.collection("delivery_queue").countDocuments({ message_id: id, recipient_device_id: bob.deviceId })).toBe(1);
  });

  it("hands out growing ids, above the highest id SQLite ever used", async () => {
    const fresh = await startServer({ MONGODB_DOMAINS: "relay" });
    try {
      // As if this server ran on SQLite before: its queue numbered items up to 5000.
      fresh.ctx.db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('delivery_queue', 5000)").run();
      const a = await fresh.client("seqa");
      const b = await fresh.client("seqb");
      const conv = (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id;
      for (let i = 0; i < 3; i++) await a.send(conv, { type: "text", text: `n${i}` });
      const ids = (await b.req("GET", "/v1/queue")).items.map((i: { id: number }) => i.id);
      expect(ids).toHaveLength(3);
      expect(ids[0]).toBeGreaterThan(5000);
      expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    } finally {
      await fresh.close();
    }
  });

  it("empties expired items with the retention job", async () => {
    await h.ctx.mongo!.db.collection("delivery_queue").updateMany({ recipient_device_id: bob.deviceId }, { $set: { expires_at: 1 } });
    const r = await runCleanup(h.ctx);
    expect(r.queue).toBeGreaterThan(0);
    expect((await bob.req("GET", "/v1/queue")).items).toHaveLength(0);
  });
});

describe("moving the relay from SQLite", () => {
  it("delivers what the migration copied, with the same ids, and numbers new items after them", async () => {
    const old = await startServer({ MONGODB_DOMAINS: "" });
    const target = await migrationTarget();
    const targetStore = new MongoRelayStore(target.mongo, target.db, old.app.log);
    try {
      const a = await old.client("movea");
      const b = await old.client("moveb");
      const conv = (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id;
      for (let i = 0; i < 3; i++) await a.send(conv, { type: "text", text: `queued ${i}` });
      const before = (await b.req("GET", "/v1/queue")).items;
      expect(before).toHaveLength(3);
      const tables = describeTables(old.ctx.db).filter((t) => t.domain === "relay");
      await target.mongo.ensureSchema(tables);
      expect(tables.map((t) => t.name).sort()).toEqual(["delivery_queue", "submitted_messages"]);
      for (const r of await migrateToMongo(old.ctx.db, target.mongo, tables)) {
        expect(r, r.table).toMatchObject({ ok: true, missing: 0, extra: 0, differing: 0 });
      }
      const moved = await targetStore.backlog(b.deviceId, Date.now(), 10);
      expect(moved.map((r) => [r.id, r.payload])).toEqual(before.map((i: { id: number; payload: unknown }) => [i.id, JSON.stringify(i.payload)]));
      expect(await targetStore.submission(before[0].messageId)).toMatchObject({ sender_user_id: a.userId });
      const { id: _old, ...item } = moved[0];
      const next = await targetStore.enqueue([{ ...item, message_id: "after-move" }]);
      expect(next[0].id).toBeGreaterThan(Math.max(...moved.map((r) => r.id)));
    } finally {
      await old.close();
      await target.close();
    }
  });
});
