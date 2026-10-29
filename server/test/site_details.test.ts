import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SITE_DETAILS_DEFAULTS, siteDetailsFromDb } from "../src/app/siteDetails.js";
import { PlanCatalog } from "../src/modules/billing/catalog.js";
import { publishMojoPlans } from "../src/modules/billing/stripeSetup.js";
import { AdminSiteDetails, SiteDetails } from "../src/shared/contracts/http/platformAdminInsights.js";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Site and legal details edited in the console (docs/SITE_DETAILS.md): served publicly to the website and apps, changed
 * only by super admins with a passkey check and a reason, audited field by field, still served during maintenance.
 */
const REASON = "Business details confirmed by the owner";
const filled = {
  operator: { legalName: "GRIIPBUDDY LLC", address: "1 Example Street, Wilmington, DE 19801, USA", jurisdiction: "Delaware, USA", registration: "1234567", governingLaw: "The laws of the State of Delaware" },
  contacts: { supportEmail: "Support@Meldiq.app", privacyEmail: "privacy@meldiq.app", dpo: null },
  policies: {
    minimumAge: 13,
    refundWindowDays: 14,
    refundRules: "Ask within 14 days of a payment.\n\nOne refund per account per year.",
    failedPaymentGraceDays: 7,
    legalBases: null,
    billingRecordRetention: "Seven years",
    transferSafeguards: null,
  },
  legalUpdatedOn: "2026-10-29",
};

describe("site and legal details", () => {
  let h: Harness;
  const mailer = new MemoryMailer();
  const admins: Record<string, ConsoleAdmin> = {};
  const as = (role: string) => admins[role]!.browser;
  const publicDetails = async () => {
    const r = await h.app.inject({ method: "GET", url: "/v2/site/details" });
    expect(r.statusCode).toBe(200);
    expect(SiteDetails.safeParse(r.json()).success).toBe(true);
    return { body: r.json(), cache: r.headers["cache-control"] };
  };

  beforeAll(async () => {
    h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, WORKFLOW_TICK_MS: "0" }, { mailer });
    for (const role of ["super_admin", "operations_admin", "billing_admin"]) admins[role] = await consoleAdmin(h, mailer, role, `site${role}`);
  });
  afterAll(async () => h.close());

  it("start from only what's decided, and are public without signing in", async () => {
    const { body, cache } = await publicDetails();
    expect(body).toEqual(SITE_DETAILS_DEFAULTS);
    expect(cache).toBe("public, max-age=60");
    const v = await as("billing_admin").expect(200, "GET", "/admin/v1/site");
    expect(AdminSiteDetails.safeParse(v).success).toBe(true);
    expect(v.missing).toContain("operator.address");
    expect(v.missing).toContain("policies.refundRules");
    expect(v.missing).not.toContain("operator.legalName");
  });

  it("change only for super admins, with a reason, audited field by field, and show on the public answer at once", async () => {
    expect((await as("operations_admin").req("PUT", "/admin/v1/site", { details: filled, reason: REASON })).status).toBe(403);
    expect((await as("billing_admin").req("PUT", "/admin/v1/site", { details: filled, reason: REASON })).status).toBe(403);
    expect((await as("super_admin").req("PUT", "/admin/v1/site", { details: filled, reason: "short" })).status).toBe(400);
    expect((await as("super_admin").req("PUT", "/admin/v1/site", { details: { ...filled, contacts: { ...filled.contacts, supportEmail: "nope" } }, reason: REASON })).status).toBe(400);
    expect((await as("super_admin").req("PUT", "/admin/v1/site", { details: { ...filled, policies: { ...filled.policies, minimumAge: 9 } }, reason: REASON })).status).toBe(400);
    expect((await as("super_admin").req("PUT", "/admin/v1/site", { details: { ...filled, extra: 1 }, reason: REASON })).status).toBe(400);

    const saved = await as("super_admin").expect(200, "PUT", "/admin/v1/site", { details: filled, reason: REASON });
    expect(saved.details.contacts.supportEmail).toBe("support@meldiq.app");
    expect(saved.missing).toEqual(["contacts.dpo", "policies.legalBases", "policies.transferSafeguards"]);
    expect(saved.updatedBy.accountId).toBe(admins.super_admin!.account.accountId);
    expect((await publicDetails()).body.operator.address).toBe(filled.operator.address);

    const audit = h.ctx.db.prepare("SELECT reason, detail FROM platform_audit WHERE action = 'site.update' ORDER BY id DESC LIMIT 1").get() as { reason: string; detail: string };
    expect(audit.reason).toBe(REASON);
    expect(JSON.parse(audit.detail)).toMatchObject({ "operator.address": `null -> "${filled.operator.address}"`, legalUpdatedOn: "2026-10-28 -> 2026-10-29" });
    expect(JSON.parse(audit.detail)).not.toHaveProperty("operator.legalName");

    // The operator CLI reads the grace period when it publishes Mojo Go and Plus.
    expect(siteDetailsFromDb(h.ctx.db).policies.failedPaymentGraceDays).toBe(7);
    const catalog = new PlanCatalog(h.ctx.billing.rows);
    await publishMojoPlans(catalog, "stripe", { go: "price_go", plus: "price_plus", spark: "price_spark" }, "test", Date.now(), 7);
    expect(catalog.current(catalog.byKey("plus")!.id)!.grace_days).toBe(7);
  });

  it("are still served while the platform is in maintenance", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/maintenance", { value: { enabled: true, message: "Back soon" }, reason: "Testing maintenance with site details" });
    expect((await h.app.inject({ method: "GET", url: "/v2/billing/plans" })).statusCode).toBe(503);
    expect((await publicDetails()).body.operator.jurisdiction).toBe("Delaware, USA");
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/maintenance", { value: { enabled: false, message: "" }, reason: "Testing maintenance with site details" });
  });
});
