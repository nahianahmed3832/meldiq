import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { AppContext } from "../../app/context.js";
import { BadgeBody, GiftBody, GiftParams, SparkAssignBody, SparkCheckoutBody, SparkParams } from "../../shared/contracts/http/mojo.js";
import { OrgParams } from "../../shared/contracts/http/orgs.js";
import { ApiError } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";
import { orgNames } from "../organizations/index.js";
import type { GiftRow } from "./gifts.js";
import { catalogView, MAX_SPARK_LEVEL, SPARK_LEVELS, SPARK_PLAN_KEY } from "./perks.js";
import type { CheckoutStarter } from "./service.js";

interface MojoSession {
  accountId: string;
  userId: string | null;
}

export interface MojoRouteHelpers {
  /** Signed in with an account session (website, web app, every app). */
  authed: RouteShorthandOptions;
  /** The same, rate-limited for routes that call the payment provider. */
  providerCall: RouteShorthandOptions;
  session: (req: FastifyRequest) => MojoSession;
  starterFor: (s: MojoSession, owner: { kind: "account"; accountId: string }) => Promise<CheckoutStarter>;
  /** Display names of users (for gifts: who gave it, who it's for). */
  userNames: (ids: readonly string[]) => Map<string, string>;
}

/** Sparks, gifts and badges belong to the person's encryption identity: a session without one (the website) can't. */
function needsUser(s: MojoSession): string {
  if (!s.userId) throw new ApiError(403, "device_required", "Open Meldiq on one of your devices to do this");
  return s.userId;
}

/** Buying and starting gifts belong to the account (email sign-in): a device linked before it has none. */
function needsAccount(s: MojoSession): string {
  if (!s.accountId) throw new ApiError(403, "device_required", "Sign in with your email on this device to do this");
  return s.accountId;
}

/**
 * Meldiq Mojo's routes (docs/MOJO.md): the catalog, a person's perks and Sparks, gifts and the badge, and a community's
 * Spark level. Plans are bought with POST /v2/billing/checkout (keys "go" and "plus").
 */
