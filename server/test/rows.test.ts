import { afterAll, describe, expect, inject, it } from "vitest";
import { openDatabase, type DB } from "../src/infrastructure/database/db.js";
import { describeTables, type TableSpec } from "../src/infrastructure/database/mongo/catalog.js";
import { MeldiqMongo } from "../src/infrastructure/database/mongo/client.js";
import { mongoConfig } from "../src/infrastructure/database/mongo/config.js";
import { MongoRows, type Rows, SqliteRows } from "../src/infrastructure/database/rows/index.js";
import { testDbName } from "./support/mongo.js";

/**
 * Rows (src/infrastructure/database/rows): the same behaviour on SQLite and on MongoDB with its in-memory copy, run on
 * the real schema of the workspace and conversation tables. SQLite is the reference; MongoDB must match it.
 */
const uri = inject("mongoUri");
const opened: MeldiqMongo[] = [];
afterAll(async () => {
  for (const m of opened) {
    await m.db.dropDatabase().catch(() => undefined);
    await m.close();
  }
});

const T = 1_700_000_000_000;

function schema(): { db: DB; specs: TableSpec[] } {
  const db = openDatabase(":memory:");
  // Users live in another domain (identity): SQLite's foreign keys need them to exist.
  const user = db.prepare("INSERT INTO users (id, username, display_name, identity_key, created_at, updated_at) VALUES (?, ?, ?, 'k', ?, ?)");
  for (const u of ["u1", "u2", "u3"]) user.run(u, u, u.toUpperCase(), T, T);
  const specs = describeTables(db).filter((t) => t.domain === "workspace" || t.domain === "conversations");
  return { db, specs };
}

const backends: [string, () => Promise<{ rows: Rows; reopen?: () => Promise<Rows> }>][] = [
  [
    "sqlite",
    async () => {
      const { db, specs } = schema();
      return { rows: new SqliteRows(db, specs) };
    },
  ],
  [
    "mongodb",
    async () => {
      const { specs } = schema();
      const cfg = mongoConfig({ MONGODB_URI: uri, MONGODB_DB: testDbName("rows") }, "development", (_n, d) => d)!;
      const mongo = await MeldiqMongo.connect(cfg, specs);
      opened.push(mongo);
      return { rows: await MongoRows.open(mongo, specs), reopen: () => MongoRows.open(mongo, specs) };
    },
  ],
];

const org = (id: string, slug: string) => ({ id, name: id.toUpperCase(), slug, created_by: "u1", created_at: T, updated_at: T });
const channel = (id: string, orgId: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  type: "CHANNEL",
  org_id: orgId,
  name: id,
  created_by: "u1",
  created_at: T,
  updated_at: T,
  ...extra,
});

