import type { FastifyInstance } from "fastify";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { MEETING_REPEATS, MeetingBody, MeetingListQuery, MeetingRespondBody, MeetingUpdateBody, OrgParams } from "../../shared/contracts/http/meetings.js";
import { idParams } from "../../shared/contracts/http/primitives.js";
import { parse } from "../../shared/validation/index.js";
import type { EventRepeat } from "../organizations/eventRepeat.js";

/** The contract's repeat values are exactly the community events' (a compile error here when they drift apart). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const repeatsMatch: Same<EventRepeat, (typeof MEETING_REPEATS)[number]> = true;
void repeatsMatch;

/**
 * Scheduled meetings in voice channels (round 7, docs/WORKSPACE_C5.md), shown as community events in the app. The
 * service checks permissions itself; these routes only parse.
 */
export default async function meetingRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };

  app.get("/v1/orgs/:orgId/meetings", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const q = parse(MeetingListQuery, req.query);
    const from = q.from ?? Date.now() - 3_600_000;
    return { meetings: ctx.meetings.list(orgId, me(req).userId, from, q.to ?? from + 30 * 86_400_000) };
  });

  app.post("/v1/orgs/:orgId/meetings", auth, async (req) => ({ meeting: await ctx.meetings.create(parse(OrgParams, req.params).orgId, me(req).userId, parse(MeetingBody, req.body)) }));

  app.get("/v1/meetings/:id", auth, async (req) => ({ meeting: ctx.meetings.get(parse(idParams, req.params).id, me(req).userId) }));

  app.put("/v1/meetings/:id", auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(MeetingUpdateBody, req.body);
    return { meeting: await ctx.meetings.update(id, me(req).userId, body.rev, body) };
  });

  app.post("/v1/meetings/:id/cancel", auth, async (req) => ({ meeting: await ctx.meetings.cancel(parse(idParams, req.params).id, me(req).userId) }));

  app.post("/v1/meetings/:id/respond", auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { response } = parse(MeetingRespondBody, req.body);
    return { meeting: await ctx.meetings.respond(id, me(req).userId, response) };
  });
}
