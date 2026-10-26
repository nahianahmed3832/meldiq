import { z } from "zod/v4";
import type { Permission as PermissionKey } from "../permissions/catalog.js";

/**
 * What a Discord server's structure becomes in Meldiq (docs/DISCORD_IMPORT.md). Pure: the Discord objects come from the
 * bot's API calls (validated here, since they're outside data), and the plan says, item by item, what will be made and
 * what won't, with a reason. Never messages, members, DMs or anything else about people.
 */

const snowflake = z.string().regex(/^\d{5,25}$/);

export const DiscordRole = z.object({
  id: snowflake,
  name: z.string().max(200),
  color: z.number().int().min(0).max(0xffffff).default(0),
  position: z.number().int(),
  permissions: z.string().regex(/^\d{1,30}$/),
  managed: z.boolean().default(false),
});
export const DiscordEmoji = z.object({
  id: snowflake.nullable(),
  name: z.string().max(200).nullable(),
  animated: z.boolean().default(false),
  managed: z.boolean().default(false),
  available: z.boolean().default(true),
});
export const DiscordGuild = z.object({
  id: snowflake,
  name: z.string().min(1).max(200),
  icon: z.string().max(80).nullable().default(null),
  description: z.string().max(2000).nullable().default(null),
  roles: z.array(DiscordRole).max(1000).default([]),
  emojis: z.array(DiscordEmoji).max(2000).default([]),
});
const Overwrite = z.object({ id: snowflake, type: z.union([z.literal(0), z.literal(1), z.string()]), allow: z.string(), deny: z.string() });
export const DiscordChannel = z.object({
  id: snowflake,
  type: z.number().int(),
  name: z.string().max(200).nullable().default(null),
  position: z.number().int().default(0),
  parent_id: snowflake.nullable().default(null),
  topic: z.string().max(4096).nullable().default(null),
  permission_overwrites: z.array(Overwrite).max(500).default([]),
});
export type DiscordGuild = z.infer<typeof DiscordGuild>;
export type DiscordChannel = z.infer<typeof DiscordChannel>;
export type DiscordRole = z.infer<typeof DiscordRole>;

/** Discord permission bits (docs.discord.com, topics/permissions). */
export const BIT = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_AUDIT_LOG: 1n << 7n,
  VIEW_CHANNEL: 1n << 10n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  MODERATE_MEMBERS: 1n << 40n,
} as const;

/** The only bot permission Meldiq asks for: to see the channel list. */
export const BOT_PERMISSIONS = BIT.VIEW_CHANNEL;

/** Discord powers with a Meldiq equivalent close enough to copy when the person asks for role permissions. */
const PERMISSION_MAP: readonly (readonly [bigint, readonly PermissionKey[], string])[] = [
  [BIT.MANAGE_GUILD, ["workspace.edit"], "Manage Server"],
  [BIT.CREATE_INSTANT_INVITE, ["members.invite"], "Create Invite"],
  [BIT.KICK_MEMBERS, ["members.remove"], "Kick Members"],
  [BIT.BAN_MEMBERS, ["members.ban"], "Ban Members"],
  [BIT.MODERATE_MEMBERS, ["members.timeout"], "Timeout Members"],
  [BIT.MANAGE_CHANNELS, ["channels.create", "channels.manage"], "Manage Channels"],
  [BIT.MANAGE_ROLES, ["roles.manage", "roles.assign"], "Manage Roles"],
  [BIT.MANAGE_GUILD_EXPRESSIONS, ["expressions.manage"], "Manage Expressions"],
  [BIT.VIEW_AUDIT_LOG, ["audit.view"], "View Audit Log"],
];

/** Whether a member with [permissions] (a Discord bit string) and [owner] manages the server. */
export function managesGuild(owner: boolean, permissions: string): boolean {
  if (owner) return true;
  if (!/^\d{1,30}$/.test(permissions)) return false;
  const p = BigInt(permissions);
  return (p & BIT.ADMINISTRATOR) !== 0n || (p & BIT.MANAGE_GUILD) !== 0n;
}

