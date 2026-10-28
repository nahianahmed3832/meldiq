import type { FastifyInstance } from "fastify";
import { requireSyntheticScopeForOrg } from "./syntheticScope.js";
import type { RowWriter } from "../../infrastructure/database/rows/index.js";
import {
  ApplicationAnswerBody,
  ApplicationQuestionsBody,
  ApplicationsQuery,
  ApplyBody,
  MAX_QUESTIONS,
} from "../../shared/contracts/http/applications.js";
import { IdParamsNonEmpty, OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { noteJoin } from "./activityAlerts.js";
import { notifyOrg } from "./orgsRoutes.js";

/**
 * Join applications (batch B4b, Discord reference ADMIN-CTRL-008 "Apply to Join"): a public community can ask up to five
 * questions; people answer and wait; holders of `members.approve` approve (they join, with the same checks as joining
 * openly: bans, paused joining, the member limit) or deny. Answers are plaintext the applicant writes for moderators.
 */
export { MAX_QUESTIONS };

interface ApplicationRow {
  id: string;
  org_id: string;
  user_id: string;
  answers: string;
  status: "pending" | "approved" | "denied" | "withdrawn";
  created_at: number;
  handled_by: string | null;
  handled_at: number | null;
  note: string | null;
}

/** A community's questions, or null when it doesn't take applications. */
export function joinQuestions(org: { join_questions?: string | null }): string[] | null {
  if (!org.join_questions) return null;
  try {
    const q = JSON.parse(org.join_questions);
    return Array.isArray(q) ? q.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function approvers(ctx: AppContext, orgId: string): string[] {
  const members = ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: orgId } });
  return members.map((m) => m.user_id).filter((u) => ctx.authz.can(orgId, u, "members.approve"));
}

