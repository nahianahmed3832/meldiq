import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { CREATOR_RULES, CreatorPostBody, CreatorVerificationQuery } from "../../../shared/contracts/http/creators.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { readBody } from "../profileMediaRoutes.js";

/** Creator verification and the creator programme (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md). */
export default async function creatorRoutes(app: FastifyInstance, ctx: AppContext) {
  const limited = (max: number, timeWindow: string) => ({ preHandler: requireAuth(ctx), config: { rateLimit: { max, timeWindow } } });
  const read = limited(60, "1 minute");
  const creators = ctx.creators;

  app.get("/v2/creators/verification", read, async (req) => creators.verification(me(req).userId));

  app.post("/v2/creators/verification", limited(10, "1 hour"), async (req, reply) => {
    const { userId } = me(req);
    const form = parse(CreatorVerificationQuery, req.query);
    const buf = await readBody(req, CREATOR_RULES.proofMaxBytes, "Proof screenshots");
    const v = await creators.apply(userId, form, buf);
    return reply.status(201).send({ application: creators.applicationView(v) });
  });

  app.get("/v2/creators/program", read, async (req) => creators.program(me(req).userId));

  app.post("/v2/creators/program/apply", limited(10, "1 hour"), async (req, reply) => {
    const a = await creators.applyProgram(me(req).userId);
    return reply.status(201).send({ application: creators.programView(a) });
  });

  app.get("/v2/creators/posts", read, async (req) => ({ posts: (await creators.posts(me(req).userId)).map((p) => creators.postView(p)) }));

  app.post("/v2/creators/posts", limited(30, "1 hour"), async (req, reply) => {
    const body = parse(CreatorPostBody, req.body);
    const p = await creators.submitPost(me(req).userId, body);
    return reply.status(201).send({ post: creators.postView(p) });
  });
}
