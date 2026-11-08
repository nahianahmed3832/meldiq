import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { SearchQuery } from "../../../shared/contracts/http/search.js";
import { parse } from "../../../shared/validation/index.js";
import { search, SEARCH_KINDS, type SearchKind } from "./service.js";

/** Universal search over what the server can read (docs/SEARCH.md, round 7 slice C2). */
export default async function searchRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };

  const run = async (req: FastifyRequest, reply: FastifyReply, input: unknown) => {
    reply.header("cache-control", "no-store");
    const userId = me(req).userId;
    const p = parse(SearchQuery, input);
    const kinds = (p.types?.split(",").map((s) => s.trim()).filter(Boolean) ?? [...SEARCH_KINDS]).filter((k): k is SearchKind =>
      (SEARCH_KINDS as readonly string[]).includes(k),
    );
    // A workspace filter only for a workspace you're in (404 otherwise, like every other workspace route).
    if (p.orgId) ctx.authz.requireOrgMember(p.orgId, userId);
    return { query: p.q, results: await search(ctx, userId, p.q, kinds, { orgId: p.orgId, limit: p.limit, cursor: p.cursor }) };
  };
  app.get("/v1/search", auth, (req, reply) => run(req, reply, req.query));
  app.post("/v2/search", { ...auth, bodyLimit: 4096 }, (req, reply) => run(req, reply, req.body));
}
