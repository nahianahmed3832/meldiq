import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket, RawData } from "ws";
import { z } from "zod/v4";
import { ApiError } from "../../shared/errors.js";
import type { BotService } from "./service.js";
import type { Bot } from "./store.js";
import {
  BotGatewayClientFrame,
  type BotGatewayServerFrame,
} from "../../shared/contracts/botGateway.js";

const HEARTBEAT_MS = 30_000;
const MAX_BUFFER = 256 * 1024;
type Session = {
  id: string;
  socket: WebSocket;
  bot?: Bot;
  cursor?: string;
  authority?: string;
  more?: boolean;
  sequence: number;
  lastHeartbeat: number;
  windowStart: number;
  frames: number;
  pending: number;
  queue: Promise<void>;
  closed: boolean;
};

/** A bot-only protocol: no human session, device queue, media key or /v1/ws access is issued. */
export function registerBotGateway(
  app: FastifyInstance,
  bots: BotService,
): void {
  const sessions = new Set<Session>(),
    byIp = new Map<string, number>();
  let stopped = false,
    pumping = false,
    rerun = false,
    watermark = "0";
  const fail = (session: Session, code: number, reason: string) => {
    if (session.closed) return;
    session.closed = true;
    session.socket.close(code, reason);
    if (session.bot) bots.connectionPresence(session.id, session.bot.id, null);
    const terminate = setTimeout(() => {
      if (session.socket.readyState !== 3) session.socket.terminate();
    }, 1_000);
    terminate.unref();
    session.socket.once("close", () => clearTimeout(terminate));
  };
  const send = (
    session: Session,
    value: z.infer<typeof BotGatewayServerFrame>,
  ): boolean => {
    if (session.closed || session.socket.readyState !== 1) return false;
    if (session.socket.bufferedAmount > MAX_BUFFER) {
      fail(session, 4429, "slow consumer; resume with last cursor");
      return false;
    }
    session.socket.send(JSON.stringify(value));
    return true;
  };
  const fresh = async (session: Session) => {
    if (!session.bot) throw new ApiError(401, "unauthorized", "Identify first");
    await bots.events.fresh(session.bot);
    if (bots.events.authorityKey(session.bot) !== session.authority)
      throw new ApiError(
        403,
        "forbidden",
        "Installation permissions changed; identify again",
      );
  };
  const enqueue = (session: Session, run: () => Promise<void>) => {
    if (session.closed) return;
    if (++session.pending > 16) {
      fail(session, 4429, "too many queued frames");
      return;
    }
    session.queue = session.queue
      .then(async () => {
        if (!session.closed) await run();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError)
          fail(
            session,
            error.statusCode === 401
              ? 4401
              : error.statusCode === 410
                ? 4410
                : error.statusCode === 503
                  ? 4503
                  : 4403,
            "bot session unavailable; reconnect",
          );
        else fail(session, 4503, "bot gateway temporarily unavailable");
      })
      .finally(() => {
        session.pending--;
      });
  };
  const deliver = async (session: Session) => {
    const page = await bots.events.page(session.bot!, session.cursor, 50);
    if (bots.events.authorityKey(session.bot!) !== session.authority) {
      fail(session, 4403, "installation changed; identify again");
      return;
    }
    // Empty frames on unrelated write wake-ups would reveal other communities' activity timing.
    if (
      page.events.length &&
      !send(session, { op: "events", sequence: ++session.sequence, ...page })
    )
      return;
    session.cursor = page.cursor;
    session.more = page.more;
    if (page.more) rerun = true;
  };
  const pump = async () => {
    if (stopped) return;
    if (pumping) {
      rerun = true;
      return;
    }
    pumping = true;
    try {
      if (
        ![...sessions].some(
          (session) =>
            session.bot && session.authority !== undefined && !session.closed,
        )
      )
        return;
      const changes = await bots.events.changes(watermark);
      const all = changes.changed.length > 200;
      watermark = changes.watermark;
      // Shared serialized scheduler uses the existing pool; no connection or polling loop per socket.
      for (const session of sessions) {
        if (!session.bot || session.authority === undefined || session.closed)
          continue;
        if (bots.events.authorityKey(session.bot) !== session.authority) {
          fail(session, 4403, "installation changed; identify again");
          continue;
        }
        const communities = bots.events.communities(session.bot);
        if (
          !session.more &&
          !all &&
          !changes.changed.some(
            (change) =>
              change.bot === session.bot!.id ||
              (change.bot === null &&
                change.org &&
                communities.includes(change.org)),
          )
        )
          continue;
        enqueue(session, () => deliver(session));
        await session.queue;
      }
    } catch {
      // A transient database outage does not advance a client's cursor or create a second authority.
      for (const session of sessions)
        fail(session, 4503, "bot gateway temporarily unavailable");
    } finally {
      pumping = false;
      if (rerun && !stopped) {
        rerun = false;
        schedule();
      }
    }
  };
  let wake: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!wake && !stopped) {
      wake = setTimeout(() => {
        wake = undefined;
        void pump();
      }, 100);
      wake.unref();
    }
  };
  const unsubscribe = bots.events.onWake(schedule);
  const stopInvalidations = bots.events.onInvalidate((botId) => {
    for (const session of sessions)
      if (session.bot?.id === botId)
        fail(
          session,
          4401,
          "bot credential or approval changed; identify again",
        );
  });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions)
      if (now - session.lastHeartbeat > HEARTBEAT_MS * 2)
        fail(session, 4408, "heartbeat timeout");
    schedule();
  }, 5_000);
  timer.unref();
  app.addHook("preClose", (done) => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(wake);
    unsubscribe();
    stopInvalidations();
    for (const session of sessions)
      fail(session, 1012, "service restarting; resume with last cursor");
    done();
  });
  app.get(
    "/v2/bot/gateway",
    {
      websocket: true,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    (socket, req) => {
      // Credentials in URLs are rejected. Even query parameter names are unnecessary for this protocol.
      if (req.url.includes("?") || !bots.events.supported()) {
        socket.close(4503, "use a credential frame on a supported server");
        return;
      }
      const origin = req.headers.origin;
      if (
        origin &&
        bots.ctx.config.webOrigins.length &&
        !bots.ctx.config.webOrigins.includes(origin)
      ) {
        socket.close(4403, "origin not allowed");
        return;
      }
      if (sessions.size >= 100 || (byIp.get(req.ip) ?? 0) >= 8) {
        socket.close(4429, "gateway connection limit");
        return;
      }
      byIp.set(req.ip, (byIp.get(req.ip) ?? 0) + 1);
      const session: Session = {
        id: randomUUID(),
        socket,
        sequence: 0,
        lastHeartbeat: Date.now(),
        windowStart: Date.now(),
        frames: 0,
        pending: 0,
        queue: Promise.resolve(),
        closed: false,
      };
      sessions.add(session);
      const deadline = setTimeout(
        () => fail(session, 4401, "identify timeout"),
        Math.min(bots.ctx.config.abuse.wsAuthTimeoutMs, 10_000),
      );
      deadline.unref();
      socket.once("close", () => {
        session.closed = true;
        clearTimeout(deadline);
        sessions.delete(session);
        const count = (byIp.get(req.ip) ?? 1) - 1;
        if (count) byIp.set(req.ip, count);
        else byIp.delete(req.ip);
        if (session.bot)
          bots.connectionPresence(session.id, session.bot.id, null);
      });
      socket.on("error", () => {
        fail(session, 4503, "connection error");
      });
      send(session, {
        op: "hello",
        version: 1,
        heartbeatIntervalMs: HEARTBEAT_MS,
        authTimeoutMs: Math.min(bots.ctx.config.abuse.wsAuthTimeoutMs, 10_000),
        maxFrameBytes: 8192,
      });
      socket.on("message", (raw: RawData, binary) => {
        if (Date.now() - session.windowStart > 60_000) {
          session.windowStart = Date.now();
          session.frames = 0;
        }
        if (++session.frames > 120) {
          fail(session, 4429, "gateway frame rate limit");
          return;
        }
        if (
          binary ||
          Buffer.byteLength(
            Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer),
          ) > 8192
        ) {
          fail(session, 4400, "invalid frame");
          return;
        }
        let parsed: z.infer<typeof BotGatewayClientFrame>;
        try {
          parsed = BotGatewayClientFrame.parse(JSON.parse(raw.toString()));
        } catch {
          fail(session, 4400, "invalid frame");
          return;
        }
        enqueue(session, async () => {
          if (parsed.op === "identify" || parsed.op === "resume") {
            if (session.bot) {
              fail(session, 4400, "already identified");
              return;
            }
            const bot = await bots.authenticate(parsed.token);
            if (!bot) {
              fail(session, 4401, "unauthorized");
              return;
            }
            if (
              [...sessions].filter((s) => s.bot?.id === bot.id && !s.closed)
                .length >= 2
            ) {
              fail(session, 4429, "bot connection limit");
              return;
            }
            // Reserve before the asynchronous replay read so parallel identifies cannot exceed the cap.
            session.bot = bot;
            const page = await bots.events.page(bot, parsed.cursor, 50);
            if (session.closed || stopped) return;
            session.bot = bot;
            session.authority = bots.events.authorityKey(bot);
            session.cursor = page.cursor;
            session.more = page.more;
            clearTimeout(deadline);
            bots.connectionPresence(session.id, bot.id, "online");
            send(session, {
              op: parsed.op === "resume" ? "resumed" : "ready",
              botId: bot.id,
              version: 1,
            });
            send(session, {
              op: "events",
              sequence: ++session.sequence,
              ...page,
            });
            if (page.more) schedule();
            return;
          }
          await fresh(session);
          if (parsed.op === "heartbeat") {
            session.lastHeartbeat = Date.now();
            send(session, {
              op: "heartbeat_ack",
              nonce: parsed.nonce ?? null,
              cursor: session.cursor,
            });
          } else if (parsed.op === "presence") {
            bots.connectionPresence(session.id, session.bot!.id, parsed.status);
            send(session, { op: "presence_ack", status: parsed.status });
          } else if (parsed.op === "request") {
            try {
              const data =
                parsed.action === "self"
                  ? bots.api.self(session.bot!)
                  : parsed.action === "communities"
                    ? bots.api.communities(session.bot!)
                    : await bots.events.page(
                        session.bot!,
                        parsed.data.cursor,
                        parsed.data.limit,
                      );
              await fresh(session);
              send(session, {
                op: "response",
                requestId: parsed.requestId,
                ok: true,
                data,
              });
            } catch (error) {
              if (
                !(error instanceof ApiError) ||
                [401, 403, 503].includes(error.statusCode)
              )
                throw error;
              send(session, {
                op: "response",
                requestId: parsed.requestId,
                ok: false,
                error: { code: error.code, message: error.message },
              });
            }
          }
        });
      });
    },
  );
}
