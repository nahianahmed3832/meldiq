import { hasPlatformAdminAccount } from "../platformAdmin/index.js";
import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { AppContext } from "../../app/context.js";
import { unauthorized } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { ActivityBody, ClaimBody, EventBody, OptOutBody, type Subject } from "./upgradePromotions.js";

export function promotionRoutes(app: FastifyInstance, ctx: AppContext, auth: RouteShorthandOptions, session: (req: FastifyRequest) => { accountId: string; userId: string | null }) {
 const options = { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
 const subject = async (req: FastifyRequest, onboardingComplete = true): Promise<Subject> => {
  const s = session(req); const a = await ctx.accounts.store.accountById(s.accountId); if (!a || !s.userId) throw unauthorized();
  const t = Date.now(); const rows = ctx.billing.rows;
  return { accountId: a.id, userId: s.userId, createdAt: a.created_at, registered: !!a.email_verified_at && !a.disabled_at,
   onboardingComplete: onboardingComplete && !!a.user_id && !!a.name.trim(),
   plan: ctx.mojo.planOf(s.userId, t), excluded: hasPlatformAdminAccount(ctx.platform, a.id) || a.admitted_via === "test",
   checkout: !!rows.get("billing_checkouts", { started_by_account_id: a.id, status: "open", expires_at: { gt: t } }) || !!rows.get("mojo_gifts", { buyer_account_id: a.id, status: "pending", expires_at: { gt: t } }) || !!rows.get("spark_purchases", { buyer_account_id: a.id, status: "pending", expires_at: { gt: t } }), region: null };
 };
 app.post("/v2/billing/reminders/renewal", options, async req => { const b = parse(z.object({ sessionId: z.string().uuid(), claim: z.boolean().default(true) }).strict(),req.body); return ctx.billing.promotions.renewal(await subject(req),b.sessionId,b.claim); });
 app.post("/v2/billing/promotions/activity", options, async req => { const b = parse(ActivityBody, req.body); return ctx.billing.promotions.activity(await subject(req, b.onboardingComplete), b.sessionId, b.active); });
 app.post("/v2/billing/promotions/claim", options, async req => { const b = parse(ClaimBody, req.body); const s = await subject(req); if (!ctx.billing.offers("personal").some(o => o.key === "plus")) return { promotion: null }; return ctx.billing.promotions.claim(s, b); });
 app.get("/v2/billing/promotions/:id", options, async req => { const { id } = parse(z.object({ id: z.string().min(1).max(150) }), req.params); if (!ctx.billing.offers("personal").some(o => o.key === "plus")) return { active: false }; return ctx.billing.promotions.current(await subject(req), id); });
 app.post("/v2/billing/promotions/events", options, async req => ctx.billing.promotions.feedback(await subject(req), parse(EventBody, req.body)));
 app.get("/v2/billing/promotions/preference", options, async req => ctx.billing.promotions.preferenceOf(await subject(req)));
 app.put("/v2/billing/promotions/preference", options, async req => ctx.billing.promotions.preference(await subject(req), parse(OptOutBody, req.body).optOut));
}
