import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxProvider } from "../src/modules/billing/providers/sandbox.js";
import type { CheckoutSnapshot, NormalizedEvent } from "../src/modules/billing/providers/types.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { type Harness, startServer } from "./support/harness.js";

for (const backend of ["sqlite", "mongodb"] as const) {
  describe(`one-time Sparks (${backend})`, () => {
    let h: Harness;
    const mailer = new MemoryMailer();
    beforeAll(async () => {
      const provider = new SandboxProvider("spark-checkout-test-secret-at-least-32-characters");
      // Deterministic payment API; signed provider/REST verification is covered by the PayPal integration suite.
      Object.assign(provider, { createPaymentCheckout: async (input: { reference: string }) => ({ sessionRef: `test_order_${input.reference}`, url: null }) });
      h = await startServer({ MONGODB_DOMAINS: backend === "mongodb" ? "billing" : "" }, { mailer, billingProvider: provider });
    });
    afterAll(async () => h.close());
    async function purchase(quantity = 1) {
      const account = await AccountClient.ready(h.baseUrl, mailer, `spark${crypto.randomBytes(3).toString("hex")}`);
      const started = await h.ctx.billing.sparkPurchases.start({ accountId: account.accountId, userId: account.userId, email: account.email, name: account.name }, quantity, null, crypto.randomUUID());
      return { account, row: h.ctx.billing.sparkPurchases.get(started.purchaseId)! };
    }
    function event(row: Awaited<ReturnType<typeof purchase>>["row"], extra: Partial<CheckoutSnapshot> = {}): NormalizedEvent {
      return { ref: `evt_${crypto.randomUUID()}`, type: "checkout.payment", createdAt: Date.now(), kind: "checkout", checkout: {
        sessionRef: row.provider_session_ref!, reference: row.id, mode: "payment", customerRef: null, subscriptionRef: null,
        paymentRef: `payment_${row.id}`, outcome: "completed", paid: true, currency: "USD", amountMinor: row.quantity * 99, ...extra,
      } };
    }
    it("advertises USD 0.99 per one-time Spark independently of Plus", async () => {
      const response = await fetch(`${h.baseUrl}/v2/mojo/catalog`);
      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({ spark: { listPriceMinor: 99, interval: "one_time" }, onSale: { plus: null, spark: { amountMinor: 99, currency: "USD" } } });
    });
    it("grants permanent slots only after verified payment, without a Plus subscription", async () => {
      const { account, row } = await purchase(3);
      expect(h.ctx.mojo.planOf(account.userId)).toBe("free");
      expect(h.ctx.mojo.sparkSlots(account.userId).purchased).toBe(0);
      await h.ctx.billing.webhooks.ingest("sandbox", event(row, { paid: false }));
      expect(h.ctx.mojo.sparkSlots(account.userId).purchased).toBe(0);
      const completed = event(row);
      await h.ctx.billing.webhooks.ingest("sandbox", completed);
      await h.ctx.billing.webhooks.ingest("sandbox", completed);
      await h.ctx.billing.webhooks.ingest("sandbox", event(row));
      expect(h.ctx.mojo.sparkSlots(account.userId)).toMatchObject({ purchased: 3, total: 3 });
      expect(h.ctx.billing.sparkPurchases.userIdsOf(account.accountId)).toContain(account.userId);
      expect(h.ctx.billing.subscriptions.liveForUser(account.userId)).toHaveLength(0);
    });
    it("does not grant for a changed amount, currency or provider order", async () => {
      for (const extra of [{ amountMinor: 1 }, { currency: "EUR" }, { sessionRef: "not_this_order" }]) {
        const { account, row } = await purchase();
        await h.ctx.billing.webhooks.ingest("sandbox", event(row, extra));
        expect(h.ctx.mojo.sparkSlots(account.userId).purchased).toBe(0);
        expect(h.ctx.billing.sparkPurchases.get(row.id)?.status).toBe("pending");
      }
    });
    it("reuses the same checkout request and refuses a quantity change", async () => {
      const { account, row } = await purchase(2);
      const starter = { accountId: account.accountId, userId: account.userId, email: account.email, name: account.name };
      const again = await h.ctx.billing.sparkPurchases.start(starter, 2, null, row.request_key!);
      expect(again.purchaseId).toBe(row.id);
      await expect(h.ctx.billing.sparkPurchases.start(starter, 3, null, row.request_key!)).rejects.toThrow(/another|different/);
    });
    it("refunds revoke slots and dominate a late capture event", async () => {
      const { account, row } = await purchase(2);
      await h.ctx.billing.webhooks.ingest("sandbox", event(row));
      expect(h.ctx.mojo.sparkSlots(account.userId).purchased).toBe(2);
      await h.ctx.billing.webhooks.ingest("sandbox", { ref: `refund_${row.id}`, type: "payment.refund", createdAt: Date.now(), kind: "payment", payment: {
        kind: "refund", state: "refunded", paymentRef: `payment_${row.id}`, purchaseRef: row.id, orderRef: row.provider_session_ref,
        currency: "USD", amountMinor: 198,
      } });
      expect(h.ctx.mojo.sparkSlots(account.userId).purchased).toBe(0);
      await h.ctx.billing.webhooks.ingest("sandbox", event(row));
      expect(h.ctx.mojo.sparkSlots(account.userId).purchased).toBe(0);
    });
  });
}
