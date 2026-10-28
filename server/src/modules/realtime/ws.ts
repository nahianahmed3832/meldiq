import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { type AppContext } from "../../app/context.js";
import { type AuthInfo, authenticateToken, stillAuthenticated } from "../auth/index.js";
import type { Conn } from "./hub.js";
import { canSeeLastSeen, presenceModeOf, type ProfileRow, shownPresence } from "../accounts/profile.js";
import { acknowledge } from "../messaging/messagesRoutes.js";
import { directPeers, memberIds } from "../messaging/index.js";
import { now } from "../../shared/utilities/util.js";

/**
 * Realtime gateway. Auth uses the same bearer session token as REST, sent in the
 * Authorization header of the upgrade request (never in the URL, so it can't leak into logs). Browsers, which can't set
 * that header, send it as their first frame instead: {t:"auth", token}.
 *
 * Client → server: {t:"auth", token} (first frame, header-less sockets only), {t:"ack", ids}, {t:"typing", c, on}, {t:"ping"}
 * Server → client: hello, queue, queue.drained, typing, presence, call, conv.updated,
 *                  org.updated, devices.changed, pong
 */
/**
 * Tells the people who may see [userId]'s presence how they appear now: online, idle, do not disturb, or offline (also
 * while invisible). Only people who share a DM or group with them learn of changes.
 */
export function announcePresence(ctx: AppContext, userId: string): void {
  const { db, hub } = ctx;
  if (!db.open) return; // server shutting down
  const peers = directPeers(ctx, userId);
  // Someone whose "last seen" is limited is announced only to the people that setting allows (src/profile.ts).
  const u = ctx.identity.get<ProfileRow>("users", { id: userId });
  if (!u) return;
  const audience = peers.filter((p) => canSeeLastSeen(ctx, p, u));
  const presence = shownPresence(ctx, u);
  const online = presence !== "offline";
  hub.sendToUsers(
    audience,
    { t: "presence", userId, online, presence, lastSeenAt: online ? null : hub.lastSeenAt(userId) },
  );
}

/** Batch B6b: whether [userId] chose to appear offline (their connections then change nothing others see). */
function invisible(ctx: AppContext, userId: string): boolean {
  const u = ctx.identity.get<ProfileRow>("users", { id: userId });
  return !!u && presenceModeOf(u) === "invisible";
}

