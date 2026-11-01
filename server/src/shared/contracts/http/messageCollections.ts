import { z } from "zod/v4";
import { route } from "./route.js";
import { StoredEvent } from "./serverMessages.js";
const Id = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const CollectionQuery = z.object({
  kind: z.enum(["main", "pins", "media", "files", "threads", "thread"]),
  root: Id.optional(), before: z.coerce.number().int().positive().optional(), beforeId: Id.optional(),
  around: Id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
}).superRefine((q, c) => {
  if ((q.kind === "thread") !== !!q.root) c.addIssue({ code: "custom", message: "root is required only for a thread" });
  if (!!q.before !== !!q.beforeId) c.addIssue({ code: "custom", message: "before and beforeId must be paired" });
  if (q.around && (!["thread", "main"].includes(q.kind) || q.before)) c.addIssue({ code: "custom", message: "around is only for a timeline without a before cursor" });
});
export type CollectionQuery = z.infer<typeof CollectionQuery>;
export const CollectionResponse = z.strictObject({
  historySince: z.number().int().nonnegative().nullable(),
  messages: z.array(StoredEvent), context: z.array(StoredEvent), changes: z.array(StoredEvent),
  threads: z.array(z.strictObject({ rootId: Id, replyCount: z.number().int().nonnegative(), lastReplyTs: z.number().int().positive() })),
  more: z.boolean(), nextCursor: z.object({ serverTs: z.number().int().positive(), id: Id }).nullable(),
});
export const messageCollectionRoutes = [route({ method: "GET", url: "/v2/conversations/:id/message-collections", tag: "messaging", auth: true,
  summary: "Authoritative paged pins, media, files, thread index or a thread's replies. Membership and history visibility apply; never marks messages read.",
  query: CollectionQuery, response: CollectionResponse, errors: ["not_found"] })];
