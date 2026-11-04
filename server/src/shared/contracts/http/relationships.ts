import { z } from "zod/v4";
import { OkTrue } from "./auth.js";
import { zTime } from "./primitives.js";
import { route } from "./route.js";
import { UserSummary } from "./users.js";

/**
 * Connections and message requests (docs/product/MELDIQ_FRIENDS_AND_DMS_SPEC.md §4): request, accept, cancel, decline
 * and remove connections, answer message requests, and choose who may message you.
 */

/** Who may start a direct message with you. */
export const DmPolicy = z.enum(["everyone", "communities", "connections"]);
/** Who may send you a connection request. */
export const RequestPolicy = z.enum(["everyone", "communities", "nobody"]);

/** API 0.65.0: who may add you to group chats ("friends": people you're connected with). */
export const GroupAddPolicy = z.enum(["everyone", "friends", "nobody"]);
export type GroupAddPolicy = z.infer<typeof GroupAddPolicy>;

const zUserId = z.string().min(1).max(64);

export const RequestNote = z
  .string()
  .trim()
  .max(1200)
  .refine((value) => [...value].length <= 300, "Use at most 300 characters");
export const ConnectBody = z.union([
  z.strictObject({ userId: zUserId, note: RequestNote.optional() }),
  z.strictObject({
    username: z.string().trim().min(1).max(64),
    note: RequestNote.optional(),
  }),
]);
export const ConnectionUserParams = z.object({ userId: zUserId });
export const MessagingSettingsBody = z.strictObject({
  dmPolicy: DmPolicy.optional(),
  requestPolicy: RequestPolicy.optional(),
  /** API 0.65.0. */
  groupAddPolicy: GroupAddPolicy.optional(),
  /** API 0.65.0: whether you're suggested to people who share communities with you. */
  suggestable: z.boolean().optional(),
});
export const RequestParams = z.object({ id: zUserId });
export const RequestAnswerBody = z.strictObject({
  action: z.enum(["accept", "decline", "block"]),
});

/** A pending request: the other person and when it was sent. */
export const ConnectionRequest = z.strictObject({
  user: UserSummary,
  at: zTime,
  note: z.string().nullable().optional(),
});
export const Connections = z.strictObject({
  connected: z.array(UserSummary),
  /** Requests others sent you. */
  incoming: z.array(ConnectionRequest),
  /** Requests you sent. */
  outgoing: z.array(ConnectionRequest),
});
export const MessagingSettings = z.strictObject({
  dmPolicy: DmPolicy,
  requestPolicy: RequestPolicy,
  groupAddPolicy: GroupAddPolicy,
  suggestable: z.boolean(),
});

/** API 0.65.0: someone you share communities with and might know. */
export const SuggestedPerson = z.strictObject({
  user: UserSummary,
  sharedCommunities: z.number().int().positive(),
});
export const SUGGESTED_PEOPLE_MAX = 20;

export const connectionRoutes = [
  route({
    method: "GET",
    url: "/v1/connections",
    tag: "connections",
    summary: "Your connections, and the requests you received and sent.",
    auth: true,
    response: Connections,
  }),
  route({
    method: "POST",
    url: "/v1/connections",
    tag: "connections",
    summary:
      "Ask someone (by id or username) to connect, or accept their request when they already asked; repeating it changes nothing.",
    auth: true,
    body: ConnectBody,
    response: z.strictObject({
      state: z.enum(["accepted", "pending"]),
      userId: z.string(),
    }),
    errors: ["not_available", "requests_not_allowed", "request_rate_limited"],
  }),
  route({
    method: "POST",
    url: "/v1/connections/:userId/accept",
    tag: "connections",
    summary: "Accept someone's connection request.",
    auth: true,
    params: ConnectionUserParams,
    response: z.strictObject({ state: z.literal("accepted") }),
    errors: ["not_found"],
  }),
  route({
    method: "DELETE",
    url: "/v1/connections/:userId",
    tag: "connections",
    summary:
      "Cancel your request, decline theirs, or remove a connection (the other person isn't told which).",
    auth: true,
    params: ConnectionUserParams,
    response: OkTrue,
  }),
  route({
    method: "GET",
    url: "/v1/users/me/messaging",
    tag: "connections",
    summary:
      "Who may message you, send you connection requests or add you to group chats, and whether you're suggested to others.",
    auth: true,
    response: MessagingSettings,
  }),
  route({
    method: "PUT",
    url: "/v1/users/me/messaging",
    tag: "connections",
    summary:
      "Change who may message you, send you connection requests or add you to group chats, and whether you're suggested to others; only the fields sent change.",
    auth: true,
    body: MessagingSettingsBody,
    response: MessagingSettings,
  }),
  route({
    method: "GET",
    url: "/v2/people/suggested",
    tag: "connections",
    summary:
      "Up to 20 people who share communities with you and let themselves be suggested, most shared communities first; never friends, requests or blocked people.",
    auth: true,
    response: z.strictObject({ people: z.array(SuggestedPerson) }),
  }),
  route({
    method: "POST",
    url: "/v1/conversations/:id/request",
    tag: "connections",
    summary:
      "Answer a message request you received: accept (connects you), decline, or block.",
    auth: true,
    params: RequestParams,
    body: RequestAnswerBody,
    response: OkTrue,
    errors: ["not_found"],
  }),
];
