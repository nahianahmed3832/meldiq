import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { KEPT_FOREVER } from "../src/modules/files/store.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

const tag = () => crypto.randomBytes(24).toString("base64url");
const ct = (n = 200) => crypto.randomBytes(n).toString("base64");

describe("encrypted message history", () => {
  let h: Harness;
  let alice: GriipClient, bob: GriipClient;
  beforeAll(async () => {
    h = await startServer({ HISTORY_MAX_ITEMS_PER_USER: "50", HISTORY_MAX_BYTES_PER_USER: String(200 * 1024), HISTORY_MAX_ITEM_BYTES: "8192" });
    alice = await h.client("alice");
    bob = await h.client("bob");
  });
  afterAll(async () => h.close());

  it("stores opaque items and returns them in write order, paged, to the same account only", async () => {
    const conv = tag();
    const items = Array.from({ length: 7 }, (_, i) => ({ tag: tag(), conv, ts: 1000 + i, body: ct() }));
    const put = await alice.req("PUT", "/v1/history/items", { items });
    expect(put).toMatchObject({ seq: 7, items: 7 });
    const p1 = await alice.req("GET", "/v1/history/items?after=0&limit=4");
    expect(p1.items.map((i: any) => i.tag)).toEqual(items.slice(0, 4).map((i) => i.tag));
    expect(p1.more).toBe(true);
    const p2 = await alice.req("GET", `/v1/history/items?after=${p1.next}&limit=4`);
    expect(p2.items.map((i: any) => i.tag)).toEqual(items.slice(4).map((i) => i.tag));
    expect(p2.more).toBe(false);
    expect(p2.items[0].body).toBe(items[4].body);
    // Another account sees nothing of it.
    expect((await bob.req("GET", "/v1/history/items?after=0")).items).toEqual([]);
    expect((await bob.req("GET", "/v1/history/summary")).items).toBe(0);
  });

  it("a replaced or deleted item moves to the end, so other devices catching up see the change", async () => {
    const t1 = tag();
    const conv = tag();
    await alice.req("PUT", "/v1/history/items", { items: [{ tag: t1, conv, ts: 1, body: ct() }] });
    const before = (await alice.req("GET", "/v1/history/summary")).seq;
    const edited = ct(300);
    await alice.req("PUT", "/v1/history/items", { items: [{ tag: t1, conv, ts: 1, body: edited }] });
    let after = await alice.req("GET", `/v1/history/items?after=${before}`);
    expect(after.items).toHaveLength(1);
    expect(after.items[0].body).toBe(edited);
    await alice.req("PUT", "/v1/history/items", { items: [{ tag: t1, conv, ts: 1, body: null }] });
    after = await alice.req("GET", `/v1/history/items?after=${after.next}`);
    expect(after.items[0]).toMatchObject({ tag: t1, body: null });
    // Deletion markers are pruned after HISTORY_TOMBSTONE_DAYS (aged in whichever store holds history).
    if (h.ctx.postgres) await h.ctx.postgres.database.query("UPDATE meldiq.history_items SET updated_at = 0 WHERE body IS NULL");
    else if (h.ctx.history.backend === "mongodb") await h.ctx.mongo!.db.collection("history_items").updateMany({ body: null }, { $set: { updated_at: 0 } });
    else h.ctx.db.prepare("UPDATE history_items SET updated_at = 0 WHERE body IS NULL").run();
    expect((await runCleanup(h.ctx)).historyTombstones).toBeGreaterThanOrEqual(1);
  });

  it("enforces per-item size, batch size and the account quota (all or nothing)", async () => {
    await expectStatus(alice.req("PUT", "/v1/history/items", { items: [{ tag: tag(), conv: tag(), ts: 1, body: ct(9000) }] }), 400);
    await expectStatus(alice.req("PUT", "/v1/history/items", { items: [{ tag: "short", conv: tag(), ts: 1, body: ct() }] }), 400);
    await expectStatus(alice.req("PUT", "/v1/history/items", { items: [] }), 400);
    const before = await alice.req("GET", "/v1/history/summary");
    const tooMany = Array.from({ length: 60 }, () => ({ tag: tag(), conv: tag(), ts: 1, body: ct(10) }));
    await expectStatus(alice.req("PUT", "/v1/history/items", { items: tooMany }), 429);
    expect(await alice.req("GET", "/v1/history/summary")).toEqual(before);
  });

  it("the person can delete their whole history from the server", async () => {
    const r = await alice.req("DELETE", "/v1/history");
    expect(r.deleted).toBeGreaterThan(0);
    expect(await alice.req("GET", "/v1/history/summary")).toMatchObject({ items: 0, bytes: 0, seq: 0 });
    expect((await alice.req("GET", "/v1/history/items?after=0")).items).toEqual([]);
  });

  it("a server can turn history off", async () => {
    const off = await startServer({ HISTORY_ENABLED: "false" });
    const c = await off.client("carol");
    await expectStatus(c.req("PUT", "/v1/history/items", { items: [{ tag: tag(), conv: tag(), ts: 1, body: ct() }] }), 403);
    expect((await c.req("GET", "/v1/history/summary")).enabled).toBe(false);
    expect((await c.req("GET", "/v1/server-info")).features).not.toContain("history");
    await off.close();
  });
});

