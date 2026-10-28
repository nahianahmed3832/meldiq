import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QuotaEngine, type Scope, scopesFor } from "../src/modules/quotas/index.js";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { tableSpecs } from "../src/infrastructure/database/mongo/catalog.js";
import { SqliteRows } from "../src/infrastructure/database/rows/index.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * The unified quota engine (docs/QUOTAS.md): resolution order, every scope having to pass, hard ceilings, temporary
 * exceptions, modes, atomic reservations, settlement, expiry and period boundaries; then the real enforcement points
 * (uploads, downloads, realtime connections) with nothing changing while no policy exists.
 */

const ME: Scope = { type: "user", id: "u1" };
const ORG: Scope = { type: "org", id: "o1" };
const ALL: Scope = { type: "global", id: "" };

function engineAt(t: { now: number }) {
  const db = openDatabase(":memory:");
  const rows = new SqliteRows(db, tableSpecs().filter((s) => s.domain === "platform"));
  return { db, q: new QuotaEngine(rows, () => t.now) };
}

const policy = (scopeType: any, scopeId: string, limit: number | null, mode: any = "block", extra: object = {}) => ({ scopeType, scopeId, key: "files.upload_bytes" as const, limit, mode, reason: "test policy", ...extra });

describe("resolution", () => {
  it("prefers override > own > plan > default, and ignores expired overrides", async () => {
    const t = { now: Date.now() };
    const { db, q } = engineAt(t);
    await q.setPolicy(policy("global", "default:user", 1000), "admin");
    expect(q.effective("files.upload_bytes", ME)).toMatchObject({ source: "default", limit: 1000 });
    db.prepare("INSERT INTO quota_plans (id, name, created_by, created_at) VALUES ('p1', 'Team', 'admin', 0)").run();
    db.prepare("INSERT INTO quota_plan_members (scope_type, scope_id, plan_id, assigned_by, assigned_at) VALUES ('user', 'u1', 'p1', 'admin', 0)").run();
    await q.setPolicy(policy("plan", "p1", 2000), "admin");
    expect(q.effective("files.upload_bytes", ME)).toMatchObject({ source: "plan", limit: 2000 });
    await q.setPolicy(policy("user", "u1", 3000), "admin");
    expect(q.effective("files.upload_bytes", ME)).toMatchObject({ source: "own", limit: 3000 });
    await q.setPolicy(policy("user", "u1", 5000, "block", { override: true, expiresAt: t.now + 60_000 }), "admin");
    expect(q.effective("files.upload_bytes", ME)).toMatchObject({ source: "override", limit: 5000 });
    t.now += 120_000;
    expect(q.effective("files.upload_bytes", ME)).toMatchObject({ source: "own", limit: 3000 });
  });

  it("lets a hard default cap narrower allocations, never raise them", async () => {
    const t = { now: Date.now() };
    const { q } = engineAt(t);
    await q.setPolicy(policy("global", "default:user", 1000, "block", { hard: true }), "admin");
    await q.setPolicy(policy("user", "u1", 5000), "admin");
    expect(q.effective("files.upload_bytes", ME)).toMatchObject({ source: "hard_default", limit: 1000 });
    await q.setPolicy(policy("user", "u1", 500), "admin");
    expect(q.effective("files.upload_bytes", ME)).toMatchObject({ source: "own", limit: 500 });
  });

  it("checks every scope: a person's exception doesn't get past their organization's or the platform's limit", async () => {
    const t = { now: Date.now() };
    const { q } = engineAt(t);
    await q.setPolicy(policy("user", "u1", 10_000, "block", { override: true, expiresAt: t.now + 3_600_000 }), "admin");
    await q.setPolicy(policy("org", "o1", 100), "admin");
    const d = await q.check("files.upload_bytes", [ME, ORG, ALL], 150);
    expect(d.allowed).toBe(false);
    expect(d.scopes.find((s) => s.outcome === "blocked")?.scope).toEqual(ORG);
    await q.setPolicy(policy("org", "o1", 1000), "admin");
    await q.setPolicy(policy("global", "", 120, "block", { hard: true }), "admin");
    expect((await q.check("files.upload_bytes", [ME, ORG, ALL], 150)).scopes.find((s) => s.outcome === "blocked")?.scope).toEqual(ALL);
  });

  it("validates policies and refuses modes a key can't enforce", async () => {
    const { q } = engineAt({ now: Date.now() });
    await expect(q.setPolicy({ ...policy("user", "u1", -1), key: "files.upload_bytes" }, "a")).rejects.toThrow(/whole number/);
    await expect(q.setPolicy({ ...policy("user", "u1", 5, "block", { override: true }) }, "a")).rejects.toThrow(/end time/);
    await expect(q.setPolicy({ ...policy("org", "o1", 5, "block", { hard: true }) }, "a")).rejects.toThrow(/ceilings/);
    await expect(q.setPolicy({ scopeType: "user", scopeId: "u1", key: "sessions.active", limit: 3, mode: "block", reason: "nope" }, "a")).rejects.toThrow(/observed or warned/);
  });
});

