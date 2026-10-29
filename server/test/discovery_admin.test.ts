import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, email, MemoryMailer } from "./support/accounts.js";
import { type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Discovery in the console (community parity batch E, docs/COMMUNITY_PARITY_API.md › Discovery): staff grant boosts
 * and Promoted weeks while billing is off, cancel them, take a community out of Discovery or mark it as Meldiq's own.
 * Each change needs the right console role and a reason, and lands in the console's audit log.
 */
let h: Harness;
const mailer = new MemoryMailer();
let billing: ConsoleAdmin, support: ConsoleAdmin, auditor: ConsoleAdmin;
let person: AccountClient;
let orgId: string;
const REASON = "Owner testing Promote";
const lastAudit = (action: string) => h.ctx.platform.get<any>("platform_audit", { action }, [["id", "desc"]]);

beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: "https://admin.example.test" }, { mailer });
  billing = await consoleAdmin(h, mailer, "billing_admin", "dsbilling");
  support = await consoleAdmin(h, mailer, "super_admin", "dssuper");
  auditor = await consoleAdmin(h, mailer, "auditor", "dsauditor");
  person = await new AccountClient(h.baseUrl, email("dsperson")).signUp(mailer);
  await person.signIn();
  await person.setUpIdentity(`dsperson${Date.now().toString(36)}`);
  orgId = (await person.req("POST", "/v1/orgs", { name: "Console Promote Lab", visibility: "public", joinPolicy: "open" })).org.id;
}, 120_000);
afterAll(async () => h.close());

describe("discovery in the console", () => {
  it("grants a boost and a Promoted week, shown on Discover at once", async () => {
    expect((await auditor.browser.req("POST", `/admin/v1/discovery/orgs/${orgId}/boosts`, { tier: "mega", weeks: 1, reason: REASON })).status).toBe(403);
    const boosted = await billing.browser.expect(200, "POST", `/admin/v1/discovery/orgs/${orgId}/boosts`, { tier: "mega", weeks: 2, reason: REASON });
    expect(boosted.discovery.boosts).toEqual([expect.objectContaining({ tier: "mega", state: "active", source: "grant" })]);
    expect(lastAudit("discovery.boost_grant")).toMatchObject({ target_id: orgId, reason: REASON });
    const promoted = await billing.browser.expect(200, "POST", `/admin/v1/discovery/orgs/${orgId}/promoted`, { reason: REASON });
    expect(promoted.discovery.bookings).toHaveLength(1);
    const page = await person.req("GET", "/v1/discover");
    expect(page.promoted.map((c: { id: string }) => c.id)).toEqual([orgId]);
    expect(page.communities[0]).toMatchObject({ id: orgId, label: "mega", memberCount: 1 });
    const seen = await auditor.browser.expect(200, "GET", `/admin/v1/discovery/orgs/${orgId}`);
    expect(seen.discovery).toMatchObject({ removedAt: null, official: false });
  });

  it("cancels them, takes the community out of Discovery and marks it official", async () => {
    const view = await auditor.browser.expect(200, "GET", `/admin/v1/discovery/orgs/${orgId}`);
    await billing.browser.expect(200, "POST", `/admin/v1/discovery/boosts/${view.discovery.boosts[0].id}/cancel`, { reason: REASON });
    await billing.browser.expect(409, "POST", `/admin/v1/discovery/boosts/${view.discovery.boosts[0].id}/cancel`, { reason: REASON });
    await billing.browser.expect(200, "POST", `/admin/v1/discovery/promoted/${view.discovery.bookings[0].id}/cancel`, { reason: REASON });
    expect((await person.req("GET", "/v1/discover")).communities).toEqual([]);
    await billing.browser.expect(403, "PUT", `/admin/v1/discovery/orgs/${orgId}`, { removed: true, reason: "Spam" });
    const removed = await support.browser.expect(200, "PUT", `/admin/v1/discovery/orgs/${orgId}`, { removed: true, official: true, reason: "Spam reports" });
    expect(removed.discovery).toMatchObject({ removedAt: expect.any(Number), removedReason: "Spam reports", official: true });
    expect((await person.req("GET", `/v1/orgs/${orgId}/discovery`)).reason).toBe("removed");
    expect(lastAudit("discovery.update")).toMatchObject({ target_id: orgId, reason: "Spam reports" });
    await support.browser.expect(404, "GET", "/admin/v1/discovery/orgs/o_nowhere");
  });
});
