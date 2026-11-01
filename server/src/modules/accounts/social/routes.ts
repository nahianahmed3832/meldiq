import { digest } from "./service.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { bearer } from "../../auth/index.js";
import { parse } from "../../../shared/validation/index.js";
import { unauthorized, ApiError } from "../../../shared/errors.js";
import {
  SocialProvider as provider,
  SocialToken as token,
  SocialFresh as fresh,
  SocialStart as start,
  SocialComplete as complete,
  SocialNative,
} from "../../../shared/contracts/http/socialAuth.js";
export default async function socialRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const social = ctx.accounts.social;
  const strict = {
    config: {
      rateLimit: {
        max: ctx.config.accounts.authRateLimitPerMinute,
        timeWindow: "1 minute",
      },
    },
  };
  const session = (req: FastifyRequest) =>
    ctx.accounts.service.sessions.authenticate(bearer(req), Date.now());
  const required = async (req: FastifyRequest) => {
    const s = await session(req);
    if (!s) throw unauthorized();
    return s;
  };
  const secure = social.config?.publicOrigin.startsWith("https:") ?? true;
  const cookieName = secure ? "__Host-meldiq-social" : "meldiq-social-dev";
  const cookie = (reply: FastifyReply, value: string, age: number) =>
    reply.header(
      "set-cookie",
      `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`,
    );
  app.addHook("onSend", async (req, reply) => {
    if (
      req.url.startsWith("/v2/auth/social") ||
      req.url.startsWith("/v2/account/identities")
    )
      reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer");
  });
  app.get("/v2/auth/social/config", async () => ({
    providers: social.config?.providers ?? [],
    googleClientId: social.config?.googleClientId ?? null,
    authorizeOrigin: social.config?.publicOrigin ?? null,
  }));
  app.post("/v2/auth/social/start", strict, async (req, reply) =>
    social.start(parse(start, req.body), await session(req), req.ip, reply),
  );
  app.get("/v2/auth/social/authorize/:id", strict, async (req, reply) => {
    const { id } = parse(z.object({ id: token }), req.params);
    const flow = await social.flow(id);
    try {
      const { url } = await social.authorize(id);
      cookie(reply, `${flow.id}.${flow.cookie}`, 600);
      return reply.redirect(url);
    } catch {
      const destination =
        flow.platform === "android"
          ? "meldiq://auth/callback"
          : `${social.config!.webOrigin}/social-auth-callback.html`;
      ctx.audit({
        action: "account.provider_failed",
        target: flow.accountId,
        detail: flow.provider,
      });
      return reply.redirect(
        `${destination}#${new URLSearchParams({ id, error: "verification_failed" })}`,
      );
    }
  });
  app.get("/v2/auth/social/callback", strict, async (req, reply) => {
    const raw = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    cookie(reply, "", 0);
    if (!raw)
      throw new ApiError(
        400,
        "social_state_invalid",
        "Sign-in state is missing. Start again from Meldiq.",
      );
    const [id, proof] = raw.split(".");
    parse(token, id);
    parse(token, proof);
    const q = parse(
      z.object({
        code: z.string().min(1).max(2048).optional(),
        error: z.string().max(200).optional(),
        error_description: z.string().max(2048).optional(),
        error_code: z.string().max(200).optional(),
      }),
      req.query,
    );
    const flow = await social.flow(id);
    const destination =
      flow.platform === "android"
        ? "meldiq://auth/callback"
        : `${social.config!.webOrigin}/social-auth-callback.html`;
    if (flow.stage !== "authorizing" || digest(proof) !== digest(flow.cookie))
      throw new ApiError(
        400,
        "social_state_invalid",
        "This sign-in state doesn't match. Start again.",
      );
    if (q.error || !q.code) {
      await social.store.replace(
        { ...flow, stage: "used", verifier: "", cookie: "", nonce: "" },
        "authorizing",
      );
      return reply.redirect(
        `${destination}#${new URLSearchParams({ id, error: "cancelled" })}`,
      );
    }
    try {
      const receipt = await social.callback(id, proof, q.code);
      return reply.redirect(
        `${destination}#${new URLSearchParams({ id: receipt.id, receipt: receipt.receipt })}`,
      );
    } catch {
      ctx.audit({
        action: "account.provider_failed",
        target: flow.accountId,
        detail: flow.provider,
      });
      return reply.redirect(
        `${destination}#${new URLSearchParams({ id, error: "verification_failed" })}`,
      );
    }
  });
  app.post("/v2/auth/social/native", strict, async (req) => {
    const b = parse(SocialNative, req.body);
    return social.native(b.id, b.verifier, b.idToken);
  });
  app.post("/v2/auth/social/complete", strict, async (req, reply) =>
    social.complete(
      parse(complete, req.body),
      await session(req),
      req.ip,
      reply,
    ),
  );
  app.get("/v2/account/identities", strict, async (req) =>
    social.list(await required(req)),
  );
  app.delete("/v2/account/identities/:provider", strict, async (req, reply) => {
    const p = parse(z.object({ provider }), req.params).provider;
    const b = parse(fresh.strict(), req.body ?? {});
    return social.disconnect(
      await required(req),
      p,
      b.password,
      b.totpCode,
      req.ip,
      reply,
    );
  });
}
