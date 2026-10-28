import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { describeTables } from "../src/infrastructure/database/mongo/catalog.js";
import { migrateToMongo } from "../src/infrastructure/database/mongo/migrate.js";
import { AccountClient, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Encrypted message history kept in MongoDB (MONGODB_DOMAINS history, docs/MONGODB.md): writes from one account never
 * interleave, history goes with an account deletion or an encryption reset, the retention job removes history a
 * deletion left behind, and the migration's copy is what the store reads.
 */
let h: Harness;
const mailer = new MemoryMailer();
const tag = () => crypto.randomBytes(18).toString("base64url");
const ct = (n = 64) => crypto.randomBytes(n).toString("base64");
const put = (c: AccountClient, n: number) => c.req("PUT", "/v1/history/items", { items: Array.from({ length: n }, () => ({ tag: tag(), conv: tag(), ts: Date.now(), body: ct() })) });

beforeAll(async () => {
  h = await startServer({ MONGODB_DOMAINS: "accounts,preferences,history" }, { mailer });
});
afterAll(async () => h.close());

describe("history in MongoDB", () => {
  it("is served from MongoDB", () => {
    expect(h.ctx.history.backend).toBe("mongodb");
  });

  it("keeps parallel writes from one account apart: every write gets its own cursor and the totals add up", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "parallel");
    await Promise.all(Array.from({ length: 10 }, () => put(c, 5)));
    expect(await c.req("GET", "/v1/history/summary")).toMatchObject({ items: 50, seq: 50, bytes: 50 * 64 });
    const page = await c.req("GET", "/v1/history/items?after=0&limit=1000");
    expect(page.items.map((i: { seq: number }) => i.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("goes with an encryption reset", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "reset");
    await put(c, 3);
    const lost = new AccountClient(h.baseUrl, c.email);
    await lost.signIn();
    await lost.req("POST", "/v2/account/identity/reset", await lost.deviceBody("register", { password: PASSWORD, identityKey: lost.identityKeyB64 }));
    expect(await h.ctx.history.account(c.userId)).toBeNull();
    expect(await h.ctx.mongo!.db.collection("history_items").countDocuments({ user_id: c.userId })).toBe(0);
  });

  it("goes with the account", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "leaving");
    await put(c, 2);
    await c.req("DELETE", "/v2/account", { password: PASSWORD, confirmEmail: c.email });
    expect(await h.ctx.mongo!.db.collection("history_items").countDocuments({ user_id: c.userId })).toBe(0);
  });

  it("is removed by retention when a deletion couldn't reach MongoDB", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "orphan");
    await put(c, 4);
    // As if the account was deleted while MongoDB was unreachable: SQLite says deleted, MongoDB still holds history.
    await h.ctx.identity.write((w) => w.update("users", { id: c.userId }, { deleted_at: 1 }));
    const kept = await AccountClient.ready(h.baseUrl, mailer, "kept");
    await put(kept, 1);
    await runCleanup(h.ctx);
    expect(await h.ctx.history.account(c.userId)).toBeNull();
    expect(await h.ctx.history.account(kept.userId)).toMatchObject({ items: 1 });
  });
});

describe("moving history from SQLite", () => {
  it("reads what the migration copied, ciphertext byte for byte", async () => {
    // A server still on SQLite, with history written through the API.
    const old = await startServer({ MONGODB_DOMAINS: "" }, { mailer });
    // An empty MongoDB database to move into (this suite's own already holds other tests' history).
    const target = await startServer({ MONGODB_DOMAINS: "history" }, { mailer });
    try {
      const c = await AccountClient.ready(old.baseUrl, mailer, "mover");
      const body = ct(100);
      await c.req("PUT", "/v1/history/items", { items: [{ tag: tag(), conv: tag(), ts: 5, body }] });
      await put(c, 2);
      // Copy the history tables, then read them through the MongoDB store.
      const tables = describeTables(old.ctx.db).filter((t) => t.domain === "history");
      const reports = await migrateToMongo(old.ctx.db, target.ctx.mongo!, tables);
      for (const r of reports) expect(r, r.table).toMatchObject({ ok: true, missing: 0, extra: 0, differing: 0 });
      expect(await target.ctx.history.account(c.userId)).toMatchObject({ items: 3, next_seq: 4 });
      const items = await target.ctx.history.items(c.userId, 0, 10);
      expect(items.map((i) => i.seq)).toEqual([1, 2, 3]);
      expect(items[0].body!.toString("base64")).toBe(body);
    } finally {
      await old.close();
      await target.close();
    }
  });
});
