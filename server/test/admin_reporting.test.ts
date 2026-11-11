import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app/context.js";
import { openDatabase, type DB } from "../src/infrastructure/database/db.js";
import { describeTables } from "../src/infrastructure/database/mongo/catalog.js";
import { SqliteRows } from "../src/infrastructure/database/rows/index.js";
import { eventRows, subscriptionRows } from "../src/modules/billing/admin.js";
import { BILLING_METRIC_MODES, billingMetrics, type BillingMetricMode } from "../src/modules/billing/metrics.js";
import { activityReport, dayCoverage, reportDays } from "../src/modules/platformAdmin/reporting.js";
import { seriesSum } from "../src/modules/telemetry/analytics.js";
import { AdminActiveUsers } from "../src/shared/contracts/http/platformAdminInsights.js";
import { AdminBillingEventsQuery, AdminBillingMetrics, AdminBillingMetricsQuery } from "../src/shared/contracts/http/platformAdminBilling.js";

const AT = Date.parse("2026-11-12T12:00:00Z"), DAY = 86_400_000;
let db: DB, rows: SqliteRows;
beforeEach(() => { db = openDatabase(":memory:"); rows = new SqliteRows(db, describeTables(db)); });
afterEach(() => db.close());

const invoice = (id: string, provider: string, currency: string, amount: number, paidAt: number, refunded = 0, mode: "test" | "live" | null = null) => rows.write(w => w.insert("billing_invoices", {
  id, provider, provider_invoice_ref: id, owner_kind: "account", account_id: "fixture_account", status: "paid", currency,
  provider_mode: mode,
  amount_due_minor: amount, amount_paid_minor: amount, amount_refunded_minor: refunded, issued_at: paidAt, paid_at: paidAt,
  provider_updated_at: AT - 1, updated_at: AT - 1,
}));

