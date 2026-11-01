import { MongoFileStore } from "../src/modules/files/mongoStore.js";
import { migrationTarget } from "./support/migration.js";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeTables } from "../src/infrastructure/database/mongo/catalog.js";
import { migrateToMongo } from "../src/infrastructure/database/mongo/migrate.js";
import { runCleanup } from "../src/modules/administration/jobs.js";
import type { UploadRow } from "../src/modules/files/store.js";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * The files module's records in MongoDB (MONGODB_DOMAINS files, src/modules/files/mongoStore.ts): files are recorded,
 * served, kept and counted there; completing an upload and expiring it can't both win; deleting a conversation takes
 * its files; retention removes expired ones and their bytes; and a migrated SQLite copy is what the store reads.
 */
let h: Harness;
let alice: GriipClient, bob: GriipClient;
let dm: string;
const upload = (c: GriipClient, conv: string, bytes: Buffer) => c.req("POST", `/v1/attachments?conversationId=${conv}`, undefined, bytes);

beforeAll(async () => {
  h = await startServer({ MONGODB_DOMAINS: "files" });
  alice = await h.client("filesalice");
  bob = await h.client("filesbob");
  dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
});
afterAll(async () => h.close());

describe("files in MongoDB", () => {
  it("are served from MongoDB", () => {
    expect(h.ctx.files.backend).toBe("mongodb");
  });

  it("records an upload there, serves it to members and counts it for its uploader", async () => {
    const bytes = crypto.randomBytes(3000);
    const a = await upload(alice, dm, bytes);
    expect(await h.ctx.mongo!.db.collection("attachments").countDocuments({ _id: a.id })).toBe(1);
    expect(Buffer.compare(await bob.req("GET", `/v1/attachments/${a.id}`), bytes)).toBe(0);
    expect(await h.ctx.files.storedUsage({ uploaders: [alice.userId], liveAt: Date.now() })).toEqual({ count: 1, bytes: 3000 });
    expect(await bob.req("POST", `/v1/attachments/${a.id}/keep`)).toMatchObject({ kept: true });
    expect((await h.ctx.files.storedUsage({ uploaders: [alice.userId], kept: true })).count).toBe(1);
  });

  it("lets exactly one of completing an upload and expiring it win", async () => {
    const t = Date.now();
    const row: UploadRow = {
      id: `a_${crypto.randomBytes(8).toString("hex")}`,
      user_id: alice.userId,
      device_id: alice.deviceId,
      conversation_id: dm,
      size: 10,
      sha256: "x".repeat(43) + "=",
      multipart_id: null,
      part_size: null,
      created_at: t,
      expires_at: t + 60_000,
    };
    await h.ctx.files.startUpload(row);
    const attachment = { id: row.id, conversation_id: dm, uploader_user_id: alice.userId, size: 10, created_at: t, expires_at: t + 60_000 };
    const results = await Promise.all([h.ctx.files.completeUpload(row.id, attachment), h.ctx.files.completeUpload(row.id, attachment)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await h.ctx.files.upload(row.id)).toBeNull();
    expect(await h.ctx.files.attachment(row.id)).toMatchObject({ id: row.id, kept: 0 });
  });

  it("removes expired files and schedules their bytes with the retention job", async () => {
    const a = await upload(alice, dm, crypto.randomBytes(100));
    await h.ctx.mongo!.db.collection("attachments").updateOne({ _id: a.id as never }, { $set: { expires_at: 1 } });
    const r = await runCleanup(h.ctx);
    expect(r.attachments).toBeGreaterThan(0);
    expect(await h.ctx.files.attachment(a.id)).toBeNull();
    expect(await h.ctx.mongo!.db.collection("pending_blob_deletes").countDocuments({ blob_id: a.id })).toBe(0); // deleted in the same run
  });

  it("takes a deleted conversation's files with it", async () => {
    const group = (await alice.req("POST", "/v1/conversations/group", { name: "Files", memberIds: [bob.userId] })).conversation.id;
    const a = await upload(alice, group, crypto.randomBytes(50));
    h.ctx.files.forgetConversation(group);
    await h.ctx.files.settled();
    expect(await h.ctx.files.attachment(a.id)).toBeNull();
    expect((await h.ctx.files.dueBlobDeletes(Date.now(), 100)).map((d) => d.blob_id)).toContain(a.id);
  });
});

describe("moving files from SQLite", () => {
  it("serves what the migration copied", async () => {
    const old = await startServer({ MONGODB_DOMAINS: "" });
    const target = await migrationTarget();
    const targetStore = new MongoFileStore(target.mongo, old.app.log);
    try {
      const a = await old.client("fmovea");
      const b = await old.client("fmoveb");
      const conv = (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id;
      const stored = await upload(a, conv, crypto.randomBytes(500));
      const tables = describeTables(old.ctx.db).filter((t) => t.domain === "files");
      await target.mongo.ensureSchema(tables);
      expect(tables.map((t) => t.name).sort()).toEqual(["abandoned_uploads", "attachment_uploads", "attachments", "pending_blob_deletes"]);
      for (const r of await migrateToMongo(old.ctx.db, target.mongo, tables)) {
        expect(r, r.table).toMatchObject({ ok: true, missing: 0, extra: 0, differing: 0 });
      }
      expect(await targetStore.attachment(stored.id)).toMatchObject({ id: stored.id, size: 500, uploader_user_id: a.userId, kept: 0 });
    } finally {
      await old.close();
      await target.close();
    }
  });
});
