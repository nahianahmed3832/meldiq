import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { digest, secret } from "../src/modules/accounts/social/service.js";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

const release = {
  minimumAge: 13,
  terms: { revision: "test-terms.1", url: "https://meldiq.app/legal/terms/test-terms.1" },
  privacy: { revision: "test-privacy.2", url: "https://meldiq.app/legal/privacy/test-privacy.2" },
};
const accepted = { ageAtLeast13: true, termsAccepted: true, privacyAcknowledged: true, termsRevision: release.terms.revision, privacyRevision: release.privacy.revision };

describe.each(process.env.MELDIQ_TEST_PG_URL ? ["postgres"] : ["sqlite", "mongodb"])("signup policy in %s", (backend) => {
  let h: Harness;
  const mailer = new MemoryMailer();
  beforeAll(async () => {
    h = await startServer({
      MELDIQ_SIGNUP_POLICY: JSON.stringify(release),
      ...(backend === "mongodb" && { MONGODB_DOMAINS: "accounts" }),
      SUPABASE_AUTH_URL: "https://test-auth.example",
      SUPABASE_AUTH_PUBLISHABLE_KEY: "sb_publishable_test",
      SOCIAL_AUTH_PUBLIC_ORIGIN: "https://web.example",
      SOCIAL_AUTH_WEB_ORIGIN: "https://web.example",
      SOCIAL_AUTH_PROVIDERS: "google,discord",
    }, { mailer });
    expect(h.ctx.accounts.store.backend).toBe(backend);
    vi.spyOn(h.ctx.accounts.social.provider!, "authorize").mockResolvedValue("https://accounts.google.com/o/oauth2/v2/auth?state=upstream-state");
    vi.spyOn(h.ctx.accounts.social.provider!, "exchange").mockImplementation(async (code) => JSON.parse(code));
  }, 120_000);
  afterAll(async () => h?.close());

  it("publishes the exact enabled revision and rejects missing, stale or false attestations before signup", async () => {
    const client = new AccountClient(h.baseUrl, email("policy"));
    expect((await client.req("GET", "/v1/server-info")).features).toContain("registration-policy");
    expect(await client.req("GET", "/v2/auth/registration-policy")).toEqual({ policy: release });
    const body = { name: "Policy test", email: client.email, password: PASSWORD };
    await expectStatus(client.req("POST", "/v2/auth/register", body), 409);
    await expectStatus(client.req("POST", "/v2/auth/register", { ...body, policyAcceptance: { ...accepted, termsRevision: "old" } }), 409);
    await expectStatus(client.req("POST", "/v2/auth/register", { ...body, policyAcceptance: { ...accepted, ageAtLeast13: false } }), 400);
    expect(await h.ctx.accounts.store.accountByEmail(client.email)).toBeUndefined();
    expect(mailer.sent.some((m) => m.to === client.email)).toBe(false);
  });

  it("atomically records the accepted versions with the new account and leaves verified accounts unchanged", async () => {
    const client = new AccountClient(h.baseUrl, email("accepted"));
    const body = { name: "Policy test", email: client.email, password: PASSWORD, policyAcceptance: accepted };
    const before = Date.now();
    expect((await client.req("POST", "/v2/auth/register", body)).status).toBe("verification_sent");
    const created = (await h.ctx.accounts.store.accountByEmail(client.email))!;
    const ledger = JSON.parse((created as unknown as { signup_policy_acceptance: string }).signup_policy_acceptance);
    expect(ledger).toEqual({ termsRevision: release.terms.revision, privacyRevision: release.privacy.revision, declaredMinimumAge: 13, entryPath: "email", recordedAt: expect.any(Number) });
    expect(ledger.recordedAt).toBeGreaterThanOrEqual(before);
    expect(ledger.recordedAt).toBeLessThanOrEqual(Date.now());
    await client.req("POST", "/v2/auth/email/verify", { email: client.email, code: mailer.verifyCode(client.email), password: PASSWORD });
    expect(JSON.stringify(await client.signIn())).not.toContain("signup_policy_acceptance");
    await client.req("POST", "/v2/auth/register", { ...body, name: "Does not replace a verified account" });
    expect(await h.ctx.accounts.store.accountByEmail(client.email)).toMatchObject({ id: created.id, signup_policy_acceptance: JSON.stringify(ledger), name: "Policy test" });
  });

  it("does not replace verified credentials or acceptance when the address is verified mid-request", async () => {
    const client = new AccountClient(h.baseUrl, email("policy-race"));
    const body = { name: "Address owner", email: client.email, password: PASSWORD, policyAcceptance: accepted };
    await client.req("POST", "/v2/auth/register", body);
    const initial = (await h.ctx.accounts.store.accountByEmail(client.email))!;
    let arrived!: () => void, resume!: () => void;
    const queued = new Promise<void>((resolve) => { arrived = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    const replace = h.ctx.accounts.store.replacePendingSignup.bind(h.ctx.accounts.store);
    const hold = vi.spyOn(h.ctx.accounts.store, "replacePendingSignup").mockImplementation(async (...args) => { arrived(); await release; return replace(...args); });
    const attempted = client.req("POST", "/v2/auth/register", { ...body, name: "Other person", password: "a different valid password" });
    try {
      await Promise.race([queued, attempted.then(() => { throw new Error("Registration did not reach the race gate"); })]);
      await client.req("POST", "/v2/auth/email/verify", { email: client.email, code: mailer.verifyCode(client.email), password: PASSWORD });
    } finally {
      resume();
      await attempted;
      hold.mockRestore();
    }
    const current = (await h.ctx.accounts.store.accountByEmail(client.email))!;
    expect(current).toMatchObject({ name: "Address owner", password_hash: initial.password_hash, signup_policy_acceptance: initial.signup_policy_acceptance, email_verified_at: expect.any(Number) });
    await client.signIn();
  });

  it.each(["google", "discord"] as const)("requires policy only for new %s accounts and keeps the verified receipt retryable", async (provider) => {
    const client = new AccountClient(h.baseUrl, email(provider));
    const identity = { provider, issuer: provider === "google" ? "https://accounts.google.com" : "https://discord.com", subject: secret(), email: client.email };
    const ready = async () => {
      const verifier = secret();
      const start = await client.req("POST", "/v2/auth/social/start", { provider, challenge: digest(verifier), mode: "login" });
      const auth = await h.app.inject({ method: "GET", url: `/v2/auth/social/authorize/${start.id}` });
      const result = await h.app.inject({ method: "GET", url: `/v2/auth/social/callback?code=${encodeURIComponent(JSON.stringify(identity))}`, headers: { cookie: String(auth.headers["set-cookie"]).split(";")[0] } });
      const receipt = new URLSearchParams(new URL(String(result.headers.location)).hash.slice(1)).get("receipt");
      expect(receipt).toBeTruthy();
      return { id: start.id, verifier, receipt };
    };
    const flow = await ready();
    await expectStatus(client.req("POST", "/v2/auth/social/complete", flow), 409);
    expect(await h.ctx.accounts.store.accountByEmail(client.email)).toBeUndefined();
    const complete = await client.req("POST", "/v2/auth/social/complete", { ...flow, policyAcceptance: accepted });
    const returning = await client.req("POST", "/v2/auth/social/complete", await ready());
    expect(returning.grant.account.id).toBe(complete.grant.account.id);
    const account = (await h.ctx.accounts.store.accountByEmail(client.email))!;
    expect(JSON.parse((account as unknown as { signup_policy_acceptance: string }).signup_policy_acceptance)).toMatchObject({ entryPath: provider, declaredMinimumAge: 13 });
  });

  it("does not let legacy public registration bypass an enabled policy", async () => {
    await expectStatus(h.client("policylegacy"), 426);
  });

  it("requires the account holder's declaration before operator-provisioned identity activation", async () => {
    const client = new AccountClient(h.baseUrl, email("operator-policy"));
    const row = await h.ctx.accounts.service.createByOperator({
      id: `a_${secret()}`, name: "Operator provisioned", email: client.email, password: PASSWORD, verified: true,
    });
    expect(row?.signup_policy_acceptance).toBeFalsy();
    await client.signIn();
    const key = { identityKey: client.identityKeyB64 };
    const device = await client.deviceBody("register", key);
    await expectStatus(client.req("POST", "/v2/account/devices", device), 409);
    await expectStatus(client.req("POST", "/v2/account/identity/reset", {
      ...device, password: PASSWORD, policyAcceptance: { ...accepted, privacyRevision: "obsolete" },
    }), 409);
    expect(await h.ctx.accounts.store.accountById(row!.id)).toMatchObject({ user_id: null });
    expect((await h.ctx.accounts.store.accountById(row!.id))?.signup_policy_acceptance).toBeFalsy();
    const activated = await client.req("POST", "/v2/account/devices", { ...device, policyAcceptance: accepted });
    expect(activated).toMatchObject({ userId: expect.any(String), deviceId: expect.any(String), result: "identity" });
    const recorded = (await h.ctx.accounts.store.accountById(row!.id))!;
    expect(recorded.user_id).toBe(activated.userId);
    expect(JSON.parse(recorded.signup_policy_acceptance!)).toMatchObject({
      termsRevision: release.terms.revision, privacyRevision: release.privacy.revision,
      declaredMinimumAge: 13, entryPath: "operator-activation", recordedAt: expect.any(Number),
    });
    await client.signIn();
    expect((await client.addThisDevice()).result).toBe("existing");
    expect((await h.ctx.accounts.store.accountById(row!.id))?.signup_policy_acceptance).toBe(recorded.signup_policy_acceptance);
  });
});
