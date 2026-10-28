import type { FastifyBaseLogger } from "fastify";
import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { type BillingOwner, ownerRef } from "./owners.js";
import { GIFT_MONTHS, GIFT_NOTE_MAX, type GiftMonths, isPlanKey, PLAN_PERKS, PLAN_RANK, type PlanKey } from "./perks.js";
import type { CheckoutSnapshot, PaymentSnapshot } from "./providers/types.js";
import type { Billing, CheckoutStarter } from "./service.js";
import type { ApplyOutcome } from "./subscriptions.js";
import type { PaymentEvents } from "./webhooks.js";

/**
 * Gifts of Meldiq Mojo (docs/MOJO.md › Gifts): a person pays once for Mojo Go or Plus for a friend, for 1, 3 or 12
 * months. Nothing renews. The gift exists for the friend only once the provider's signed event says the payment is in;
 * the friend then starts it when they like, so a gift to someone who already has Mojo is never wasted. Its time follows
 * on from any free period of the same or a higher plan they already have.
 *
 * - Price: the plan's published monthly price times the months, in its currency. The client names a plan and months,
 *   never an amount.
 * - Not to oneself (buy the plan instead). The recipient must be a Meldiq user the buyer can see.
 * - Refunded before it's started: it can't be started. Refunded after: recorded; whether to end it is a business decision
 *   (today: no, as with subscriptions).
 */
export type GiftStatus = "pending" | "paid" | "redeemed" | "refunded" | "expired" | "failed";

export interface GiftRow {
  id: string;
  buyer_account_id: string;
  buyer_user_id: string | null;
  recipient_user_id: string;
  plan_key: "go" | "plus";
  months: GiftMonths;
  currency: string;
  amount_minor: number;
  note: string | null;
  status: GiftStatus;
  provider: string;
  provider_session_ref: string | null;
  provider_payment_ref: string | null;
  grant_id: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
  redeemed_at: number | null;
  updated_at: number;
}

const CHECKOUT_TTL_MS = 24 * 3_600_000;
/** How long a gift bought in an app store waits for the store's payment (Google Play's pending payments clear in days). */
const STORE_PENDING_MS = 7 * 24 * 3_600_000;
/** Gift ids (newId("gft")): how a checkout event is told apart from a plan's. */
export const GIFT_PREFIX = "gft_";

