import type { SparkPurchaseRow } from "./sparkPurchases.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import type { GiftRow, Gifts } from "./gifts.js";
import { PayPalProvider } from "./providers/paypal.js";
import type { Billing, CheckoutStarter } from "./service.js";
import type { SubscriptionRow } from "./subscriptions.js";

interface CheckoutRow {
  id: string;
  user_id: string | null;
  account_id: string;
  org_id?: string | null;
  provider_session_ref: string | null;
  status: string;
  expires_at: number;
  plan_version_id: string;
}
interface ActionRow {
  id: string;
  status: string;
  provider_ref: string | null;
}

/** A thin orchestration layer over Billing/Gifts, not a second entitlement system. */
export class PayPalCheckout {
  readonly provider: PayPalProvider;
  constructor(
    private readonly billing: Billing,
    private readonly gifts: Gifts,
  ) {
    if (!(billing.provider instanceof PayPalProvider)) throw notFound("PayPal is not configured");
    this.provider = billing.provider;
  }

  async start(
    starter: CheckoutStarter & { accountId: string },
    input:
      | { product: "plus"; requestKey: string }
      | { product: "bots_plus"; orgId: string; requestKey: string }
      | { product: "spark"; quantity: number; requestKey: string }
      | { product: "gift"; requestKey: string; recipientUserId?: string; recipient?: import("./giftDelivery.js").GiftTarget; months: number; note: string },
  ) {
    if (input.product === "spark") {
      const result = await this.billing.sparkPurchases.start(starter, input.quantity, this.billing.returnTo("web"), input.requestKey);
      return this.view(starter.accountId, result.purchaseId);
    }
    const price = input.product === "bots_plus"
      ? this.billing.offers("organization").find((offer) => offer.key === "bots_plus" && offer.interval === "month")
      : this.gifts.price("plus", 1);
    if (!price || price.currency !== "USD" || price.amountMinor !== 399) throw new ApiError(409, "billing_unavailable", "Publish the selected product at USD 3.99/month before checkout.");
    let id: string;
    if (input.product === "plus" || input.product === "bots_plus") {
      const owner = input.product === "bots_plus" ? { kind: "org" as const, orgId: input.orgId } : { kind: "account" as const, accountId: starter.accountId };
      const pending = input.product === "bots_plus" ? this.billing.subscriptions.liveAddonForOwner(owner) : this.billing.subscriptions.liveForOwner(owner);
      if (pending?.provider === "paypal" && pending.status === "incomplete" && pending.checkout_id) {
        const resumed = await this.confirm(starter.accountId, pending.checkout_id, false);
        if (resumed.status !== "incomplete_expired") return resumed;
      }
      const result = await this.billing.startOwnerCheckout(owner, starter, input.product, { returnUrl: this.billing.returnTo("web"), requestKey: input.requestKey });
      id = result.checkoutId;
    } else {
      const result = await this.gifts.start(starter, { ...input, planKey: "plus" }, this.billing.returnTo("web"), input.requestKey);
      id = result.giftId;
    }
    return this.view(starter.accountId, id);
  }

  private owned(
    accountId: string,
    id: string,
  ): { gift: GiftRow | SparkPurchaseRow | null; checkout: CheckoutRow | null } {
    const gift = this.gifts.get(id) ?? this.billing.sparkPurchases.get(id);
    if (
      gift &&
      gift.provider === "paypal" &&
      gift.buyer_account_id === accountId
    )
      return { gift, checkout: null };
    const checkout =
      this.billing.rows.get<CheckoutRow>("billing_checkouts", {
        id,
        provider: "paypal",
        owner_kind: "account",
        account_id: accountId,
      }) ?? this.billing.rows.get<CheckoutRow>("billing_checkouts", { id, provider: "paypal", owner_kind: "org", started_by_account_id: accountId }) ?? null;
    if (!checkout) throw notFound("Purchase not found");
    return { gift: null, checkout };
  }