export default async function applicationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, authz, ws } = ctx;
  const auth = { preHandler: requireAuth(ctx) };
  const application = (id: string) => ws.get<ApplicationRow>("join_applications", { id });

  const view = (r: ApplicationRow) => {
    const u = ctx.identity.get<{ id: string; username: string; display_name: string }>("users", { id: r.user_id });
    const by = r.handled_by ? ctx.identity.get<{ display_name: string }>("users", { id: r.handled_by }) : undefined;
    const org = ws.get<{ join_questions: string | null }>("orgs", { id: r.org_id });
    return {
      id: r.id,
      orgId: r.org_id,
      user: u ? { id: u.id, username: u.username, displayName: u.display_name } : { id: r.user_id, username: null, displayName: null },
      questions: org ? (joinQuestions(org) ?? []) : [],
      answers: JSON.parse(r.answers) as string[],
      status: r.status,
      createdAt: r.created_at,
      handledAt: r.handled_at,
      handledByName: by?.display_name ?? null,
      note: r.note,
    };
  };

  /** Turns applications on with these questions, changes them, or turns them off (null). */
  app.put("/v1/orgs/:orgId/application", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const actor = me(req).userId;
    const body = parse(ApplicationQuestionsBody, req.body);
    authz.requireOrgMember(orgId, actor);
    if (!authz.can(orgId, actor, "workspace.edit")) throw forbidden("Your role doesn't include changing how people join");
    await ws.write((w) => w.update("orgs", { id: orgId }, { join_questions: body.questions ? JSON.stringify(body.questions) : null }));
    ctx.audit({ actorId: actor, orgId, action: body.questions ? "community.applications_on" : "community.applications_off", target: orgId });
    notifyOrg(ctx, orgId);
    return { questions: body.questions };
  });

  app.post("/v1/communities/:id/apply", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const userId = me(req).userId;
    const { id } = parse(IdParamsNonEmpty, req.params);
    const body = parse(ApplyBody, req.body);
    const o = ws.get<any>("orgs", { id });
    const questions = o ? joinQuestions(o) : null;
    if (!o || o.visibility !== "public" || !questions) throw notFound("This community doesn't take applications");
    if (authz.orgRole(id, userId)) throw conflict("You're already a member");
    requireSyntheticScopeForOrg(ctx, userId, id);
    if (authz.isBanned(id, userId)) throw new ApiError(403, "banned", "You've been banned from this community");
    if (authz.pausedUntil(id, "invites", now())) throw new ApiError(403, "invites_paused", "This community has paused new members for now. Try again later.");
    if (body.answers.length !== questions.length || body.answers.some((a) => !a)) throw badRequest("Answer every question");
    const appId = newId("apl");
    // Checked and written in one unit: two taps make one application.
    const pending = await ws.write((w) => {
      const existing = w.get<ApplicationRow>("join_applications", { org_id: id, user_id: userId, status: "pending" });
      if (!existing) w.insert("join_applications", { id: appId, org_id: id, user_id: userId, answers: JSON.stringify(body.answers), created_at: now() });
      return existing;
    });
    if (pending) return { application: view(pending), repeated: true };
    ctx.hub.sendToUsers(approvers(ctx, id), { t: "org.applications", orgId: id });
    return { application: view(application(appId)!), repeated: false };
  });

  app.get("/v1/orgs/:orgId/applications", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const actor = me(req).userId;
    const q = parse(ApplicationsQuery, req.query);
    authz.requireOrgMember(orgId, actor);
    authz.requirePermission(orgId, actor, "members.approve", "Your role doesn't include applications");
    const rows = ws.all<ApplicationRow>("join_applications", {
      where: { org_id: orgId, status: q.status === "pending" ? "pending" : { ne: "pending" } },
      orderBy: [["created_at", "desc"]],
      limit: 100,
    });
    const pending = ws.count("join_applications", { org_id: orgId, status: "pending" });
    return { applications: rows.map(view), pending };
  });

  app.patch("/v1/applications/:id", auth, async (req) => {
    const actor = me(req).userId;
    const { id } = parse(IdParamsNonEmpty, req.params);
    const body = parse(ApplicationAnswerBody, req.body);
    const r = application(id);
    if (!r || !authz.can(r.org_id, actor, "members.approve")) throw notFound("Application not found");
    if (r.status !== "pending") throw conflict("This application was already answered");
    const t = now();
    // B13: the answer is claimed with a conditional update inside the transaction, so two moderators answering at once
    // can't both approve (or approve and deny) the same application.
    const claim = (w: RowWriter, status: string) =>
      w.update("join_applications", { id, status: "pending" }, { status, handled_by: actor, handled_at: t, note: body.note ?? null }) > 0;
    if (body.status === "approved") {
      if (authz.isBanned(r.org_id, r.user_id)) throw new ApiError(409, "banned", "This person is banned from the community");
      await ws.write((w) => {
        if (!claim(w, "approved")) throw conflict("This application was already answered");
        ctx.entitlements.check("members", w.count("org_members", { org_id: r.org_id }), r.org_id);
        w.insert("org_members", { org_id: r.org_id, user_id: r.user_id, role: "MEMBER", joined_at: t }, { orIgnore: true });
        authz.autoJoinScope(w, r.org_id, r.user_id, t);
      });
      await noteJoin(ctx, r.org_id, t);
    } else if (!(await ws.write((w) => claim(w, "denied")))) {
      throw conflict("This application was already answered");
    }
    ctx.audit({ actorId: actor, orgId: r.org_id, action: `application.${body.status}`, target: r.user_id });
    notifyOrg(ctx, r.org_id);
    ctx.hub.sendToUser(r.user_id, { t: "org.application", orgId: r.org_id, status: body.status });
    return { application: view(application(id)!) };
  });

  /** The person's own applications (pending and answered), newest first. */
  app.get("/v1/me/applications", auth, async (req) => {
    const userId = me(req).userId;
    const rows = ws.all<ApplicationRow>("join_applications", { where: { user_id: userId }, orderBy: [["created_at", "desc"]], limit: 50 });
    return {
      applications: rows.map((r) => ({
        id: r.id,
        orgId: r.org_id,
        orgName: ws.get<{ name: string }>("orgs", { id: r.org_id })?.name ?? null,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  });

  app.delete("/v1/applications/:id", auth, async (req) => {
    const userId = me(req).userId;
    const { id } = parse(IdParamsNonEmpty, req.params);
    const r = application(id);
    if (!r || r.user_id !== userId) throw notFound("Application not found");
    if (r.status === "pending") await ws.write((w) => w.update("join_applications", { id }, { status: "withdrawn", handled_at: now() }));
    return { ok: true };
  });
}
