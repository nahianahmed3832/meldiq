import { z } from "zod/v4";
import { route } from "./route.js";

/** Approval limits a bot's existing community roles; it never grants those roles or bypasses their denials. */
export const BOT_PLATFORM_SCOPES = [
  "communities.read", "channels.read", "members.read", "events.read", "direct_messages",
  "channels.manage", "roles.manage", "members.remove", "members.ban", "members.timeout", "members.nicknames",
  "messages.history", "messages.manage", "messages.react", "messages.post", "expressions.manage", "members.invite",
  "voice.connect", "voice.speak", "voice.mute_members", "voice.move_members", "events.manage", "webhooks.manage",
] as const;
export type BotPlatformScope = typeof BOT_PLATFORM_SCOPES[number];
export const BotPlatformScope = z.enum(BOT_PLATFORM_SCOPES);
export const BotPermissionList = z.array(BotPlatformScope).max(BOT_PLATFORM_SCOPES.length).refine((items) => new Set(items).size === items.length, "List each permission once");
export const BotManifestUpdate = z.strictObject({ permissions: BotPermissionList, rev: z.number().int().nonnegative() });
export const BotInstallationApproval = z.strictObject({ permissions: BotPermissionList, manifestRev: z.number().int().positive(), rev: z.number().int().nonnegative() });
export const BotPermissionManifest = z.strictObject({ botId: z.string(), permissions: BotPermissionList, rev: z.number().int().nonnegative() });
export const BotPermissionInstallation = z.strictObject({ orgId: z.string(), botId: z.string(), permissions: BotPermissionList, manifestRev: z.number().int().nonnegative(), rev: z.number().int().nonnegative(), approvedBy: z.string().nullable(), approvedAt: z.number().nullable() });
const botId = z.strictObject({ botId: z.string().min(1).max(64) });
const owned = z.strictObject({ id: z.string().min(1).max(64) });
const installed = z.strictObject({ orgId: z.string().min(1).max(64), botId: z.string().min(1).max(64) });
export const botPlatformContracts = [
  route({ method: "GET", url: "/v2/bots/:botId/permissions", tag: "Bots", auth: true, params: botId, response: BotPermissionManifest, summary: "Requested permissions of a public or owned bot; no installation approval is implied." }),
  route({ method: "PUT", url: "/v2/developer/bots/:id/permissions", tag: "Bots", auth: true, params: owned, body: BotManifestUpdate, response: BotPermissionManifest, summary: "Owner-only revision-checked requested permissions. Existing installation approvals never expand automatically." }),
  route({ method: "GET", url: "/v1/orgs/:orgId/bots/:botId/permissions", tag: "Bots", auth: true, params: installed, response: BotPermissionInstallation, summary: "Current installation approval, visible only to a permitted community bot manager." }),
  route({ method: "PUT", url: "/v1/orgs/:orgId/bots/:botId/permissions", tag: "Bots", auth: true, params: installed, body: BotInstallationApproval, response: BotPermissionInstallation, summary: "Explicit revision-checked installation approval. Never grants community roles or overrides current denials." }),
];