/** [t] plus [months] calendar months (the same day of the month, or the month's last day). */
export function addMonths(t: number, months: number): number {
  const d = new Date(t);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

export interface GiftDeps {
  /** Whether [userId] is a Meldiq user (users.id) [buyerUserId] may give to. */
  canReceive: (recipientUserId: string, buyerUserId: string | null) => boolean;
  /** Told when a gift's state changes for its recipient (realtime notice). */
  notify: (recipientUserId: string) => void;
}

export class Gifts implements PaymentEvents {
  constructor(
    private readonly billing: Billing,
    private readonly rows: Rows,
    private readonly deps: GiftDeps,
    private readonly log: FastifyBaseLogger,
    private readonly clock: () => number = Date.now,
  ) {}

  get(id: string): GiftRow | null {
    return this.rows.get<GiftRow>("mojo_gifts", { id }) ?? null;
  }

  /** The plan's current price for [months], from the published catalog at the configured provider; null: not on sale. */
  price(planKey: PlanKey, months: number): { currency: string; amountMinor: number } | null {
    const provider = this.billing.provider;
    const plan = this.billing.catalog.byKey(planKey);
    const v = plan && plan.public && plan.status === "active" ? this.billing.catalog.current(plan.id) : null;
    if (!provider || !v || v.provider !== provider.id || v.interval !== "month") return null;
    return { currency: v.currency, amountMinor: v.amount_minor * months };
  }

  /** Starts paying for a gift: the provider's hosted page, priced by the server. */
  async start(
    starter: CheckoutStarter & { accountId: string },
    input: { recipientUserId: string; planKey: string; months: number; note?: string | null },
    returnUrl: string | null,
  ): Promise<{ giftId: string; url: string | null; expiresAt: number }> {
    const provider = this.billing.requireProvider();
    if (!provider.createPaymentCheckout) throw new ApiError(409, "billing_unavailable", "Gifts can't be bought with this payment provider");
    const { planKey, note } = this.validate(starter, input);
    const price = this.price(planKey, input.months);
    if (!price) throw new ApiError(409, "billing_unavailable", "Mojo isn't on sale yet");
    const t = this.clock();
    const id = newId("gft");
    await this.rows.write((w) =>
      w.insert("mojo_gifts", {
        id, buyer_account_id: starter.accountId, buyer_user_id: starter.userId, recipient_user_id: input.recipientUserId, plan_key: planKey, months: input.months,
        currency: price.currency, amount_minor: price.amountMinor, note: note || null, status: "pending", provider: provider.id, provider_session_ref: null,
        provider_payment_ref: null, grant_id: null, created_at: t, expires_at: t + CHECKOUT_TTL_MS, paid_at: null, redeemed_at: null, updated_at: t,
      }),
    );
    const owner: BillingOwner = { kind: "account", accountId: starter.accountId };
    let session: { sessionRef: string; url: string | null };
    try {
      const customerRef = await this.billing.customerFor(provider, owner, starter);
      const name = `${PLAN_PERKS[planKey].name} for ${input.months} month${input.months === 1 ? "" : "s"} (a gift)`;
      session = await provider.createPaymentCheckout({
        reference: id, customerRef, owner: ownerRef(owner), currency: price.currency, amountMinor: price.amountMinor, productName: name,
        successUrl: `${returnUrl ?? ""}?gift=success`, cancelUrl: `${returnUrl ?? ""}?gift=canceled`,
      });
    } catch (e) {
      await this.rows.write((w) => w.update("mojo_gifts", { id }, { status: "failed", updated_at: this.clock() }));
      if (e instanceof ApiError) throw e;
      this.log.error({ err: e, gift: id }, "billing provider gift checkout failed");
      throw new ApiError(503, "unavailable", "The payment provider couldn't be reached. Nothing was charged. Try again in a moment.");
    }
    await this.rows.write((w) => w.update("mojo_gifts", { id }, { provider_session_ref: session.sessionRef, updated_at: this.clock() }));
    return { giftId: id, url: session.url, expiresAt: t + CHECKOUT_TTL_MS };
  }

  private validate(starter: { userId: string | null }, input: { recipientUserId: string; planKey: string; months: number; note?: string | null }): { planKey: "go" | "plus"; note: string } {
    if (!isPlanKey(input.planKey) || input.planKey === "free") throw notFound("No such plan");
    const planKey = input.planKey;
    if (!(GIFT_MONTHS as readonly number[]).includes(input.months)) throw badRequest(`Gifts are for ${GIFT_MONTHS.join(", ")} months`);
    const note = (input.note ?? "").trim();
    if (note.length > GIFT_NOTE_MAX) throw badRequest(`A gift note is up to ${GIFT_NOTE_MAX} characters`);
    if (input.recipientUserId === starter.userId) throw conflict("Gifts are for friends: get Mojo for yourself from the plans above");
    // An unknown recipient and one the buyer can't give to answer alike: nobody learns who has an account.
    if (!this.deps.canReceive(input.recipientUserId, starter.userId)) throw notFound("That person can't receive gifts");
    return { planKey, note };
  }

  /**
   * A gift bought in an app store (Google Play, play.ts): recorded before the store's sheet opens, under the same rules
   * as on the website, and paid only by the store purchase the server verifies with the store. The store charges its own
   * localized price; the row keeps the plan's list price for the record. A store's pending payment (cash, bank) can take
   * days, so the gift waits longer than a website checkout.
   */
  async startStore(
    starter: { accountId: string; userId: string | null },
    input: { recipientUserId: string; planKey: string; months: number; note?: string | null },
    provider: string,
  ): Promise<{ giftId: string }> {
    const { planKey, note } = this.validate(starter, input);
    const t = this.clock();
    const id = newId("gft");
    await this.rows.write((w) =>
      w.insert("mojo_gifts", {
        id, buyer_account_id: starter.accountId, buyer_user_id: starter.userId, recipient_user_id: input.recipientUserId, plan_key: planKey, months: input.months,
        currency: "USD", amount_minor: PLAN_PERKS[planKey].listPriceMinor * input.months, note: note || null, status: "pending", provider, provider_session_ref: null,
        provider_payment_ref: null, grant_id: null, created_at: t, expires_at: t + STORE_PENDING_MS, paid_at: null, redeemed_at: null, updated_at: t,
      }),
    );
    return { giftId: id };
  }

  /** A gift's checkout finished or ran out (PaymentEvents): only a paid one becomes a gift the friend sees. */
  applyCheckout(w: RowWriter, provider: string, snap: CheckoutSnapshot, t: number): ApplyOutcome | null {
    if (snap.mode !== "payment" || !snap.reference?.startsWith(GIFT_PREFIX)) return null;
    const g = w.get<GiftRow>("mojo_gifts", { id: snap.reference, provider });
    if (!g) return { result: "stale", subscriptionId: null, owner: null };
    const owner: BillingOwner = { kind: "account", accountId: g.buyer_account_id };
    if (snap.outcome === "completed") {
      if (snap.customerRef) this.billing.subscriptions.rememberCustomer(w, provider, owner, snap.customerRef, t);
      // A completed checkout paid by a delayed method is paid only at its async_payment_succeeded event.
      if (!snap.paid || g.status !== "pending") return { result: g.status === "pending" ? "stale" : "applied", subscriptionId: null, owner };
      w.update("mojo_gifts", { id: g.id }, { status: "paid", paid_at: t, provider_payment_ref: snap.paymentRef ?? null, updated_at: t });
      this.afterCommit(g.recipient_user_id);
      return { result: "applied", subscriptionId: null, owner };
    }
    if (g.status === "pending") w.update("mojo_gifts", { id: g.id }, { status: snap.outcome === "expired" ? "expired" : "failed", updated_at: t });
    return { result: "applied", subscriptionId: null, owner };
  }

  /** A refund on a gift's payment (PaymentEvents): an unstarted gift can't be started any more. */
  applyPayment(w: RowWriter, provider: string, p: PaymentSnapshot, t: number): ApplyOutcome | null {
    if (p.kind !== "refund" || !p.paymentRef) return null;
    const g = w.get<GiftRow>("mojo_gifts", { provider, provider_payment_ref: p.paymentRef });
    if (!g) return null;
    const owner: BillingOwner = { kind: "account", accountId: g.buyer_account_id };
    if (g.status === "paid" && p.state === "refunded") {
      w.update("mojo_gifts", { id: g.id }, { status: "refunded", updated_at: t });
      this.afterCommit(g.recipient_user_id);
    }
    return { result: "applied", subscriptionId: null, owner };
  }

  private afterCommit(recipientUserId: string): void {
    // After the unit commits (a notice for a change that rolled back would only cause a needless refresh).
    queueMicrotask(() => {
      try {
        this.deps.notify(recipientUserId);
      } catch (e) {
        this.log.warn({ err: e }, "gift notice failed");
      }
    });
  }

  /**
   * The recipient starts a paid gift: a free period of its plan, following on from any free period of the same or a
   * higher plan they have. Once only.
   */
  async redeem(recipient: { accountId: string; userId: string }, giftId: string): Promise<{ startsAt: number; endsAt: number }> {
    const t = this.clock();
    return this.rows.write((w) => {
      const g = w.get<GiftRow>("mojo_gifts", { id: giftId });
      if (!g || g.recipient_user_id !== recipient.userId) throw notFound("Gift not found");
      if (g.status === "redeemed") throw conflict("This gift is already started");
      if (g.status !== "paid") throw forbidden(g.status === "refunded" ? "This gift was refunded" : "This gift isn't paid for");
      const sameOrHigher = (["go", "plus"] as const).filter((k) => PLAN_RANK[k] >= PLAN_RANK[g.plan_key]);
      const startsAt = Math.max(t, this.billing.grants.latestEnd(recipient.accountId, sameOrHigher, t, w) ?? t);
      const endsAt = addMonths(startsAt, g.months);
      const grantId = this.billing.grants.addGift(w, { accountId: recipient.accountId, userId: recipient.userId, planKey: g.plan_key, giftId: g.id, startsAt, endsAt });
      w.update("mojo_gifts", { id: g.id }, { status: "redeemed", redeemed_at: t, grant_id: grantId, updated_at: t });
      return { startsAt, endsAt };
    });
  }

  /** Gifts for [userId] that are paid or started, and gifts [accountId] bought, newest first. */
  listFor(accountId: string, userId: string | null) {
    const received = userId
      ? this.rows.all<GiftRow>("mojo_gifts", { where: { recipient_user_id: userId, status: { in: ["paid", "redeemed"] } }, orderBy: [["paid_at", "desc"]] })
      : [];
    const sent = this.rows.all<GiftRow>("mojo_gifts", { where: { buyer_account_id: accountId, status: { ne: "pending" } }, orderBy: [["created_at", "desc"]], limit: 50 });
    return { received, sent };
  }

  /** Closes unpaid gift checkouts past their time (the cleanup job). */
  async sweep(): Promise<number> {
    const due = { status: "pending", expires_at: { lte: this.clock() } };
    if (!this.rows.get("mojo_gifts", due)) return 0;
    return this.rows.write((w) => w.update("mojo_gifts", due, { status: "expired", updated_at: this.clock() }));
  }
}
