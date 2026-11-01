import { ApiError, conflict, notFound } from "../../shared/errors.js";
import type { GiftRow, Gifts } from "./gifts.js";
import { PayPalProvider } from "./providers/paypal.js";
import type { Billing, CheckoutStarter } from "./service.js";
import type { SubscriptionRow } from "./subscriptions.js";

interface CheckoutRow {
  id: string;
  user_id: string | null;
  account_id: string;
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
    if (!(billing.provider instanceof PayPalProvider))
      throw notFound("PayPal Sandbox is not configured");
    this.provider = billing.provider;
  }

  async start(
    starter: CheckoutStarter & { accountId: string },
    input:
      | { product: "plus"; requestKey: string }
      | {
          product: "gift";
          requestKey: string;
          recipientUserId: string;
          months: number;
          note: string;
        },
  ) {
    const price = this.gifts.price("plus", 1);
    if (!price || price.currency !== "USD" || price.amountMinor !== 399)
      throw new ApiError(
        409,
        "billing_unavailable",
        "Publish the existing Plus offer at USD 3.99/month for PayPal Sandbox before checkout.",
      );
    let id: string;
    if (input.product === "plus") {
      const pending = this.billing.subscriptions.liveForOwner({
        kind: "account",
        accountId: starter.accountId,
      });
      if (
        pending?.provider === "paypal" &&
        pending.status === "incomplete" &&
        pending.checkout_id
      )
        return this.view(starter.accountId, pending.checkout_id);
      const result = await this.billing.startOwnerCheckout(
        { kind: "account", accountId: starter.accountId },
        starter,
        "plus",
        {
          returnUrl: this.billing.returnTo("web"),
          requestKey: input.requestKey,
        },
      );
      id = result.checkoutId;
    } else {
      const result = await this.gifts.start(
        starter,
        { ...input, planKey: "plus" },
        this.billing.returnTo("web"),
        input.requestKey,
      );
      id = result.giftId;
    }
    return this.view(starter.accountId, id);
  }

  private owned(
    accountId: string,
    id: string,
  ): { gift: GiftRow | null; checkout: CheckoutRow | null } {
    const gift = this.gifts.get(id);
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
      }) ?? null;
    if (!checkout) throw notFound("Purchase not found");
    return { gift: null, checkout };
  }

  view(accountId: string, id: string) {
    const { gift, checkout } = this.owned(accountId, id);
    if (gift)
      return {
        id,
        product: "gift" as const,
        providerRef: gift.provider_session_ref,
        status: gift.status,
        confirmed: gift.status === "paid" || gift.status === "redeemed",
        currency: "USD" as const,
        amountMinor: gift.amount_minor,
        interval: "one_time" as const,
        expiresAt: gift.expires_at,
      };
    const c = checkout!;
    const sub = this.billing.rows.get<SubscriptionRow>(
      "billing_subscriptions",
      { provider: "paypal", checkout_id: c.id },
    );
    return {
      id,
      product: "plus" as const,
      providerRef: c.provider_session_ref,
      status: sub?.status ?? c.status,
      confirmed: !!sub && this.billing.subscriptions.grants(sub, Date.now()),
      currency: "USD" as const,
      amountMinor: this.billing.catalog.version(c.plan_version_id)!
        .amount_minor,
      interval: "month" as const,
      expiresAt: c.expires_at,
    };
  }

  /** The client supplies only our purchase ID; the provider reference always comes from the owned stored row. */
  async confirm(accountId: string, id: string, capture: boolean) {
    const { gift, checkout } = this.owned(accountId, id);
    if (gift?.provider_session_ref) {
      const expected = { reference: gift.id, amountMinor: gift.amount_minor };
      const snap =
        capture && gift.status === "pending"
          ? await this.provider.captureOrder(
              gift.provider_session_ref,
              expected,
            )
          : await this.provider.readOrder(gift.provider_session_ref, expected);
      if (snap.paid)
        await this.billing.webhooks.ingest("paypal", {
          ref: `capture:${snap.paymentRef}`,
          type: "MELDIQ.PAYPAL.CAPTURE.VERIFIED",
          createdAt: Date.now(),
          kind: "checkout",
          checkout: snap,
        });
    } else if (checkout?.provider_session_ref) {
      await this.billing.rows.write((w) =>
        w.update(
          "billing_checkouts",
          { id: checkout.id },
          { provider_subscription_ref: checkout.provider_session_ref },
        ),
      );
      await this.billing.reconcileRefs([checkout.provider_session_ref]);
    }
    return this.view(accountId, id);
  }

  async cancel(accountId: string) {
    const sub = this.billing.subscriptions.liveForOwner({
      kind: "account",
      accountId,
    });
    if (!sub || sub.provider !== "paypal")
      throw notFound("PayPal subscription not found");
    await this.provider.cancelSubscription(sub.provider_subscription_ref);
    await this.billing.reconcileRefs([sub.provider_subscription_ref]);
    const updated = this.billing.subscriptions.get(sub.id)!;
    return {
      confirmed:
        !!updated.cancel_at_period_end || updated.status === "canceled",
      accessUntil: updated.current_period_end,
      status: updated.status,
    };
  }

  transactions(accountId?: string) {
    const rows = this.billing.rows;
    const gifts = rows.all<GiftRow>("mojo_gifts", {
      where: {
        provider: "paypal",
        ...(accountId ? { buyer_account_id: accountId } : {}),
      },
      orderBy: [["created_at", "desc"]],
      limit: 100,
    });
    const invoices = rows.all<{
      id: string;
      account_id: string;
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
    return [
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
          refundStatus:
            g.refund_status && g.refund_status !== "none"
              ? g.refund_status
              : g.status === "refunded"
                ? "refunded"
                : (action?.status ?? "none"),
          createdAt: g.created_at,
          completedAt: g.paid_at,
          refundable:
            (g.status === "paid" || g.status === "redeemed") &&
            !!g.provider_payment_ref &&
            (!action || action.status === "pending"),
        };
      }),
      ...invoices.map((i) => ({
        id: i.id,
        userId: null,
        customer: i.account_id,
        product: "Plus subscription",
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

  history(accountId: string) {
    const subs = this.billing.rows.all<SubscriptionRow>(
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
        providerRef: s.provider_subscription_ref,
        status: s.status,
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
  async refund(
    giftId: string,
    actorAccountId: string,
    reason: string,
    beforeSend: () => Promise<void>,
  ) {
    const g = this.gifts.get(giftId);
    if (!g || g.provider !== "paypal" || !g.provider_payment_ref)
      throw notFound("PayPal captured gift not found");
    let action = this.billing.rows.get<ActionRow>("billing_payment_actions", {
      provider: "paypal",
      purchase_id: g.id,
    });
    if (action?.status === "completed")
      return { status: "completed", reference: action.provider_ref };
    if (g.status !== "paid" && g.status !== "redeemed")
      throw conflict("Only paid gifts can be refunded");
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
    const result = await this.provider.refundCapture(
      g.provider_payment_ref,
      g.id,
    );
    const status = result.status === "COMPLETED" ? "completed" : "pending";
    await this.billing.rows.write((w) =>
      w.update(
        "billing_payment_actions",
        { provider: "paypal", purchase_id: g.id },
        { status, provider_ref: result.id, updated_at: Date.now() },
      ),
    );
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
