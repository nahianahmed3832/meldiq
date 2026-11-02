import { readControl } from "../../app/platformControls.js";
import { addMonths } from "../billing/gifts.js";
import { standingOf, revokeWarning } from "../accounts/standing.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import type { AppContext } from "../../app/context.js";
import { randomInt, timingSafeEqual, createHash } from "node:crypto";
import { networkKey } from "../../app/middleware/abuse.js";
import { parse } from "../../shared/validation/index.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../../shared/errors.js";
import { now, newId } from "../../shared/utilities/util.js";
import {
  NoticeBody,
  NoticeStateBody,
  OpsId,
  OpsQuery,
  AppealBody,
  AppealDecision,
  PromotionBody,
  PolicyBody,
} from "../../shared/contracts/http/operations.js";
import { zReason } from "../../shared/contracts/http/platformAdmin.js";
import { me, requireAuth } from "../auth/index.js";
import type { AdminDeps } from "./dataRoutes.js";
import type { Permission } from "./permissions.js";
import { allowed } from "./permissions.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import { runtimePolicy, inRollout } from "./runtimePolicy.js";
import { PlatformAudit } from "./audit.js";
import { notifyOrg } from "../organizations/orgsRoutes.js";

type NoticeRow = {
  id: string;
  target_user_id: string | null;
  status: string;
  starts_at: number;
  ends_at: number | null;
  version: number;
  kind: string;
  created_by: string;
  title: string;
  body: string;
};
type AppealRow = {
  id: string;
  user_id: string;
  notice_id: string | null;
  version: number;
  status: string;
};
type PromotionRow = {
  product: string;
  discount_percent: number;
  code: string;
  enabled: number;
  starts_at: number;
  ends_at: number;
  months: number;
  redeemed: number;
  max_redemptions: number;
  version: number;
};
const params = z.object({ id: OpsId });
const reasonBody = z.strictObject({ reason: zReason });
const live = (n: NoticeRow, t: number) =>
  n.status === "published" &&
  n.starts_at <= t &&
  (n.ends_at === null || n.ends_at > t);
