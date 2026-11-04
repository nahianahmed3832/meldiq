import { z } from "zod/v4";
import { route } from "./route.js";
import { WebhookView } from "./webhooks.js";
import { BotMessageBody } from "./bots.js";
import { SendMessageResult } from "./serverMessages.js";

/** Approval limits a bot's existing community roles; it never grants those roles or bypasses their denials. */
export const BOT_PLATFORM_SCOPES = [
  "communities.read",
  "channels.read",
  "members.read",
  "events.read",
  "direct_messages",
  "channels.manage",
  "roles.manage",
  "members.remove",
  "members.ban",
  "members.timeout",
  "members.nicknames",
  "messages.history",
  "messages.manage",
  "messages.react",
  "messages.post",
  "files.upload",
  "files.read",
  "expressions.manage",
  "members.invite",
  "voice.connect",
  "voice.speak",
  "voice.mute_members",
  "voice.move_members",
  "events.manage",
  "webhooks.manage",
] as const;
export type BotPlatformScope = (typeof BOT_PLATFORM_SCOPES)[number];
export const BotPlatformScope = z.enum(BOT_PLATFORM_SCOPES);
export const BotPermissionList = z
  .array(BotPlatformScope)
  .max(BOT_PLATFORM_SCOPES.length)
  .refine(
    (items) => new Set(items).size === items.length,
    "List each permission once",
  );