describe("keeping files for history", () => {
  let h: Harness;
  let alice: GriipClient, bob: GriipClient, eve: GriipClient;
  let dm: string;
  beforeAll(async () => {
    h = await startServer({ ATTACHMENT_USER_KEPT_BYTES: "30000", ATTACHMENT_USER_STORED_BYTES: "50000" });
    alice = await h.client("alice");
    bob = await h.client("bob");
    eve = await h.client("eve");
    dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  });
  afterAll(async () => h.close());

  it("a member keeps a file beyond the 7-day window; outsiders can't", async () => {
    const up = await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, crypto.randomBytes(10_000));
    await expectStatus(eve.req("POST", `/v1/attachments/${up.id}/keep`), 404);
    const k = await bob.req("POST", `/v1/attachments/${up.id}/keep`);
    expect(k.kept).toBe(true);
    expect(k.expiresAt).toBeGreaterThan(Date.now() + 300 * 86_400_000);
    // Still there after the relay window would have passed.
    await runCleanup(h.ctx);
    expect((await bob.req("GET", `/v1/attachments/${up.id}`)).length).toBe(10_000);
  });

  it("kept files have their own quota and don't use up the 7-day one", async () => {
    // 10 kB kept already; 45 kB more in the 7-day window fits only because kept files aren't counted there.
    const a = await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, crypto.randomBytes(22_000));
    await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, crypto.randomBytes(23_000));
    // Keeping 22 kB more would take kept files past 30 kB.
    await expectStatus(bob.req("POST", `/v1/attachments/${a.id}/keep`), 429);
  });

  it("a server that keeps no files says so", async () => {
    const s = await startServer({ ATTACHMENT_KEEP_DAYS: "0", ATTACHMENT_KEEP_FOREVER: "false" });
    const x = await s.client("xavier");
    const y = await s.client("yasmin");
    const c = (await x.req("POST", "/v1/conversations/dm", { userId: y.userId })).conversation.id;
    const up = await x.req("POST", `/v1/attachments?conversationId=${c}`, undefined, crypto.randomBytes(100));
    expect((await y.req("POST", `/v1/attachments/${up.id}/keep`)).kept).toBe(false);
    expect((await x.req("GET", "/v1/server-info")).features).not.toContain("attachment-keep");
    await s.close();
  });

  it("server-info lists what this server supports", async () => {
    const info = await alice.req("GET", "/v1/server-info");
    expect(info.features).toEqual(expect.arrayContaining(["profiles", "profile-photos", "history", "attachment-keep", "org-delete"]));
    expect(JSON.stringify(info)).not.toMatch(/s3|bucket|aws/i);
  });
});

describe("keeping every file for good (ATTACHMENT_KEEP_FOREVER, the default since API 0.66.0)", () => {
  it("never expires a new upload, keeps files stored before the setting, and keeps what the retention job sees", async () => {
    const s = await startServer({});
    try {
      const x = await s.client("forevera");
      const y = await s.client("foreverb");
      const c = (await x.req("POST", "/v1/conversations/dm", { userId: y.userId })).conversation.id;
      const up = await x.req("POST", `/v1/attachments?conversationId=${c}`, undefined, crypto.randomBytes(500));
      expect(up.expiresAt).toBe(KEPT_FOREVER);
      // A file from before the setting, due to expire in a minute, becomes kept for good on the next retention run.
      const old = await x.req("POST", `/v1/attachments?conversationId=${c}`, undefined, crypto.randomBytes(300));
      await s.ctx.files.keep(old.id, Date.now() + 60_000);
      await runCleanup(s.ctx);
      expect((await s.ctx.files.attachment(old.id))!.expires_at).toBe(KEPT_FOREVER);
      // Nothing is purged, even long after the relay window would have passed.
      expect(await s.ctx.files.purgeExpired(Date.now() + 400 * 86_400_000)).toEqual([]);
      expect((await y.req("GET", `/v1/attachments/${up.id}`)).length).toBe(500);
      expect(await y.req("POST", `/v1/attachments/${up.id}/keep`)).toMatchObject({ kept: true, expiresAt: KEPT_FOREVER });
    } finally {
      await s.close();
    }
  });
});
