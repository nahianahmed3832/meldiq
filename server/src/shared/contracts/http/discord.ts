import { z } from "zod/v4";
import { zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Importing a Discord server's structure into a Meldiq community (docs/DISCORD_IMPORT.md): connect with Discord (the
 * person adds Meldiq's bot and Meldiq confirms they manage that server), preview, import, follow its progress, retry.
 * Only structure: the server icon, roles, categories, channels and emoji. Never messages, members or DMs.
 */

const zId = z.string().min(1).max(64);
export const DiscordIdParams = z.object({ id: zId });

export const DiscordImportOptions = z.strictObject({
  icon: z.boolean(),
  roles: z.boolean(),
  /** Also what each role may do, where Meldiq has an equivalent (Administrator never). */
  rolePermissions: z.boolean(),
  channels: z.boolean(),
  emojis: z.boolean(),
});

export const DiscordCallbackBody = z.object({
  code: z.string().min(1).max(200),
  state: z.string().min(16).max(200),
  /** What Discord put in the redirect; checked against what Discord itself says. */
  guildId: z
    .string()
    .regex(/^\d{5,25}$/)
    .optional(),
});

export const DiscordImportBody = z.object({
  connectionId: zId,
  destination: z.union([z.strictObject({ orgId: zId }), z.strictObject({ name: z.string().trim().min(1).max(80) })]),
  options: DiscordImportOptions,
});

export const DiscordPreviewQuery = z.object({ orgId: zId.optional() });
export const DiscordDisconnectQuery = z.object({ leave: z.enum(["true", "false"]).optional() });

const Connection = z.strictObject({ id: z.string(), guildId: z.string(), guildName: z.string(), verifiedAt: zTime, expiresAt: zTime });

export const DiscordItemKind = z.enum(["icon", "role", "category", "channel", "emoji"]);
const PreviewItem = z.strictObject({ key: z.string(), kind: DiscordItemKind, name: z.string(), action: z.enum(["create", "skip"]), note: z.string().nullable() });
const ImportItem = z.strictObject({
  key: z.string(),
  kind: DiscordItemKind,
  name: z.string(),
  status: z.enum(["pending", "done", "failed", "skipped"]),
  note: z.string().nullable(),
});
const ImportView = z.strictObject({
  id: z.string(),
  guildId: z.string(),
  guildName: z.string(),
  orgId: z.string().nullable(),
  status: z.enum(["running", "completed", "completed_with_errors", "failed", "interrupted"]),
  error: z.string().nullable(),
  options: DiscordImportOptions,
  counts: z.strictObject({ total: z.number().int(), done: z.number().int(), failed: z.number().int(), skipped: z.number().int(), pending: z.number().int() }),
  createdAt: zTime,
  finishedAt: zTime.nullable(),
});

const discord = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "discord-import", auth: true, ...c });

export const discordRoutes = [
  discord({
    method: "GET",
    url: "/v1/discord/status",
    summary: "Whether this server can import from Discord, and the Discord servers you've connected (usable for 24 hours).",
    response: z.strictObject({ configured: z.boolean(), connections: z.array(Connection) }),
  }),
  discord({
    method: "POST",
    url: "/v1/discord/connect",
    summary: "Start connecting Discord: the address where you add Meldiq's bot to a server you manage (valid 10 minutes).",
    response: z.strictObject({ url: z.string() }),
    errors: ["discord_not_configured"],
  }),
  discord({
    method: "POST",
    url: "/v1/discord/callback",
    summary: "Finish connecting: Meldiq checks with Discord that you own the server or have Manage Server there, then forgets your Discord token.",
    body: DiscordCallbackBody,
    response: z.strictObject({ connection: Connection }),
    errors: ["discord_not_configured", "discord_not_allowed", "discord_bot_missing", "discord_unreachable"],
  }),
  discord({
    method: "DELETE",
    url: "/v1/discord/connections/:id",
    summary: "Disconnect a Discord server; with ?leave=true Meldiq's bot also leaves it.",
    params: DiscordIdParams,
    query: DiscordDisconnectQuery,
    response: z.strictObject({ ok: z.literal(true), botLeft: z.boolean() }),
    errors: ["not_found", "discord_unreachable"],
  }),
  discord({
    method: "GET",
    url: "/v1/discord/connections/:id/preview",
    summary: "What an import would make, item by item, and what it would leave out and why.",
    params: DiscordIdParams,
    query: DiscordPreviewQuery,
    response: z.strictObject({
      guild: z.strictObject({ id: z.string(), name: z.string(), description: z.string().nullable() }),
      items: z.array(PreviewItem),
      excluded: z.array(z.string()),
    }),
    errors: ["not_found", "discord_not_configured", "discord_bot_missing", "discord_unreachable"],
  }),
  discord({
    method: "POST",
    url: "/v1/discord/imports",
    summary: "Import a connected server into a new community (private, invite-only) or one you run. Runs in the background.",
    body: DiscordImportBody,
    response: z.strictObject({ import: ImportView }),
    status: 202,
    errors: ["not_found", "forbidden", "org_name_taken", "discord_not_configured", "discord_bot_missing", "discord_unreachable", "conflict"],
  }),
  discord({
    method: "GET",
    url: "/v1/discord/imports/:id",
    summary: "An import's progress and, item by item, what was made, left out or failed.",
    params: DiscordIdParams,
    response: z.strictObject({ import: ImportView, items: z.array(ImportItem) }),
    errors: ["not_found"],
  }),
  discord({
    method: "POST",
    url: "/v1/discord/imports/:id/retry",
    summary: "Try the failed items again (and continue an interrupted import). Nothing already made is made twice.",
    params: DiscordIdParams,
    response: z.strictObject({ import: ImportView }),
    status: 202,
    errors: ["not_found", "conflict", "discord_not_configured"],
  }),
] as const;
