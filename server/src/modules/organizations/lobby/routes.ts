import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { OrgParamsNonEmpty } from "../../../shared/contracts/http/community.js";
import { LobbyFeedParams, LobbyFeedPostBody, LobbySettingsBody, LobbyTemplateBody } from "../../../shared/contracts/http/communityLobby.js";
import { forbidden } from "../../../shared/errors.js";
import { sha256Hex } from "../../../shared/utilities/util.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { notifyOrg } from "../orgsRoutes.js";

/** Posts one feed URL may take per minute. */
const FEED_POSTS_PER_MINUTE = 30;

/**
 * The community lobby (community parity B, feature "community-lobby", docs/COMMUNITY_PARITY_API.md › Lobby): members
 * read it and say they've seen it; people who can edit the community change it, apply templates and manage its feed
 * URL; anyone holding the feed URL posts to it.
 */
export default async function communityLobbyRoutes(app: FastifyInstance, ctx: AppContext) {
  const { authz } = ctx;
  const auth = { preHandler: requireAuth(ctx) };
  const lobby = () => ctx.lobby;

  /** The member's id after the feature and membership checks (404 for people outside the community). */
  const member = (req: FastifyRequest): { orgId: string; userId: string } => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    lobby().requireEnabled();
    authz.requireOrgMember(orgId, userId);
    return { orgId, userId };
  };
  const editor = (req: FastifyRequest): { orgId: string; userId: string } => {
    const m = member(req);
    if (!lobby().canEdit(m.orgId, m.userId)) throw forbidden("Your role doesn't include changing the community's lobby");
    return m;
  };

  app.get("/v1/orgs/:orgId/lobby", auth, async (req) => {
    const { orgId, userId } = member(req);
    return lobby().view(orgId, userId);
  });

  app.get("/v1/orgs/:orgId/lobby/settings", auth, async (req) => {
    const { orgId, userId } = member(req);
    return lobby().settingsView(orgId, userId);
  });

  app.put("/v1/orgs/:orgId/lobby/settings", auth, async (req) => {
    const body = parse(LobbySettingsBody, req.body);
    const { orgId, userId } = editor(req);
    const changed = await lobby().update(orgId, userId, body);
    if (changed.length > 0) {
      ctx.audit({ actorId: userId, orgId, action: "community.lobby", target: orgId, detail: changed.join(", ") });
      notifyOrg(ctx, orgId);
    }
    return lobby().settingsView(orgId, userId);
  });

  app.post("/v1/orgs/:orgId/lobby/template", auth, async (req) => {
    const body = parse(LobbyTemplateBody, req.body);
    const { orgId, userId } = editor(req);
    await lobby().applyTemplate(orgId, userId, body.key, body.rev);
    ctx.audit({ actorId: userId, orgId, action: "community.lobby_template", target: orgId, detail: body.key });
    notifyOrg(ctx, orgId);
    return lobby().settingsView(orgId, userId);
  });

  app.post("/v1/orgs/:orgId/lobby/seen", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { orgId, userId } = member(req);
    return { seen: true as const, seenAt: await lobby().markSeen(orgId, userId) };
  });

  app.post("/v1/orgs/:orgId/lobby/feed", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { orgId, userId } = editor(req);
    const created = await lobby().createFeed(orgId, userId);
    ctx.audit({ actorId: userId, orgId, action: "community.lobby_feed", target: orgId, detail: created.replaced ? "replaced" : "created" });
    return { token: created.token, feed: { createdAt: created.createdAt, lastPostAt: null } };
  });

  app.delete("/v1/orgs/:orgId/lobby/feed", auth, async (req) => {
    const { orgId, userId } = editor(req);
    if (await lobby().deleteFeed(orgId)) ctx.audit({ actorId: userId, orgId, action: "community.lobby_feed", target: orgId, detail: "deleted" });
    return { feed: null };
  });

  // Anyone with the URL: no sign-in, limited per feed (by the token's hash). Lobbies show new posts when next opened
  // (no event to every member: a busy feed would make every app reload the community).
  const perFeed = {
    rateLimit: {
      max: FEED_POSTS_PER_MINUTE,
      timeWindow: "1 minute",
      keyGenerator: async (req: FastifyRequest) => `lobby-feed:${sha256Hex(String((req.params as { token?: unknown }).token ?? ""))}`,
    },
  };
  app.post("/v1/lobby-feed/:token", { config: perFeed }, async (req) => {
    lobby().requireEnabled();
    const { token } = parse(LobbyFeedParams, req.params);
    const body = parse(LobbyFeedPostBody, req.body ?? {});
    const { id, postedAt } = await lobby().post(token, body);
    return { id, postedAt };
  });
}
