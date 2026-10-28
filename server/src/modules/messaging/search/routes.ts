import type { FastifyInstance } from "fastify";
import { type AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { SearchQuery } from "../../../shared/contracts/http/search.js";
import { parse } from "../../../shared/validation/index.js";
import { search, SEARCH_KINDS, type SearchKind } from "./service.js";

/** Universal search over what the server can read (docs/SEARCH.md, round 7 slice C2). */
export default async function searchRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };

  app.get("/v1/search", auth, async (req) => {
    const userId = me(req).userId;
    const p = parse(SearchQuery, req.query);
    const kinds = (p.types?.split(",").map((s) => s.trim()).filter(Boolean) ?? [...SEARCH_KINDS]).filter((k): k is SearchKind =>
      (SEARCH_KINDS as readonly string[]).includes(k),
    );
    // A workspace filter only for a workspace you're in (404 otherwise, like every other workspace route).
    if (p.orgId) ctx.authz.requireOrgMember(p.orgId, userId);
    return { query: p.q, results: await search(ctx, userId, p.q, kinds, { orgId: p.orgId, limit: p.limit, cursor: p.cursor }) };
  });
}