const publicNotice = (n: NoticeRow) => ({
  id: n.id,
  title: n.title,
  body: n.body,
  kind: n.kind,
  startsAt: n.starts_at,
  endsAt: n.ends_at,
});
function list<T>(
  ctx: AppContext,
  table: string,
  query: unknown,
  billing = false,
) {
  const q = parse(OpsQuery, query);
  const rows = (billing ? ctx.billing.rows : ctx.platform).all<
    T & { id: string }
  >(table, {
    where: q.after ? { id: { gt: q.after } } : {},
    orderBy: [["id", "asc"]],
    limit: q.limit + 1,
  });
  return {
    items: rows.slice(0, q.limit),
    next: rows.length > q.limit ? rows[q.limit - 1].id : null,
  };
}
export async function legacyOperatorAllowed(
  ctx: AppContext,
  userId: string,
  permission: Permission,
): Promise<boolean> {
  if (!ctx.config.platformAdmins.has(userId)) return false;
  if (
    ctx.platform.get<{ value: string }>("platform_settings", {
      key: `operator.denied.${userId}`,
    })?.value === "true"
  )
    return false;
  const account = await ctx.accounts.store.accountByUserId(userId);
  if (!account) return true; // retain the existing pre-account operator, unless explicitly denied
  const grant = ctx.platform.get<{
    role: any;
    revoked_at: number | null;
    permissions: string | null;
  }>("platform_admins", { account_id: account.id });
  return !grant || (grant.revoked_at === null && allowed(grant, permission));
}
export default async function operationsAdminRoutes(
  app: FastifyInstance,
  d: AdminDeps,
) {
  const needs = (p: Permission) => ({
    preHandler: requirePermission(d.auth, d.audit, p),
  });
  const audit = (
    req: FastifyRequest,
    action: string,
    target: string,
    reason: string,
    detail?: Record<string, string | number | boolean | null>,
  ) => {
    const p = principal(req);
    return {
      action,
      targetType: "operation",
      targetId: target,
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      outcome: "success" as const,
      reason,
      requestId: String(req.id),
      network: networkKey(req.ip),
      detail,
    };
  };
  app.get(
    "/admin/v1/operations/notices",
    needs("incidents.view"),
    async (req) => list(d.ctx, "platform_notices", req.query),
  );
  app.post(
    "/admin/v1/operations/notices",
    needs("announcements.manage"),
    async (req) => {
      const x = parse(NoticeBody, req.body);
      if (x.kind !== "announcement")
        throw badRequest("Use account-standing warnings for moderation");
      if (
        x.targetUserId &&
        !d.ctx.identity.get("users", { id: x.targetUserId })
      )
        throw notFound("Recipient not found");
      const id = newId("notice"),
        t = now();
      await d.ctx.platform.write((w) => {
        w.insert("platform_notices", {
          id,
          kind: x.kind,
          title: x.title,
          body: x.body,
          target_user_id: x.targetUserId,
          status: "draft",
          starts_at: x.startsAt,
          ends_at: x.endsAt,
          version: 1,
          created_by: principal(req).account.id,
          created_at: t,
          updated_at: t,
        });
        d.audit.append(
          w,
          audit(req, "notice.create", id, x.reason, {
            kind: x.kind,
            targetUserId: x.targetUserId,
          }),
        );
      });
      return { item: d.ctx.platform.get("platform_notices", { id }) };
    },
  );
  app.post(
    "/admin/v1/operations/notices/:id/state",
    needs("announcements.manage"),
    async (req) => {
      const { id } = parse(params, req.params),
        x = parse(NoticeStateBody, req.body);
      await d.ctx.platform.write((w) => {
        const n = w.get<NoticeRow>("platform_notices", { id });
        if (!n) throw notFound();
        if (
          n.kind === "warning" &&
          !allowed(principal(req).grant, "reports.manage")
        )
          throw forbidden();
        if (n.version !== x.version)
          throw conflict("Refresh this notice before changing it");
        if (
          x.status === "published" &&
          n.ends_at !== null &&
          n.ends_at <= now()
        )
          throw badRequest("The notice has expired");
        w.update(
          "platform_notices",
          { id },
          { status: x.status, version: x.version + 1, updated_at: now() },
        );
        d.audit.append(
          w,
          audit(req, "notice." + x.status, id, x.reason, {
            before: n.status,
            after: x.status,
          }),
        );
      });
      return { item: d.ctx.platform.get("platform_notices", { id }) };
    },
  );
  app.get(
    "/admin/v1/operations/notices/:id/receipts",
    needs("incidents.view"),
    async (req) => {
      const { id } = parse(params, req.params);
      if (!d.ctx.platform.get("platform_notices", { id })) throw notFound();
      return {
        read: d.ctx.platform.count("platform_notice_receipts", {
          notice_id: id,
        }),
      };
    },
  );

  app.get(
    "/admin/v1/operations/warnings",
    needs("reports.view"),
    async (req) => {
      const { userId } = parse(z.object({ userId: OpsId }), req.query);
      return {
        standing: standingOf(d.ctx.safety, userId),
        items: d.ctx.safety.all("account_warnings", {
          where: { user_id: userId },
          orderBy: [["created_at", "desc"]],
          limit: 100,
        }),
      };
    },
  );
  app.post(
    "/admin/v1/operations/warnings",
    needs("reports.manage"),
    async (req) => {
      const x = parse(
        z.strictObject({
          userId: OpsId,
          days: z.number().int().min(1).max(365),
          message: z.string().trim().min(10).max(500),
          requestId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
          reason: zReason,
        }),
        req.body,
      );
      if (!d.ctx.identity.get("users", { id: x.userId }))
        throw notFound("User not found");
      if (x.userId === principal(req).account.user_id)
        throw forbidden("Another moderator must handle your account");
      const id = "warn_" + x.requestId;
      await d.audit.record(
        audit(req, "warning.requested", id, x.reason, {
          userId: x.userId,
          days: x.days,
        }),
      );
      await d.ctx.safety.write((w) => {
        const old = w.get<{ user_id: string; reason: string }>(
          "account_warnings",
          { id },
        );
        if (old) {
          if (old.user_id !== x.userId || old.reason !== x.message)
            throw conflict("This request key was used for a different warning");
          return;
        }
        w.insert("account_warnings", {
          id,
          user_id: x.userId,
          reason: x.message,
          created_by: principal(req).account.id,
          created_at: now(),
          expires_at: now() + x.days * 86400000,
          revoked_at: null,
        });
      });
      await d.audit.record(
        audit(req, "warning.created", id, x.reason, { userId: x.userId }),
      );
      return { id, standing: standingOf(d.ctx.safety, x.userId) };
    },
  );
  app.post(
    "/admin/v1/operations/warnings/:id/revoke",
    needs("reports.manage"),
    async (req) => {
      const { id } = parse(params, req.params),
        { reason } = parse(reasonBody, req.body);
      if (!d.ctx.safety.get("account_warnings", { id })) throw notFound();
      await d.audit.record(audit(req, "warning.revoke_requested", id, reason));
      await revokeWarning(d.ctx.safety, id);
      await d.audit.record(audit(req, "warning.revoked", id, reason));
      return { ok: true };
    },
  );
  app.get("/admin/v1/operations/appeals", needs("reports.view"), async (req) =>
    list(d.ctx, "platform_appeals", req.query),
  );
  app.post(
    "/admin/v1/operations/appeals/:id/decision",
    needs("reports.manage"),
    async (req) => {
      const { id } = parse(params, req.params),
        x = parse(AppealDecision, req.body),
        p = principal(req);
      if (x.assigneeAccountId) {
        const g = d.store.activeGrant(x.assigneeAccountId);
        if (!g || !allowed(g, "reports.manage"))
          throw badRequest("Choose an active moderator");
      }
      await d.ctx.platform.write((w) => {
        const a = w.get<AppealRow>("platform_appeals", { id });
        if (!a) throw notFound();
        if (a.user_id === p.account.user_id)
          throw forbidden("Another moderator must handle your appeal");
        if (
          a.notice_id &&
          d.ctx.safety.get<{ created_by: string }>("account_warnings", {
            id: a.notice_id,
          })?.created_by === p.account.id &&
          x.status !== "escalated"
        )
          throw forbidden(
            "Another moderator must review an appeal against your warning",
          );
        if (a.version !== x.version)
          throw conflict("The appeal changed; refresh it");
        w.update(
          "platform_appeals",
          { id },
          {
            status: x.status,
            decision: x.decision,
            assigned_to: x.assigneeAccountId ?? null,
            delivery_pending: 1,
            next_delivery_at: 0,
            sync_status: x.status === "accepted" ? "pending" : "complete",
            version: x.version + 1,
            updated_at: now(),
          },
        );
        d.audit.append(
          w,
          audit(req, "appeal." + x.status, id, x.reason, {
            before: a.status,
            after: x.status,
          }),
        );
      });
      await settleAppealDecisions(d.ctx, id);
      return { item: d.ctx.platform.get("platform_appeals", { id }) };
    },
  );
  app.get(
    "/admin/v1/operations/promotions",
    needs("billing.view"),
    async (req) => {
      const q = parse(OpsQuery, req.query);
      const rows = d.ctx.billing.rows.all<{ code: string }>(
        "billing_promotions",
        {
          where: q.after ? { code: { gt: q.after } } : {},
          orderBy: [["code", "asc"]],
          limit: q.limit + 1,
        },
      );
      return {
        items: rows.slice(0, q.limit),
        next: rows.length > q.limit ? rows[q.limit - 1].code : null,
      };
    },
  );
  app.put(
    "/admin/v1/operations/promotions",
    needs("billing.manage"),
    async (req) => {
      const x = parse(PromotionBody, req.body);
      await d.audit.record(
        audit(req, "promotion.save_requested", x.code, x.reason),
      );
      await d.ctx.billing.rows.write((w) => {
        const old = w.get<PromotionRow>("billing_promotions", { code: x.code });
        if ((old?.version ?? 0) !== x.version)
          throw conflict("This promotion changed; refresh it");
        if (
          old &&
          (old.months !== x.months ||
            old.product !== x.product ||
            old.discount_percent !== x.discountPercent ||
            x.maxRedemptions < old.redeemed)
        )
          throw badRequest(
            "Existing terms are immutable and the cap must include prior redemptions",
          );
        const v = {
          product: x.product,
          discount_percent: x.discountPercent,
          title: x.title,
          months: x.months,
          max_redemptions: x.maxRedemptions,
          enabled: x.enabled ? 1 : 0,
          starts_at: x.startsAt,
          ends_at: x.endsAt,
          version: x.version + 1,
          updated_at: now(),
        };
        w.upsert(
          "billing_promotions",
          { code: x.code, ...v, redeemed: 0, created_at: now() },
          v,
        );
      });
      await d.audit.record(audit(req, "promotion.saved", x.code, x.reason));
      return {
        item: d.ctx.billing.rows.get("billing_promotions", { code: x.code }),
      };
    },
  );
  app.get("/admin/v1/operations/policy", needs("settings.view"), async () =>
    runtimePolicy(d.ctx.platform),
  );
  app.get(
    "/admin/v1/operations/policy/history",
    needs("settings.view"),
    async () => ({
      items: d.ctx.platform
        .all<{ value: string; updated_at: number }>("platform_settings", {
          where: {
            key: { gte: "operations.policy_revision." },
            $or: [{ key: { lt: "operations.policy_revision/" } }],
          },
          orderBy: [["key", "desc"]],
          limit: 30,
        })
        .filter((r) => {
          try {
            return (
              typeof JSON.parse(r.value).version === "number" &&
              !!JSON.parse(r.value).policy
            );
          } catch {
            return false;
          }
        })
        .map((r) => ({ ...JSON.parse(r.value), updatedAt: r.updated_at })),
    }),
  );
  app.put(
    "/admin/v1/operations/policy",
    needs("controls.edit"),
    async (req) => {
      const x = parse(PolicyBody, req.body);
      await d.ctx.platform.write((w) => {
        const old = runtimePolicy(w);
        if (old.version !== x.version)
          throw conflict("Policy changed; refresh it");
        w.upsert(
          "platform_settings",
          {
            key: "operations.policy",
            value: JSON.stringify({ version: x.version + 1, policy: x.policy }),
            updated_by: principal(req).account.id,
            updated_at: now(),
          },
          "replace",
        );
        w.upsert(
          "platform_settings",
          {
            key: `operations.policy_revision.${String(x.version + 1).padStart(10, "0")}`,
            value: JSON.stringify({ version: x.version + 1, policy: x.policy }),
            updated_by: principal(req).account.id,
            updated_at: now(),
          },
          "replace",
        );
        d.audit.append(
          w,
          audit(req, "operations.policy", "policy", x.reason, {
            before: JSON.stringify(old.policy),
            after: JSON.stringify(x.policy),
            beforeHash: createHash("sha256")
              .update(JSON.stringify(old.policy))
              .digest("hex"),
            afterHash: createHash("sha256")
              .update(JSON.stringify(x.policy))
              .digest("hex"),
          }),
        );
      });
      return runtimePolicy(d.ctx.platform);
    },
  );
  app.get("/admin/v1/operations/operators", needs("admins.view"), async () => ({
    items: await Promise.all(
      [...d.ctx.config.platformAdmins].slice(0, 1000).map(async (userId) => {
        const a = await d.ctx.accounts.store.accountByUserId(userId);
        const g = a ? d.store.grant(a.id) : null;
        return {
          userId,
          configured: true,
          denied: !(await legacyOperatorAllowed(d.ctx, userId, "health.view")),
          consoleAccountId: a?.id ?? null,
          consoleRole: g?.role ?? null,
          consoleRevoked: !!g?.revoked_at,
        };
      }),
    ),
  }));
  app.put(
    "/admin/v1/operations/operators/:id",
    needs("admins.manage"),
    async (req) => {
      const { id } = parse(params, req.params),
        x = parse(
          z.strictObject({ denied: z.boolean(), reason: zReason }),
          req.body,
        );
      if (!d.ctx.config.platformAdmins.has(id))
        throw badRequest(
          "Only configured legacy operators can be reduced here",
        );
      if (principal(req).account.user_id === id)
        throw badRequest(
          "Another super administrator must change your legacy access",
        );
      await d.ctx.platform.write((w) => {
        w.upsert(
          "platform_settings",
          {
            key: `operator.denied.${id}`,
            value: JSON.stringify(x.denied),
            updated_by: principal(req).account.id,
            updated_at: now(),
          },
          "replace",
        );
        d.audit.append(
          w,
          audit(req, "operator.access", id, x.reason, { denied: x.denied }),
        );
      });
      return { ok: true };
    },
  );
  app.get("/admin/v1/operations/ownership", needs("orgs.view"), async (req) =>
    list(d.ctx, "platform_ownership_requests", req.query),
  );
  app.post(
    "/admin/v1/operations/ownership",
    needs("orgs.ownership.request"),
    async (req) => {
      const x = parse(
        z.strictObject({
          orgId: OpsId,
          ownerUserId: OpsId,
          targetUserId: OpsId,
          confirmName: z.string().max(200),
          reason: zReason,
        }),
        req.body,
      );
      const org = d.ctx.ws.get<{ name: string }>("orgs", { id: x.orgId });
      if (!org) throw notFound();
      if (org.name !== x.confirmName)
        throw badRequest("Type the exact community name");
      if (d.ctx.authz.orgRole(x.orgId, x.ownerUserId) !== "OWNER")
        throw conflict("The chosen owner must still own this community");
      const role = d.ctx.authz.orgRole(x.orgId, x.targetUserId);
      if (!role || role === "GUEST" || role === "OWNER")
        throw badRequest("Choose a current non-guest member");
      const id = newId("ownreq");
      await d.ctx.platform.write((w) => {
        w.insert("platform_ownership_requests", {
          id,
          org_id: x.orgId,
          owner_user_id: x.ownerUserId,
          target_user_id: x.targetUserId,
          requested_by: principal(req).account.id,
          reason: x.reason,
          status: "pending",
          created_at: now(),
          expires_at: now() + 7 * 86400000,
          completed_at: null,
        });
        d.audit.append(
          w,
          audit(req, "ownership.request", id, x.reason, {
            orgId: x.orgId,
            targetUserId: x.targetUserId,
          }),
        );
      });
      return {
        item: d.ctx.platform.get("platform_ownership_requests", { id }),
      };
    },
  );
}