  view(accountId: string, id: string) {
    const { gift, checkout } = this.owned(accountId, id);
    if (gift)
      return {
        id,
        product: "quantity" in gift ? "spark" as const : "gift" as const,
        ...("quantity" in gift ? { quantity: gift.quantity } : {}),
        providerRef: gift.provider_session_ref,
        status: gift.status,
        confirmed: gift.status === "paid" || gift.status === "redeemed",
        currency: "USD" as const,
        amountMinor: gift.amount_minor,
        interval: "one_time" as const,
        expiresAt: gift.expires_at,
      };
    const c = checkout!;
    const sub = this.billing.rows.get<SubscriptionRow>("billing_subscriptions", { provider: "paypal", checkout_id: c.id });
    return {
      id,
      product: this.billing.catalog.plan(this.billing.catalog.version(c.plan_version_id)!.plan_id)?.key === "bots_plus" ? "bots_plus" as const : "plus" as const,
      orgId: c.org_id ?? null,
      providerRef: c.provider_session_ref,
      status: sub?.status ?? c.status,
      confirmed: !!sub && this.billing.subscriptions.grants(sub, Date.now()),
      currency: "USD" as const,
      amountMinor: this.billing.catalog.version(c.plan_version_id)!.amount_minor,
      interval: "month" as const,
      expiresAt: c.expires_at,
    };
  }

  /** The client supplies only our purchase ID; the provider reference always comes from the owned stored row. */
  async confirm(accountId: string, id: string, capture: boolean) {
    let approved = false;
    const { gift, checkout } = this.owned(accountId, id);
    if (gift?.provider_session_ref) {
      const expected = { reference: gift.id, amountMinor: gift.amount_minor };
      const snap = capture && gift.status === "pending" ? await this.provider.captureOrder(gift.provider_session_ref, expected) : await this.provider.readOrder(gift.provider_session_ref, expected);
      if (snap.paid)
        await this.billing.webhooks.ingest("paypal", {
          ref: `capture:${snap.paymentRef}`,
          type: "MELDIQ.PAYPAL.CAPTURE.VERIFIED",
          createdAt: Date.now(),
          kind: "checkout",
          checkout: snap,
        });
    } else if (checkout?.provider_session_ref) {
      if (this.billing.rows.get<SubscriptionRow>("billing_subscriptions", { provider: "paypal", checkout_id: checkout.id })?.status === "incomplete_expired") return { ...this.view(accountId, id), approved: false };
      await this.billing.rows.write((w) => w.update("billing_checkouts", { id: checkout.id }, { provider_subscription_ref: checkout.provider_session_ref }));
      const snapshots = await this.billing.reconcileRefs([checkout.provider_session_ref]);
      if (!snapshots.length) throw new ApiError(503, "unavailable", "PayPal status could not be verified. Refresh billing before trying again.");
      approved = snapshots[0]?.approvalConfirmed === true;
    }
    return { ...this.view(accountId, id), approved };
  }

  async cancel(accountId: string, subscriptionId?: string) {
    const selected = subscriptionId ? this.billing.subscriptions.get(subscriptionId) : null;
    if (subscriptionId && (!selected || selected.billing_account_id !== accountId)) throw notFound("PayPal subscription not found");
    const sub = selected ?? this.billing.subscriptions.liveForOwner({
      kind: "account",
      accountId,
    });
    if (!sub || sub.provider !== "paypal") throw notFound("PayPal subscription not found");
    if (sub.status === "incomplete_expired") return { confirmed: false, accessUntil: null, status: "incomplete_expired", checkoutExpired: true };
    const snapshots = await this.billing.reconcileRefs([sub.provider_subscription_ref]);
    if (this.billing.subscriptions.get(sub.id)?.status === "incomplete_expired") return { confirmed: false, accessUntil: null, status: "incomplete_expired", checkoutExpired: true };
    if (!snapshots.length) throw new ApiError(503, "unavailable", "PayPal status could not be verified. Refresh billing before trying again.");
    if (snapshots[0]?.status === "incomplete" && snapshots[0].approvalConfirmed === false) {
      // PayPal rejects /cancel before buyer approval; no recurring mandate exists to cancel.
      return { confirmed: false, accessUntil: null, status: "incomplete", approvalPending: true };
    }
    await this.provider.cancelSubscription(sub.provider_subscription_ref);
    await this.billing.reconcileRefs([sub.provider_subscription_ref]);
    const updated = this.billing.subscriptions.get(sub.id)!;
    return {
      confirmed: !!updated.cancel_at_period_end || updated.status === "canceled",
      accessUntil: updated.current_period_end,
      status: updated.status,
    };
  }

