import type { FastifyInstance } from "fastify";
import { IdParamsNonEmpty, OrgParamsNonEmpty } from "../../../shared/contracts/http/community.js";
import { REPORT_REASON_KEYS, ReportBody, ReportStatusBody, ReportsQuery } from "../../../shared/contracts/http/reports.js";
import { type AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { parse } from "../../../shared/validation/index.js";
import { REPORT_REASONS, type ReportRow } from "./store.js";
import { ApiError, badRequest, notFound } from "../../../shared/errors.js";
import { newId, now } from "../../../shared/utilities/util.js";

/**
 * Reports (batch B4, docs/product/MELDIQ_FULLSTACK_SPEC.md §2.2; Discord reference CHAT-MSG-003, FRIEND-CTRL-011).
 *
 * Messages are end-to-end encrypted, so the server never sees what was said. A report carries only what the reporter's
 * app chose to share after showing them a review step: the decrypted message, its attachments' names and hashes, and up
 * to five messages of context. That is sealed with the server's reports key and shown to the community's moderators
 * (people with `reports.view`), or to Meldiq's operators for direct messages, groups and illegal content. Moderators
 * don't see who reported. Closed reports are deleted 90 days after they were handled (jobs.ts).
 */
export const REPORTS_PER_HOUR = 10;
export const REPORT_PAGE = 50;
export const REPORT_RETENTION_MS = 90 * 86_400_000;

// The contract's copy of the reasons (shared/ can't import modules) stays equal to REPORT_REASONS.
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameReasons: SameKeys<(typeof REPORT_REASON_KEYS)[number], (typeof REPORT_REASONS)[number]> = true;
void _sameReasons;

/** Who reports go to: a community's moderators, or Meldiq's operators (null). */
function scopeOf(ctx: AppContext, reason: string, conv: { type: string; org_id: string | null } | undefined, orgId: string | undefined, reporter: string, target: string): string | null {
  if (reason === "illegal") return null;
  if (conv) return conv.type === "CHANNEL" ? conv.org_id : null;
  if (orgId && ctx.authz.orgRole(orgId, reporter) && ctx.authz.orgRole(orgId, target)) return orgId;
  return null;
}

/** The people who see a community's reports: holders of `reports.view` there. */
function moderators(ctx: AppContext, orgId: string): string[] {
  const members = ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: orgId } });
  return members.map((m) => m.user_id).filter((u) => ctx.authz.can(orgId, u, "reports.view"));
}

function person(ctx: AppContext, userId: string | null) {
  if (!userId) return null;
  const u = ctx.identity.get<{ id: string; username: string; display_name: string }>("users", { id: userId });
  return u ? { id: u.id, username: u.username, displayName: u.display_name } : { id: userId, username: null, displayName: null };
}

/** A report as moderators see it: never who reported it. */
function moderatorView(ctx: AppContext, r: ReportRow) {
  const conv = r.conversation_id ? ctx.ws.get<{ name: string | null; type: string }>("conversations", { id: r.conversation_id }) : undefined;
  return {
    id: r.id,
    orgId: r.org_id,
    reason: r.reason,
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
    handledAt: r.handled_at,
    handledBy: person(ctx, r.handled_by),
    handledNote: r.handled_note,
    target: person(ctx, r.target_user_id),
    conversationId: r.conversation_id,
    conversationName: conv?.name ?? null,
    messageId: r.message_id,
    content: ctx.reportSealer.open(r.id, r.content),
  };
}

export default async function reportRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, authz } = ctx;
  const auth = { preHandler: requireAuth(ctx) };

  const notifyModerators = async (orgId: string) => {
    const open = await ctx.reports.countOpen(orgId);
    ctx.hub.sendToUsers(moderators(ctx, orgId), { t: "org.reports", orgId, open });
  };

  app.post("/v1/reports", auth, async (req) => {
    const { userId } = me(req);
    const body = parse(ReportBody, req.body);
    if (body.targetUserId === userId) throw badRequest("You can't report yourself");
    if (body.messageId && !body.conversationId) throw badRequest("Say which conversation the message is in");
    if (!ctx.identity.get("users", { id: body.targetUserId })) throw notFound("No such person");
    // A message report needs the reporter to be in the conversation; the server checks the sender while it still knows.
    const conv = body.conversationId ? authz.requireMember(body.conversationId, userId) : undefined;
    if (body.messageId) {
      const sent = await ctx.relay.submission(body.messageId);
      if (sent && sent.sender_user_id !== body.targetUserId) throw badRequest("That message wasn't sent by this person");
      const earlier = await ctx.reports.byReporterMessage(userId, body.messageId);
      if (earlier) return { report: { id: earlier.id, status: earlier.status, to: earlier.org_id ? "community" : "meldiq", repeated: true } };
    }
    const t = now();
    if ((await ctx.reports.countSince(userId, t - 3_600_000)) >= REPORTS_PER_HOUR) {
      throw new ApiError(429, "report_limit", "You've sent a lot of reports in the last hour. Try again later.");
    }
    const id = newId("rep");
    const orgId = scopeOf(ctx, body.reason, conv, body.orgId, userId, body.targetUserId);
    await ctx.reports.create({
      id,
      org_id: orgId,
      reporter_id: userId,
      target_user_id: body.targetUserId,
      conversation_id: body.conversationId ?? null,
      message_id: body.messageId ?? null,
      reason: body.reason,
      note: body.note || null,
      content: body.content ? ctx.reportSealer.seal(id, body.content) : null,
      status: "open",
      handled_by: null,
      handled_note: null,
      created_at: t,
      handled_at: null,
    });
    if (orgId) await notifyModerators(orgId);
    req.log.info({ reportId: id, scope: orgId ? "community" : "meldiq", reason: body.reason }, "report received");
    return { report: { id, status: "open", to: orgId ? "community" : "meldiq", repeated: false } };
  });

  app.get("/v1/orgs/:orgId/reports", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const q = parse(ReportsQuery, req.query);
    authz.requireOrgMember(orgId, userId);
    authz.requirePermission(orgId, userId, "reports.view", "Your role doesn't include reports");
    const rows = await ctx.reports.list(orgId, q.status === "closed", REPORT_PAGE + 1, q.before);
    const page = rows.slice(0, REPORT_PAGE);
    return {
      reports: page.map((r) => moderatorView(ctx, r)),
      open: await ctx.reports.countOpen(orgId),
      nextBefore: rows.length > REPORT_PAGE ? page[page.length - 1].created_at : null,
    };
  });

  app.patch("/v1/reports/:id", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(IdParamsNonEmpty, req.params);
    const body = parse(ReportStatusBody, req.body);
    const r = await ctx.reports.get(id);
    // Operators' reports are handled with the admin tools; everyone else sees the same 404 for reports they can't see.
    if (!r?.org_id || !authz.can(r.org_id, userId, "reports.view")) throw notFound("Report not found");
    // A moderator never closes a report about themselves (the owner, who answers to no one in the community, may).
    if (r.target_user_id === userId && authz.orgRole(r.org_id, userId) !== "OWNER") {
      throw new ApiError(403, "own_report", "This report is about you: another moderator handles it");
    }
    const updated = (await ctx.reports.setStatus(id, body.status, userId, body.note || null, now()))!;
    ctx.audit({ actorId: userId, orgId: r.org_id, action: body.status === "open" ? "report.reopen" : `report.${body.status}`, target: id });
    await notifyModerators(r.org_id);
    return { report: moderatorView(ctx, updated) };
  });
}