export async function operationalUserRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const retry = async () => {
    await Promise.all([
      settleAppealDecisions(ctx),
      settleOwnershipRequests(ctx),
    ]).catch(() =>
      ctx.log.error({ kind: "appeal_recovery" }, "Appeal recovery will retry"),
    );
  };
  const retryTimer = setInterval(() => void retry(), 60000);
  retryTimer.unref();
  app.addHook("onReady", retry);
  app.addHook("onClose", async () => clearInterval(retryTimer));
  const auth = {
    preHandler: requireAuth(ctx),
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  };
  const strict = { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } };
  app.post("/v2/platform/appeals/email/start", strict, async (req, reply) => {
    const { email } = parse(
      z.strictObject({
        email: z.string().trim().toLowerCase().email().max(254),
      }),
      req.body,
    );
    if (!ctx.accounts.mailer.available)
      throw new Error("Appeal email delivery is unavailable");
    const a = await ctx.accounts.store.accountByEmail(email),
      id = newId("appealproof"),
      code = String(randomInt(100000, 1000000)),
      t = now();
    const limited =
      !!a?.user_id &&
      ctx.ephemeral.count("platform_appeal_challenges", {
        account_id: a.id,
        created_at: { gt: t - 3600000 },
      }) >= 5;
    await ctx.ephemeral.write((w) => {
      w.delete("platform_appeal_challenges", { expires_at: { lt: t } });
      w.insert("platform_appeal_challenges", {
        id,
        account_id: limited ? null : (a?.id ?? null),
        user_id: limited ? null : (a?.user_id ?? null),
        code_hash: createHash("sha256")
          .update(id + ":" + code)
          .digest("hex"),
        attempts: 0,
        created_at: t,
        expires_at: t + 15 * 60000,
      });
    });
    if (a?.user_id && !limited)
      await ctx.accounts.mailer.send({
        to: email,
        subject: "Meldiq appeal verification code",
        text: `Your appeal verification code is ${code}. It expires in 15 minutes and cannot sign in or change your account. If you did not request it, ignore this message.`,
      });
    return reply
      .code(202)
      .send({
        challengeId: id,
        message:
          "If that address belongs to an account, an appeal code has been sent.",
      });
  });
  app.post("/v2/platform/appeals/email/complete", strict, async (req) => {
    const x = parse(
      z.strictObject({
        challengeId: OpsId,
        code: z.string().regex(/^\d{6}$/),
        subject: z.string().trim().min(3).max(120),
        body: z.string().trim().min(10).max(4000),
      }),
      req.body,
    );
    const proof = await ctx.ephemeral.write((w) => {
      const c = w.get<{
        user_id: string | null;
        account_id: string | null;
        code_hash: string;
        attempts: number;
        expires_at: number;
      }>("platform_appeal_challenges", { id: x.challengeId });
      if (!c || c.expires_at <= now() || c.attempts >= 5) return null;
      w.update(
        "platform_appeal_challenges",
        { id: x.challengeId },
        { attempts: c.attempts + 1 },
      );
      if (
        !timingSafeEqual(
          Buffer.from(c.code_hash, "hex"),
          createHash("sha256")
            .update(x.challengeId + ":" + x.code)
            .digest(),
        ) ||
        !c.user_id
      )
        return null;
      w.delete("platform_appeal_challenges", { id: x.challengeId });
      return c;
    });
    if (!proof?.user_id)
      throw badRequest("The appeal code is invalid or expired");
    const id = newId("appeal");
    await ctx.platform.write((w) => {
      if (
        w.count("platform_appeals", {
          user_id: proof.user_id!,
          created_at: { gt: now() - 86400000 },
        }) >= 5
      )
        throw badRequest("You can submit up to five appeals per day");
      w.insert("platform_appeals", {
        id,
        user_id: proof.user_id!,
        notice_id: null,
        subject: x.subject,
        body: x.body,
        status: "open",
        decision: null,
        assigned_to: null,
        version: 1,
        created_at: now(),
        updated_at: now(),
      });
      new PlatformAudit(ctx.platform).append(w, {
        action: "appeal.email_submitted",
        outcome: "success",
        targetType: "appeal",
        targetId: id,
        detail: { userId: proof.user_id! },
      });
    });
    return { id, status: "open" };
  });

  app.get("/v2/platform/notices", auth, async (req) => {
    const userId = me(req).userId,
      t = now();
    const q = parse(OpsQuery, req.query);
    const items = ctx.platform.all<NoticeRow>("platform_notices", {
      where: {
        status: "published",
        starts_at: { lte: t },
        $or: [
          { ends_at: null, target_user_id: null },
          { ends_at: null, target_user_id: userId },
          { ends_at: { gt: t }, target_user_id: null },
          { ends_at: { gt: t }, target_user_id: userId },
        ],
        ...(q.after ? { id: { gt: q.after } } : {}),
      },
      orderBy: [["id", "asc"]],
      limit: q.limit + 1,
    });
    return {
      items: items
        .slice(0, q.limit)
        .filter((n) => live(n, t))
        .map((n) => ({
          ...publicNotice(n),
          read: !!ctx.platform.get("platform_notice_receipts", {
            notice_id: n.id,
            user_id: userId,
          }),
        })),
      next: items.length > q.limit ? items[q.limit - 1].id : null,
    };
  });
  app.post("/v2/platform/notices/:id/read", auth, async (req) => {
    const { id } = parse(params, req.params),
      u = me(req).userId,
      n = ctx.platform.get<NoticeRow>("platform_notices", { id });
    if (!n || !live(n, now()) || (n.target_user_id && n.target_user_id !== u))
      throw notFound();
    await ctx.platform.write((w) =>
      w.insert(
        "platform_notice_receipts",
        { notice_id: id, user_id: u, read_at: now() },
        { orIgnore: true },
      ),
    );
    return { ok: true };
  });
  app.get("/v2/platform/appeals", auth, async (req) => ({
    items: ctx.platform.all("platform_appeals", {
      where: { user_id: me(req).userId },
      orderBy: [["created_at", "desc"]],
      limit: 50,
    }),
  }));
  app.post("/v2/platform/appeals", auth, async (req) => {
    const x = parse(AppealBody, req.body),
      u = me(req).userId;
    const id = newId("appeal");
    await ctx.platform.write((w) => {
      if (x.noticeId) {
        const n = ctx.safety.get<{ user_id: string }>("account_warnings", {
          id: x.noticeId,
        });
        if (!n || n.user_id !== u) throw notFound("Warning not found");
        if (
          w.get("platform_appeals", {
            user_id: u,
            notice_id: x.noticeId,
            status: { in: ["open", "escalated"] },
          })
        )
          throw conflict("An appeal is already open for this warning");
      }
      if (
        w.count("platform_appeals", {
          user_id: u,
          created_at: { gt: now() - 86400000 },
        }) >= 5
      )
        throw badRequest("You can submit up to five appeals per day");
      w.insert("platform_appeals", {
        id,
        user_id: u,
        notice_id: x.noticeId,
        subject: x.subject,
        body: x.body,
        status: "open",
        decision: null,
        assigned_to: null,
        version: 1,
        created_at: now(),
        updated_at: now(),
      });
      new PlatformAudit(ctx.platform).append(w, {
        action: "appeal.submitted",
        outcome: "success",
        targetType: "appeal",
        targetId: id,
        detail: { userId: u },
      });
    });
    return { item: ctx.platform.get("platform_appeals", { id }) };
  });
  app.get("/v2/platform/features", auth, async (req) => ({
    features: Object.fromEntries(
      (["calls", "uploads", "orgCreation"] as const).map((f) => [
        f,
        readControl(ctx.platform, "features")[f] &&
          inRollout(ctx.platform, f, me(req).userId),
      ]),
    ),
    version: runtimePolicy(ctx.platform).version,
  }));
  app.post("/v2/platform/promotions/redeem", auth, async (req) => {
    const { code } = parse(
      z.strictObject({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9-]{4,32}$/),
      }),
      req.body,
    );
    const u = me(req).userId,
      a = await ctx.accounts.store.accountByUserId(u);
    if (!a)
      throw forbidden("Sign in with your Meldiq account to redeem a promotion");
    const t = now();
    let grantId = "";
    await ctx.billing.rows.write((w) => {
      const old = w.get<{ grant_id: string }>("billing_promotion_redemptions", {
        code,
        account_id: a.id,
      });
      if (old) {
        grantId = old.grant_id;
        return;
      }
      const p = w.get<PromotionRow>("billing_promotions", { code });
      if (
        !p ||
        p.product !== "plus_time" ||
        !p.enabled ||
        p.starts_at > t ||
        p.ends_at <= t ||
        p.redeemed >= p.max_redemptions
      )
        throw conflict("This promotion is unavailable");
      grantId = newId("grt");
      const current = ctx.billing.grants.active(a.id, t);
      const subscription = ctx.billing.subscriptions.liveForOwner({
        kind: "account",
        accountId: a.id,
      });
      const starts = Math.max(
        t,
        current?.ends_at ?? t,
        subscription?.current_period_end ?? t,
      );
      w.insert("billing_grants", {
        id: grantId,
        account_id: a.id,
        user_id: u,
        plan_key: "plus",
        source: "operator",
        reference: `promotion:${code}`,
        once_key: `promotion:${code}:${a.id}`,
        starts_at: starts,
        ends_at: addMonths(starts, p.months),
        created_at: t,
      });
      w.insert("billing_promotion_redemptions", {
        code,
        account_id: a.id,
        user_id: u,
        grant_id: grantId,
        redeemed_at: t,
      });
      w.update(
        "billing_promotions",
        { code },
        { redeemed: p.redeemed + 1, updated_at: t },
      );
    });
    ctx.billing.onChange?.({ kind: "account", accountId: a.id });
    return { ok: true, grantId };
  });
  app.get("/v2/platform/ownership", auth, async (req) => ({
    items: ctx.platform.all("platform_ownership_requests", {
      where: {
        owner_user_id: me(req).userId,
        status: "pending",
        expires_at: { gt: now() },
      },
      limit: 50,
    }),
  }));
  app.post("/v2/platform/ownership/:id/approve", auth, async (req) => {
    const { id } = parse(params, req.params),
      { confirmName } = parse(
        z.strictObject({ confirmName: z.string().max(200) }),
        req.body,
      );
    const r = ctx.platform.get<{
      org_id: string;
      owner_user_id: string;
      target_user_id: string;
      expires_at: number;
      status: string;
    }>("platform_ownership_requests", { id });
    if (!r || r.owner_user_id !== me(req).userId) throw notFound();
    if (r.expires_at <= now() || r.status !== "pending")
      throw conflict("This request is no longer pending");
    if (ctx.authz.platformSuspended(r.org_id))
      throw forbidden("This community is suspended");
    const org = ctx.ws.get<{ name: string }>("orgs", { id: r.org_id });
    if (!org || org.name !== confirmName)
      throw badRequest("Type the exact community name");
    if (ctx.authz.orgRole(r.org_id, me(req).userId) !== "OWNER")
      throw forbidden("Only the current owner can approve");
    await ctx.platform.write((w) => {
      const current = w.get<{ status: string }>("platform_ownership_requests", {
        id,
      });
      if (current?.status !== "pending")
        throw conflict("This request is no longer pending");
      w.update(
        "platform_ownership_requests",
        { id },
        { status: "approved", approved_name: confirmName },
      );
      new PlatformAudit(ctx.platform).append(w, {
        action: "ownership.owner_approved",
        outcome: "success",
        targetType: "org",
        targetId: r.org_id,
        detail: { requestId: id, ownerUserId: r.owner_user_id },
      });
    });
    await settleOwnershipRequests(ctx, id);
    return { ok: true };
  });
}