  transactions(accountId?: string) {
    return PayPalCheckout.records(this.billing, accountId);
  }

  static records(billing: Billing, accountId?: string) {
    const rows = billing.rows;
    const gifts = rows.all<GiftRow>("mojo_gifts", {
      where: {
        provider: "paypal",
        ...(accountId ? { buyer_account_id: accountId } : {}),
      },
      orderBy: [["created_at", "desc"]],
      limit: 100,
    });
    const personalInvoices = rows.all<{
      id: string;
      account_id: string;
      subscription_id: string | null;
      provider_invoice_ref: string;
      status: string;
      currency: string;
      amount_paid_minor: number;
      amount_due_minor: number;
      amount_refunded_minor: number;
      issued_at: number;
      paid_at: number | null;
    }>("billing_invoices", {
      where: {
        provider: "paypal",
        ...(accountId ? { account_id: accountId } : {}),
      },
      orderBy: [["issued_at", "desc"]],
      limit: 100,
    });
    const paidOrganizations = accountId ? rows.all<SubscriptionRow>("billing_subscriptions", { where: { provider: "paypal", owner_kind: "org", billing_account_id: accountId } }) : [];
    const orgInvoices = paidOrganizations.length ? rows.all<(typeof personalInvoices)[number]>("billing_invoices", { where: { provider: "paypal", subscription_id: { in: paidOrganizations.map((subscription) => subscription.id) } }, orderBy: [["issued_at", "desc"]], limit: 100 }) : [];
    const invoices = [...personalInvoices, ...orgInvoices];
    const sparks = rows.all<SparkPurchaseRow>("spark_purchases", { where: { provider: "paypal", ...(accountId ? { buyer_account_id: accountId } : {}) }, orderBy: [["created_at", "desc"]], limit: 100 });
    return [
      ...sparks.map((purchase) => ({ id: purchase.id, userId: purchase.buyer_user_id, customer: purchase.buyer_account_id,
        product: `${purchase.quantity} Meldiq Spark${purchase.quantity === 1 ? "" : "s"} · one-time`, currency: purchase.currency,
        amountMinor: purchase.amount_minor, provider: "paypal", providerRef: purchase.provider_payment_ref ?? purchase.provider_session_ref,
        status: purchase.status, refundStatus: purchase.status === "refunded" ? "refunded" : "none", createdAt: purchase.created_at, completedAt: purchase.paid_at, refundable: false })),
      ...gifts.map((g) => {
        const action = rows.get<ActionRow>("billing_payment_actions", {
          provider: "paypal",
          purchase_id: g.id,
        });
        return {
          id: g.id,
          userId: g.buyer_user_id,
          customer: g.buyer_account_id,
          product: `Plus gift · ${g.months} month${g.months === 1 ? "" : "s"}`,
          currency: g.currency,
          amountMinor: g.amount_minor,
          provider: "paypal",
          providerRef: g.provider_payment_ref ?? g.provider_session_ref,
          status: g.status,
          refundStatus: g.refund_status && g.refund_status !== "none" ? g.refund_status : g.status === "refunded" ? "refunded" : (action?.status ?? "none"),
          createdAt: g.created_at,
          completedAt: g.paid_at,
          refundable: (g.status === "paid" || g.status === "redeemed") && !!g.provider_payment_ref && (!action || action.status === "pending"),
        };
      }),
      ...invoices.map((i) => ({
        id: i.id,
        userId: null,
        customer: i.account_id,
        product: PayPalCheckout.subscriptionName(billing, i.subscription_id),
        currency: i.currency,
        amountMinor: i.amount_paid_minor || i.amount_due_minor,
        provider: "paypal",
        providerRef: i.provider_invoice_ref,
        status: i.status,
        refundStatus: i.amount_refunded_minor > 0 ? "refunded" : "none",
        createdAt: i.issued_at,
        completedAt: i.paid_at,
        refundable: false,
      })),
    ]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }

