import type { FastifyInstance } from "fastify";
import { type AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { parse } from "../../../shared/validation/index.js";
import { badRequest } from "../../../shared/errors.js";
import {
  ReminderAckBody,
  ReminderCreateBody,
  ReminderListQuery,
  ReminderParams,
  ReminderUpdateBody,
} from "../../../shared/contracts/http/reminders.js";
import { isValidTimeZone } from "./schedule.js";

/**
 * Reminders (docs/REMINDERS.md): the person's own, on any of their devices. Content is sealed by the app; only the
 * owner can list, change or delete theirs (anyone else's id answers like one that doesn't exist).
 */
export default async function reminderRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const writes = { ...auth, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  const reminders = ctx.reminders;

  app.get("/v1/reminders", auth, async (req) => {
    const { userId } = me(req);
    const { state } = parse(ReminderListQuery, req.query);
    return { reminders: reminders.list(userId, state) };
  });

  app.get("/v1/reminders/:id", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(ReminderParams, req.params);
    return { reminder: reminders.get(userId, id) };
  });

  app.post("/v1/reminders", writes, async (req, reply) => {
    const { userId, deviceId } = me(req);
    const body = parse(ReminderCreateBody, req.body);
    return reply.code(201).send({ reminder: await reminders.create(userId, deviceId, body) });
  });

  app.patch("/v1/reminders/:id", writes, async (req) => {
    const { userId, deviceId } = me(req);
    const { id } = parse(ReminderParams, req.params);
    const body = parse(ReminderUpdateBody, req.body);
    if (body.repeat && !isValidTimeZone(body.timeZone ?? "UTC")) throw badRequest("Unknown time zone");
    return { reminder: await reminders.update(userId, deviceId, id, body) };
  });

  app.delete("/v1/reminders/:id", writes, async (req) => {
    const { userId, deviceId } = me(req);
    const { id } = parse(ReminderParams, req.params);
    await reminders.delete(userId, deviceId, id);
    return { ok: true };
  });

  app.post("/v1/reminders/:id/ack", writes, async (req) => {
    const { userId } = me(req);
    const { id } = parse(ReminderParams, req.params);
    const { firedAt } = parse(ReminderAckBody, req.body);
    await reminders.ack(userId, id, firedAt);
    return { ok: true };
  });
}
