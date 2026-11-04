import { z } from "zod/v4";
import { route } from "./route.js";
import { SendMessageResult } from "./serverMessages.js";
const id = z.string().min(1).max(64);
export const BotMessageTarget = z.strictObject({
  channelId: id,
  messageId: id,
});
export const BotReactionTarget = BotMessageTarget.extend({
  emoji: z.string().min(1).max(128),
});
export const BotBulkTarget = z.strictObject({ channelId: id });
export const BotBulkBody = z.strictObject({
  messageIds: z
    .array(id)
    .min(1)
    .max(100)
    .refine(
      (items) => new Set(items).size === items.length,
      "Each message must be listed once",
    ),
});
const base = { tag: "Bots", auth: true, scheme: "bot" as const };
const root = "/v2/bot/channels/:channelId/messages/:messageId";
export const botMessageContracts = [
  route({
    ...base,
    method: "GET",
    url: `${root}/reactions`,
    params: BotMessageTarget,
    response: z.strictObject({
      reactions: z.array(
        z.strictObject({
          emoji: z.string(),
          userIds: z.array(z.string()),
          count: z.number().int().nonnegative(),
        }),
      ),
    }),
    summary:
      "Current visible reactions. Requires approved history access and current channel/history visibility.",
  }),
  ...(["PUT", "DELETE"] as const).map((method) =>
    route({
      ...base,
      method,
      url: `${root}/reactions/:emoji`,
      params: BotReactionTarget,
      response: SendMessageResult,
      summary: `${method === "PUT" ? "Add" : "Remove"} this bot's reaction through the native message path. Requires approved reactions and current native posting/reaction authority.`,
    }),
  ),
  ...(["PUT", "DELETE"] as const).map((method) =>
    route({
      ...base,
      method,
      url: `${root}/pin`,
      params: BotMessageTarget,
      response: SendMessageResult,
      summary: `${method === "PUT" ? "Pin" : "Unpin"} a visible message. Approval and native message-moderation authority are both required.`,
    }),
  ),
  route({
    ...base,
    method: "POST",
    url: "/v2/bot/channels/:channelId/messages/bulk-delete",
    params: BotBulkTarget,
    body: BotBulkBody,
    response: z.strictObject({
      deleted: z.array(z.string()),
      failed: z.array(
        z.strictObject({ messageId: z.string(), code: z.string() }),
      ),
    }),
    summary:
      "Delete at most 100 messages through native deletion controls. Approval and native moderation apply per message. Partial outcomes are explicit; this is not an atomic batch.",
  }),
];
