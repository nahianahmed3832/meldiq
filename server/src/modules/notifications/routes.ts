import type { FastifyInstance } from "fastify";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { FcmBody, UnifiedPushBody } from "../../shared/contracts/http/notifications.js";
import { checkEndpoint, ENDPOINT_REFUSALS } from "./address.js";
import { removeUnifiedPushEndpoint } from "./service.js";
import { ApiError } from "../../shared/errors.js";

/**
 * Push wake-ups (docs/BACKGROUND_DELIVERY.md): the signed-in device registers, replaces or removes its own UnifiedPush
 * endpoint. Only endpoints on the server's allow-listed push hosts are accepted; wake-ups never carry content.
 */
export default async function pushRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };

  app.put("/v1/devices/current/push", auth, async (req) => {
    const { deviceId } = me(req);
    const push = ctx.push;
    if (!push) throw new ApiError(404, "push_unavailable", "This server doesn't send push wake-ups");
    const body = parse(UnifiedPushBody, req.body);
    const checked = checkEndpoint(body.endpoint, push.config.unifiedPushHosts);
    if ("refusal" in checked) {
      const details = checked.refusal === "push_host_not_allowed" ? { allowedHosts: push.config.unifiedPushHosts } : undefined;
      throw new ApiError(400, checked.refusal, ENDPOINT_REFUSALS[checked.refusal], details);
    }
    return { push: await push.register(deviceId, checked.url) };
  });

  /** Firebase (docs/PUSH_FCM.md): this device's FCM registration token, when the server has FCM configured. */
  app.put("/v1/devices/current/fcm", auth, async (req) => {
    const { deviceId } = me(req);
    if (!ctx.fcm) throw new ApiError(404, "push_unavailable", "This server doesn't send Firebase wake-ups");
    const { token } = parse(FcmBody, req.body);
    return { push: await ctx.fcm.register(deviceId, token) };
  });

  app.delete("/v1/devices/current/fcm", auth, async (req) => {
    const { deviceId } = me(req);
    const removed = await ctx.identity.write((w) => w.delete("fcm_tokens", { device_id: deviceId }) > 0);
    return { ok: true, removed };
  });

  // Also works while the server has push turned off, so a device can always withdraw its endpoint.
  app.delete("/v1/devices/current/push", auth, async (req) => {
    const { deviceId } = me(req);
    const removed = await (ctx.push ? ctx.push.unregister(deviceId) : removeUnifiedPushEndpoint(ctx.identity, deviceId));
    return { ok: true, removed };
  });
}
