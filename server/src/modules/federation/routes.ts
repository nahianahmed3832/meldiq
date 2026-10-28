/**
 * Federation HTTP surface (docs/FEDERATION_PROTOCOL.md §4–§6).
 * - `GET /.well-known/griip-server`: this server's descriptor; with ?challenge=…&core=… also a signed proof for a core node.
 * - `/fed/v1/*`: server-to-server API. Every request is signed by the sending server and checked (destination, time,
 *   signature against its verified descriptor, nonce, rate limit, policy). Every response is signed by this server.
 * - `/v1/federation/*`: for this server's own signed-in users (address lookup, blocking).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { ResolveQuery } from "../../shared/contracts/http/federation.js";
import { parse } from "../../shared/validation/index.js";
import { privacyOf } from "../accounts/profile.js";
import { keyFingerprint } from "../../shared/utilities/crypto.js";
import { notifyConversation } from "../organizations/orgsRoutes.js";
import { userSummary } from "../auth/routes.js";
import { callActions, loadCall } from "../calls/routes.js";
import { badRequest, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { isServerId } from "./identity.js";
import { FederationError, type ResolvedServer } from "./resolver.js";
import type { Federation } from "./service.js";
import { sha256b64 } from "./sign.js";
import { checkRequest, H, responseString, useNonce } from "./transport.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
    fedPeer?: ResolvedServer;
  }
}

const hdr = (req: FastifyRequest, k: string) => {
  const v = req.headers[k];
  return typeof v === "string" ? v : "";
};

export async function federationPeerRoutes(app: FastifyInstance, ctx: AppContext, fed: Federation) {
  // Keep the exact request bytes: the signature covers their hash.
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 4 * 1024 * 1024 }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString("utf8")) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  // Sign every /fed and well-known response for the requester (status codes included), binding it to their nonce.
  app.addHook("onSend", async (req, reply, payload) => {
    const body = typeof payload === "string" ? payload : payload === null || payload === undefined ? "" : Buffer.isBuffer(payload) ? payload.toString("utf8") : "";
    reply.header(H.rsig, fed.identity.signText(responseString(hdr(req, H.nonce), sha256b64(body), fed.serverId, hdr(req, H.from))));
    return payload;
  });

  app.get("/.well-known/griip-server", async (req) => {
    const q = req.query as { challenge?: string; core?: string };
    const proof =
      typeof q.challenge === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(q.challenge) && typeof q.core === "string" && /^gc1[a-z2-7]{26}$/.test(q.core)
        ? fed.identity.selfSigned({ t: "griip.server.challenge", coreId: q.core, nonce: q.challenge })
        : null;
    return { descriptor: fed.descriptor(), proof };
  });

  const verify = async (req: FastifyRequest) => {
    const from = hdr(req, H.from);
    if (!isServerId(from)) throw new FederationError(401, "unsigned", "Federation requests must be signed");
    if (!fed.requestLimit.take(from)) throw new FederationError(429, "rate_limited", "Too many requests from your server");
    let peer: ResolvedServer;
    try {
      peer = await fed.resolver.server(from);
    } catch {
      throw new FederationError(403, "unknown_server", "Your server isn't registered with the directory");
    }
    fed.checkPeer(peer);
    if (peer.state === "suspended" || peer.state === "pending" || peer.state === "unknown") throw new FederationError(403, "server_not_active", `Your server is ${peer.state} in the directory`);
    const bodyHash = req.rawBody ? sha256b64(req.rawBody) : req.method === "GET" ? sha256b64("") : hdr(req, H.body);
    let checked;
    try {
      checked = checkRequest(req.headers, req.method, req.url, bodyHash, fed.serverId, peer);
    } catch (e) {
      if (!(e instanceof FederationError) || e.code !== "bad_signature") throw e;
      peer = await fed.resolver.server(from, { fresh: true }); // the peer may have rotated its key since we cached it
      fed.checkPeer(peer);
      checked = checkRequest(req.headers, req.method, req.url, bodyHash, fed.serverId, peer);
    }
    if (!useNonce(ctx.db, checked.nonce, from)) throw new FederationError(401, "replayed", "This request was already received");
    req.fedPeer = peer;
  };
  const signed = { preHandler: verify };

  // Exact-address lookup only. Same 404 for "no such user" and "not reachable from other servers".
  app.get("/fed/v1/users/lookup", signed, async (req, reply) => {
    const peer = req.fedPeer!;
    if (!fed.lookupLimit.take(peer.serverId)) throw new FederationError(429, "rate_limited", "Too many lookups from your server");
    const { username } = parse(z.object({ username: z.string().trim().toLowerCase().max(24) }), req.query);
    const u = ctx.db.prepare("SELECT id, privacy FROM users WHERE username = ? AND home_server_id IS NULL AND disabled_at IS NULL").get(username) as
      | { id: string; privacy: string | null }
      | undefined;
    // People who limited who can find them by username aren't found from other servers either.
    const entry = u && privacyOf(u).findByUsername === "everyone" ? fed.entry(u.id) : null;
    if (!entry) return reply.code(404).send({ error: { code: "not_found", message: "No such user" } });
    ctx.audit({ action: "federation.lookup", target: peer.serverId }); // who asked; not whom
    return { user: entry };
  });

  // By id: only to servers hosting someone this user already shares a conversation with (key refresh).
  app.get("/fed/v1/users/:userId", signed, async (req, reply) => {
    const peer = req.fedPeer!;
    const { userId } = parse(z.object({ userId: z.string().max(64) }), req.params);
    const entry = fed.sharesConversation(userId, peer.serverId) ? fed.entry(userId) : null;
    if (!entry) return reply.code(404).send({ error: { code: "not_found", message: "No such user" } });
    return { user: entry };
  });

  app.post("/fed/v1/deliver", signed, async (req) => {
    const peer = req.fedPeer!;
    const results = await fed.acceptBatch(peer, req.body as never, (convId) => notifyConversation(ctx, convId));
    return { results, at: now() };
  });

  await federationCallRoutes(app, ctx, fed, verify);

  app.post("/fed/v1/attachments", { ...signed, bodyLimit: ctx.config.attachmentMaxBytes + 1024 }, async (req, reply) => {
    const peer = req.fedPeer!;
    let meta;
    try {
      meta = JSON.parse(hdr(req, "x-griip-attachment"));
    } catch {
      throw badRequest("Missing attachment metadata");
    }
    const body = req.body as Readable;
    if (!body || typeof body.pipe !== "function") throw badRequest("Expected application/octet-stream body");
    const r = await fed.acceptAttachment(peer, meta, body, hdr(req, H.body));
    if (r.status !== 200) return reply.code(r.status).send({ error: { code: r.code, message: "Attachment refused" } });
    return { ok: true };
  });
}

export async function federationCallRoutes(app: FastifyInstance, ctx: AppContext, fed: Federation, verify: (req: FastifyRequest) => Promise<void>) {
  const signed = { preHandler: verify };
  const actions = callActions(ctx);

  // A call this peer hosts changed (ring, updated, ended, …): mirror it and tell our people in it.
  app.post("/fed/v1/calls/event", signed, async (req) => {
    await fed.acceptCallEvent(req.fedPeer!, req.body as never, (convId) => notifyConversation(ctx, convId));
    return { ok: true };
  });

  // One of the peer's users acts on a call hosted here. Only for their own user and device, in a conversation we share.
  app.post("/fed/v1/calls/:id/:action", signed, async (req) => {
    const peer = req.fedPeer!;
    const { id, action } = parse(z.object({ id: z.string().max(64), action: z.enum(["join", "connected", "alerted", "decline", "end", "leave"]) }), req.params);
    const body = parse(
      z.object({ userId: z.string().max(64), deviceId: z.string().max(64), reason: z.enum(["declined", "busy"]).default("declined") }),
      req.body ?? {},
    );
    const c = await loadCall(ctx, id);
    if (!c || c.host_server_id) throw notFound("Call not found");
    const dev = ctx.db
      .prepare("SELECT u.home_server_id h, d.revoked_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.user_id = ?")
      .get(body.deviceId, body.userId) as { h: string | null; revoked_at: number | null } | undefined;
    if (!dev || dev.h !== peer.serverId || dev.revoked_at) throw new FederationError(403, "not_your_user", "That user or device isn't on your server");
    if (!ctx.authz.isMember(c.conversation_id, body.userId)) throw notFound("Call not found");
    let r: { call: unknown; media?: unknown };
    if (action === "join") r = await actions.join(c, body.userId, body.deviceId);
    else if (action === "connected") r = await actions.connected(c, body.userId, body.deviceId);
    else if (action === "alerted") r = await actions.alerted(c, body.userId);
    else if (action === "decline") r = await actions.decline(c, body.userId, body.reason);
    else if (action === "end") r = await actions.end(c, body.userId);
    else r = await actions.leave(c, body.userId, body.deviceId);
    return { call: await fed.callRelayView((await loadCall(ctx, id))!), ...(r.media ? { media: r.media } : {}) };
  });
}

export async function federationClientRoutes(app: FastifyInstance, ctx: AppContext, fed: Federation) {
  const auth = { preHandler: requireAuth(ctx) };

  app.get("/v1/federation/info", auth, async (req) => {
    const u = ctx.db.prepare("SELECT username FROM users WHERE id = ?").get(me(req).userId) as { username: string };
    return { enabled: true, domain: fed.domain, serverId: fed.serverId, address: `@${fed.address(u.username)}` };
  });

  // Resolve "@name:server" to a verified identity. Exact addresses only; rate-limited per user.
  app.get("/v1/federation/resolve", { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { userId } = me(req);
    if (!fed.userLookupLimit.take(userId)) throw new FederationError(429, "rate_limited", "Too many lookups. Try again in a minute.");
    const { address } = parse(ResolveQuery, req.query);
    const r = await fed.lookup(address);
    if (r.userId === userId) throw badRequest("That's you");
    const u = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(r.userId) as any;
    if (!u) throw notFound("No one with that address");
    const local = r.local;
    return {
      user: {
        ...userSummary(u),
        identityKey: u.identity_key,
        fingerprint: keyFingerprint(u.identity_key),
        address: `@${local ? fed.address(u.username) : u.username}`,
      },
      server: r.server
        ? {
            serverId: r.server.serverId,
            domain: r.server.domain,
            state: r.server.state,
            verifiedBy: r.server.agreeing,
            source: r.server.source,
            identityChanged: !!r.server.previousServerId,
          }
        : { serverId: fed.serverId, domain: fed.domain, state: "active", verifiedBy: 0, source: "local", identityChanged: false },
    };
  });

}
