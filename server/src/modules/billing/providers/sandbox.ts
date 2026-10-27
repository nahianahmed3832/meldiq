import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { SUBSCRIPTION_STATUSES } from "../lifecycle.js";
import { type BillingProvider, type NormalizedEvent, WebhookRejected } from "./types.js";

/**
 * The sandbox provider (BILLING_PROVIDER=sandbox): a test-mode stand-in with the same contract a real provider has, so
 * the whole flow (checkout, signed webhooks, lifecycle, invoices, entitlements) runs end to end without money. Its
 * events are signed like a real provider's: header `meldiq-sandbox-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<raw body>">` with BILLING_SANDBOX_WEBHOOK_SECRET, accepted within five minutes of [t].
 */
export const SANDBOX_SIGNATURE_HEADER = "meldiq-sandbox-signature";
const TOLERANCE_S = 300;

const zMs = z.number().int().nonnegative();
const zRef = z.string().min(1).max(200);

const SandboxSubscription = z.object({
  id: zRef,
  customer: zRef.nullable().default(null),
  status: z.enum(SUBSCRIPTION_STATUSES),
  price: zRef,
  checkoutReference: zRef.nullable().default(null),
  currentPeriodStart: zMs.nullable().default(null),
  currentPeriodEnd: zMs.nullable().default(null),
  trialEnd: zMs.nullable().default(null),
  cancelAtPeriodEnd: z.boolean().default(false),
  canceledAt: zMs.nullable().default(null),
});

const zMinor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SandboxInvoice = z.object({
  id: zRef,
  subscription: zRef.nullable().default(null),
  status: z.enum(["open", "paid", "payment_failed", "void", "uncollectible"]),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()),
  amountDue: zMinor,
  amountPaid: zMinor.default(0),
  amountRefunded: zMinor.default(0),
  tax: zMinor.nullable().default(null),
  periodStart: zMs.nullable().default(null),
  periodEnd: zMs.nullable().default(null),
  issuedAt: zMs,
  paidAt: zMs.nullable().default(null),
});

const SandboxEvent = z.object({
  id: zRef,
  type: z.string().min(1).max(100),
  created: zMs,
  data: z.object({ subscription: SandboxSubscription.optional(), invoice: SandboxInvoice.optional() }).default({}),
});

/** The signature header for [body] at [t] (seconds): used by tests and by `admin.js billing-sandbox-event`. */
export function signSandbox(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

function header(headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const v = headers[SANDBOX_SIGNATURE_HEADER];
  return typeof v === "string" ? v : null;
}

export class SandboxProvider implements BillingProvider {
  readonly id = "sandbox";
  readonly mode = "test" as const;

  constructor(private readonly secret: string) {}

  verifyWebhook(headers: Readonly<Record<string, string | string[] | undefined>>, rawBody: string, now: number): NormalizedEvent {
    const sig = header(headers);
    if (!sig) throw new WebhookRejected("missing_signature");
    const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=", 2) as [string, string]));
    const t = Number(parts.t);
    if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) throw new WebhookRejected("bad_signature");
    const expected = createHmac("sha256", this.secret).update(`${t}.${rawBody}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(parts.v1!, "hex"))) throw new WebhookRejected("bad_signature");
    if (Math.abs(now / 1000 - t) > TOLERANCE_S) throw new WebhookRejected("stale_timestamp");
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WebhookRejected("unreadable_body");
    }
    const parsed = SandboxEvent.safeParse(json);
    if (!parsed.success) throw new WebhookRejected("unreadable_body");
    const e = parsed.data;
    const base = { ref: e.id, type: e.type, createdAt: e.created };
    if (e.type.startsWith("subscription.") && e.data.subscription) {
      const s = e.data.subscription;
      return {
        ...base,
        kind: "subscription",
        subscription: {
          ref: s.id,
          customerRef: s.customer,
          status: s.status,
          priceRef: s.price,
          checkoutRef: s.checkoutReference,
          currentPeriodStart: s.currentPeriodStart,
          currentPeriodEnd: s.currentPeriodEnd,
          trialEnd: s.trialEnd,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          canceledAt: s.canceledAt,
        },
      };
    }
    if (e.type.startsWith("invoice.") && e.data.invoice) {
      const i = e.data.invoice;
      return {
        ...base,
        kind: "invoice",
        invoice: {
          ref: i.id,
          subscriptionRef: i.subscription,
          status: i.status,
          currency: i.currency,
          amountDueMinor: i.amountDue,
          amountPaidMinor: i.amountPaid,
          amountRefundedMinor: i.amountRefunded,
          taxMinor: i.tax,
          periodStart: i.periodStart,
          periodEnd: i.periodEnd,
          issuedAt: i.issuedAt,
          paidAt: i.paidAt,
        },
      };
    }
    return { ...base, kind: "other" };
  }

  async createCheckout(): Promise<{ sessionRef: string; url: string | null }> {
    // No hosted page: a test drives the rest with signed events naming the checkout reference.
    return { sessionRef: `sbx_cs_${randomBytes(9).toString("base64url")}`, url: null };
  }
}