  private static subscriptionName(billing: Billing, id: string | null): string {
    const subscription = id ? billing.subscriptions.get(id) : null;
    const version = subscription ? billing.catalog.version(subscription.plan_version_id) : null;
    return version ? billing.catalog.plan(version.plan_id)?.name ?? "Meldiq subscription" : "Meldiq payment";
  }

  history(accountId: string) {
    const personal = this.billing.rows.all<SubscriptionRow>(
      "billing_subscriptions",
      {
        where: {
          provider: "paypal",
          owner_kind: "account",
          account_id: accountId,
        },
        orderBy: [["created_at", "desc"]],
        limit: 50,
      },
    );
    const organization = this.billing.rows.all<SubscriptionRow>("billing_subscriptions", { where: { provider: "paypal", owner_kind: "org", billing_account_id: accountId }, orderBy: [["created_at", "desc"]], limit: 50 });
    const subs = [...personal, ...organization];
    const history = subs.length
      ? this.billing.rows.all<{
          subscription_id: string;
          at: number;
          from_status: string | null;
          to_status: string;
          source: string;
        }>("billing_subscription_history", {
          where: { subscription_id: { in: subs.map((s) => s.id) } },
          orderBy: [["at", "desc"]],
          limit: 100,
        })
      : [];
    return {
      transactions: this.transactions(accountId),
      subscriptions: subs.map((s) => ({
        id: s.id,
        product: this.billing.catalog.plan(this.billing.catalog.version(s.plan_version_id)!.plan_id)?.key ?? "plus",
        orgId: s.org_id,
        providerRef: s.provider_subscription_ref,
        status: s.status,
        approvalPending: this.billing.subscriptions.awaitingApproval(s),
        billingStartAt: s.trial_end,
        currentPeriodEnd: s.current_period_end,
        cancelAtPeriodEnd: !!s.cancel_at_period_end,
        createdAt: s.created_at,
      })),
      history: history.map((h) => ({
        subscriptionId: h.subscription_id,
        at: h.at,
        from: h.from_status,
        to: h.to_status,
        source: h.source,
      })),
    };
  }

  /** Full captured-gift refunds only. The durable intent is reserved before the external financial action. */
  async refund(giftId: string, actorAccountId: string, reason: string, beforeSend: () => Promise<void>) {
    const g = this.gifts.get(giftId);
    if (!g || g.provider !== "paypal" || !g.provider_payment_ref) throw notFound("PayPal captured gift not found");
    let action = this.billing.rows.get<ActionRow>("billing_payment_actions", {
      provider: "paypal",
      purchase_id: g.id,
    });
    if (action?.status === "completed") return { status: "completed", reference: action.provider_ref };
    if (g.status !== "paid" && g.status !== "redeemed") throw conflict("Only paid gifts can be refunded");
    const now = Date.now();
    await this.billing.rows.write((w) =>
      w.insert(
        "billing_payment_actions",
        {
          id: `refund-${g.id}`,
          provider: "paypal",
          purchase_id: g.id,
          payment_ref: g.provider_payment_ref,
          actor_account_id: actorAccountId,
          reason,
          status: "pending",
          created_at: now,
          updated_at: now,
        },
        { orIgnore: true },
      ),
    );
    // If audit persistence fails, do not perform the financial action.
    await beforeSend();
    const result = await this.provider.refundCapture(g.provider_payment_ref, g.id);
    const status = result.status === "COMPLETED" ? "completed" : "pending";
    await this.billing.rows.write((w) => w.update("billing_payment_actions", { provider: "paypal", purchase_id: g.id }, { status, provider_ref: result.id, updated_at: Date.now() }));
    if (status === "completed")
      await this.billing.webhooks.ingest("paypal", {
        ref: `refund:${result.id}`,
        type: "MELDIQ.PAYPAL.REFUND.VERIFIED",
        createdAt: Date.now(),
        kind: "payment",
        payment: {
          kind: "refund",
          ref: result.id,
          paymentRef: g.provider_payment_ref,
          customerRef: null,
          currency: g.currency,
          amountMinor: g.amount_minor,
          affectedMinor: g.amount_minor,
          state: "refunded",
        },
      });
    action = this.billing.rows.get<ActionRow>("billing_payment_actions", {
      provider: "paypal",
      purchase_id: g.id,
    });
    return { status, reference: action?.provider_ref ?? null };
  }
}
