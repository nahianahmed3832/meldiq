import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../../app/context.js";
import { SecretBox } from "../../../infrastructure/crypto/secretBox.js";
import { ApiError } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { bearer, me, requireAuth, stillAuthenticated } from "../../auth/index.js";
import { configuredSparkProvider, type SparkMessage, type SparkProvider } from "./provider.js";

import { SPARK_MAX_REPLY, SPARK_MAX_TURNS, SparkThreadId, SparkTitle, SparkCreate, SparkRename, SparkPrompt, SparkTurn } from "../../../shared/contracts/http/webExperience.js";

const MAX_THREADS = 30;
const GENERATION_MS = 40_000;
const payload = z.strictObject({ title: SparkTitle, turns: z.array(SparkTurn).max(SPARK_MAX_TURNS) });

interface SparkRow {
  id: string;
  user_id: string;
  sealed: string;
  updated_at: number;
  request_id: string | null;
  busy_until: number;
}

const SYSTEM = [
  "You are Meldiq Spark. Offer suggestions only; you cannot perform actions or access any Meldiq accounts, chats, files, people or settings.",
  "Meldiq supports direct and group chats, public community discovery, community channels and roles, voice rooms, saved messages and reminders.",
  "Global search uses Control or Command + K; private message search runs on the user's device. The Later section holds saved messages and collections.",
  "Activity shows mentions and recent conversations when enabled; language and privacy controls are in Settings.",
  "Do not request passwords, encryption keys, tokens or private messages. Be clear when you do not know something.",
].join(" ");

