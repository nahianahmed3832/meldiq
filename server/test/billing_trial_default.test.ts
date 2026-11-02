import { expect, it } from "vitest";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { expectStatus, startServer } from "./support/harness.js";

it("keeps a new account free after unsuccessful checkout and repeated billing reads", async () => {
  const mailer = new MemoryMailer();
  const h = await startServer({ BILLING_TRIAL_STARTS_AT: new Date(Date.now() - 1000).toISOString() }, { mailer });
  try {
    const account = await AccountClient.ready(h.baseUrl, mailer, "noautomatictrial");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await account.req("GET", "/v2/billing/entitlements")).personal).toMatchObject({ plan: null, trial: null });
      expect((await account.req("GET", "/v2/mojo/me")).plan).toBe("free");
      expect((await account.req("GET", "/v2/billing/account")).freePeriod).toBeNull();
      await expectStatus(account.req("POST", "/v2/billing/checkout", { planKey: "plus" }), 409);
    }
    expect(h.ctx.billing.rows.count("billing_grants", { account_id: account.accountId })).toBe(0);
    expect((await account.req("GET", "/v2/billing/plans")).trial.days).toBe(0);
  } finally {
    await h.close();
  }
}, 120_000);