describe.each(backends)("rows on %s", (_name, make) => {
  it("inserts with the columns' defaults and reads back", async () => {
    const { rows } = await make();
    await rows.write((w) => w.insert("orgs", org("o1", "acme")));
    expect(rows.get("orgs", { id: "o1" })).toMatchObject({ id: "o1", kind: "team", visibility: "private", guests_allowed: 1, ai_enabled: 0, description: null });
    expect(rows.count("orgs")).toBe(1);
    expect(rows.get("orgs", { id: "nope" })).toBeUndefined();
  });

  it("follows SQL's semantics for NULL, ne, in, notIn, ranges, $or, order and limit", async () => {
    const { rows } = await make();
    await rows.write((w) => {
      w.insert("orgs", org("o1", "acme"));
      w.insert("conversations", channel("c1", "o1", { topic: "a", position: 3 }));
      w.insert("conversations", channel("c2", "o1", { topic: null, position: 1 }));
      w.insert("conversations", channel("c3", null, { type: "GROUP", topic: "b", position: 2 }));
    });
    const ids = (q: Parameters<Rows["all"]>[1]) => rows.all<{ id: string }>("conversations", q).map((r) => r.id);
    expect(ids({ where: { topic: null } })).toEqual(["c2"]);
    expect(ids({ where: { topic: { ne: "a" } }, orderBy: [["id", "asc"]] })).toEqual(["c3"]); // NULL is not "not a"
    expect(ids({ where: { topic: { ne: null } }, orderBy: [["id", "asc"]] })).toEqual(["c1", "c3"]);
    expect(ids({ where: { org_id: { in: ["o1", null] } }, orderBy: [["id", "asc"]] })).toEqual(["c1", "c2"]); // NULL never IN
    expect(ids({ where: { org_id: { notIn: ["zz"] } }, orderBy: [["id", "asc"]] })).toEqual(["c1", "c2"]); // nor NOT IN
    expect(ids({ where: { id: { in: [] } } })).toEqual([]);
    expect(ids({ where: { position: { gte: 2 } }, orderBy: [["position", "asc"]] })).toEqual(["c3", "c1"]);
    expect(ids({ where: { $or: [{ type: "GROUP" }, { position: 1 }] }, orderBy: [["id", "asc"]] })).toEqual(["c2", "c3"]);
    expect(ids({ orderBy: [["topic", "asc"]] })).toEqual(["c2", "c1", "c3"]); // NULLs first
    expect(ids({ orderBy: [["topic", "desc"]], limit: 2 })).toEqual(["c3", "c1"]);
    expect(rows.get<{ id: string }>("conversations", { org_id: "o1" }, [["position", "desc"]])!.id).toBe("c1");
    expect(rows.count("conversations", { org_id: "o1", topic: { ne: null } })).toBe(1);
  });

  it("keeps a NOCASE unique column unique whatever the case, and finds it in any case", async () => {
    const { rows } = await make();
    await rows.write((w) => w.insert("orgs", org("o1", "Acme")));
    await expect(rows.write((w) => w.insert("orgs", org("o2", "acme")))).rejects.toThrow(/UNIQUE constraint failed/);
    expect(rows.get<{ id: string }>("orgs", { slug: "ACME" })!.id).toBe("o1");
    expect(rows.count("orgs")).toBe(1);
  });

  it("ignores a conflicting insert with orIgnore, and upserts", async () => {
    const { rows } = await make();
    await rows.write((w) => w.insert("orgs", org("o1", "acme")));
    const r = await rows.write((w) => {
      w.insert("org_members", { org_id: "o1", user_id: "u1", role: "OWNER", joined_at: T });
      return w.insert("org_members", { org_id: "o1", user_id: "u1", role: "MEMBER", joined_at: T }, { orIgnore: true });
    });
    expect(r.inserted).toBe(false);
    expect(rows.get("org_members", { org_id: "o1", user_id: "u1" })).toMatchObject({ role: "OWNER" });
    await rows.write((w) => w.upsert("org_members", { org_id: "o1", user_id: "u1", role: "MEMBER", joined_at: T + 1 }, { role: "ADMIN" }));
    expect(rows.get("org_members", { org_id: "o1", user_id: "u1" })).toMatchObject({ role: "ADMIN", joined_at: T });
    await rows.write((w) => w.upsert("org_members", { org_id: "o1", user_id: "u2", role: "MEMBER", joined_at: T }, { role: "ADMIN" }));
    expect(rows.get("org_members", { org_id: "o1", user_id: "u2" })).toMatchObject({ role: "MEMBER" });
    await rows.write((w) => w.upsert("org_members", { org_id: "o1", user_id: "u2", role: "GUEST", joined_at: T + 5 }, "replace"));
    expect(rows.get("org_members", { org_id: "o1", user_id: "u2" })).toMatchObject({ role: "GUEST", joined_at: T + 5 });
  });

  it("updates and deletes, reporting how many rows", async () => {
    const { rows } = await make();
    const n = await rows.write((w) => {
      w.insert("orgs", org("o1", "acme"));
      for (const c of ["c1", "c2", "c3"]) w.insert("conversations", channel(c, "o1"));
      return w.update("conversations", { id: { in: ["c1", "c2"] } }, { topic: "t" });
    });
    expect(n).toBe(2);
    expect(rows.count("conversations", { topic: "t" })).toBe(2);
    expect(await rows.write((w) => w.delete("conversations", { topic: "t" }))).toBe(2);
    expect(rows.all("conversations").length).toBe(1);
  });

  it("applies ON DELETE CASCADE and SET NULL, through composite keys too", async () => {
    const { rows } = await make();
    await rows.write((w) => {
      w.insert("orgs", org("o1", "acme"));
      w.insert("org_members", { org_id: "o1", user_id: "u1", role: "OWNER", joined_at: T });
      w.insert("org_members", { org_id: "o1", user_id: "u2", role: "MEMBER", joined_at: T });
      w.insert("org_roles", { id: "r1", org_id: "o1", name: "Mods", permissions: "[]", denies: "[]", position: 1, rev: 1, created_by: "u1", created_at: T, updated_at: T });
      w.insert("org_role_members", { role_id: "r1", org_id: "o1", user_id: "u2", assigned_by: "u1", assigned_at: T });
      w.insert("channel_categories", { id: "cat1", org_id: "o1", name: "Cat", position: 0, created_by: "u1", created_at: T, updated_at: T });
      w.insert("conversations", channel("c1", "o1", { category_id: "cat1" }));
      w.insert("conversation_members", { conversation_id: "c1", user_id: "u2", role: "MEMBER", joined_at: T });
    });
    // A member leaves: their role assignment goes with their membership (composite key).
    await rows.write((w) => w.delete("org_members", { org_id: "o1", user_id: "u2" }));
    expect(rows.count("org_role_members")).toBe(0);
    // A category goes: its channels stay, uncategorised.
    await rows.write((w) => w.delete("channel_categories", { id: "cat1" }));
    expect(rows.get("conversations", { id: "c1" })).toMatchObject({ category_id: null });
    // The organisation goes: members, roles, channels and their members with it.
    await rows.write((w) => w.delete("orgs", { id: "o1" }));
    for (const t of ["org_members", "org_roles", "conversations", "conversation_members"]) expect([t, rows.count(t)]).toEqual([t, 0]);
  });

  it("refuses a row whose parent in the same rows doesn't exist", async () => {
    const { rows } = await make();
    await expect(rows.write((w) => w.insert("conversation_members", { conversation_id: "missing", user_id: "u1", role: "MEMBER", joined_at: T }))).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  it("applies a unit entirely or not at all, and lets the unit read its own writes", async () => {
    const { rows } = await make();
    let seen = -1;
    await expect(
      rows.write((w) => {
        w.insert("orgs", org("o1", "acme"));
        seen = w.count("orgs") + rows.count("orgs"); // through the writer and through the rows: both see it
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");
    expect(seen).toBe(2);
    expect(rows.count("orgs")).toBe(0);
    // A nested unit that fails is undone alone (a SQLite savepoint).
    await rows.write((w) => {
      w.insert("orgs", org("o1", "acme"));
      rows
        .write((inner) => {
          inner.insert("orgs", org("o2", "beta"));
          throw new Error("inner");
        })
        .catch(() => undefined);
    });
    expect(rows.all<{ id: string }>("orgs").map((o) => o.id)).toEqual(["o1"]);
  });

  it("hands out AUTOINCREMENT ids in order and never again, and keeps rowid tables", async () => {
    const { rows } = await make();
    const a = await rows.write((w) => w.insert("audit_log", { at: T, action: "a" }));
    const b = await rows.write((w) => w.insert("audit_log", { at: T, action: "b" }));
    expect(b.id).toBe(a.id! + 1);
    await rows.write((w) => w.delete("audit_log", {}));
    const c = await rows.write((w) => w.insert("audit_log", { at: T, action: "c" }));
    expect(c.id).toBe(b.id! + 1);
    await rows.write((w) => {
      w.insert("orgs", org("o1", "acme"));
      w.insert("conversations", channel("c1", "o1"));
      w.insert("mention_all_events", { conversation_id: "c1", user_id: "u1", message_id: "m1", at: T });
      w.insert("mention_all_events", { conversation_id: "c1", user_id: "u1", message_id: "m2", at: T });
    });
    expect(rows.count("mention_all_events", { conversation_id: "c1" })).toBe(2);
    expect(await rows.write((w) => w.delete("mention_all_events", { message_id: "m1" }))).toBe(1);
  });

  it("runs units one after another: a failing one doesn't take the next with it", async () => {
    const { rows } = await make();
    await rows.write((w) => w.insert("orgs", org("o1", "acme")));
    const results = await Promise.allSettled([
      rows.write((w) => w.insert("orgs", org("o2", "beta"))),
      rows.write((w) => w.insert("orgs", org("o3", "BETA"))), // same slug, other case
      rows.write((w) => w.update("orgs", { id: "o2" }, { name: "Beta 2" })),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(rows.get("orgs", { id: "o2" })).toMatchObject({ name: "Beta 2" });
  });

  it("returns copies: changing a row read doesn't change the rows", async () => {
    const { rows } = await make();
    await rows.write((w) => w.insert("orgs", org("o1", "acme")));
    const r = rows.get<{ name: string }>("orgs", { id: "o1" })!;
    r.name = "changed";
    expect(rows.get("orgs", { id: "o1" })).toMatchObject({ name: "O1" });
  });

  it("keeps everything across a restart (MongoDB: loaded again from the collections)", async () => {
    const { rows, reopen } = await make();
    if (!reopen) return;
    await rows.write((w) => {
      w.insert("orgs", org("o1", "Acme"));
      w.insert("org_members", { org_id: "o1", user_id: "u1", role: "OWNER", joined_at: T });
      w.insert("audit_log", { at: T, action: "x" });
    });
    const last = rows.all<{ id: number }>("audit_log", { orderBy: [["id", "desc"]], limit: 1 })[0].id;
    await rows.write((w) => w.delete("audit_log", {}));
    const again = await reopen();
    expect(again.get("orgs", { slug: "acme" })).toMatchObject({ id: "o1", kind: "team" });
    expect(again.count("org_members", { org_id: "o1" })).toBe(1);
    const next = await again.write((w) => w.insert("audit_log", { at: T, action: "y" }));
    expect(next.id).toBe(last + 1); // the counter survives even with no rows left
  });
});