export const BotManifestUpdate = z.strictObject({
  permissions: BotPermissionList,
  rev: z.number().int().nonnegative(),
  voicePublicKey: z.string().trim().regex(/^[A-Za-z0-9+/]{43}=$/).nullable().optional(),
});
export const BotInstallationApproval = z.strictObject({
  permissions: BotPermissionList,
  manifestRev: z.number().int().positive(),
  rev: z.number().int().nonnegative(),
});
export const BotPermissionManifest = z.strictObject({
  botId: z.string(),
  permissions: BotPermissionList,
  rev: z.number().int().nonnegative(),
  voicePublicKey: z.string().nullable().optional(),
  voiceKeyFingerprint: z.string().nullable().optional(),
});
export const BotPermissionInstallation = z.strictObject({
  orgId: z.string(),
  botId: z.string(),
  permissions: BotPermissionList,
  manifestRev: z.number().int().nonnegative(),
  rev: z.number().int().nonnegative(),
  approvedBy: z.string().nullable(),
  approvedAt: z.number().nullable(),
});
const botId = z.strictObject({ botId: z.string().min(1).max(64) });
const owned = z.strictObject({ id: z.string().min(1).max(64) });
const installed = z.strictObject({
  orgId: z.string().min(1).max(64),
  botId: z.string().min(1).max(64),
});
export const BotEventsQuery = z.strictObject({
  cursor: z.string().max(640).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const BotInventoryQuery = z.strictObject({
  after: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const BotTestEventBody = z.strictObject({ testId: z.uuid() });
export const BotDmConsentBody = z.strictObject({
  enabled: z.boolean(),
  rev: z.number().int().nonnegative(),
  manifestRev: z.number().int().nonnegative(),
  noticeVersion: z.string().max(80),
});
export const BotDmConsentView = z.strictObject({
  botId: z.string(),
  enabled: z.boolean(),
  conversationId: z.string().nullable(),
  rev: z.number().int().nonnegative(),
  manifestRev: z.number().int().nonnegative(),
  requested: z.boolean(),
  noticeVersion: z.string(),
});
export const BotDmUserParams = z.strictObject({
  userId: z.string().min(1).max(64),
});
export const BotEventPage = z.strictObject({
  events: z
    .array(
      z.strictObject({
        id: z.uuid(),
        type: z.enum([
          "message",
          "dm_message",
          "reaction_add",
          "reaction_remove",
          "member_join",
          "member_leave",
          "invite_create",
          "invite_delete",
          "voice_join",
          "voice_leave",
          "command",
          "interaction",
          "test",
        ]),
        communityId: z.string().nullable(),
        channelId: z.string().nullable(),
        actorId: z.string().nullable(),
        targetId: z.string().nullable(),
        sourceId: z.string().nullable(),
        data: z.record(z.string(), z.unknown()),
        createdAt: z.number(),
      }),
    )
    .max(100),
  cursor: z.string().max(640),
  more: z.boolean(),
  replayWindowSeconds: z.number(),
});
export const botPlatformContracts = [
  route({
    method: "GET",
    url: "/v2/bots/:botId/direct-messages",
    tag: "Bots",
    auth: true,
    params: botId,
    response: BotDmConsentView,
    summary:
      "This person's own bot-DM consent and the bot's requested access. Community managers cannot consent on another person's behalf.",
  }),
  route({
    method: "PUT",
    url: "/v2/bots/:botId/direct-messages",
    tag: "Bots",
    auth: true,
    params: botId,
    body: BotDmConsentBody,
    response: BotDmConsentView,
    errors: ["stale_revision", "bot_events_unavailable"],
    summary:
      "Explicit recipient-controlled bot-DM consent, revision checked against current requested access and notice. Revocation stops sends/history/replay; renewed consent starts a fresh conversation.",
  }),
  route({
    method: "POST",
    url: "/v2/bot/users/:userId/dm",
    tag: "Bots",
    auth: true,
    scheme: "bot",
    params: BotDmUserParams,
    body: BotMessageBody,
    response: SendMessageResult.extend({ conversationId: z.string() }),
    summary:
      "Send a native text DM only to a person who explicitly enabled this bot's current requested DM access. Cannot initiate unsolicited messages or enter a person-to-person DM.",
  }),
  route({
    method: "GET",
    url: "/v2/bot/changelog",
    tag: "Bots",
    auth: true,
    scheme: "bot",
    response: z.strictObject({
      protocolVersion: z.literal(1),
      entries: z.array(
        z.strictObject({
          version: z.string(),
          date: z.string(),
          changes: z.array(z.string()),
        }),
      ),
    }),
    summary:
      "Native bot protocol and capability history of this server; no vendor compatibility promise.",
  }),
  route({
    method: "GET",
    url: "/v2/bot/webhooks",
    tag: "Bots",
    auth: true,
    scheme: "bot",
    query: BotInventoryQuery,
    response: z.strictObject({
      webhooks: z.array(WebhookView).max(100),
      next: z.string().nullable(),
    }),
    summary:
      "Paginated sanitized webhook inventory across currently approved communities and manageable, visible channels. Never includes tokens or hashes.",
  }),
  route({
    method: "GET",
    url: "/v2/bot/orgs/:orgId/voice",
    tag: "Bots",
    auth: true,
    scheme: "bot",
    params: z.strictObject({ orgId: z.string().min(1).max(64) }),
    query: BotInventoryQuery,
    response: z.strictObject({
      channels: z
        .array(
          z.strictObject({
            id: z.string(),
            name: z.string(),
            callId: z.string().nullable(),
            participants: z.array(z.string()),
          }),
        )
        .max(100),
      next: z.string().nullable(),
    }),
    summary:
      "Currently joinable community voice rooms and participant account ids, requiring approved voice.connect and current native room authority. No media credentials.",
  }),
  route({
    method: "POST",
    url: "/v2/bot/events/test",
    tag: "Bots",
    auth: true,
    scheme: "bot",
    body: BotTestEventBody,
    response: z.strictObject({
      id: z.uuid(),
      testId: z.uuid(),
      duplicate: z.boolean(),
    }),
    errors: ["bot_events_unavailable"],
    summary:
      "Emit a self-addressed ID-only diagnostic event. A caller testId is idempotent during the seven-day retained event window. No other bot can receive it.",
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/bots/:botId/permission-review",
    tag: "Bots",
    auth: true,
    params: installed,
    response: z.strictObject({
      manifest: BotPermissionManifest,
      installation: BotPermissionInstallation,
      approvable: BotPermissionList,
    }),
    summary:
      "Installed-bot permission review for a current community manager, including private bots. Lists only permissions this manager may approve.",
  }),
  route({
    method: "GET",
    url: "/v2/bot/events",
    tag: "Bots",
    auth: true,
    scheme: "bot",
    query: BotEventsQuery,
    response: BotEventPage,
    errors: ["bot_cursor_expired", "bot_events_unavailable", "stale_revision"],
    summary:
      "Durable, bot-bound ID-only event replay, filtered by current scopes, installation, native roles and channel history. Seven-day operational replay; PostgreSQL required.",
  }),
  route({
    method: "GET",
    url: "/v2/bots/:botId/permissions",
    tag: "Bots",
    auth: true,
    params: botId,
    response: BotPermissionManifest,
    summary:
      "Requested permissions of a public or owned bot; no installation approval is implied.",
  }),
  route({
    method: "PUT",
    url: "/v2/developer/bots/:id/permissions",
    tag: "Bots",
    auth: true,
    params: owned,
    body: BotManifestUpdate,
    response: BotPermissionManifest,
    summary:
      "Owner-only revision-checked requested permissions. Existing installation approvals never expand automatically.",
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/bots/:botId/permissions",
    tag: "Bots",
    auth: true,
    params: installed,
    response: BotPermissionInstallation,
    summary:
      "Current installation approval, visible only to a permitted community bot manager.",
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/bots/:botId/permissions",
    tag: "Bots",
    auth: true,
    params: installed,
    body: BotInstallationApproval,
    response: BotPermissionInstallation,
    summary:
      "Explicit revision-checked installation approval. Never grants community roles or overrides current denials.",
  }),
];
