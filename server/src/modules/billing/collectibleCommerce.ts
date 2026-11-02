import { z } from "zod/v4";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import type { RowWriter } from "../../infrastructure/database/rows/index.js";
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
} from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { ItemId } from "../../shared/contracts/http/collectibles.js";
import {
  Order,
  OpsId,
  OpsQuery,
} from "../../shared/contracts/http/operations.js";
import { zReason } from "../../shared/contracts/http/platformAdmin.js";
import { parse } from "../../shared/validation/index.js";
import {
  CollectionService,
  available,
  INVENTORY,
  applySlot,
} from "../accounts/collectibles/service.js";
import { styleOf } from "../accounts/profileMedia.js";
import {
  announceProfileChange,
  announceOwnSettingsChange,
} from "../accounts/profileEvents.js";
import { me, requireAuth } from "../auth/index.js";
import { PayPalProvider } from "./providers/paypal.js";
import type { CheckoutSnapshot, PaymentSnapshot } from "./providers/types.js";
import type { ApplyOutcome } from "./subscriptions.js";
import type { AdminDeps } from "../platformAdmin/dataRoutes.js";
import { principal, requirePermission } from "../platformAdmin/guards.js";
import { PlatformAudit } from "../platformAdmin/audit.js";
type Purchase = z.infer<typeof Order>;
export class CollectibleCommerce {
  private syncing = false;
  constructor(readonly ctx: AppContext) {}
  get(id: string) {
    return this.ctx.billing.rows.get<Purchase>("collectible_orders", { id });
  }
  capability() {
    const p = this.ctx.billing.provider;
    return {
      checkout:
        !!p?.createPaymentCheckout &&
        (p.id !== "paypal" || p.supportsOneTimePurchases === true),
      refund: !!p?.refundPayment || p instanceof PayPalProvider,
      provider: p?.id ?? null,
      mode: p?.mode ?? null,
    };
  }
  async start(
    userId: string,
    itemId: string,
    requestKey: string,
    promotionCode?: string,
  ) {
    const a = await this.ctx.accounts.store.accountByUserId(userId);
    if (!a)
      throw forbidden("Use your verified Meldiq account to buy decorations");
    const p = this.ctx.billing.provider;
    if (!p?.createPaymentCheckout || !this.capability().checkout)
      throw new ApiError(
        503,
        "billing_unavailable",
        "Hosted collectible checkout is unavailable with the configured provider",
      );
    const service = new CollectionService(this.ctx),
      item = service.item(itemId);
    if (
      !available(item) ||
      item.acquisitionType !== "purchase" ||
      item.currency !== "USD" ||
      item.price <= 0
    )
      throw conflict("This item is not on sale for USD");
    let id = newId("colpay");
    const t = now();
    await this.ctx.billing.rows.write((w) => {
      const previous = w.get<Purchase>("collectible_orders", {
        account_id: a.id,
        request_key: requestKey,
      });
      if (previous) {
        if (
          previous.item_id !== itemId ||
          previous.promotion_code !== (promotionCode ?? null)
        )
          throw conflict("This request key belongs to another item");
        id = previous.id;
        return;
      }
      if (
        this.ctx.identity.get(INVENTORY, {
          user_id: userId,
          decoration_id: itemId,
        })
      )
        throw conflict("You already own this item");
      if (
        w.get("collectible_orders", {
          account_id: a.id,
          item_id: itemId,
          status: { in: ["pending", "paid"] },
        })
      )
        throw conflict("Resume your existing purchase for this item");
      let amount = item.price;
      if (promotionCode) {
        const promo = w.get<{
          product: string;
          enabled: number;
          starts_at: number;
          ends_at: number;
          redeemed: number;
          max_redemptions: number;
          discount_percent: number;
        }>("billing_promotions", { code: promotionCode });
        if (
          !promo ||
          promo.product !== "collectible_discount" ||
          !promo.enabled ||
          promo.starts_at > t ||
          promo.ends_at <= t ||
          promo.redeemed >= promo.max_redemptions ||
          w.get("billing_promotion_redemptions", {
            code: promotionCode,
            account_id: a.id,
          })
        )
          throw conflict(
            "This collectible discount is unavailable or already used",
          );
        amount = Math.max(
          1,
          Math.round((item.price * (100 - promo.discount_percent)) / 100),
        );
        w.update(
          "billing_promotions",
          { code: promotionCode },
          { redeemed: promo.redeemed + 1, updated_at: t },
        );
        w.insert("billing_promotion_redemptions", {
          code: promotionCode,
          account_id: a.id,
          user_id: userId,
          grant_id: id,
          redeemed_at: t,
          state: "reserved",
        });
      }
      w.insert("collectible_orders", {
        id,
        account_id: a.id,
        user_id: userId,
        item_id: itemId,
        item_version: item.version,
        amount_minor: amount,
        original_amount_minor: item.price,
        promotion_code: promotionCode ?? null,
        currency: item.currency,
        provider: p.id,
        session_ref: null,
        checkout_url: null,
        payment_ref: null,
        status: "pending",
        sync_status: "pending",
        request_key: requestKey,
        created_at: t,
        updated_at: t,
        expires_at: t + 86400000,
      });
    });
    const order = this.get(id)!;
    if (order.status !== "pending" || order.checkout_url)
      return this.public(order);
    if (order.expires_at <= now())
      throw conflict("This checkout expired; use a new request key");
    const returnUrl = this.ctx.billing.returnTo("web");
    if (!returnUrl)
      throw new ApiError(
        503,
        "billing_unavailable",
        "Configure the existing web billing return URL before checkout",
      );
    const session = await p.createPaymentCheckout({
      kind: "collectible",
      reference: id,
      customerRef: null,
      owner: { kind: "account", id: a.id },
      currency: order.currency,
      amountMinor: order.amount_minor,
      productName: item.name,
      successUrl: returnUrl + "?collectible=" + id,
      cancelUrl: returnUrl + "?collectible=" + id,
    });
    await this.ctx.billing.rows.write((w) =>
      w.update(
        "collectible_orders",
        { id },
        {
          session_ref: session.sessionRef,
          checkout_url: session.url,
          updated_at: now(),
        },
      ),
    );
    return this.public(this.get(id)!);
  }
  public(r: Purchase) {
    return {
      id: r.id,
      itemId: r.item_id,
      amountMinor: r.amount_minor,
      currency: r.currency,
      status: r.status,
      fulfillment: r.sync_status,
      url: r.status === "pending" ? r.checkout_url : null,
      expiresAt: r.expires_at,
    };
  }
  applyCheckout(
    w: RowWriter,
    provider: string,
    s: CheckoutSnapshot,
    t: number,
  ): ApplyOutcome | null {
    if (s.mode !== "payment" || !s.reference?.startsWith("colpay_"))
      return null;
    const r = w.get<Purchase>("collectible_orders", {
      id: s.reference,
      provider,
    });
    if (!r) return { result: "stale", subscriptionId: null, owner: null };
    if (
      s.sessionRef !== r.session_ref ||
      s.currency !== r.currency ||
      s.amountMinor !== r.amount_minor
    )
      throw new Error("Collectible payment differs from its frozen order");
    if (s.outcome === "completed" && s.paid && s.paymentRef) {
      if (!["refunded", "disputed"].includes(r.status)) {
        w.update(
          "collectible_orders",
          { id: r.id },
          {
            status: "paid",
            payment_ref: s.paymentRef,
            sync_status: "pending",
            updated_at: t,
          },
        );
        if (r.promotion_code)
          w.update(
            "billing_promotion_redemptions",
            { code: r.promotion_code, account_id: r.account_id },
            { state: "redeemed" },
          );
      }
    } else if (s.outcome !== "completed" && r.status === "pending")
      w.update(
        "collectible_orders",
        { id: r.id },
        {
          status: s.outcome === "expired" ? "expired" : "failed",
          sync_status: "complete",
          updated_at: t,
        },
      );
    return {
      result: "applied",
      subscriptionId: null,
      owner: { kind: "account", accountId: r.account_id },
    };
  }
  applyPayment(
    w: RowWriter,
    provider: string,
    s: PaymentSnapshot,
    t: number,
  ): ApplyOutcome | null {
    const r =
      (s.purchaseRef
        ? w.get<Purchase>("collectible_orders", { id: s.purchaseRef, provider })
        : undefined) ??
      (s.paymentRef
        ? w.get<Purchase>("collectible_orders", {
            provider,
            payment_ref: s.paymentRef,
          })
        : undefined);
    if (!r) return null;
    if (
      s.currency !== r.currency ||
      s.amountMinor !== r.amount_minor ||
      (s.orderRef && s.orderRef !== r.session_ref) ||
      (r.payment_ref && s.paymentRef !== r.payment_ref)
    )
      throw new Error("Collectible refund differs from its frozen payment");
    const revoke =
      s.state === "refunded" || s.state === "reversed" || s.kind === "dispute";
    if (revoke)
      w.update(
        "collectible_orders",
        { id: r.id },
        {
          status: s.kind === "dispute" ? "disputed" : "refunded",
          payment_ref: s.paymentRef ?? r.payment_ref,
          sync_status: "pending",
          updated_at: t,
        },
      );
    return {
      result: "applied",
      subscriptionId: null,
      owner: { kind: "account", accountId: r.account_id },
    };
  }
  /** The billing row is a durable outbox. Replaying after any crash repairs identity and its completion audit. */
  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const rows = this.ctx.billing.rows.all<Purchase>("collectible_orders", {
        where: {
          sync_status: "pending",
          status: { in: ["paid", "refunded", "disputed"] },
        },
        orderBy: [["updated_at", "asc"]],
        limit: 20,
      });
      for (const row of rows) {
        const r = this.get(row.id)!;
        const source = "purchase:" + r.id;
        await this.ctx.identity.write((w) => {
          if (r.status === "paid") {
            if (!w.get("users", { id: r.user_id })) return;
            if (
              !w.get(INVENTORY, {
                user_id: r.user_id,
                decoration_id: r.item_id,
              })
            ) {
              w.insert(INVENTORY, {
                user_id: r.user_id,
                decoration_id: r.item_id,
                acquisition_source: source,
                acquired_at: now(),
                is_favorite: 0,
              });
              const previous = w.get<{ id: string }>(
                "profile_collectible_transactions",
                { user_id: r.user_id, decoration_id: r.item_id },
              );
              const receipt = {
                transaction_type: "purchase",
                price: r.amount_minor,
                currency: r.currency,
                payment_reference: r.payment_ref,
                created_at: now(),
              };
              if (previous)
                w.update(
                  "profile_collectible_transactions",
                  { id: previous.id },
                  receipt,
                );
              else
                w.insert("profile_collectible_transactions", {
                  id: r.id,
                  user_id: r.user_id,
                  decoration_id: r.item_id,
                  ...receipt,
                });
            }
          } else {
            const removed = w.delete(INVENTORY, {
              user_id: r.user_id,
              decoration_id: r.item_id,
              acquisition_source: source,
            });
            if (removed) {
              const u = w.get<{ profile_style: string | null }>("users", {
                id: r.user_id,
              });
              if (u) {
                let style = styleOf(u);
                for (const look of style.collectibles ?? [])
                  if (look.id === r.item_id)
                    style = applySlot(style, look.category, null);
                w.update(
                  "users",
                  { id: r.user_id },
                  { profile_style: JSON.stringify(style), updated_at: now() },
                );
              }
              w.update(
                "profile_collectible_transactions",
                {
                  user_id: r.user_id,
                  decoration_id: r.item_id,
                  payment_reference: r.payment_ref,
                },
                { transaction_type: r.status },
              );
            }
          }
        });
        await this.ctx.platform.write((w) => {
          if (
            !w.get("platform_settings", {
              key: `collectible.fulfilled.${r.id}.${r.status}`,
            })
          ) {
            new PlatformAudit(this.ctx.platform).append(w, {
              action: "collectible.payment_" + r.status,
              outcome: "success",
              targetType: "collectible_order",
              targetId: r.id,
              detail: {
                userId: r.user_id,
                itemId: r.item_id,
                amountMinor: r.amount_minor,
              },
            });
            w.insert("platform_settings", {
              key: `collectible.fulfilled.${r.id}.${r.status}`,
              value: "true",
              updated_by: "payment-provider",
              updated_at: now(),
            });
          }
        });
        await this.ctx.billing.rows.write((w) => {
          const current = w.get<Purchase>("collectible_orders", { id: r.id });
          if (current?.status === r.status)
            w.update(
              "collectible_orders",
              { id: r.id },
              { sync_status: "complete", updated_at: now() },
            );
        });
        announceProfileChange(this.ctx, r.user_id);
        announceOwnSettingsChange(this.ctx, r.user_id);
      }
    } finally {
      this.syncing = false;
    }
  }
  async confirm(userId: string, id: string) {
    const r = this.get(id);
    if (!r || r.user_id !== userId) throw notFound();
    const p = this.ctx.billing.provider;
    if (p instanceof PayPalProvider && r.session_ref) {
      const s = await p.captureOrder(r.session_ref, {
        reference: r.id,
        amountMinor: r.amount_minor,
      });
      if (s.paid && s.paymentRef)
        await this.ctx.billing.webhooks.ingest(p.id, {
          ref: `capture:${s.paymentRef}`,
          type: "MELDIQ.COLLECTIBLE.CAPTURE.VERIFIED",
          createdAt: now(),
          kind: "checkout",
          checkout: s,
        });
    }
    await this.sync();
    return this.public(this.get(id)!);
  }
  async refund(
    id: string,
    actor: string,
    reason: string,
    beforeSend: () => Promise<unknown>,
  ) {
    const r = this.get(id),
      p = this.ctx.billing.provider;
    if (!r || r.provider !== p?.id || !r.payment_ref)
      throw notFound("Captured order not found");
    if (!this.capability().refund)
      throw conflict(
        "Refund through the payment provider; verified webhook events revoke ownership",
      );
    const old = this.ctx.billing.rows.get<{
      status: string;
      provider_ref: string | null;
    }>("billing_payment_actions", { provider: r.provider, purchase_id: id });
    if (old?.status === "completed")
      return { status: "completed", reference: old.provider_ref };
    if (r.status !== "paid") throw conflict("Only paid orders can be refunded");
    await this.ctx.billing.rows.write((w) =>
      w.insert(
        "billing_payment_actions",
        {
          id: `refund-${id}`,
          provider: r.provider,
          purchase_id: id,
          payment_ref: r.payment_ref,
          actor_account_id: actor,
          reason,
          status: "pending",
          created_at: now(),
          updated_at: now(),
        },
        { orIgnore: true },
      ),
    );
    await beforeSend();
    const result =
      p instanceof PayPalProvider
        ? await p.refundCapture(r.payment_ref, id)
        : await p!.refundPayment!(r.payment_ref, id);
    const completed =
      result.status.toLowerCase() === "completed" ||
      result.status.toLowerCase() === "succeeded";
    await this.ctx.billing.rows.write((w) =>
      w.update(
        "billing_payment_actions",
        { provider: r.provider, purchase_id: id },
        {
          status: completed ? "completed" : "pending",
          provider_ref: result.id,
          updated_at: now(),
        },
      ),
    );
    if (completed)
      await this.ctx.billing.webhooks.ingest(r.provider, {
        ref: `refund:${result.id}`,
        type: "MELDIQ.COLLECTIBLE.REFUND.VERIFIED",
        createdAt: now(),
        kind: "payment",
        payment: {
          kind: "refund",
          ref: result.id,
          paymentRef: r.payment_ref,
          customerRef: null,
          currency: r.currency,
          amountMinor: r.amount_minor,
          affectedMinor: r.amount_minor,
          state: "refunded",
        },
      });
    await this.sync();
    return {
      status: completed ? "completed" : "pending",
      reference: result.id,
    };
  }
}
export async function collectibleCommerceUserRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const auth = {
    preHandler: requireAuth(ctx),
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  };
  const params = z.object({ id: OpsId });
  app.get("/v2/collectible-purchases", auth, async (req) => {
    await ctx.collectibleCommerce.sync();
    return {
      capability: ctx.collectibleCommerce.capability(),
      items: ctx.billing.rows
        .all<Purchase>("collectible_orders", {
          where: { user_id: me(req).userId },
          orderBy: [["created_at", "desc"]],
          limit: 50,
        })
        .map((r) => ctx.collectibleCommerce.public(r)),
    };
  });
  app.post("/v2/collectible-purchases", auth, async (req) => {
    const x = parse(
      z.strictObject({
        itemId: ItemId,
        requestKey: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
        promotionCode: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9-]{4,32}$/)
          .optional(),
      }),
      req.body,
    );
    return ctx.collectibleCommerce.start(
      me(req).userId,
      x.itemId,
      x.requestKey,
      x.promotionCode,
    );
  });
  app.post("/v2/collectible-purchases/:id/confirm", auth, async (req) =>
    ctx.collectibleCommerce.confirm(
      me(req).userId,
      parse(params, req.params).id,
    ),
  );
  const sweep = () =>
    ctx.collectibleCommerce
      .sync()
      .catch((e) =>
        ctx.log.error(
          { errorType: e instanceof Error ? e.name : "unknown" },
          "Collectible payment reconciliation failed",
        ),
      );
  const timer = setInterval(() => void sweep(), 15000);
  timer.unref();
  app.addHook("onReady", sweep);
  app.addHook("onClose", async () => clearInterval(timer));
}
export async function collectibleCommerceAdminRoutes(
  app: FastifyInstance,
  d: AdminDeps,
) {
  app.get(
    "/admin/v1/operations/orders",
    { preHandler: requirePermission(d.auth, d.audit, "billing.view") },
    async (req) => {
      const q = parse(OpsQuery, req.query);
      const rows = d.ctx.billing.rows.all<Purchase>("collectible_orders", {
        where: q.after ? { id: { gt: q.after } } : {},
        orderBy: [["id", "asc"]],
        limit: q.limit + 1,
      });
      return {
        capability: d.ctx.collectibleCommerce.capability(),
        items: rows.slice(0, q.limit),
        next: rows.length > q.limit ? rows[q.limit - 1].id : null,
      };
    },
  );
  app.post(
    "/admin/v1/operations/orders/:id/refund",
    { preHandler: requirePermission(d.auth, d.audit, "billing.manage") },
    async (req) => {
      const { id } = parse(z.object({ id: OpsId }), req.params),
        { reason } = parse(z.strictObject({ reason: zReason }), req.body),
        p = principal(req);
      return d.ctx.collectibleCommerce.refund(id, p.account.id, reason, () =>
        d.audit.record({
          action: "collectible.refund_requested",
          outcome: "success",
          actorAccountId: p.account.id,
          actorRole: p.grant.role,
          targetType: "collectible_order",
          targetId: id,
          reason,
        }),
      );
    },
  );
  app.post(
    "/admin/v1/operations/orders/reconcile",
    { preHandler: requirePermission(d.auth, d.audit, "billing.manage") },
    async (req) => {
      const { reason } = parse(z.strictObject({ reason: zReason }), req.body);
      await d.audit.record({
        action: "collectible.reconcile",
        outcome: "success",
        actorAccountId: principal(req).account.id,
        reason,
      });
      await d.ctx.collectibleCommerce.sync();
      return { ok: true };
    },
  );
}
