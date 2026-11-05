import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { OrgParamsNonEmpty } from "../../../shared/contracts/http/community.js";
import { TicketListQuery, TicketOpenBody, TicketPanelParams, TicketParams, TicketRevisionBody, TicketsConfigBody } from "../../../shared/contracts/http/tickets.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { TicketDesk } from "./ticketDesk.js";

/** Tickets (community parity batch C, docs/COMMUNITY_PARITY_API.md › Posting tools). */
export default async function ticketRoutes(app: FastifyInstance, ctx: AppContext) {
  const t = ctx.tickets;
  const desk = new TicketDesk(t);
  const auth = { preHandler: requireAuth(ctx) };
  const few = { ...auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.get("/v1/orgs/:orgId/tickets/config", auth, async (req) => t.config(parse(OrgParamsNonEmpty, req.params).orgId, me(req).userId));
  app.put("/v1/orgs/:orgId/tickets/config", auth, async (req) => t.setConfig(parse(OrgParamsNonEmpty, req.params).orgId, me(req).userId, parse(TicketsConfigBody, req.body)));
  app.post("/v1/orgs/:orgId/tickets/panels/:panelId/post", few, async (req) => {
    const p = parse(TicketPanelParams, req.params);
    return t.postPanel(p.orgId, p.panelId, me(req).userId, req.log);
  });
  app.get("/v1/orgs/:orgId/tickets", auth, async (req) => t.list(parse(OrgParamsNonEmpty, req.params).orgId, me(req).userId, parse(TicketListQuery, req.query).state));
  app.post("/v1/orgs/:orgId/tickets", few, async (req, reply) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    return reply.code(201).send(await desk.open(orgId, me(req).userId, parse(TicketOpenBody, req.body), req.log));
  });
  app.post("/v1/orgs/:orgId/tickets/:channelId/join", auth, async (req) => {
    const p = parse(TicketParams, req.params);
    return desk.join(p.orgId, p.channelId, me(req).userId);
  });
  app.post("/v1/orgs/:orgId/tickets/:channelId/close", auth, async (req) => {
    const p = parse(TicketParams, req.params);
    return desk.close(p.orgId, p.channelId, me(req).userId, req.log);
  });
  app.post("/v1/orgs/:orgId/tickets/:channelId/claim", auth, async (req) => {
    const p = parse(TicketParams, req.params);
    return desk.assign(p.orgId, p.channelId, me(req).userId);
  });
  app.delete("/v1/orgs/:orgId/tickets/:channelId/claim", auth, async (req) => {
    const p = parse(TicketParams, req.params);
    return desk.assign(p.orgId, p.channelId, me(req).userId, parse(TicketRevisionBody, req.body).expectedRevision);
  });
  app.post("/v1/orgs/:orgId/tickets/:channelId/reopen", few, async (req) => {
    const p = parse(TicketParams, req.params);
    return desk.reopen(p.orgId, p.channelId, me(req).userId, parse(TicketRevisionBody, req.body).expectedRevision);
  });
}