export default async function wsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, hub, authz } = ctx;
  /** When a device was last connected (the device list's "last seen"): best effort, never in the way of the socket. */
  const seen = (deviceId: string) =>
    void ctx.identity.write((w) => w.update("devices", { id: deviceId }, { last_seen_at: now() })).catch((err) => ctx.log.warn({ err }, "device last-seen not recorded"));
  const lastTyping = new Map<string, number>();

  hub.onPresenceChange = (userId) => {
    if (!db.open) return; // server shutting down
    // Batch B6b: an invisible person's apps connecting and disconnecting change nothing anyone sees.
    if (invisible(ctx, userId)) return;
    announcePresence(ctx, userId);
  };
  // Nor their "last seen" time. Sockets closing after the database during shutdown record nothing (found in B12: the
  // query on a closed database threw from the close handler).
  hub.recordsLastSeen = (userId) => db.open && !invisible(ctx, userId);

  app.get("/v1/ws", { websocket: true }, (socket, req) => {
    // A browser page from an origin not in WEB_ORIGINS can't use this socket (when the list is set). Apps send no Origin.
    const origin = req.headers.origin;
    if (origin && ctx.config.webOrigins.length && !ctx.config.webOrigins.includes(origin)) {
      socket.close(4403, "origin not allowed");
      return;
    }
    const header = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
    // Browsers can't set headers on a WebSocket: they send {t:"auth", token} as their first frame instead (never in the
    // URL, so the token stays out of logs). Any other first frame, or none in time, closes the socket.
    let awaitingAuthFrame = header === undefined;
    const refuse = () => {
      hub.stats.authFailures += 1;
      socket.close(4401, "unauthorized");
    };
    const authTimer = awaitingAuthFrame ? setTimeout(refuse, ctx.config.abuse.wsAuthTimeoutMs) : undefined;
    const client = ctx.telemetry?.classify(req.headers);
    socket.once("close", () => clearTimeout(authTimer));
    // Frames are handled one at a time, in order, each after the session is checked again (which may wait on the
    // account store); frames arriving before authentication finishes wait for it.
    let onFrame: ((raw: Buffer) => Promise<void>) | null = null;
    let deviceId = "";
    const early: Buffer[] = [];
    socket.on("message", (raw: Buffer) => {
      if (awaitingAuthFrame) {
        awaitingAuthFrame = false;
        clearTimeout(authTimer);
        const token = authFrameToken(raw);
        if (token === undefined) refuse();
        else start(token);
        return;
      }
      if (!onFrame) {
        if (early.length < 32) early.push(raw);
        return;
      }
      const handle = onFrame;
      // In the device's work queue: in order, and after acknowledgements its other sockets sent earlier.
      void hub.onDevice(deviceId, () => handle(raw)).catch((e) => ctx.log.warn({ err: e }, "websocket frame failed"));
    });
    socket.on("error", () => {
      /* close handler cleans up */
    });
    const start = (token: string | undefined): void => {
      authenticateToken(ctx, token)
        .then(async (auth) => {
          if (!auth) {
            refuse();
            return;
          }
          if (socket.readyState !== socket.OPEN) return;
          // Open connections per person and in total (docs/QUOTAS.md), when an operator governs them.
          if (ctx.quotas.hasPolicies("ws.connections")) {
            const all = hub.connections();
            const decision = await ctx.quotas.check("ws.connections", [{ type: "user", id: auth.userId }, { type: "pool", id: "realtime" }], 1, {
              measured: { user: all.filter((c) => c.userId === auth.userId).length, pool: all.length },
            });
            if (!decision.allowed || socket.readyState !== socket.OPEN) {
              if (socket.readyState === socket.OPEN) socket.close(4429, "connection allowance used up");
              return;
            }
          }
          deviceId = auth.deviceId;
          onFrame = open(socket, auth, token, client);
          const handle = onFrame;
          for (const raw of early.splice(0)) void hub.onDevice(deviceId, () => handle(raw)).catch((e) => ctx.log.warn({ err: e }, "websocket frame failed"));
        })
        .catch((e) => {
          ctx.log.error({ err: e }, "websocket authentication failed");
          socket.close(1011, "try again");
        });
    };
    if (header !== undefined) start(header);
  });

  /** A connection authenticated as [auth]: registered with the hub, sent its backlog; returns its frame handler. */
  const open = (socket: WebSocket, auth: AuthInfo, token: string | undefined, client?: Conn["client"]): ((raw: Buffer) => Promise<void>) => {
    const conn = hub.add(socket, auth.userId, auth.deviceId);
    conn.client = client;
    conn.sessionId = auth.sessionId;
    seen(auth.deviceId);
    socket.send(hub.encode({ t: "hello", userId: auth.userId, deviceId: auth.deviceId, serverTime: now() }));
    void hub.onDevice(auth.deviceId, () => hub.flushBacklog(conn)).catch((err) => ctx.log.error({ err }, "backlog flush failed"));

    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        /* closed */
      }
    }, 30_000);
    socket.on("pong", () => (alive = true));

    // Frame budget (docs/ABUSE_CONTROLS.md › Realtime): a steady rate with a burst. Frames past it are ignored, and a
    // connection that keeps sending far past it is closed. Apps send a few frames a second at most.
    const { wsFramesPerSecond: rate, wsFrameBurst: burst } = ctx.config.abuse;
    let budget = burst;
    let budgetAt = now();

    const onFrame = async (raw: Buffer): Promise<void> => {
      alive = true;
      const t = now();
      conn.lastFrameAt = t;
      ctx.telemetry?.activity.addTraffic(auth.userId, "ws.in", raw.length, t);
      budget = Math.min(burst, budget + ((t - budgetAt) / 1000) * rate) - 1;
      budgetAt = t;
      if (budget < -burst) {
        socket.close(4429, "too many messages");
        return;
      }
      if (budget < 0) return;
      if (raw.length > 64 * 1024) return;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      // Re-check the session on every frame so revoked devices are cut off immediately. (A v2 session is checked by
      // its id: its access token is renewed every few minutes while the socket stays open.)
      if (!(await stillAuthenticated(ctx, token, auth))) {
        socket.close(4401, "session expired");
        return;
      }
      switch (msg?.t) {
        case "ping":
          socket.send(hub.encode({ t: "pong", serverTime: now() }));
          break;
        case "ack": {
          const ids = Array.isArray(msg.ids) ? msg.ids.filter((x: unknown) => Number.isInteger(x)).slice(0, 500) : [];
          if (ids.length) await acknowledge(ctx, auth.userId, auth.deviceId, ids);
          // Only while this socket's backlog is still being sent: clients also acknowledge the final (empty)
          // batch with backlog:true, and answering that with another flush looped forever and re-sent
          // unacknowledged live items (P6 duplicates).
          if (msg.backlog && conn.flushing) await hub.flushBacklog(conn);
          break;
        }
        case "typing": {
          const convId = typeof msg.c === "string" ? msg.c : "";
          const key = `${auth.deviceId}:${convId}`;
          const last = lastTyping.get(key) ?? 0;
          if (msg.on && now() - last < 1500) break; // rate-limit
          lastTyping.set(key, now());
          if (lastTyping.size > 5000) for (const [k, at] of lastTyping) if (now() - at > 10_000) lastTyping.delete(k); // bounded (D20)
          const conv = authz.conversation(convId);
          if (!conv || !authz.isMember(conv.id, auth.userId)) break;
          const members = memberIds(ctx, conv.id).filter((u) => u !== auth.userId);
          if (members.length > 200) break; // large channels: skip typing fan-out
          hub.sendToUsers(members, { t: "typing", c: conv.id, u: auth.userId, on: !!msg.on });
          break;
        }
        default:
          break;
      }
    };

    socket.on("close", (code: number) => {
      clearInterval(heartbeat);
      hub.remove(conn, code);
      if (db.open) seen(auth.deviceId);
    });
    return onFrame;
  };
}

/** The token of a browser's first frame, {t:"auth", token}; undefined for anything else. */
function authFrameToken(raw: Buffer): string | undefined {
  if (raw.length > 1024) return undefined;
  try {
    const msg = JSON.parse(raw.toString("utf8")) as { t?: unknown; token?: unknown };
    return msg?.t === "auth" && typeof msg.token === "string" ? msg.token : undefined;
  } catch {
    return undefined;
  }
}
