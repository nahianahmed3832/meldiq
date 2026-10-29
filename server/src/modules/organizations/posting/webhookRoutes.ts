import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../../app/context.js";
import {
  ChannelWebhookParams,
  ChannelWebhooksParams,
  WEBHOOK_LIMITS,
  WebhookCreateBody,
  WebhookIdParams,
  WebhookMessageBody,
  WebhookRenameBody,
  WebhookTokenParams,
} from "../../../shared/contracts/http/webhooks.js";
import { parse } from "../../../shared/validation/index.js";
import { sha256Hex } from "../../../shared/utilities/util.js";
import { me, requireAuth } from "../../auth/index.js";
import { withImageType } from "../communityImages.js";

/** A webhook's post (Discord's JSON) is at most this large. */
const WEBHOOK_BODY_BYTES = 64 * 1024;

/**
 * Posts to a webhook's address are limited per webhook and token: someone guessing tokens for a webhook never uses up
 * its real address's allowance.
 */
const perWebhook = {
  rateLimit: {
    max: WEBHOOK_LIMITS.postsPerMinute,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => {
      const p = req.params as { webhookId?: string; token?: string };
      return `webhook:${p.webhookId ?? ""}:${sha256Hex(p.token ?? "").slice(0, 16)}`;
    },
  },
};

/**
 * Channel webhooks (community parity batch C, docs/COMMUNITY_PARITY_API.md › Posting tools): managing them (holders of
 * `webhooks.manage`), their pictures, "Make a post", and the secret address itself, which takes no session.
 */
export default async function webhookRoutes(app: FastifyInstance, ctx: AppContext) {
  const hooks = ctx.webhooks;
  const auth = { preHandler: requireAuth(ctx) };
  const base = "/v1/orgs/:orgId/channels/:channelId/webhooks";
  const channel = (req: FastifyRequest) => parse(ChannelWebhooksParams, req.params);
  const one = (req: FastifyRequest) => parse(ChannelWebhookParams, req.params);

  app.get(base, auth, async (req) => {
    const p = channel(req);
    return hooks.list(p.orgId, p.channelId, me(req).userId);
  });
  app.post(base, { ...auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const p = channel(req);
    const body = parse(WebhookCreateBody, req.body ?? {});
    return reply.code(201).send(await hooks.create(p.orgId, p.channelId, me(req).userId, body.name));
  });
  app.patch(`${base}/:webhookId`, auth, async (req) => {
    const p = one(req);
    return hooks.rename(p.orgId, p.channelId, p.webhookId, me(req).userId, parse(WebhookRenameBody, req.body).name);
  });
  app.put(`${base}/:webhookId/avatar`, auth, async (req) => {
    const p = one(req);
    return hooks.setAvatar(p.orgId, p.channelId, p.webhookId, me(req).userId, req);
  });
  app.delete(`${base}/:webhookId/avatar`, auth, async (req) => {
    const p = one(req);
    return hooks.clearAvatar(p.orgId, p.channelId, p.webhookId, me(req).userId);
  });
  app.post(`${base}/:webhookId/token`, { ...auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const p = one(req);
    return hooks.rotate(p.orgId, p.channelId, p.webhookId, me(req).userId);
  });
  app.delete(`${base}/:webhookId`, auth, async (req) => {
    const p = one(req);
    return hooks.remove(p.orgId, p.channelId, p.webhookId, me(req).userId);
  });
  app.post(`${base}/:webhookId/post`, { ...auth, bodyLimit: WEBHOOK_BODY_BYTES, config: { rateLimit: { max: WEBHOOK_LIMITS.postsPerMinute, timeWindow: "1 minute" } } }, async (req) => {
    const p = one(req);
    return hooks.postFor(p.orgId, p.channelId, p.webhookId, me(req).userId, parse(WebhookMessageBody, req.body), req.log);
  });

  app.get("/v1/webhooks/:webhookId/avatar", auth, async (req, reply) => {
    const { stream, rev } = await hooks.avatar(parse(WebhookIdParams, req.params).webhookId, me(req).userId);
    const { type, body } = await withImageType(stream);
    return reply.header("content-type", type).header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=3600").header("etag", `"${rev}"`).send(body);
  });

  // The secret address: no session, Discord's JSON (a `?wait=true` is accepted and changes nothing: the answer always
  // names the message).
  app.post("/v1/webhooks/:webhookId/:token", { bodyLimit: WEBHOOK_BODY_BYTES, config: perWebhook }, async (req) => {
    const p = parse(WebhookTokenParams, req.params);
    return hooks.execute(p.webhookId, p.token, parse(WebhookMessageBody, req.body), req.log);
  });
}
