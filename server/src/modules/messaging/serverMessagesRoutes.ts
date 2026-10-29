import type { FastifyInstance } from "fastify";
import { HistoryQuery, ImportBody, MAX_PAYLOAD_BYTES, SearchQuery, SendMessage } from "../../shared/contracts/http/serverMessages.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { ApiError } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import type { MessageEvent } from "./store/messageStore.js";
import { eventToWire, sendServerMessage } from "./serverSend.js";

export { countChars, eventToWire } from "./serverSend.js";

/** Unread messages are counted up to this many per conversation (the apps show "99+"). */
const UNREAD_CAP = 99;
/**
 * Messages stored and served by the server (API 0.57.0, docs/SERVER_MESSAGES.md): the owner's decision to keep every
 * message on Meldiq's servers instead of end-to-end encrypting it. Sending checks the same rules as before (standing,
 * membership, posting rights, slowmode, message requests, @everyone) and, now that the server can read them, the
 * plan's character limit and who may change a message. Every member's devices then get the message through their
 * delivery queue, and any member can page the conversation's history.
 */
export default async function serverMessagesRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };

  app.post("/v2/messages", { ...auth, bodyLimit: 2 * MAX_PAYLOAD_BYTES }, async (req) => {
    const { userId, deviceId } = me(req);
    const m = parse(SendMessage, req.body);
    return sendServerMessage(ctx, { userId, deviceId }, m, req.log);
  });

  app.get<{ Params: { id: string } }>("/v2/conversations/:id/messages", auth, async (req) => {
    const { userId } = me(req);
    const q = parse(HistoryQuery, req.query);
    const conv = ctx.authz.requireMember(req.params.id, userId);
    const page = q.around ? await ctx.messages.around(conv.id, userId, q.around, Math.ceil(q.limit / 2)) : await ctx.messages.page(conv.id, userId, q.before ?? null, q.limit);
    if (!page) throw new ApiError(404, "not_found", "That message isn't in this conversation");
    return { messages: page.messages.map(eventToWire), changes: page.changes.map(eventToWire), more: page.more };
  });

  // A device's history from before the server kept messages, uploaded once when its app updates: what's already stored
  // is skipped. Only conversations the person is still in, only times in the past, and every item records who uploaded
  // it (apps show imported messages as such).
  app.post("/v2/messages/import", { ...auth, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const { userId } = me(req);
    const { items } = parse(ImportBody, req.body);
    const t = now();
    const member = new Map<string, boolean>();
    const isMember = (conversationId: string) => {
      if (!member.has(conversationId)) member.set(conversationId, ctx.authz.isMember(conversationId, userId));
      return member.get(conversationId)!;
    };
    const events: MessageEvent[] = [];
    for (const i of items) {
      const payload = JSON.stringify(i.payload);
      if (!isMember(i.conversationId) || i.serverTs > t || Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) continue;
      events.push({
        id: i.id,
        conversation_id: i.conversationId,
        sender_user_id: i.senderUserId,
        sender_device_id: null,
        cls: i.cls,
        type: i.payload.type,
        target: typeof i.payload.target === "string" ? i.payload.target : null,
        audience: "all",
        payload,
        sent_at: i.sentAt,
        server_ts: i.serverTs,
        mention_all: 0,
        imported_by: userId,
      });
    }
    const added = await ctx.messages.addMany(events);
    return { added, skipped: items.length - added };
  });

  app.get("/v2/messages/summary", auth, async (req) => {
    const { userId } = me(req);
    const mine = ctx.ws.all<{ conversation_id: string }>("conversation_members", { where: { user_id: userId } }).map((r) => r.conversation_id);
    const list = await ctx.messages.summaries(mine, userId, UNREAD_CAP);
    return {
      conversations: list.map((c) => ({ conversationId: c.conversation_id, last: c.last ? eventToWire(c.last) : null, readUpTo: c.read_up_to, unread: c.unread, mentions: c.mentions })),
    };
  });

  app.get("/v2/messages/search", auth, async (req) => {
    const { userId } = me(req);
    const q = parse(SearchQuery, req.query);
    const mine = q.conversationId
      ? [ctx.authz.requireMember(q.conversationId, userId).id]
      : ctx.ws.all<{ conversation_id: string }>("conversation_members", { where: { user_id: userId } }).map((r) => r.conversation_id);
    const hits = await ctx.messages.search(mine, q.q, q.limit);
    return { messages: hits.map(eventToWire) };
  });
}