describe("authoritative reporting", () => {
  it("uses half-open payment boundaries and keeps provider, currency and chart totals aligned", async () => {
    await invoice("inside_usd", "paypal", "USD", 299, AT - 1, 70);
    await invoice("inside_jpy", "paypal", "JPY", 1234, AT - 2 * DAY);
    await invoice("inside_kwd", "stripe", "KWD", 1001, AT - DAY);
    await invoice("boundary_start", "paypal", "USD", 101, AT - 7 * DAY);
    await invoice("before_start", "paypal", "USD", 999, AT - 7 * DAY - 1, 20);
    await invoice("boundary_end", "paypal", "USD", 888, AT);
    const all = billingMetrics(rows, 7, AT);
    expect(all.scope).toMatchObject({ environment: "unclassified", from: AT - 7 * DAY, to: AT, timezone: "UTC" });
    expect(all.money.collected).toEqual([{ currency: "JPY", amountMinor: 1234 }, { currency: "KWD", amountMinor: 1001 }, { currency: "USD", amountMinor: 400 }]);
    const scoped = billingMetrics(rows, 7, AT, { provider: "paypal", currency: "USD" });
    expect(scoped.money.collected).toEqual([{ currency: "USD", amountMinor: 400 }]);
    expect(scoped.collectionDays.flatMap(d => d.collected).reduce((sum, m) => sum + m.amountMinor, 0)).toBe(400);
    expect(scoped.collectionDays[0].partial).toBe(true);
    expect(scoped.collectionDays.at(-1)?.partial).toBe(true);
    // These are a cumulative stock; an unrelated invoice update must never invent a period refund.
    expect(scoped.money.refunds).toEqual([{ currency: "USD", amountMinor: 90 }]);
    expect(billingMetrics(rows, 7, AT, { provider: "stripe", currency: "USD" }).money.collected).toEqual([]);
  });

  it("normalizes recurring estimates with exact arithmetic, quantity, and one final rounding per currency", async () => {
    await rows.write(w => {
      for (const [id, amount, interval, frequency, quantity] of [["year1", 1, "year", 1, 1], ["year11", 11, "year", 1, 1], ["quarter", 333, "month", 3, 3]] as const) {
        w.insert("billing_plans", { id, key: id, name: id, status: "active", created_by: "fixture", created_at: AT - DAY, updated_at: AT - DAY });
        w.insert("billing_plan_versions", { id, plan_id: id, version: 1, interval, billing_frequency: frequency, currency: "USD", amount_minor: amount, provider: "stripe", created_by: "fixture", created_at: AT - DAY, updated_at: AT - DAY });
        w.insert("billing_subscriptions", { id, owner_kind: "account", account_id: id, plan_version_id: id, status: "active", provider: "stripe", provider_subscription_ref: id, quantity, provider_updated_at: AT - DAY, created_at: AT - DAY, updated_at: AT - DAY });
      }
    });
    expect(billingMetrics(rows, 7, AT).money.mrrEstimate).toEqual([{ currency: "USD", amountMinor: 334 }]);
  });

  it("separates persisted environments across money, subscriptions and matching webhook drill-downs", async () => {
    const amountByMode = { unclassified: 100, test: 5000, live: 700 };
    const quantityByMode = { unclassified: 2, test: 3, live: 5 };
    const failedByMode = { unclassified: 1, test: 2, live: 3 };
    for (const mode of BILLING_METRIC_MODES) {
      const source = mode === "unclassified" ? null : mode;
      await invoice(`${mode}_invoice`, "paypal", "USD", amountByMode[mode], AT - 1, quantityByMode[mode], source);
      await rows.write(w => {
        w.insert("billing_plans", { id: mode, key: mode, name: mode, status: "active", created_by: "fixture", created_at: AT - DAY, updated_at: AT - DAY });
        w.insert("billing_plan_versions", { id: mode, plan_id: mode, version: 1, interval: "month", billing_frequency: 1, currency: "USD", amount_minor: 125, provider: "paypal", created_by: "fixture", created_at: AT - DAY, updated_at: AT - DAY });
        w.insert("billing_subscriptions", { id: mode, owner_kind: "account", account_id: mode, plan_version_id: mode, status: "active", provider: "paypal", provider_mode: source, provider_subscription_ref: mode, quantity: quantityByMode[mode], provider_updated_at: AT - DAY, created_at: AT - DAY, updated_at: AT - DAY });
        // Identical timestamps across modes exercise the exact scope through keyset pagination.
        for (let i = 0; i < failedByMode[mode]; i++) w.insert("billing_provider_events", { id: `${mode}_failed_${i}`, provider: "paypal", provider_mode: source, event_ref: `${mode}_failed_${i}`, type: "fixture", provider_created_at: AT - 5, received_at: AT - 5, status: "failed", attempts: 1, summary: "{}" });
        for (const [suffix, status, received] of [["old", "received", AT - 8 * DAY], ["dead", "dead", AT - 1], ["end", "failed", AT]] as const) w.insert("billing_provider_events", { id: `${mode}_${suffix}`, provider: "paypal", provider_mode: source, event_ref: `${mode}_${suffix}`, type: "fixture", provider_created_at: received, received_at: received, status, attempts: 1, summary: "{}" });
      });
    }
    await invoice("live_jpy", "paypal", "JPY", 99, AT - 1, 0, "live");
    await invoice("test_stripe", "stripe", "USD", 123, AT - 1, 0, "test");
    await rows.write(w => {
      w.insert("billing_provider_events", { id: "other_provider", provider: "stripe", provider_mode: "test", event_ref: "other_provider", type: "fixture", provider_created_at: AT - 5, received_at: AT - 5, status: "failed", attempts: 1, summary: "{}" });
      w.insert("billing_webhook_rejections", { provider: "paypal", day: "2026-11-12", reason: "bad_signature", count: 4 });
    });

    expect(AdminBillingMetricsQuery.parse({}).mode).toBe("unclassified");
    expect(AdminBillingEventsQuery.parse({}).mode).toBe("unclassified");
    expect(AdminBillingMetricsQuery.safeParse({ mode: "all" }).success).toBe(false);
    expect(AdminBillingEventsQuery.safeParse({ mode: "all" }).success).toBe(false);
    expect(billingMetrics(rows, 7, AT).money.collected).toEqual([{ currency: "USD", amountMinor: 100 }]);

    for (const mode of BILLING_METRIC_MODES) {
      const filter = { mode, provider: "paypal", currency: "USD" };
      const report = billingMetrics(rows, 7, AT, filter);
      expect(AdminBillingMetrics.omit({ setup: true, definitions: true }).safeParse(report).success).toBe(true);
      expect(report.scope.environment).toBe(mode);
      expect(report.money.collected).toEqual([{ currency: "USD", amountMinor: amountByMode[mode] }]);
      expect(report.money.refunds).toEqual([{ currency: "USD", amountMinor: quantityByMode[mode] }]);
      expect(report.money.mrrEstimate).toEqual([{ currency: "USD", amountMinor: 125 * quantityByMode[mode] }]);
      expect(report.collectionDays.flatMap(day => day.collected).reduce((total, money) => total + money.amountMinor, 0)).toBe(amountByMode[mode]);
      expect(report.subscriptions).toMatchObject({ granting: 1, started: 1, byStatus: { active: 1 } });
      expect(subscriptionRows(rows, { ...filter, status: "active", limit: 25 }).map(subscription => subscription.id)).toEqual([mode]);
      expect(report.webhooks).toMatchObject({ byStatus: { failed: failedByMode[mode], dead: 1, received: 0 }, backlog: failedByMode[mode] + 1, oldestBacklogAt: AT - 8 * DAY, lastReceivedAt: AT - 1 });
      expect(report.webhooks.rejected).toEqual(mode === "unclassified" ? [{ reason: "bad_signature", count: 4 }] : []);
      const drilldown = { mode, provider: "paypal", status: "failed", from: report.scope.from, to: report.scope.to, limit: 1 };
      const ids: string[] = [];
      let after: { createdAt: number; id: string } | undefined;
      for (;;) {
        const page = eventRows(rows, { ...drilldown, after });
        if (!page.length) break;
        ids.push(page[0].id);
        if (page.length <= drilldown.limit) break;
        after = { createdAt: page[0].created_at, id: page[0].id };
      }
      expect(ids).toHaveLength(report.webhooks.byStatus.failed);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every(id => id.startsWith(`${mode}_failed_`))).toBe(true);
      expect(report.environmentTotals).toEqual(BILLING_METRIC_MODES.map(environment => ({ environment, subscriptions: 1, invoices: 1, collected: [{ currency: "USD", amountMinor: amountByMode[environment] }], failedEvents: failedByMode[environment], deadEvents: 1, backlog: failedByMode[environment] + 1 })));
    }
    const live = billingMetrics(rows, 7, AT, { mode: "live", provider: "paypal" });
    expect(live.money.collected).toEqual([{ currency: "JPY", amountMinor: 99 }, { currency: "USD", amountMinor: 700 }]);
    expect(billingMetrics(rows, 7, AT, { mode: "test", currency: "USD" }).money.collected).toEqual([{ currency: "USD", amountMinor: 5123 }]);
    expect(rows.get<{ provider_mode: BillingMetricMode | null }>("billing_invoices", { id: "unclassified_invoice" })?.provider_mode).toBeNull();
    expect(eventRows(rows, { status: "failed", from: AT - 7 * DAY, to: AT, limit: 25 }).map(event => event.id)).toEqual(["unclassified_failed_0"]);
  });

  it("matches webhook drill-down filters and pages tied timestamps without duplicates", async () => {
    await rows.write(w => {
      for (const [id, provider, received, status] of [["a", "paypal", AT - 5, "failed"], ["b", "paypal", AT - 5, "failed"], ["c", "paypal", AT - 1, "failed"], ["d", "stripe", AT - 1, "failed"], ["e", "paypal", AT, "failed"], ["f", "paypal", AT - 8 * DAY, "failed"]] as const) {
        w.insert("billing_provider_events", { id, provider, event_ref: id, type: "fixture", provider_created_at: received, received_at: received, status, attempts: 1, summary: "{}" });
      }
    });
    const filter = { provider: "paypal", status: "failed", from: AT - 7 * DAY, to: AT, limit: 2 };
    const page = eventRows(rows, filter);
    expect(page.map(r => r.id)).toEqual(["c", "b", "a"]); // extra row advertises another page
    const next = eventRows(rows, { ...filter, after: { createdAt: page[1].created_at, id: page[1].id } });
    expect(next.map(r => r.id)).toEqual(["a"]);
    expect(billingMetrics(rows, 7, AT, { provider: "paypal" }).webhooks.byStatus.failed).toBe(3);
  });

  it("keeps unavailable and partial activity distinct and deduplicates cross-platform identities", async () => {
    const since = Date.parse("2026-11-10T12:00:00Z");
    await rows.write(w => {
      for (const [day, platform, user] of [["2026-11-10", "web", "alice"], ["2026-11-11", "web", "alice"], ["2026-11-11", "android", "alice"], ["2026-11-11", "web", "internal"], ["2026-11-12", "web", "alice"]]) {
        const at = Date.parse(`${day}T${day === "2026-11-12" ? "11" : "13"}:00:00Z`);
        w.insert("activity_daily", { day, user_id: user, platform, client_version: "", first_at: at, last_at: at, requests: 1, actions: 0, first_action_at: null, signup_at: Date.parse("2026-11-10T12:00:00Z") });
      }
    });
    const ctx = { platform: rows, ephemeral: rows, telemetry: { since: () => since } } as unknown as AppContext;
    const report = activityReport(ctx, ["internal"], { from: "2026-11-09", to: "2026-11-12" }, AT);
    expect(AdminActiveUsers.safeParse(report).success).toBe(true);
    expect(report.days).toEqual([
      { day: "2026-11-09", dau: null, wau: null, mau: null, newActive: null, returningActive: null, collected: false, partial: false },
      { day: "2026-11-10", dau: 1, wau: null, mau: null, newActive: 1, returningActive: 0, collected: true, partial: true },
      { day: "2026-11-11", dau: 1, wau: null, mau: null, newActive: 0, returningActive: 1, collected: true, partial: false },
      { day: "2026-11-12", dau: 1, wau: null, mau: null, newActive: 0, returningActive: 1, collected: true, partial: true },
    ]);
    expect(dayCoverage("2026-11-11", Date.parse("2026-10-13T00:00:00Z"), AT, 30)).toBe("observed");
    expect(dayCoverage("2026-11-11", Date.parse("2026-10-13T00:00:01Z"), AT, 30)).toBe("partial");
    expect(() => reportDays({ from: "2026-01-01", to: "2026-11-12" }, AT)).toThrow(/120/);
  });

  it("combines expired-minute hourly history with recent minutes once, including the unfinished hour", async () => {
    const hourMs = 3_600_000, oldHour = Math.floor((AT - 3 * DAY) / hourMs), recentHour = Math.floor((AT - DAY) / hourMs), currentHour = Math.floor(AT / hourMs);
    await rows.write(w => {
      w.insert("resource_hourly", { series: "api.requests", hour: oldHour, avg: 100, min: 100, max: 100, samples: 60 });
      w.insert("resource_hourly", { series: "api.requests", hour: recentHour, avg: 3, min: 3, max: 3, samples: 2 });
      for (const minute of [recentHour * 60 + 10, recentHour * 60 + 20]) w.insert("resource_samples", { series: "api.requests", minute, value: 3 });
      w.insert("resource_samples", { series: "api.requests", minute: currentHour * 60, value: 7 });
    });
    const source = { platform: rows, ephemeral: rows };
    // 6,000 old requests + 6 overlapping retained/rolled requests + 7 not yet rolled up.
    expect(seriesSum(source, "api.requests", oldHour * hourMs, AT)).toBe(6013);
    // A retained boundary minute selection must not include the rest of that hour's rollup.
    expect(seriesSum(source, "api.requests", (recentHour * 60 + 15) * 60_000, (recentHour * 60 + 25) * 60_000)).toBe(3);
    // Older boundaries have only hour precision and are labelled as whole-hour coverage in the UI.
    expect(seriesSum(source, "api.requests", oldHour * hourMs + 30 * 60_000, AT)).toBe(6013);
    expect(seriesSum(source, "api.errors_5xx", oldHour * hourMs, AT)).toBeNull();
  });

  it("does not silently round an unsafe monetary total", async () => {
    await invoice("huge1", "paypal", "USD", Number.MAX_SAFE_INTEGER, AT - 1);
    await invoice("huge2", "paypal", "USD", 1, AT - 1);
    expect(() => billingMetrics(rows, 7, AT)).toThrow(/safe reporting range/);
  });
});