/** The Meldiq permissions for a Discord role's bits, and what wasn't copied (Administrator never is). */
export function mapPermissions(bits: string): { permissions: PermissionKey[]; notCopied: string[] } {
  const p = BigInt(bits);
  const permissions = new Set<PermissionKey>();
  for (const [bit, keys] of PERMISSION_MAP) if ((p & bit) !== 0n) for (const k of keys) permissions.add(k);
  const notCopied = (p & BIT.ADMINISTRATOR) !== 0n ? ["Administrator"] : [];
  return { permissions: [...permissions], notCopied };
}

export interface ImportOptions {
  icon: boolean;
  roles: boolean;
  rolePermissions: boolean;
  channels: boolean;
  emojis: boolean;
}

export type ItemKind = "icon" | "role" | "category" | "channel" | "emoji";

/** What one item becomes. Only structure: names, topics, colours, kinds, positions. */
export type ItemSpec =
  | { kind: "icon"; guildId: string; hash: string }
  | { kind: "role"; name: string; color: string | null; permissions: PermissionKey[] }
  | { kind: "category"; name: string; position: number }
  | {
      kind: "channel";
      name: string;
      topic: string | null;
      channelKind: "PUBLIC" | "PRIVATE" | "ANNOUNCEMENT";
      voice: boolean;
      format: "text" | "forum";
      parentKey: string | null;
      position: number;
    }
  | { kind: "emoji"; emojiId: string; name: string; animated: boolean };

export interface PlanItem {
  sourceKey: string;
  kind: ItemKind;
  name: string;
  /** null: shown in the preview but not made, with [note] saying why. */
  spec: ItemSpec | null;
  note: string | null;
}

/** Limits the plan keeps to (the same as Meldiq's own: CHANNEL_LIMITS, MAX_ACTIVE_ROLES, EXPRESSION_LIMITS). */
export interface PlanLimits {
  channelsPerCategory: number;
  channels: number;
  roles: number;
  emoji: number;
}

const CHANNEL_TYPES: Readonly<Record<number, { label: string; voice: boolean; format: "text" | "forum"; announcement: boolean; note: string | null }>> = {
  0: { label: "text", voice: false, format: "text", announcement: false, note: null },
  5: { label: "announcement", voice: false, format: "text", announcement: true, note: null },
  2: { label: "voice", voice: true, format: "text", announcement: false, note: null },
  13: { label: "stage", voice: true, format: "text", announcement: false, note: "Stage channel: becomes a voice channel" },
  15: { label: "forum", voice: false, format: "forum", announcement: false, note: null },
  16: { label: "media", voice: false, format: "forum", announcement: false, note: "Media channel: becomes a forum" },
};

const TEXT_MAX = 500;
const NAME_MAX = 60;
const ROLE_NAME_MAX = 40;

/** A channel or category name Meldiq accepts: control characters out, trimmed, 1–60 characters. */
export function cleanName(raw: string | null, fallback: string, max = NAME_MAX): string {
  const s = (raw ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, max)
    .trim();
  return s || fallback;
}

/** An emoji name Meldiq accepts (2–32 of a–z, 0–9, _), or null. */
export function emojiName(raw: string | null): string | null {
  const s = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
  return s.length >= 2 ? s : null;
}

const hex = (color: number): string | null => (color === 0 ? null : `#${color.toString(16).padStart(6, "0").toUpperCase()}`);

/** Hidden from @everyone in Discord: then it's private in Meldiq too, so nothing private becomes public. */
export function isPrivate(guildId: string, ch: DiscordChannel): boolean {
  return ch.permission_overwrites.some((o) => o.id === guildId && String(o.type) === "0" && /^\d+$/.test(o.deny) && (BigInt(o.deny) & BIT.VIEW_CHANNEL) !== 0n);
}

const byPosition = <T extends { position: number; id: string }>(a: T, b: T) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