const appealDeliveryActive = new WeakSet<AppContext>();
export async function settleAppealDecisions(ctx: AppContext, id?: string) {
  if (appealDeliveryActive.has(ctx)) return;
  appealDeliveryActive.add(ctx);
  try {
    const rows = ctx.platform.all<{
      id: string;
      user_id: string;
      notice_id: string | null;
      status: string;
      subject: string;
      decision: string | null;
      version: number;
      notified_version: number;
      sync_status: string;
    }>("platform_appeals", {
      where: {
        ...(id ? { id } : {}),
        status: { in: ["accepted", "rejected", "escalated"] },
        next_delivery_at: { lte: now() },
        $or: [{ delivery_pending: 1 }, { sync_status: "pending" }],
      },
      orderBy: [["updated_at", "asc"]],
      limit: 50,
    });
    for (const a of rows) {
      if (a.sync_status === "pending" && a.status === "accepted") {
        if (a.notice_id) await revokeWarning(ctx.safety, a.notice_id);
        await ctx.platform.write((w) => {
          w.update(
            "platform_appeals",
            { id: a.id, version: a.version },
            { sync_status: "complete" },
          );
          new PlatformAudit(ctx.platform).append(w, {
            action: "appeal.warning_restored",
            outcome: "success",
            targetType: "appeal",
            targetId: a.id,
          });
        });
      }
      if (a.notified_version >= a.version) continue;
      const account = await ctx.accounts.store.accountByUserId(a.user_id);
      try {
        if (!account || !ctx.accounts.mailer.available)
          throw new Error("delivery_unavailable");
        await ctx.accounts.mailer.send({
          to: account.email,
          subject: "Meldiq appeal update",
          text: `Your appeal “${a.subject}” is ${a.status}.\n\n${a.decision ?? ""}\n\nAppeal reference: ${a.id}`,
        });
        await ctx.platform.write((w) =>
          w.update(
            "platform_appeals",
            { id: a.id, version: a.version },
            {
              notified_version: a.version,
              notification_error: null,
              delivery_pending: 0,
            },
          ),
        );
      } catch {
        await ctx.platform.write((w) =>
          w.update(
            "platform_appeals",
            { id: a.id, version: a.version },
            {
              notification_error: "delivery_failed",
              next_delivery_at: now() + 300000,
            },
          ),
        );
      }
    }
  } finally {
    appealDeliveryActive.delete(ctx);
  }
}

