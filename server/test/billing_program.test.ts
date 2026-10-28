import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA } from "../src/infrastructure/database/schema.generated.js";
import { publishMojoPlans } from "../src/modules/billing/stripeSetup.js";
import { AccountEntitlements, PublicPlans } from "../src/shared/contracts/http/billing.js";
import { AdminMojoAccount, AdminMojoControls, AdminMojoGiftsPage, AdminMojoGrantChanged, AdminMojoGrantsPage, AdminMojoSparks, AdminProgram } from "../src/shared/contracts/http/platformAdminBilling.js";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { ADMIN_ORIGIN, type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Running Meldiq Mojo's trials and invite links from the Platform Admin Console (docs/BILLING.md › Running trials from
 * the console): the program follows the environment until an operator saves it, takes effect at once, and operators can
 * give and end free periods; operators also set whether Mojo's limits are enforced and their numbers (docs/MOJO.md ›
 * Running Mojo from the console). Billing stays off (BILLING_PROVIDER unset), as in production today.
 */
const DAY = 86_400_000;
const REASON = "Launch of the Meldiq Mojo trial program";

describe("billing_grants in MongoDB", () => {
  it("keeps its columns, so its collection validator never needs collMod (production's database user can't run it)", () => {
    expect(SCHEMA.find((t) => t.name === "billing_grants")!.columns.map((c) => c.name)).toEqual([
      "id", "account_id", "user_id", "plan_key", "source", "reference", "once_key", "starts_at", "ends_at", "created_at",
    ]);
  });
});