/** The whole plan, in the order it's carried out: icon, roles, categories, channels, emoji. */
export function planImport(guild: DiscordGuild, channels: readonly DiscordChannel[], options: ImportOptions, limits: PlanLimits): PlanItem[] {
  const items: PlanItem[] = [];
  if (options.icon && guild.icon) items.push({ sourceKey: `icon:${guild.id}`, kind: "icon", name: "Server icon", spec: { kind: "icon", guildId: guild.id, hash: guild.icon }, note: null });

  if (options.roles) {
    // Highest first, as Discord lists them; @everyone is the community's default and bot roles belong to their bots.
    const roles = guild.roles.filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
    let made = 0;
    for (const r of roles) {
      const name = cleanName(r.name, "Role", ROLE_NAME_MAX);
      const key = `role:${r.id}`;
      if (r.managed) {
        items.push({ sourceKey: key, kind: "role", name, spec: null, note: "Belongs to a Discord bot or integration" });
        continue;
      }
      if (made >= limits.roles) {
        items.push({ sourceKey: key, kind: "role", name, spec: null, note: `Over Meldiq's ${limits.roles} roles` });
        continue;
      }
      made++;
      const mapped = options.rolePermissions ? mapPermissions(r.permissions) : { permissions: [], notCopied: [] };
      const note = options.rolePermissions
        ? mapped.notCopied.length
          ? `Name, colour and permissions; not copied: ${mapped.notCopied.join(", ")}`
          : "Name, colour and permissions"
        : "Name and colour";
      items.push({ sourceKey: key, kind: "role", name, spec: { kind: "role", name, color: hex(r.color), permissions: mapped.permissions }, note });
    }
  }

  if (options.channels) {
    const categories = channels.filter((c) => c.type === 4).sort(byPosition);
    const known = new Set(categories.map((c) => c.id));
    categories.forEach((c, i) => {
      const name = cleanName(c.name, "Category");
      items.push({ sourceKey: `category:${c.id}`, kind: "category", name, spec: { kind: "category", name, position: i }, note: null });
    });
    // Uncategorised channels first (as Discord shows them), then each category's, in Discord's order.
    const groups: (string | null)[] = [null, ...categories.map((c) => c.id)];
    let total = 0;
    for (const parent of groups) {
      const inGroup = channels.filter((c) => c.type !== 4 && (parent === null ? c.parent_id === null || !known.has(c.parent_id) : c.parent_id === parent)).sort(byPosition);
      let position = 0;
      for (const c of inGroup) {
        const key = `channel:${c.id}`;
        const type = CHANNEL_TYPES[c.type];
        const name = cleanName(c.name, "channel");
        if (!type) {
          items.push({ sourceKey: key, kind: "channel", name, spec: null, note: "This kind of Discord channel has no Meldiq equivalent" });
          continue;
        }
        if (position >= limits.channelsPerCategory || total >= limits.channels) {
          items.push({ sourceKey: key, kind: "channel", name, spec: null, note: "Over Meldiq's channel limit" });
          continue;
        }
        const hidden = isPrivate(guild.id, c);
        const channelKind = hidden ? "PRIVATE" : type.announcement ? "ANNOUNCEMENT" : "PUBLIC";
        const notes = [type.note, hidden ? "Private in Discord: private here, add people or roles after" : null].filter(Boolean);
        items.push({
          sourceKey: key,
          kind: "channel",
          name,
          spec: {
            kind: "channel",
            name,
            topic: c.topic ? cleanName(c.topic, "", TEXT_MAX) || null : null,
            channelKind,
            voice: type.voice,
            format: type.format,
            parentKey: parent ? `category:${parent}` : null,
            position: position++,
          },
          note: notes.length ? notes.join(". ") : null,
        });
        total++;
      }
    }
  }

  if (options.emojis) {
    const taken = new Set<string>();
    let made = 0;
    for (const e of guild.emojis) {
      if (!e.id) continue;
      const base = emojiName(e.name);
      const key = `emoji:${e.id}`;
      const shown = `:${e.name ?? "emoji"}:`;
      if (e.managed || !e.available) {
        items.push({ sourceKey: key, kind: "emoji", name: shown, spec: null, note: "Managed by an integration, or not available" });
        continue;
      }
      if (!base) {
        items.push({ sourceKey: key, kind: "emoji", name: shown, spec: null, note: "Its name can't be used in Meldiq" });
        continue;
      }
      if (made >= limits.emoji) {
        items.push({ sourceKey: key, kind: "emoji", name: shown, spec: null, note: `Over Meldiq's ${limits.emoji} emoji` });
        continue;
      }
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 29)}_${n}`;
      taken.add(name);
      made++;
      items.push({ sourceKey: key, kind: "emoji", name: `:${name}:`, spec: { kind: "emoji", emojiId: e.id, name, animated: e.animated }, note: name === base ? null : "Renamed: the name was taken" });
    }
  }
  return items;
}
