import { z } from "zod";
import { route, type RouteContract } from "./route.js";

const id = z.string().uuid();
const name = z.string().trim().min(1).max(60);
const messageId = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const SavedCollection = z.strictObject({ id, name, messageIds: z.array(messageId).max(100) });
export const SavedCollectionOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("create"), id, name }),
  z.strictObject({ op: z.literal("rename"), id, name }),
  z.strictObject({ op: z.literal("delete"), id }),
  z.strictObject({ op: z.literal("add"), id, messageId }),
  z.strictObject({ op: z.literal("remove"), id, messageId }),
]);
const collections = z.strictObject({ collections: z.array(SavedCollection).max(20) });

export const SparkThreadId = z.strictObject({ id });
export const SparkTitle = z.string().trim().min(1).max(100);
export const SparkCreate = SparkThreadId.extend({ title: SparkTitle });
export const SparkRename = z.strictObject({ title: SparkTitle });
export const SparkPrompt = z.strictObject({
  requestId: id,
  prompt: z.string().trim().min(1).max(4000),
  consent: z.literal(true),
  locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2}|-[0-9]{3})?$/).optional(),
});
export const SPARK_MAX_REPLY = 8_000;
export const SPARK_MAX_TURNS = 30;
export const SparkTurn = z.strictObject({ requestId: id, user: z.string().max(4000), assistant: z.string().max(SPARK_MAX_REPLY), at: z.number() });
const summary = SparkCreate.extend({ updatedAt: z.number() });
const sparkInfo = z.strictObject({ configured: z.boolean(), historyAvailable: z.boolean(), threads: z.array(summary).max(30) });
const thread = z.strictObject({ thread: summary.extend({ turns: z.array(SparkTurn).max(SPARK_MAX_TURNS) }) });
const frame = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("delta"), text: z.string() }),
  z.strictObject({ type: z.literal("done") }),
  z.strictObject({ type: z.literal("error"), code: z.literal("provider_unavailable") }),
]);

const me = (tag: string, c: Omit<RouteContract, "tag" | "auth">) => route({ tag, auth: true, ...c });
export const webExperienceRoutes = [
  me("saved-collections", { method: "GET", url: "/v2/me/saved-collections", summary: "Read your saved-message collections.", response: collections }),
  me("saved-collections", { method: "POST", url: "/v2/me/saved-collections", summary: "Create, rename, delete, add to, or remove from your saved-message collections.", body: SavedCollectionOp, response: collections, errors: ["limit_reached", "not_found", "stale_preferences"] }),
  me("spark-assistant", { method: "GET", url: "/v2/me/spark", summary: "Read assistant availability and your Spark conversation titles.", response: sparkInfo }),
  me("spark-assistant", { method: "POST", url: "/v2/me/spark/threads", summary: "Create your Spark conversation.", body: SparkCreate, response: thread, errors: ["provider_not_configured", "limit_reached", "conflict"] }),
  me("spark-assistant", { method: "GET", url: "/v2/me/spark/threads/:id", summary: "Read your Spark conversation.", params: SparkThreadId, response: thread, errors: ["not_found", "unavailable"] }),
  me("spark-assistant", { method: "PATCH", url: "/v2/me/spark/threads/:id", summary: "Rename your Spark conversation.", params: SparkThreadId, body: SparkRename, response: thread, errors: ["not_found", "unavailable"] }),
  me("spark-assistant", { method: "DELETE", url: "/v2/me/spark/threads/:id", summary: "Delete your Spark conversation.", params: SparkThreadId, response: z.strictObject({ deleted: z.literal(true) }) }),
  me("spark-assistant", { method: "POST", url: "/v2/me/spark/threads/:id/turns", summary: "Send a consented prompt and stream newline-delimited reply frames.", params: SparkThreadId, body: SparkPrompt, response: frame, ndjson: true, errors: ["provider_not_configured", "not_found", "limit_reached", "conflict"] }),
];