describe("the trial program in the console", () => {
  let h: Harness;
  const mailer = new MemoryMailer();
  const admins: Record<string, ConsoleAdmin> = {};
  const as = (role: string) => admins[role]!.browser;
  const signedIn = async (name: string) => {
    const c = new AccountClient(h.baseUrl, email(name), PASSWORD, name);
    await c.signUp(mailer);
    await c.signIn();
    return c;
  };
  const ent = async (c: AccountClient) => {
    const e = await c.req("GET", "/v2/billing/entitlements");
    expect(AccountEntitlements.safeParse(e).success).toBe(true);
    return e;
  };
  const program = async () => {
    const p = await as("billing_admin").expect(200, "GET", "/admin/v1/billing/program");
    expect(AdminProgram.safeParse(p).success).toBe(true);
    return p;
  };
  const turnOn = (extra: Record<string, unknown> = {}) =>
    as("billing_admin").expect(200, "PUT", "/admin/v1/billing/program", {
      enabled: true,
      startsAt: null,
      planKey: "plus",
      days: 14,
      referralDays: 30,
      referralCapDays: 90,
      claimWindowDays: 7,
      reason: REASON,
      ...extra,
    });

  beforeAll(async () => {
    h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, WORKFLOW_TICK_MS: "0" }, { mailer });
    for (const role of ["super_admin", "billing_admin", "support_admin", "auditor"]) admins[role] = await consoleAdmin(h, mailer, role, `prog${role}`);
    await publishMojoPlans(h.ctx.billing.catalog, "stripe", { go: "price_go", plus: "price_plus", spark: "price_spark" }, "test", Date.now());
  });
  afterAll(async () => h.close());

  it("follows the environment until an operator saves it: off here, so nobody gets a trial", async () => {
    const p = await program();
    expect(p).toMatchObject({ source: "environment", live: false, settings: { enabled: false, planKey: "plus", days: 14, referralDays: 30, referralCapDays: 90, claimWindowDays: 7 } });
    expect(p.plans.map((x: any) => x.key)).toEqual(["go", "plus"]);
    expect((await h.app.inject({ method: "GET", url: "/v2/billing/plans" })).json().trial).toBeNull();
    const early = await signedIn("earlybird");
    expect((await ent(early)).personal).toMatchObject({ plan: null, trial: null });
  });

  it("lets only billing managers change it, with a passkey check and a reason", async () => {
    expect((await as("auditor").req("PUT", "/admin/v1/billing/program", { useEnvironment: true, reason: REASON })).status).toBe(403);
    expect((await as("support_admin").req("PUT", "/admin/v1/billing/program", { useEnvironment: true, reason: REASON })).status).toBe(403);
    expect((await as("support_admin").req("GET", "/admin/v1/billing/program")).status).toBe(200);
    expect((await as("billing_admin").req("PUT", "/admin/v1/billing/program", { useEnvironment: true, reason: "short" })).status).toBe(400);
    const bad = await as("billing_admin").req("PUT", "/admin/v1/billing/program", {
      enabled: true,
      startsAt: null,
      planKey: "plus",
      days: 14,
      referralDays: 30,
      referralCapDays: 90,
      claimWindowDays: 0,
      reason: REASON,
    });
    expect(bad.status).toBe(400);
  });

  it("turns on at once: the price list shows the trial, and every account gets it from then", async () => {
    const before = Date.now();
    const p = await turnOn();
    expect(p).toMatchObject({ source: "console", live: true, settings: { enabled: true }, updatedBy: { accountId: admins.billing_admin!.account.accountId } });
    expect(p.settings.startsAt).toBeGreaterThanOrEqual(before);
    const plans = (await h.app.inject({ method: "GET", url: "/v2/billing/plans" })).json();
    expect(PublicPlans.safeParse(plans).success).toBe(true);
    expect(plans.trial).toEqual({ planKey: "plus", days: 14, referralDays: 30, referralYearlyCapDays: 90 });
    const audit = h.ctx.db.prepare("SELECT reason, detail FROM platform_audit WHERE action = 'billing.program_update' ORDER BY id DESC LIMIT 1").get() as any;
    expect(audit.reason).toBe(REASON);
    expect(JSON.parse(audit.detail).before).toContain('"source":"environment"');

    // The account that signed up while the program was off gets its 14 days from the launch, not from its sign-up.
    const early = await signedIn("earlybird2");
    const e = await ent(early);
    expect(e.personal).toMatchObject({ plan: { key: "plus", name: "Mojo Plus" }, trial: { source: "signup" } });
    expect(e.personal.accessUntil).toBeGreaterThanOrEqual(p.settings.startsAt + 14 * DAY);
  });

  it("gives and ends free periods by hand, after the free period an account already has", async () => {
    const pat = await signedIn("pat");
    const trialEnd = (await ent(pat)).personal.accessUntil as number;
    const given = await as("billing_admin").expect(200, "POST", "/admin/v1/billing/grants", { accountId: pat.accountId, days: 30, reason: "Thank you for the bug report" });
    expect(AdminMojoGrantChanged.safeParse(given).success).toBe(true);
    expect(given.grant).toMatchObject({ source: "operator", planKey: "plus", state: "upcoming", startsAt: trialEnd, endsAt: trialEnd + 30 * DAY, note: "Thank you for the bug report" });
    expect(given.grant.account.email).toBeNull(); // billing admins don't see emails
    expect(given.grant.grantedBy.accountId).toBe(admins.billing_admin!.account.accountId);

    const acct = await as("billing_admin").expect(200, "GET", `/admin/v1/billing/accounts/${pat.accountId}`);
    expect(AdminMojoAccount.safeParse(acct).success).toBe(true);
    expect(acct.current).toMatchObject({ plan: { key: "plus" }, from: "free_period", accessUntil: trialEnd, renews: false });
    expect(acct.grants.map((g: any) => g.source)).toEqual(["operator", "signup_trial"]);

    // Ending the trial early makes the gift apply... from its own start; ending both leaves nothing.
    const trialGrant = acct.grants.find((g: any) => g.source === "signup_trial");
    const ended = await as("billing_admin").expect(200, "POST", `/admin/v1/billing/grants/${trialGrant.id}/end`, { reason: "Testing ending a free period" });
    expect(ended).toMatchObject({ changed: true, grant: { state: "ended", endedBy: { accountId: admins.billing_admin!.account.accountId } } });
    expect((await as("billing_admin").expect(200, "POST", `/admin/v1/billing/grants/${trialGrant.id}/end`, { reason: "Testing ending a free period" })).changed).toBe(false);
    expect((await ent(pat)).personal.trial).toBeNull();
    await as("billing_admin").expect(200, "POST", `/admin/v1/billing/grants/${given.grant.id}/end`, { reason: "Testing ending a free period" });

    // A new gift now starts at once and shows as a gift.
    const now = await as("billing_admin").expect(200, "POST", "/admin/v1/billing/grants", { accountId: pat.accountId, days: 7, reason: "Testing a gift that starts now" });
    expect(now.grant.state).toBe("active");
    expect((await ent(pat)).personal).toMatchObject({ plan: { key: "plus" }, trial: { source: "operator" } });

    const page = await as("billing_admin").expect(200, "GET", `/admin/v1/billing/grants?account=${pat.accountId}&state=active`);
    expect(AdminMojoGrantsPage.safeParse(page).success).toBe(true);
    expect(page.grants.map((g: any) => g.id)).toEqual([now.grant.id]);
    const audits = h.ctx.db.prepare("SELECT action FROM platform_audit WHERE target_id = ? ORDER BY id").all(pat.accountId) as { action: string }[];
    expect(audits.map((a) => a.action)).toEqual(["billing.grant_give", "billing.grant_end", "billing.grant_end", "billing.grant_give"]);
  });

  it("finds an account by email only for roles that may see emails", async () => {
    const quinn = await signedIn("quinn");
    expect((await as("billing_admin").req("POST", "/admin/v1/billing/grants", { email: quinn.email, days: 5, reason: "Gift by email address" })).status).toBe(403);
    expect((await as("super_admin").req("POST", "/admin/v1/billing/grants", { email: "nobody@example.test", days: 5, reason: "Gift by email address" })).status).toBe(404);
    expect((await as("super_admin").req("POST", "/admin/v1/billing/grants", { email: quinn.email, accountId: quinn.accountId, days: 5, reason: "Gift by email address" })).status).toBe(400);
    const g = await as("super_admin").expect(200, "POST", "/admin/v1/billing/grants", { email: quinn.email, days: 5, reason: "Gift by email address" });
    expect(g.grant.account).toMatchObject({ accountId: quinn.accountId, email: quinn.email });
    expect((await as("auditor").req("POST", "/admin/v1/billing/grants", { accountId: quinn.accountId, days: 5, reason: "Gift by email address" })).status).toBe(403);
  });

  it("counts invites in the figures and on the account", async () => {
    const host = await signedIn("hostess");
    const { code } = await host.req("GET", "/v2/billing/referral");
    const guest = await signedIn("guest");
    await guest.req("POST", "/v2/billing/referral/claim", { code });
    const p = await program();
    expect(p.figures.referrals).toMatchObject({ total: 1, last30Days: 1, inviters: 1, bonusDaysGiven: 30 });
    expect(p.figures.accountsInFreePeriod).toBeGreaterThanOrEqual(3);
    expect(p.referrals[0]).toMatchObject({ inviter: { accountId: host.accountId }, invitee: { accountId: guest.accountId }, inviterDays: 30 });
    const g = await as("billing_admin").expect(200, "GET", `/admin/v1/billing/accounts/${guest.accountId}`);
    expect(g.referral.invitedBy.accountId).toBe(host.accountId);
    const hostView = await as("billing_admin").expect(200, "GET", `/admin/v1/billing/accounts/${host.accountId}`);
    expect(hostView.referral).toMatchObject({ code, invited: 1, bonusDaysThisYear: 30 });
  });

  it("turning off stops new trials and invite bonuses, and keeps the free periods already given", async () => {
    const before = await signedIn("beforeoff");
    const kept = (await ent(before)).personal.accessUntil;
    const off = await as("billing_admin").expect(200, "PUT", "/admin/v1/billing/program", {
      ...(await program()).settings,
      enabled: false,
      reason: "Pausing the trial program",
    });
    expect(off).toMatchObject({ source: "console", live: false });
    expect((await h.app.inject({ method: "GET", url: "/v2/billing/plans" })).json().trial).toBeNull();
    expect((await ent(before)).personal).toMatchObject({ accessUntil: kept, trial: { source: "signup" } });
    const after = await signedIn("afteroff");
    expect((await ent(after)).personal.trial).toBeNull();
    const { code } = await before.req("GET", "/v2/billing/referral");
    await expectStatus(after.req("POST", "/v2/billing/referral/claim", { code }), 409);
  });

  it("starts on a future date only from then, and can hand the decision back to the environment", async () => {
    const p = await turnOn({ startsAt: Date.now() + 3 * DAY });
    expect(p.live).toBe(false);
    expect(p.warnings.join(" ")).toMatch(/starts on/);
    expect((await ent(await signedIn("tooearly"))).personal.trial).toBeNull();
    const back = await as("billing_admin").expect(200, "PUT", "/admin/v1/billing/program", { useEnvironment: true, reason: "Back to the server's settings" });
    expect(back).toMatchObject({ source: "environment", live: false, updatedBy: null });
    const warn = await turnOn({ planKey: "max" });
    expect(warn.warnings.join(" ")).toMatch(/no plan with the key "max"/);
    await as("billing_admin").expect(200, "PUT", "/admin/v1/billing/program", { useEnvironment: true, reason: "Back to the server's settings" });
  });

  describe("Mojo's enforcement and limits", () => {
    const controls = async () => {
      const c = await as("billing_admin").expect(200, "GET", "/admin/v1/billing/mojo");
      expect(AdminMojoControls.safeParse(c).success).toBe(true);
      return c;
    };
    const save = (body: Record<string, unknown>) => as("billing_admin").req("PUT", "/admin/v1/billing/mojo", { enforce: null, plans: {}, levels: {}, reason: "Testing Mojo's limits in the console", ...body });

    it("start from the built-in numbers, not enforced while nothing is on sale", async () => {
      const c = await controls();
      expect(c).toMatchObject({ enforced: false, enforce: { console: null, environment: "auto", effective: "auto" }, overrides: { plans: {}, levels: {} }, updatedBy: null });
      expect(c.plans.map((p: any) => [p.key, p.messageChars])).toEqual([["free", 1000], ["go", 2000], ["plus", 5000]]);
      expect(h.ctx.mojo.limitsOf("u_nobody")).toBeNull();
    });

    it("turn enforcement on and change a plan's numbers, at once, for the server and the apps' catalog", async () => {
      const r = await save({ enforce: "on", plans: { free: { messageChars: 800, uploadBytes: 25_000_000 } }, levels: { "1": { sparks: 3 } } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ enforced: true, enforce: { console: "on", effective: "on" }, overrides: { plans: { free: { messageChars: 800, uploadBytes: 25_000_000 } }, levels: { "1": { sparks: 3 } } } });
      expect(r.body.catalogVersion).toMatch(/\+\d+$/);
      expect(h.ctx.mojo.enforced()).toBe(true);
      expect(h.ctx.mojo.limitsOf("u_nobody")).toMatchObject({ key: "free", messageChars: 800, uploadBytes: 25_000_000 });
      expect(h.ctx.mojo.levelOf(null).level).toBe(0);
      const catalog = (await h.app.inject({ method: "GET", url: "/v2/mojo/catalog" })).json();
      expect(catalog.enforced).toBe(true);
      expect(catalog.version).toBe(r.body.catalogVersion);
      expect(catalog.plans.find((p: any) => p.key === "free")).toMatchObject({ messageChars: 800, uploadBytes: 25_000_000 });
      expect(catalog.spark.levels[1]).toMatchObject({ level: 1, sparks: 3 });
      const audit = h.ctx.db.prepare("SELECT reason, detail FROM platform_audit WHERE action = 'mojo.controls_update' ORDER BY id DESC LIMIT 1").get() as any;
      expect(JSON.parse(audit.detail)).toMatchObject({ enforceBefore: "environment", enforceAfter: "on", enforcedBefore: false, enforcedAfter: true });
    });

    it("refuse numbers out of bounds and Spark levels that don't rise, and changes from roles that can't manage billing", async () => {
      expect((await save({ plans: { go: { messageChars: 5 } } })).status).toBe(400);
      expect((await save({ plans: { go: { uploadBytes: 9_000_000_000 } } })).status).toBe(400);
      expect((await save({ levels: { "2": { sparks: 1 } } })).status).toBe(400);
      expect((await save({ plans: { go: { name: "Cheap" } } })).status).toBe(400);
      expect((await as("support_admin").req("PUT", "/admin/v1/billing/mojo", { enforce: "off", plans: {}, levels: {}, reason: "Testing Mojo's limits in the console" })).status).toBe(403);
      expect((await controls()).enforce.console).toBe("on");
    });

    it("hand enforcement back to the environment, and show gifts and Sparks as metadata", async () => {
      const r = await save({});
      expect(r.body).toMatchObject({ enforced: false, enforce: { console: null, effective: "auto" }, overrides: { plans: {}, levels: {} } });
      expect(h.ctx.mojo.limitsOf("u_nobody")).toBeNull();
      const gifts = await as("billing_admin").expect(200, "GET", "/admin/v1/billing/gifts");
      expect(AdminMojoGiftsPage.safeParse(gifts).success).toBe(true);
      const sparks = await as("billing_admin").expect(200, "GET", "/admin/v1/billing/sparks");
      expect(AdminMojoSparks.safeParse(sparks).success).toBe(true);
    });
  });
});
