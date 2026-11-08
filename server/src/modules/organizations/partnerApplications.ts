import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { nameBlocked } from "./discovery/listing.js";
import { onboardingOn } from "./onboardingRoutes.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
import {
  PartnerSubmission,
  PartnerChecklist,
} from "../../shared/contracts/http/partners.js";
import {
  ApiError,
  conflict,
  notFound,
  forbidden,
} from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
export interface PartnerRow {
  org_id: string;
  submitted_by: string;
  statement: string;
  checklist: string;
  status: "submitted" | "approved" | "declined";
  rev: number;
  submitted_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  review_note: string | null;
}
const DAY = 86_400_000;
const MOD_ACTIONS = ["member.ban", "member.kick", "member.remove", "org.member.remove", "member.timeout", "member.voice_ban", "member.voice_mute", "member.voice_disconnect", "voice_room.mute", "voice_room.disconnect"];

export function partnerEligibility(ctx: AppContext, orgId: string, ownerId: string, rows: RowReader = ctx.ws, at = now()) {
  const org = rows.get<{ created_at: number; name: string }>("orgs", { id: orgId });
  const owner = ctx.identity.get<{ created_at: number; disabled_at: number | null }>("users", { id: ownerId });
  if (!org || !owner) throw notFound("Community not found");
  const ageDays = Math.max(0, Math.floor((at - Math.max(org.created_at, owner.created_at)) / DAY));
  const members = rows.count("org_members", { org_id: orgId });
  const hasRules = Boolean(ctx.communityRules.view(orgId, ownerId).channelId) || onboardingOn(ctx, orgId);
  const activeMods = new Set(rows.all<{ actor_id: string | null }>("audit_log", {
    where: { org_id: orgId, at: { gte: at - 30 * DAY }, action: { in: MOD_ACTIONS } },
  }).flatMap(({ actor_id }) => actor_id && actor_id !== ownerId && rows.get("org_members", { org_id: orgId, user_id: actor_id }) ? [actor_id] : [])).size;
  const verification = ctx.communitySafety.verificationLevel(orgId);
  const activeSparks = ctx.mojo.levelOf(orgId, at).active;
  const staffAction = ctx.platform.all<{ action: string; detail: string | null }>("platform_audit", { where: {
    target_type: "org", target_id: orgId, at: { gte: at - 90 * DAY }, outcome: "success", action: { in: ["org.suspend", "discovery.update", "org.warn"] },
  } }).some((row) => {
    if (row.action !== "discovery.update") return true;
    try { return JSON.parse(row.detail ?? "{}").removed === true; } catch { return true; }
  });
  const cleanStanding = !owner.disabled_at && !ctx.authz.platformSuspended(orgId) &&
    !nameBlocked(org.name, ctx.config.discovery.blockedWords) && !staffAction &&
    !ctx.safety.get("account_warnings", { user_id: ownerId, created_at: { gte: at - 90 * DAY }, revoked_at: null });
  const eligible = activeSparks >= 7 && members >= 1000 && hasRules && activeMods >= 2 &&
    ["medium", "high", "highest"].includes(verification) && ageDays >= 10 && cleanStanding;
  return { eligible, activeSparks, members, hasRules, activeMods, verification, ageDays, cleanStanding };
}

export function partnerView(r: PartnerRow) {
  return {
    orgId: r.org_id,
    statement: r.statement,
    checklist: PartnerChecklist.parse(JSON.parse(r.checklist)),
    status: r.status,
    rev: r.rev,
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
  };
}
export default async function partnerRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const auth = { preHandler: requireAuth(ctx) };
  const owner = (orgId: string, userId: string) => {
    if (ctx.authz.orgRole(orgId, userId) !== "OWNER")
      throw notFound("Application not found");
  };
  app.get("/v1/orgs/:orgId/partner-eligibility", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const { userId } = me(req);
    owner(orgId, userId);
    return partnerEligibility(ctx, orgId, userId);
  });
  app.get("/v1/orgs/:orgId/partner-application", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    owner(orgId, me(req).userId);
    const row = ctx.ws.get<PartnerRow>("org_partner_applications", {
      org_id: orgId,
    });
    return { application: row ? partnerView(row) : null };
  });
  app.put("/v1/orgs/:orgId/partner-application", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params),
      { userId } = me(req);
    owner(orgId, userId);
    const body = parse(PartnerSubmission, req.body);
    const application = await ctx.ws.write((w) => {
      const prior = w.get<PartnerRow>("org_partner_applications", {
        org_id: orgId,
      });
      if ((prior?.rev ?? 0) !== body.baseRev)
        throw new ApiError(
          409,
          "stale_revision",
          "This application changed. Reload before submitting.",
        );
      if (prior?.status === "approved")
        throw conflict(
          "This application was already approved. Contact the operator for any changes.",
        );
      if (!w.get("org_members", { org_id: orgId, user_id: userId, role: "OWNER" })) throw notFound("Application not found");
      if (!partnerEligibility(ctx, orgId, userId, w).eligible)
        throw conflict("This community has not met all Partner requirements.");
      const next: PartnerRow = {
        org_id: orgId,
        submitted_by: userId,
        statement: body.statement,
        checklist: JSON.stringify(body.checklist),
        status: "submitted",
        rev: body.baseRev + 1,
        submitted_at: now(),
        reviewed_at: null,
        reviewed_by: null,
        review_note: null,
      };
      const { org_id: _, ...set } = next;
      w.upsert("org_partner_applications", { ...next }, set);
      return partnerView(next);
    });
    return { application };
  });
}

/** Only the permission-guarded operator surface calls this internal projection. */
export function listPartnerApplications(
  ctx: AppContext,
  q: { after?: string; limit: number },
) {
  const rows = ctx.ws.all<PartnerRow>("org_partner_applications", {
    where: {
      status: "submitted",
      ...(q.after ? { org_id: { gt: q.after } } : {}),
    },
    orderBy: [["org_id", "asc"]],
    limit: q.limit + 1,
  });
  return {
    applications: rows.slice(0, q.limit).map(partnerView),
    nextAfter: rows.length > q.limit ? rows[q.limit - 1].org_id : null,
  };
}
export async function reviewPartnerApplication(
  ctx: AppContext,
  orgId: string,
  actor: { accountId: string; userId: string | null },
  body: { baseRev: number; status: "approved" | "declined"; reason: string },
) {
  return ctx.ws.write((w) => {
    const prior = w.get<PartnerRow>("org_partner_applications", {
      org_id: orgId,
    });
    if (!prior) throw notFound("Application not found");
    if (
      actor.userId === prior.submitted_by ||
      (actor.userId && ctx.authz.orgRole(orgId, actor.userId) === "OWNER")
    )
      throw forbidden("Another operator must review this application");
    if (prior.rev !== body.baseRev)
      throw new ApiError(
        409,
        "stale_revision",
        "This application changed. Reload before reviewing.",
      );
    if (prior.status !== "submitted")
      throw conflict("This application was already reviewed");
    if (body.status === "approved" && (!w.get("org_members", { org_id: orgId, user_id: prior.submitted_by, role: "OWNER" }) ||
      !partnerEligibility(ctx, orgId, prior.submitted_by, w).eligible))
      throw conflict("This community no longer meets the Partner requirements.");
    const next = {
      ...prior,
      status: body.status,
      rev: prior.rev + 1,
      reviewed_at: now(),
      reviewed_by: actor.accountId,
      review_note: body.reason,
    };
    w.update("org_partner_applications", { org_id: orgId }, next);
    return partnerView(next);
  });
}
