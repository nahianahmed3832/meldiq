import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HealthReport, warningsFor } from "../src/modules/administration/ops/health.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** Round 7 slice C1: the platform health report (docs/OPERATIONS.md). */
let h: Harness;
let admin: GriipClient, member: GriipClient;
let dm: string;

beforeAll(async () => {
  h = await startServer();
  [admin, member] = await Promise.all(["opsadmin", "opsmember"].map((n) => h.client(n)));
  (h.ctx.config.platformAdmins as Set<string>).add(admin.userId);
  dm = (await member.req("POST", "/v1/conversations/dm", { userId: admin.userId })).conversation.id;
  await member.req("GET", `/v1/conversations/${dm}`);
});
afterAll(async () => h.close());

const health = async (c: GriipClient) => (await c.req("GET", "/v1/admin/health")).health as HealthReport;

describe("platform health (round 7, C1)", () => {
  it("is for platform admins only, not workspace roles", async () => {
    await expectStatus(member.req("GET", "/v1/admin/health"), 403);
    const org = (await member.req("POST", "/v1/orgs", { name: "Owner Co" })).org.id;
    expect(org).toBeTruthy();
    await expectStatus(member.req("GET", "/v1/admin/health"), 403); // owning a workspace changes nothing
  });

  it("reports measured values and says what isn't measured", async () => {
    const r = await health(admin);
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.checks.database).toMatchObject({ available: true, ok: true });
    expect(r.checks.storage).toMatchObject({ available: true, backend: "local", reachable: true });
    expect(r.checks.livekit).toMatchObject({ available: true, configured: true });
    if (!h.ctx.mongo) expect(r.checks.mongodb).toEqual({ available: false, reason: "not configured" });
    expect(r.process.rssBytes).toBeGreaterThan(0);
    expect(r.queues.delivery.items).toBeGreaterThanOrEqual(0);
  });

  it("counts requests by route template, never the raw path with ids", async () => {
    const r = await health(admin);
    const routes = r.metrics.routes.map((x) => x.route);
    expect(routes).toContain("GET /v1/conversations/:id");
    expect(JSON.stringify(r)).not.toContain(dm);
    expect(JSON.stringify(r)).not.toContain(member.userId);
  });

  it("warns about a late reminder from real state", async () => {
    const t = Date.now() - 10 * 60_000;
    await h.ctx.identity.write((w) =>
      w.insert("reminders", { id: "rem_late", user_id: member.userId, sealed: "x", due_at: t, time_zone: "UTC", state: "scheduled", created_at: t, updated_at: t }),
    );
    const r = await health(admin);
    expect(r.queues.reminders.overdueUndelivered).toBeGreaterThanOrEqual(1);
    expect(r.warnings.some((w) => w.includes("reminders are more than 5 minutes late"))).toBe(true);
    await h.ctx.identity.write((w) => w.delete("reminders", { id: "rem_late" }));
  });

  it("warns about a provider that is failing now, not one that recovered", () => {
    const base = { name: "mail.smtp", ok: 1, failed: 1, lastErrorKind: "ECONNREFUSED" };
    const report = (lastOkAt: number, lastFailureAt: number): HealthReport =>
      ({
        checks: { database: { available: true, ok: true, sizeBytes: 1 }, mongodb: { available: false, reason: "" }, livekit: { available: true, configured: true }, storage: { available: true, backend: "local", reachable: true } },
        process: { rssBytes: 1, heapUsedBytes: 1, eventLoopDelayP99Ms: 5 },
        queues: { delivery: { items: 0, oldestAgeSeconds: null }, reminders: { overdueUndelivered: 0, retrying: 0 }, integrations: { available: false, reason: "" } },
        metrics: { since: 0, window: { minutes: 15, requests: 0, serverErrors: 0, errorRate: null, p95Ms: null }, routes: [], jobs: [], providers: [{ ...base, lastOkAt, lastFailureAt }] },
      }) as unknown as HealthReport;
    const t = 10_000_000;
    expect(warningsFor(report(t - 60_000, t - 1000), t)[0]).toMatch(/^mail\.smtp is failing \(ECONNREFUSED\)/);
    expect(warningsFor(report(t - 1000, t - 60_000), t)).toEqual([]);
  });
});
