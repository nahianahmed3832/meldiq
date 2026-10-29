import type { FastifyInstance, FastifyRequest } from "fastify";
import { networkKey } from "../../app/middleware/abuse.js";
import { AdminCreatorListQuery, AdminCreatorParams, AdminCreatorPostReview, AdminCreatorPostsQuery, AdminCreatorReject } from "../../shared/contracts/http/creators.js";
import { ApiError, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import type { AdminDeps } from "./dataRoutes.js";
import { metaOf, principal, requirePermission } from "./guards.js";

/**
 * The creators review queues (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md): channel verification applications
 * with their proof screenshots, applications to the creator programme, and the posts members send (counted or not,
 * with a reward note). Every decision is audited.
 */
export default async function adminCreatorRoutes(app: FastifyInstance, d: AdminDeps) {
  const needs = { preHandler: requirePermission(d.auth, d.audit, "creators.review") };
  const creators = d.ctx.creators;

  const person = (userId: string, names: Map<string, string>) => ({ userId, username: creators.usernameOf(userId), displayName: names.get(userId) ?? null });

  const record = async (req: FastifyRequest, action: string, targetType: string, targetId: string, reason: string, detail: Record<string, string | number | boolean | null>) => {
    const p = principal(req);
    const meta = metaOf(req);
    await d.audit.record({
      action,
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType,
      targetId,
      reason,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail,
    });
  };

  // Channel verification.
  app.get("/admin/v1/creators/verification", needs, async (req) => {
    const q = parse(AdminCreatorListQuery, req.query);
    const page = await creators.verificationPage(q.status, q.before ?? null, q.limit);
    const names = d.ctx.userNames(page.items.map((v) => v.userId));
    return {
      applications: page.items.map((v) => ({
        ...creators.applicationView(v),
        user: person(v.userId, names),
        codeLine: creators.codeLine(v.userId),
        nameMatches: creators.nameMatches(v.userId, v.channelName),
        proofUrl: `/admin/v1/creators/verification/${v.id}/proof`,
        proofType: v.proofType,
        proofSize: v.proofSize,
        reviewedBy: v.reviewedBy,
      })),
      next: page.next,
    };
  });

  app.get("/admin/v1/creators/verification/:id/proof", needs, async (req, reply) => {
    const { id } = parse(AdminCreatorParams, req.params);
    const proof = await creators.proof(id);
    if (!proof) throw notFound("Not found");
    // Shown inside the console only: never sniffed, never framed, never cached.
    return reply
      .header("content-type", proof.type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "no-store")
      .send(proof.body);
  });

  const decideVerification = (decision: "approve" | "reject") => async (req: FastifyRequest) => {
    const { id } = parse(AdminCreatorParams, req.params);
    const reason = decision === "reject" ? parse(AdminCreatorReject, req.body).reason : null;
    const decided = await creators.decideVerification(id, decision, principal(req).account.id, reason);
    if (!decided) throw new ApiError(409, "conflict", "This application has already been reviewed, or doesn't exist.");
    await record(req, `creator.verification.${decision}`, "creator_verification", id, reason ?? "approved", { userId: decided.userId, platform: decided.platform, channelName: decided.channelName });
    return { application: creators.applicationView(decided) };
  };
  app.post("/admin/v1/creators/verification/:id/approve", needs, decideVerification("approve"));
  app.post("/admin/v1/creators/verification/:id/reject", needs, decideVerification("reject"));

  // The creator programme.
  app.get("/admin/v1/creators/program", needs, async (req) => {
    const q = parse(AdminCreatorListQuery, req.query);
    const page = await creators.programPage(q.status, q.before ?? null, q.limit);
    const names = d.ctx.userNames(page.items.map((a) => a.userId));
    return {
      applications: page.items.map((a) => ({ ...creators.programView(a), user: person(a.userId, names), verified: creators.isVerified(a.userId), reviewedBy: a.reviewedBy })),
      next: page.next,
    };
  });

  const decideProgram = (decision: "approve" | "reject") => async (req: FastifyRequest) => {
    const { id } = parse(AdminCreatorParams, req.params);
    const reason = decision === "reject" ? parse(AdminCreatorReject, req.body).reason : null;
    const decided = await creators.decideProgram(id, decision, principal(req).account.id, reason);
    if (!decided) throw new ApiError(409, "conflict", "This application has already been reviewed, or doesn't exist.");
    await record(req, `creator.program.${decision}`, "creator_program", id, reason ?? "approved", { userId: decided.userId });
    return { application: creators.programView(decided) };
  };
  app.post("/admin/v1/creators/program/:id/approve", needs, decideProgram("approve"));
  app.post("/admin/v1/creators/program/:id/reject", needs, decideProgram("reject"));

  // Posts members sent.
  app.get("/admin/v1/creators/posts", needs, async (req) => {
    const q = parse(AdminCreatorPostsQuery, req.query);
    const page = await creators.postsPage(q.status === "counted", q.before ?? null, q.limit);
    const names = d.ctx.userNames(page.items.map((p) => p.userId));
    return { posts: page.items.map((p) => ({ ...creators.postView(p), user: person(p.userId, names), reviewedBy: p.reviewedBy })), next: page.next };
  });

  app.post("/admin/v1/creators/posts/:id/review", needs, async (req) => {
    const { id } = parse(AdminCreatorParams, req.params);
    const body = parse(AdminCreatorPostReview, req.body);
    const reviewed = await creators.reviewPost(id, principal(req).account.id, body.counted, body.rewardNote);
    if (!reviewed) throw notFound("Post not found");
    await record(req, "creator.post.review", "creator_post", id, body.counted ? "counted" : "not counted", { userId: reviewed.userId, rewardNote: reviewed.rewardNote });
    return { post: creators.postView(reviewed) };
  });
}
