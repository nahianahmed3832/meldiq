import type { FastifyInstance } from "fastify";
import { networkKey } from "../../app/middleware/abuse.js";
import { AdminDecorationDecision, AdminDecorationParams, AdminDecorationsQuery } from "../../shared/contracts/http/platformAdmin.js";
import { ApiError, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import type { AdminDeps } from "./dataRoutes.js";
import { metaOf, principal, requirePermission } from "./guards.js";

/**
 * The review queue for profile decorations people send in (API 0.60.0, docs/PROFILE_DECORATIONS.md): look at each
 * one, approve it (it joins the catalog with its maker's name) or turn it down with a reason the maker sees, and take an
 * approved one down again (it comes off everyone wearing it). Every decision is audited.
 */
export default async function adminDecorationRoutes(app: FastifyInstance, d: AdminDeps) {
  const needs = { preHandler: requirePermission(d.auth, d.audit, "decorations.review") };
  const deco = d.ctx.decorations;

  app.get("/admin/v1/decorations", needs, async (req) => {
    const q = parse(AdminDecorationsQuery, req.query);
    const page = await deco.store.page(q.status, q.before ?? null, q.limit);
    const names = d.ctx.userNames(page.items.map((x) => x.creatorId));
    return {
      decorations: page.items.map((x) => ({
        ...deco.submissionView(x),
        imageUrl: `/admin/v1/decorations/${x.id}/image`,
        format: x.format,
        size: x.size,
        creator: { userId: x.creatorId, displayName: names.get(x.creatorId) ?? null, artist: deco.isArtist(x.creatorId) },
        reviewedBy: x.reviewedBy,
      })),
      next: page.next,
    };
  });

  app.get("/admin/v1/decorations/:id/image", needs, async (req, reply) => {
    const { id } = parse(AdminDecorationParams, req.params);
    const image = await deco.anyImage(id);
    if (!image) throw notFound("Not found");
    // Shown inside the console only: never sniffed, never framed, never cached.
    return reply.header("content-type", image.type).header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; sandbox").send(image.body);
  });

  app.post("/admin/v1/decorations/:id/decision", needs, async (req) => {
    const { id } = parse(AdminDecorationParams, req.params);
    const body = parse(AdminDecorationDecision, req.body);
    const p = principal(req);
    const reason = body.decision === "approve" ? null : body.reason;
    const decided = await deco.decide(id, body.decision, p.account.id, reason);
    if (!decided) throw new ApiError(409, "conflict", body.decision === "remove" ? "Only an approved decoration can be taken down." : "This decoration has already been reviewed.");
    const meta = metaOf(req);
    await d.audit.record({
      action: `decoration.${body.decision}`,
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "decoration",
      targetId: id,
      reason: reason ?? "approved",
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail: { creatorId: decided.creatorId, name: decided.name },
    });
    return { decoration: deco.submissionView(decided) };
  });
}