describe("accounting", () => {
  it("doesn't let two parallel operations both take the last of an allowance", async () => {
    const { q } = engineAt({ now: Date.now() });
    await q.setPolicy(policy("user", "u1", 100), "admin");
    const first = await q.check("files.upload_bytes", [ME], 80, { reserve: true });
    const second = await q.check("files.upload_bytes", [ME], 80, { reserve: true });
    expect([first.allowed, second.allowed]).toEqual([true, false]);
    await q.release(first.reservationId!);
    expect((await q.check("files.upload_bytes", [ME], 80, { reserve: true })).allowed).toBe(true);
  });

  it("commits what was really used, releases failures, and treats a repeated key as the same operation", async () => {
    const { q } = engineAt({ now: Date.now() });
    await q.setPolicy(policy("user", "u1", 1000), "admin");
    const a = await q.check("files.upload_bytes", [ME], 300, { reserve: true, idempotencyKey: "upload:a" });
    expect((await q.check("files.upload_bytes", [ME], 300, { reserve: true, idempotencyKey: "upload:a" })).reservationId).toBe(a.reservationId);
    expect(q.usage("files.upload_bytes", ME)).toMatchObject({ used: 0, reserved: 300 });
    await q.settleByKey("upload:a", "commit", 250);
    await q.settleByKey("upload:a", "commit", 250); // twice: once
    expect(q.usage("files.upload_bytes", ME)).toMatchObject({ used: 250, reserved: 0 });
    await q.check("files.upload_bytes", [ME], 400, { reserve: true, idempotencyKey: "upload:b" });
    await q.settleByKey("upload:b", "release");
    expect(q.usage("files.upload_bytes", ME)).toMatchObject({ used: 250, reserved: 0 });
  });

  it("gives back reservations nobody settled once they expire, and records it", async () => {
    const t = { now: Date.now() };
    const { db, q } = engineAt(t);
    await q.setPolicy(policy("user", "u1", 1000), "admin");
    await q.check("files.upload_bytes", [ME], 600, { reserve: true, ttlMs: 1000 });
    t.now += 2000;
    expect(await q.expireReservations()).toBe(1);
    expect(q.usage("files.upload_bytes", ME).reserved).toBe(0);
    expect(db.prepare("SELECT outcome FROM quota_events WHERE outcome = 'expired_reservation'").all()).toHaveLength(1);
  });

  it("starts a new period at the UTC month boundary without deleting the old one", async () => {
    const t = { now: Date.parse("2026-10-31T23:59:00Z") };
    const { db, q } = engineAt(t);
    await q.setPolicy(policy("user", "u1", 100), "admin");
    await q.charge("files.upload_bytes", [ME], 90);
    expect((await q.check("files.upload_bytes", [ME], 20)).allowed).toBe(false);
    t.now = Date.parse("2026-11-01T00:01:00Z");
    expect((await q.check("files.upload_bytes", [ME], 20)).allowed).toBe(true);
    expect(db.prepare("SELECT period_start, used FROM quota_counters ORDER BY period_start").all()).toEqual([{ period_start: "2026-10", used: 90 }]);
  });

  it("observes without refusing, warns at the level, and allows the grace in soft mode", async () => {
    const t = { now: Date.parse("2026-10-24T10:00:00Z") };
    const { db, q } = engineAt(t);
    await q.setPolicy(policy("user", "u1", 100, "observe"), "admin");
    expect(await q.check("files.upload_bytes", [ME], 150)).toMatchObject({ allowed: true });
    await q.setPolicy(policy("user", "u1", 100, "soft", { gracePct: 20 }), "admin");
    expect((await q.check("files.upload_bytes", [ME], 115)).scopes[0]!.outcome).toBe("soft_over");
    expect((await q.check("files.upload_bytes", [ME], 125)).allowed).toBe(false);
    // No metered key is throttled since AI was removed (API 0.47.0): throttling is refused as a mode for these keys.
    const outcomes = (db.prepare("SELECT DISTINCT outcome FROM quota_events").all() as { outcome: string }[]).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["blocked", "observed_over", "soft_over"]);
  });

  it("keeps policy history: a change supersedes, a removal ends, nothing is deleted", async () => {
    const { db, q } = engineAt({ now: Date.now() });
    const a = await q.setPolicy(policy("user", "u1", 100), "admin");
    const b = await q.setPolicy(policy("user", "u1", 200), "admin");
    expect(db.prepare("SELECT superseded_by FROM quota_policies WHERE id = ?").get(a.id)).toEqual({ superseded_by: b.id });
    await q.removePolicy(b.id);
    expect(q.effective("files.upload_bytes", ME).source).toBe("none");
    expect(db.prepare("SELECT COUNT(*) n FROM quota_policies").get()).toEqual({ n: 2 });
  });
});

