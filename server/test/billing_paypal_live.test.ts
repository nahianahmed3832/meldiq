import { afterEach, expect, it, vi } from "vitest";
import { HttpPayPalApi, PayPalResourceNotFound } from "../src/modules/billing/providers/paypalApi.js";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";

afterEach(() => vi.unstubAllGlobals());
it.each([["GET", 404, true], ["POST", 404, false], ["GET", 401, false]] as const)("classifies %s %i without exposing provider data", async (method, status, missing) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/token") ? { access_token: "fake", expires_in: 300 } : { privatePayerData: "must-not-leak" }), { status: url.endsWith("/token") ? 200 : status })));
  const error = await new HttpPayPalApi("fake", "fake", "live").request(method, "/v1/billing/subscriptions/I-EXPIRED").catch((e) => e);
  expect(error instanceof PayPalResourceNotFound).toBe(missing);
  expect(error.message).not.toContain("must-not-leak");
});
it.each(["live", "sandbox"] as const)("keeps %s OAuth and resource traffic on the matching host", async (environment) => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    return new Response(JSON.stringify(url.endsWith("/token") ? { access_token: "fake-private-token", expires_in: 300 } : { id: "P-TEST" }), { status: 200 });
  }));
  await new HttpPayPalApi("fake-public", "fake-secret", environment).request("GET", "/v1/billing/plans/P-TEST");
  const host = environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  expect(requests).toEqual([`${host}/v1/oauth2/token`, `${host}/v1/billing/plans/P-TEST`]);
});

it("schedules the server-owned free period without a trial cycle or unpaid entitlements", async () => {
  const now = Date.now(), start = now + 7 * 86400000;
  let created: any;
  const api = { request: vi.fn(async (method: string, path: string, body?: unknown) => {
    if (path === "/v1/billing/plans/P-TEST") return { id: "P-TEST", status: "ACTIVE", billing_cycles: [{ tenure_type: "REGULAR", total_cycles: 0, frequency: { interval_unit: "MONTH", interval_count: 1 }, pricing_scheme: { fixed_price: { currency_code: "USD", value: "3.99" } } }] };
    if (method === "POST") { created = body; return { ...created, id: "I-FUTURE", plan_id: "P-TEST", status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://www.paypal.com/checkoutnow?token=TEST" }] }; }
    return { ...created, id: "I-FUTURE", status: "ACTIVE", links: [] };
  }) };
  const provider = new PayPalProvider({ environment: "live", clientId: "fake-public", clientSecret: "fake-secret", merchantId: "FAKE", webhookId: "WH-FAKE", plusPlanId: "P-TEST", subscriptionsApproved: true, api, clock: () => now });
  await provider.createCheckout({ reference: "chk_future", priceRef: "P-TEST", trialDays: 0, trialEndsAt: start, customerRef: null, owner: { kind: "account", id: "acc_fake" }, successUrl: "https://meldiq.test/settings/checkout", cancelUrl: "https://meldiq.test/settings/checkout" });
  expect(created.start_time).toBe(new Date(start).toISOString());
  expect(created).not.toHaveProperty("plan");
  expect(await provider.fetchSubscription("I-FUTURE")).toMatchObject({ approvalConfirmed: true, status: "incomplete", currentPeriodEnd: null, trialEnd: start });
  expect(provider.supportsOneTimePurchases).toBe(false);
  await expect(provider.createPaymentCheckout({ reference: "gift_fake", customerRef: null, owner: { kind: "account", id: "acc_fake" }, currency: "USD", amountMinor: 399, productName: "Gift", successUrl: "https://meldiq.test", cancelUrl: "https://meldiq.test" })).rejects.toThrow(/not enabled/);
});

it("rejects Sandbox webhook certificates in live mode before verification traffic", async () => {
  const request = vi.fn();
  const provider = new PayPalProvider({ environment: "live", clientId: "fake-public", clientSecret: "fake-secret", merchantId: "FAKE", webhookId: "WH-FAKE", plusPlanId: "P-TEST", subscriptionsApproved: true, api: { request } });
  await expect(provider.verifyWebhook({ "paypal-transmission-id": "TX", "paypal-transmission-time": new Date().toISOString(), "paypal-transmission-sig": "fake", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/FAKE", "paypal-auth-algo": "SHA256withRSA" }, "{}", Date.now())).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
