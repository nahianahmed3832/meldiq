import type { FastifyInstance } from "fastify";
import { type AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { parse } from "../../../shared/validation/index.js";
import { announceOwnSettingsChange } from "../profileEvents.js";
import { availableUser, blockedEitherWay, notAvailable, requestAllowed, requireRequestBudget, settingsOf, sharesCommunity } from "./rules.js";
import { type ConnectionRow, type MessagingSettings, pairOf } from "./store.js";
import { ConnectBody, ConnectionUserParams, MessagingSettingsBody, RequestAnswerBody, RequestParams } from "../../../shared/contracts/http/relationships.js";
import { ApiError, badRequest, notFound } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { userSummary } from "../../auth/routes.js";
import { notifyConversation } from "../../organizations/orgsRoutes.js";

/**
 * Batch B6 (docs/product/MELDIQ_FRIENDS_AND_DMS_SPEC.md §4): connections (request, accept, cancel, decline, remove),
 * answering message requests, and who may message you. No suggestions, no mutual lists: only what each person did.
 */
export default async function connectionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { identity } = ctx;
  const auth = { preHandler: requireAuth(ctx) };
  const rel = ctx.relationships;

  const people = (ids: string[]) => {
    if (ids.length === 0) return new Map<string, ReturnType<typeof userSummary>>();
    const rows = identity.all<Parameters<typeof userSummary>[0]>("users", { where: { id: { in: ids }, disabled_at: null } });
    return new Map(rows.map((u) => [u.id, userSummary(u)]));
  };
  const other = (row: ConnectionRow, userId: string) => (row.a === userId ? row.b : row.a);
  const changed = (...ids: string[]) => ctx.hub.sendToUsers(new Set(ids), { t: "connections.updated" });

  app.get("/v1/connections", auth, async (req) => {
    const userId = me(req).userId;
    const rows = (await rel.connectionsOf(userId)).filter((r) => !blockedEitherWay(ctx, r.a, r.b));
    const users = people(rows.map((r) => other(r, userId)));
    const entry = (r: ConnectionRow) => ({ user: users.get(other(r, userId)), at: r.accepted_at ?? r.created_at });
    const present = (r: ConnectionRow) => users.has(other(r, userId));
    return {
      connected: rows.filter((r) => r.state === "accepted" && present(r)).map((r) => entry(r).user),
      incoming: rows.filter((r) => r.state === "pending" && r.requested_by !== userId && present(r)).map(entry),
      outgoing: rows.filter((r) => r.state === "pending" && r.requested_by === userId && present(r)).map(entry),
    };
  });

  /** Sends a request, or accepts theirs when they already asked; repeating it changes nothing. */
  app.post("/v1/connections", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const userId = me(req).userId;
    const body = parse(ConnectBody, req.body);
    const targetId =
      "userId" in body
        ? body.userId
        : identity.get<{ id: string }>("users", { username: body.username.replace(/^@/, ""), disabled_at: null })?.id;
    if (targetId === userId) throw badRequest("You can't connect with yourself");
    const target = targetId ? availableUser(ctx, targetId) : null;
    if (!target || target.home_server_id || blockedEitherWay(ctx, userId, target.id)) throw notAvailable();
    const t = now();
    const existing = await rel.connection(userId, target.id);
    if (existing?.state === "accepted") return { state: "accepted", userId: target.id };
    if (existing && existing.requested_by === userId) return { state: "pending", userId: target.id };
    if (existing) {
      await rel.putConnection({ ...existing, state: "accepted", accepted_at: t });
      changed(userId, target.id);
      return { state: "accepted", userId: target.id };
    }
    if (!requestAllowed(await settingsOf(ctx, target.id), sharesCommunity(ctx, userId, target.id))) {
      throw new ApiError(403, "requests_not_allowed", "This person isn't accepting connection requests");
    }
    await requireRequestBudget(ctx, userId, t);
    await rel.putConnection({ ...pairOf(userId, target.id), state: "pending", requested_by: userId, created_at: t, accepted_at: null });
    changed(userId, target.id);
    return { state: "pending", userId: target.id };
  });

  app.post("/v1/connections/:userId/accept", auth, async (req) => {
    const userId = me(req).userId;
    const { userId: from } = parse(ConnectionUserParams, req.params);
    const row = await rel.connection(userId, from);
    if (!row || row.state !== "pending" || row.requested_by === userId || blockedEitherWay(ctx, userId, from)) throw notFound("Request not found");
    await rel.putConnection({ ...row, state: "accepted", accepted_at: now() });
    changed(userId, from);
    return { state: "accepted" };
  });

  /** Cancels your request, declines theirs, or removes a connection. The other person isn't told which. */
  app.delete("/v1/connections/:userId", auth, async (req) => {
    const userId = me(req).userId;
    const { userId: otherId } = parse(ConnectionUserParams, req.params);
    if (await rel.deleteConnection(userId, otherId)) changed(userId, otherId);
    return { ok: true };
  });

  app.get("/v1/users/me/messaging", auth, async (req) => {
    const s = await settingsOf(ctx, me(req).userId);
    return { dmPolicy: s.dm_policy, requestPolicy: s.request_policy };
  });

  app.put("/v1/users/me/messaging", auth, async (req) => {
    const userId = me(req).userId;
    const body = parse(MessagingSettingsBody, req.body);
    const current = await settingsOf(ctx, userId);
    const next = { dm_policy: body.dmPolicy ?? current.dm_policy, request_policy: body.requestPolicy ?? current.request_policy } as MessagingSettings;
    await rel.putSettings(userId, next, now());
    announceOwnSettingsChange(ctx, userId);
    return { dmPolicy: next.dm_policy, requestPolicy: next.request_policy };
  });

  /**
   * Answers a message request you received. Accept connects you and moves the DM to your chats; decline hides it from
   * you and drops what's waiting for your devices (the sender's view doesn't change); block declines and blocks.
   */
  app.post("/v1/conversations/:id/request", auth, async (req) => {
    const userId = me(req).userId;
    const { id } = parse(RequestParams, req.params);
    const { action } = parse(RequestAnswerBody, req.body);
    const r = await rel.request(id);
    if (!r || r.recipient !== userId || r.state !== "pending") throw notFound("Request not found");
    const t = now();
    if (action === "accept") {
      await rel.deleteRequest(id);
      const existing = await rel.connection(userId, r.sender);
      await rel.putConnection({ ...pairOf(userId, r.sender), state: "accepted", requested_by: existing?.requested_by ?? r.sender, created_at: existing?.created_at ?? r.created_at, accepted_at: t });
      changed(userId, r.sender);
    } else {
      await rel.declineRequest(id, t);
      const devices = identity.all<{ id: string }>("devices", { where: { user_id: userId } }).map((d) => d.id);
      ctx.relay.forgetConversationFor(id, devices);
      if (action === "block") await identity.write((w) => w.insert("user_blocks", { user_id: userId, blocked_user_id: r.sender, created_at: t }, { orIgnore: true }));
    }
    // Only the recipient's apps hear of it: a declined sender sees nothing change.
    if (action === "accept") notifyConversation(ctx, id);
    else ctx.hub.sendToUsers(new Set([userId]), { t: "conv.updated", conversationId: id });
    return { ok: true };
  });
}
