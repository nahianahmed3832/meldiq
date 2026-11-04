import { z } from "zod/v4";
import { idParams } from "./primitives.js";
import { route } from "./route.js";
export const ThreadLifecycle = z.strictObject({
  rootId: z.string(),
  conversationId: z.string(),
  authorId: z.string(),
  rev: z.number().int().nonnegative(),
  deletesParent: z.boolean(),
  closed: z.boolean(),
  locked: z.boolean(),
  deleting: z.boolean(),
  deleted: z.boolean(),
  deletionError: z.enum(["access_changed", "retry_required"]).nullable(),
  deletedReplies: z.number().int().nonnegative(),
  canReply: z.boolean(),
  canClose: z.boolean(),
  canLock: z.boolean(),
  canDelete: z.boolean(),
  following: z.boolean().nullable(),
});
export const ThreadChange = z
  .strictObject({
    baseRev: z.number().int().nonnegative(),
    closed: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .refine(
    (b) => b.closed !== undefined || b.locked !== undefined,
    "Choose a thread change",
  );
export const ThreadDelete = z.strictObject({
  baseRev: z.number().int().nonnegative(),
  deleteParent: z.boolean(),
});
export const ThreadFollow = z.strictObject({ following: z.boolean() });
export const ThreadFollowResult = z.strictObject({
  rootId: z.string(),
  following: z.boolean(),
});
export const ThreadPreferencesQuery = z.object({
  after: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});
export const ThreadPreferences = z.strictObject({
  nextAfter: z.string().nullable(),
  preferences: z.array(
    z.strictObject({
      rootId: z.string(),
      conversationId: z.string(),
      following: z.boolean(),
    }),
  ),
});
export const threadLifecycleContracts = [
  route({
    method: "GET",
    url: "/v1/threads/:id",
    tag: "messages",
    auth: true,
    params: idParams,
    response: ThreadLifecycle,
    summary:
      "Community thread authority, lifecycle and this account's follow preference.",
    errors: ["not_found"],
  }),
  route({
    method: "PATCH",
    url: "/v1/threads/:id",
    tag: "messages",
    auth: true,
    params: idParams,
    body: ThreadChange,
    response: ThreadLifecycle,
    summary:
      "Root authors close/reopen; channel thread managers may also lock/unlock. Stale writes are rejected.",
    errors: ["not_found", "forbidden", "stale_revision", "conflict"],
  }),
  route({
    method: "POST",
    url: "/v1/threads/:id/delete",
    tag: "messages",
    auth: true,
    params: idParams,
    body: ThreadDelete,
    response: ThreadLifecycle,
    summary:
      "Begin or resume bounded durable deletion of a community thread. Text parents remain; forum parents are deleted last.",
    errors: ["not_found", "forbidden", "stale_revision"],
  }),
  route({
    method: "PUT",
    url: "/v1/threads/:id/follow",
    tag: "messages",
    auth: true,
    params: idParams,
    body: ThreadFollow,
    response: ThreadFollowResult,
    summary:
      "Account-synced follow or explicit opt-out, without changing channel membership.",
    errors: ["not_found"],
  }),
  route({
    method: "GET",
    url: "/v1/me/thread-preferences",
    tag: "messages",
    auth: true,
    query: ThreadPreferencesQuery,
    response: ThreadPreferences,
    summary: "Only this account's currently authorized thread preferences.",
  }),
];