export function mojoRoutes(app: FastifyInstance, ctx: AppContext, h: MojoRouteHelpers): void {
  const nameOfOrg = (orgId: string) => orgNames(ctx.ws, [orgId]).get(orgId) ?? null;

  app.get("/v2/mojo/catalog", async () => {
    const price = (key: string) => {
      const o = ctx.billing.offers("personal").find((p) => p.key === key && p.interval === "month");
      return o ? { currency: o.currency, amountMinor: o.amountMinor } : null;
    };
    return {
      ...catalogView(),
      enforced: ctx.mojo.enforced(),
      onSale: {
        mode: ctx.billing.provider?.mode ?? null,
        go: price("go"),
        plus: price("plus"),
        spark: price(SPARK_PLAN_KEY),
        gifts: !!ctx.billing.provider?.createPaymentCheckout && (price("go") !== null || price("plus") !== null),
      },
    };
  });

  app.get("/v2/mojo/me", h.authed, async (req) => {
    const s = h.session(req);
    const userId = needsUser(s);
    const t = now();
    const plan = ctx.mojo.planOf(userId, t);
    const perks = ctx.mojo.perksOf(userId, t);
    const sparks = ctx.mojo.sparksView(userId, nameOfOrg, t);
    const addon = s.accountId ? ctx.billing.subscriptions.liveAddonForOwner({ kind: "account", accountId: s.accountId }) : null;
    const gifts = ctx.gifts.listFor(s.accountId, userId);
    const names = h.userNames([...gifts.received.map((g) => g.buyer_user_id ?? ""), ...gifts.sent.map((g) => g.recipient_user_id)].filter(Boolean));
    const view = (g: GiftRow, personId: string | null) => ({
      id: g.id, planKey: g.plan_key, months: g.months, status: g.status, note: g.note, person: { userId: personId, name: personId ? (names.get(personId) ?? null) : null },
      currency: g.currency, amountMinor: g.amount_minor, paidAt: g.paid_at, redeemedAt: g.redeemed_at,
    });
    return {
      plan,
      perks,
      sparks: {
        ...sparks,
        subscription: addon
          ? {
              quantity: addon.quantity,
              status: addon.status,
              renews: ctx.billing.subscriptions.grants(addon, t) && !addon.cancel_at_period_end,
              currentPeriodEnd: addon.current_period_end,
            }
          : null,
      },
      badge: { kind: perks.badge, check: perks.check, hidden: ctx.mojo.badgeHidden(userId) },
      gifts: { received: gifts.received.map((g) => view(g, g.buyer_user_id)), sent: gifts.sent.map((g) => view(g, g.recipient_user_id)) },
    };
  });

  app.post("/v2/mojo/sparks", h.authed, async (req) => {
    const s = h.session(req);
    const userId = needsUser(s);
    const { orgId } = parse(SparkAssignBody, req.body);
    const a = await ctx.mojo.assign(userId, orgId);
    ctx.audit({ actorId: userId, orgId, action: "mojo.spark_give", target: a.id });
    ctx.mojo.notifyOrg(orgId);
    return { id: a.id, orgId: a.org_id, assignedAt: a.assigned_at };
  });

  app.post("/v2/mojo/sparks/:id/move", h.authed, async (req) => {
    const s = h.session(req);
    const userId = needsUser(s);
    const { id } = parse(SparkParams, req.params);
    const { orgId } = parse(SparkAssignBody, req.body);
    const from = ctx.billing.rows.get<{ org_id: string }>("spark_assignments", { id })?.org_id ?? null;
    const a = await ctx.mojo.move(userId, id, orgId);
    ctx.audit({ actorId: userId, orgId, action: "mojo.spark_move", target: a.id, detail: from ? `from:${from}` : null });
    if (from) ctx.mojo.notifyOrg(from);
    ctx.mojo.notifyOrg(orgId);
    return { id: a.id, orgId: a.org_id, assignedAt: a.assigned_at };
  });

  app.delete("/v2/mojo/sparks/:id", h.authed, async (req) => {
    const s = h.session(req);
    const userId = needsUser(s);
    const { id } = parse(SparkParams, req.params);
    const orgId = ctx.billing.rows.get<{ org_id: string }>("spark_assignments", { id })?.org_id ?? null;
    await ctx.mojo.remove(userId, id);
    ctx.audit({ actorId: userId, orgId, action: "mojo.spark_remove", target: id });
    if (orgId) ctx.mojo.notifyOrg(orgId);
    return { ok: true as const };
  });

  app.post("/v2/mojo/sparks/checkout", h.providerCall, async (req) => {
    const s = h.session(req);
    const { quantity, returnTo } = parse(SparkCheckoutBody, req.body);
    const owner = { kind: "account" as const, accountId: needsAccount(s) };
    const started = await ctx.billing.startOwnerCheckout(owner, await h.starterFor(s, owner), SPARK_PLAN_KEY, { quantity, returnUrl: ctx.billing.returnTo(returnTo) });
    ctx.audit({ actorId: s.userId ?? s.accountId, action: "billing.checkout", target: started.checkoutId, detail: `spark x${quantity}` });
    return started;
  });

  app.post("/v2/mojo/gifts", h.providerCall, async (req) => {
    const s = h.session(req);
    needsUser(s);
    const b = parse(GiftBody, req.body);
    const owner = { kind: "account" as const, accountId: needsAccount(s) };
    const started = await ctx.gifts.start({ ...(await h.starterFor(s, owner)), accountId: owner.accountId }, b, ctx.billing.returnTo(b.returnTo));
    ctx.audit({ actorId: s.userId ?? s.accountId, action: "mojo.gift_checkout", target: started.giftId, detail: `${b.planKey} x${b.months}` });
    return started;
  });

  app.post("/v2/mojo/gifts/:id/redeem", h.authed, async (req) => {
    const s = h.session(req);
    const userId = needsUser(s);
    const { id } = parse(GiftParams, req.params);
    const accountId = needsAccount(s);
    const started = await ctx.gifts.redeem({ accountId, userId }, id);
    ctx.audit({ actorId: userId, action: "mojo.gift_redeem", target: id });
    ctx.billing.onChange?.({ kind: "account", accountId });
    return started;
  });

  app.put("/v2/mojo/badge", h.authed, async (req) => {
    const userId = needsUser(h.session(req));
    const { hidden } = parse(BadgeBody, req.body);
    await ctx.mojo.setBadgeHidden(userId, hidden);
    return { hidden };
  });

  app.get("/v1/orgs/:orgId/sparks", { preHandler: requireAuth(ctx) }, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const { userId } = me(req);
    ctx.authz.requireOrgMember(orgId, userId);
    const t = now();
    const level = ctx.mojo.levelOf(orgId, t);
    const { active, ...perks } = level;
    const next = level.level < MAX_SPARK_LEVEL ? SPARK_LEVELS[level.level + 1]! : null;
    const total = ctx.mojo.sparkSlots(userId, t).total;
    const mine = ctx.mojo
      .assignmentsOf(userId)
      .map((a, i) => ({ id: a.id, orgId: a.org_id, assignedAt: a.assigned_at, paused: i >= total }))
      .filter((a) => a.orgId === orgId)
      .map(({ orgId: _o, ...a }) => a);
    return { level: level.level, active, next: next ? { level: next.level, needs: next.sparks - active } : null, perks, levels: [...SPARK_LEVELS], mine };
  });
}