const ownershipActive = new WeakSet<AppContext>();
export async function settleOwnershipRequests(ctx: AppContext, id?: string) {
  if (ownershipActive.has(ctx)) return;
  ownershipActive.add(ctx);
  try {
    const rows = ctx.platform.all<{
      id: string;
      org_id: string;
      owner_user_id: string;
      target_user_id: string;
      approved_name: string;
      expires_at: number;
    }>("platform_ownership_requests", {
      where: { status: "approved", ...(id ? { id } : {}) },
      limit: 50,
    });
    for (const r of rows) {
      let valid = true;
      await ctx.ws.write((w) => {
        const owner = ctx.authz.orgRole(r.org_id, r.owner_user_id),
          target = ctx.authz.orgRole(r.org_id, r.target_user_id);
        if (owner === "ADMIN" && target === "OWNER") return;
        const org = w.get<{ name: string }>("orgs", { id: r.org_id });
        if (
          !org ||
          org.name !== r.approved_name ||
          owner !== "OWNER" ||
          !target ||
          target === "GUEST" ||
          target === "OWNER" ||
          ctx.authz.platformSuspended(r.org_id) ||
          r.expires_at <= now()
        ) {
          valid = false;
          return;
        }
        w.update(
          "org_members",
          { org_id: r.org_id, user_id: r.target_user_id },
          { role: "OWNER" },
        );
        w.update(
          "org_members",
          { org_id: r.org_id, user_id: r.owner_user_id },
          { role: "ADMIN" },
        );
        ctx.authz.autoJoinScope(w, r.org_id, r.target_user_id, now());
      });
      await ctx.platform.write((w) => {
        if (
          w.get<{ status: string }>("platform_ownership_requests", { id: r.id })
            ?.status !== "approved"
        )
          return;
        w.update(
          "platform_ownership_requests",
          { id: r.id },
          { status: valid ? "completed" : "cancelled", completed_at: now() },
        );
        new PlatformAudit(ctx.platform).append(w, {
          action: valid ? "ownership.completed" : "ownership.cancelled",
          outcome: valid ? "success" : "failed",
          targetType: "org",
          targetId: r.org_id,
          detail: { requestId: r.id },
        });
      });
      if (valid) notifyOrg(ctx, r.org_id);
    }
  } finally {
    ownershipActive.delete(ctx);
  }
}