export default async function sparkRoutes(app: FastifyInstance, ctx: AppContext, provider: SparkProvider | null = configuredSparkProvider(process.env)) {
  const box = new SecretBox(ctx.config.platformSecretsKey);
  const running = new Set<string>();
  const auth = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 50, timeWindow: "1 minute" } } };
  const available = () => !!provider && box.available;
  const rowWhere = (userId: string, id: string) => ({ id, user_id: userId });
  const data = (r: SparkRow) => payload.parse(JSON.parse(box.open(r.sealed, `spark:${r.user_id}:${r.id}`)));
  const seal = (userId: string, id: string, value: z.infer<typeof payload>) => box.seal(JSON.stringify(value), `spark:${userId}:${id}`);
  const view = (r: SparkRow, d = data(r)) => ({ id: r.id, title: d.title, turns: d.turns, updatedAt: r.updated_at });
  const find = (userId: string, id: string) => {
    const row = ctx.safety.get<SparkRow>("spark_threads", rowWhere(userId, id));
    if (!row) throw new ApiError(404, "not_found", "Spark conversation not found.");
    return row;
  };
  const need = () => {
    if (!available()) throw new ApiError(503, "provider_not_configured", "Spark is not configured on this server.");
  };
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("cache-control", "no-store, no-transform");
  });
  app.get("/v2/me/spark", auth, async (req) => {
    const { userId } = me(req);
    const rows = box.available ? ctx.safety.all<SparkRow>("spark_threads", { where: { user_id: userId }, orderBy: [["updated_at", "desc"], ["id", "asc"]], limit: MAX_THREADS }) : [];
    return { configured: available(), historyAvailable: box.available, threads: rows.map((r) => ({ id: r.id, title: data(r).title, updatedAt: r.updated_at })) };
  });
  app.post("/v2/me/spark/threads", auth, async (req) => {
    need();
    const { userId } = me(req);
    const body = parse(SparkCreate, req.body);
    return ctx.safety.write((w) => {
      const previous = w.get<SparkRow>("spark_threads", rowWhere(userId, body.id));
      if (previous) return { thread: view(previous) };
      if (w.count("spark_threads", { user_id: userId }) >= MAX_THREADS) throw new ApiError(409, "limit_reached", "Delete a conversation to start a new one.");
      const row: SparkRow = { id: body.id, user_id: userId, sealed: seal(userId, body.id, { title: body.title, turns: [] }), updated_at: Date.now(), request_id: null, busy_until: 0 };
      if (!w.insert("spark_threads", { ...row }, { orIgnore: true }).inserted) throw new ApiError(409, "conflict", "Could not create a conversation with that ID.");
      return { thread: view(row) };
    });
  });
  app.get("/v2/me/spark/threads/:id", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(SparkThreadId, req.params);
    if (!box.available) throw new ApiError(503, "unavailable", "Spark history is unavailable.");
    return { thread: view(find(userId, id)) };
  });
  app.patch("/v2/me/spark/threads/:id", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(SparkThreadId, req.params);
    const body = parse(SparkRename, req.body);
    if (!box.available) throw new ApiError(503, "unavailable", "Spark history is unavailable.");
    return ctx.safety.write((w) => {
      const r = w.get<SparkRow>("spark_threads", rowWhere(userId, id));
      if (!r) throw new ApiError(404, "not_found", "Spark conversation not found.");
      const d = { ...data(r), title: body.title };
      const at = Date.now();
      w.update("spark_threads", rowWhere(userId, id), { sealed: seal(userId, id, d), updated_at: at });
      return { thread: view({ ...r, updated_at: at }, d) };
    });
  });
  app.delete("/v2/me/spark/threads/:id", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(SparkThreadId, req.params);
    await ctx.safety.write((w) => w.delete("spark_threads", rowWhere(userId, id)));
    return { deleted: true };
  });

  app.post("/v2/me/spark/threads/:id/turns", { ...auth, bodyLimit: 24 * 1024, config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (req, reply) => {
    need();
    const principal = me(req);
    const { userId } = principal;
    const token = bearer(req);
    const { id } = parse(SparkThreadId, req.params);
    const body = parse(SparkPrompt, req.body);
    if (running.has(userId) || running.size >= 24) throw new ApiError(429, "rate_limited", "Spark is busy. Try again shortly.");
    running.add(userId);
    const where = rowWhere(userId, id);
    const leased = { ...where, request_id: body.requestId };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      reply.raw.off("close", closed);
      running.delete(userId);
      await ctx.safety.write((w) => w.update("spark_threads", leased, { request_id: null, busy_until: 0 })).catch(() => {});
    };
    const closed = () => {
      controller.abort();
      // The iterator might never be pulled if the peer disconnects just before headers.
      void release();
    };
    const frame = (object: object) => JSON.stringify(object) + "\n";
    try {
      const result = await ctx.safety.write((w) => {
        const row = w.get<SparkRow>("spark_threads", where);
        if (!row) throw new ApiError(404, "not_found", "Spark conversation not found.");
        const d = data(row);
        const duplicate = d.turns.find((t) => t.requestId === body.requestId);
        if (duplicate) return { duplicate };
        const now = Date.now();
        if (row.busy_until > now) throw new ApiError(409, "conflict", "A reply is already being generated.");
        if (d.turns.length >= SPARK_MAX_TURNS) throw new ApiError(409, "limit_reached", "This conversation is full. Start a new one to continue.");
        if (!w.update("spark_threads", { ...where, busy_until: row.busy_until }, { request_id: body.requestId, busy_until: now + GENERATION_MS + 10_000 }))
          throw new ApiError(409, "conflict", "A reply is already being generated.");
        return { turns: d.turns };
      });
      reply.type("application/x-ndjson; charset=utf-8").header("X-Accel-Buffering", "no");
      if (result.duplicate) {
        running.delete(userId);
        return reply.send(Readable.from([frame({ type: "delta", text: result.duplicate.assistant }), frame({ type: "done" })]));
      }
      const messages: SparkMessage[] = [{ role: "system", content: SYSTEM + (body.locale === "bn" ? " Prefer answering in Bengali." : "") }];
      for (const t of result.turns!.slice(-5)) messages.push({ role: "user", content: t.user }, { role: "assistant", content: t.assistant });
      messages.push({ role: "user", content: body.prompt });
      reply.raw.once("close", closed);
      if (reply.raw.destroyed) closed();
      else timer = setTimeout(() => controller.abort(), GENERATION_MS);
      const output = async function* () {
        try {
          let answer = "";
          for await (const delta of provider!.complete(messages, controller.signal)) {
            if (controller.signal.aborted || answer.length + delta.length > SPARK_MAX_REPLY) throw new Error("Spark reply interrupted");
            answer += delta;
            yield frame({ type: "delta", text: delta });
          }
          if (!answer.trim() || controller.signal.aborted || !(await stillAuthenticated(ctx, token, principal))) throw new Error("Spark reply unavailable");
          const at = Date.now();
          await ctx.safety.write((w) => {
            const row = w.get<SparkRow>("spark_threads", leased);
            if (!row || controller.signal.aborted) throw new Error("Spark conversation no longer available");
            const d = data(row);
            d.turns.push({ requestId: body.requestId, user: body.prompt, assistant: answer, at });
            if (!w.update("spark_threads", leased, { sealed: seal(userId, id, d), updated_at: at, request_id: null, busy_until: 0 })) throw new Error("Spark conversation no longer available");
          });
          yield frame({ type: "done" });
        } catch {
          if (!reply.raw.destroyed) yield frame({ type: "error", code: "provider_unavailable" });
        } finally {
          await release();
        }
      };
      return reply.send(Readable.from(output()));
    } catch (error) {
      await release();
      throw error;
    }
  });
}