describe("enforcement in the running server", () => {
  let h: Harness;
  let a: GriipClient, b: GriipClient;
  let dm: string;
  beforeAll(async () => {
    h = await startServer({ TELEMETRY_TICK_MS: "0" });
    a = await h.client("quotaa");
    b = await h.client("quotab");
    dm = (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id;
  });
  afterAll(async () => h.close());
  afterEach(() => vi.useRealTimers());
  const upload = (n: number) => a.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, crypto.randomBytes(n));

  it("changes nothing and writes nothing while no policy exists", async () => {
    await upload(2000);
    expect(h.ctx.platform.count("quota_counters")).toBe(0);
  });

  it("refuses an upload past this month's allowance, and a failed upload costs nothing", async () => {
    await h.ctx.quotas.setPolicy({ scopeType: "user", scopeId: a.userId, key: "files.upload_bytes", limit: 5000, mode: "block", reason: "test" }, "admin");
    const first = await upload(3000);
    expect(h.ctx.quotas.usage("files.upload_bytes", { type: "user", id: a.userId })).toMatchObject({ used: 3000, reserved: 0 });
    const refused = await expectStatus(upload(3000), 429);
    expect(refused.error).toMatchObject({ code: "quota_exceeded", details: { quota: "files.upload_bytes", scope: "user", limit: 5000 } });
    // An upload that ends early is released, not charged.
    const res = await fetch(`${h.baseUrl}/v1/attachments?conversationId=${dm}`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/octet-stream", "content-length": "1500" },
      body: new Uint8Array(crypto.randomBytes(1000)),
    }).catch(() => null);
    expect(res === null || res.status >= 400).toBe(true);
    expect(h.ctx.quotas.usage("files.upload_bytes", { type: "user", id: a.userId }).reserved).toBe(0);
    // A larger single upload than allowed, whatever is left of the month.
    await h.ctx.quotas.setPolicy({ scopeType: "global", scopeId: "default:user", key: "files.max_upload_bytes", limit: 1000, mode: "block", reason: "test" }, "admin");
    await expectStatus(b.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, crypto.randomBytes(1500)), 429);
    // Downloads have their own monthly allowance, charged in bytes asked for.
    await h.ctx.quotas.setPolicy({ scopeType: "user", scopeId: b.userId, key: "files.download_bytes", limit: 4000, mode: "block", reason: "test" }, "admin");
    await b.req("GET", `/v1/attachments/${first.id}`);
    const again = await expectStatus(b.req("GET", `/v1/attachments/${first.id}`), 429);
    expect(again.error.details).toMatchObject({ quota: "files.download_bytes", used: 3000 });
  });

  it("refuses a realtime connection past a person's allowance, while sign-in stays possible", async () => {
    await h.ctx.quotas.setPolicy({ scopeType: "user", scopeId: a.userId, key: "ws.connections", limit: 1, mode: "block", reason: "test" }, "admin");
    await a.connect();
    const tab = await h.client("quotatab");
    Object.assign(tab, { token: a.token, deviceId: a.deviceId, userId: a.userId, identity: a.identity, device: a.device });
    await expect(tab.connect()).rejects.toThrow();
    await a.disconnect();
    await a.login();
  });

  it("scopes a person to their community when the conversation belongs to one", async () => {
    expect(scopesFor("u", "o")).toEqual([{ type: "user", id: "u" }, { type: "org", id: "o" }, { type: "global", id: "" }]);
    expect(scopesFor("u", null)).toEqual([{ type: "user", id: "u" }, { type: "global", id: "" }]);
  });
});
