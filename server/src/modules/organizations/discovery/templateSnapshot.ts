import { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { RowReader, RowWriter } from "../../../infrastructure/database/rows/index.js";
import { newId } from "../../../shared/utilities/util.js";
import type { ConversationRow } from "../authz.js";
import { insertCategory, insertChannel } from "../communityStart.js";

/**
 * A template's copy of a community (community parity batch E, docs/COMMUNITY_PARITY_API.md › Discovery): its custom
 * roles (names, colours, permissions, denies, gradient, mentionable, automatic for everyone), the @everyone defaults,
 * categories and channels (names, kinds, topics, order, slowmode, forum tags and guidelines, channel options) and the
 * permission overwrites for @everyone and roles. Never messages, members, people's overwrites, pictures or tickets.
 * Roles and categories are named by keys inside the copy ("r1", "k1"), so nothing points back at the source.
 */

const Overwrite = z.object({ subject: z.string(), allow: z.array(z.string()), deny: z.array(z.string()) });
const Role = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  hoist: z.boolean(),
  permissions: z.array(z.string()),
  denies: z.array(z.string()),
  color2: z.string().nullable(),
  mentionable: z.boolean(),
  autoEveryone: z.boolean(),
});
const Category = z.object({ key: z.string(), name: z.string(), position: z.number(), overwrites: z.array(Overwrite) });
const Options = z.object({ textOnly: z.boolean(), noGifs: z.boolean(), stage: z.boolean(), readOnly: z.boolean(), posterRoles: z.array(z.string()) });
const Channel = z.object({
  name: z.string(),
  topic: z.string().nullable(),
  kind: z.enum(["PUBLIC", "PRIVATE", "ANNOUNCEMENT"]),
  voice: z.boolean(),
  format: z.enum(["text", "forum"]),
  category: z.string().nullable(),
  position: z.number(),
  slowmodeSec: z.number(),
  forumTags: z.string().nullable(),
  guidelines: z.string().nullable(),
  options: Options.nullable(),
  overwrites: z.array(Overwrite),
});
export const Snapshot = z.object({
  v: z.literal(1),
  everyone: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }).nullable(),
  roles: z.array(Role),
  categories: z.array(Category),
  channels: z.array(Channel),
});
export type Snapshot = z.infer<typeof Snapshot>;

const json = (s: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  hoist: number;
  permissions: string;
  denies: string;
  position: number;
}

/** Overwrites on [type] [id], with role subjects as keys; people's overwrites and unknown roles are left out. */
function overwritesOf(r: RowReader, type: "category" | "channel", id: string, roleKeys: Map<string, string>) {
  return r
    .all<{ subject: string; allow: string; deny: string }>("channel_overwrites", { where: { target_type: type, target_id: id } })
    .flatMap((o) => {
      const subject = o.subject === "everyone" ? "everyone" : roleKeys.get(o.subject);
      return subject ? [{ subject, allow: json(o.allow), deny: json(o.deny) }] : [];
    });
}

/** [orgId] as a template copies it. */
export function takeSnapshot(ctx: AppContext, orgId: string): Snapshot {
  const r = ctx.ws;
  const roles = r.all<RoleRow>("org_roles", { where: { org_id: orgId, archived_at: null }, orderBy: [["position", "asc"], ["id", "asc"]] });
  const roleKeys = new Map(roles.map((x, i) => [x.id, `r${i + 1}`]));
  const extras = new Map(r.all<{ role_id: string; color2: string | null; mentionable: number; auto_assign: string }>("org_role_extras", { where: { org_id: orgId } }).map((x) => [x.role_id, x]));
  const everyone = r.get<{ added: string; removed: string }>("community_member_defaults", { org_id: orgId });
  const categories = r.all<{ id: string; name: string; position: number }>("channel_categories", { where: { org_id: orgId }, orderBy: [["position", "asc"], ["id", "asc"]] });
  const categoryKeys = new Map(categories.map((c, i) => [c.id, `k${i + 1}`]));
  const tickets = new Set(r.all<{ channel_id: string }>("tickets", { where: { org_id: orgId } }).map((t) => t.channel_id));
  const channels = ctx.authz
    .conversationIdsOf(orgId)
    .map((id) => ctx.authz.conversation(id))
    .filter((c): c is ConversationRow => !!c && c.type === "CHANNEL" && !c.archived_at && !tickets.has(c.id))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  return {
    v: 1,
    everyone: everyone ? { added: json(everyone.added), removed: json(everyone.removed) } : null,
    roles: roles.map((x) => {
      const e = extras.get(x.id);
      return {
        key: roleKeys.get(x.id)!,
        name: x.name,
        description: x.description,
        color: x.color,
        icon: x.icon,
        hoist: x.hoist === 1,
        permissions: json(x.permissions),
        denies: json(x.denies),
        color2: e?.color2 ?? null,
        mentionable: e?.mentionable === 1,
        autoEveryone: e?.auto_assign === "everyone",
      };
    }),
    categories: categories.map((c) => ({ key: categoryKeys.get(c.id)!, name: c.name, position: c.position, overwrites: overwritesOf(r, "category", c.id, roleKeys) })),
    channels: channels.map((c) => {
      const o = r.get<{ text_only: number; no_gifs: number; stage: number; read_only: number; poster_role_ids: string }>("channel_options", { conversation_id: c.id });
      return {
        name: c.name ?? "channel",
        topic: c.topic,
        kind: c.kind ?? "PUBLIC",
        voice: c.voice === 1,
        format: c.format ?? "text",
        category: c.category_id ? (categoryKeys.get(c.category_id) ?? null) : null,
        position: c.position ?? 0,
        slowmodeSec: c.slowmode_sec ?? 0,
        forumTags: c.forum_tags ?? null,
        guidelines: (c as { guidelines?: string | null }).guidelines ?? null,
        options: o
          ? { textOnly: o.text_only === 1, noGifs: o.no_gifs === 1, stage: o.stage === 1, readOnly: o.read_only === 1, posterRoles: json(o.poster_role_ids).flatMap((id) => roleKeys.get(id) ?? []) }
          : null,
        overwrites: overwritesOf(r, "channel", c.id, roleKeys),
      };
    }),
  };
}

function writeOverwrites(w: RowWriter, orgId: string, type: "category" | "channel", id: string, list: Snapshot["channels"][number]["overwrites"], roleIds: Map<string, string>, actorId: string, t: number): void {
  for (const o of list) {
    const subject = o.subject === "everyone" ? "everyone" : roleIds.get(o.subject);
    if (!subject) continue;
    w.insert("channel_overwrites", { target_type: type, target_id: id, org_id: orgId, subject, allow: JSON.stringify(o.allow), deny: JSON.stringify(o.deny), updated_by: actorId, updated_at: t }, { orIgnore: true });
  }
}

/**
 * Rebuilds [s] in [orgId], a community [ownerId] just made (inside one write unit; the caller notifies). Roles beyond
 * what the new community's plan allows are left out. Returns the new channel ids.
 */
export function rebuild(ctx: AppContext, w: RowWriter, orgId: string, ownerId: string, s: Snapshot, roleLimit: number | null, t: number): string[] {
  const roleIds = new Map<string, string>();
  s.roles.slice(0, roleLimit ?? s.roles.length).forEach((x, i) => {
    const id = newId("rl");
    roleIds.set(x.key, id);
    w.insert("org_roles", {
      id,
      org_id: orgId,
      name: x.name,
      description: x.description,
      color: x.color,
      icon: x.icon,
      permissions: JSON.stringify(x.permissions),
      denies: JSON.stringify(x.denies),
      template: null,
      position: i + 1,
      hoist: x.hoist ? 1 : 0,
      rev: 1,
      created_by: ownerId,
      created_at: t,
      updated_at: t,
    });
    if (x.color2 || x.mentionable || x.autoEveryone) {
      w.insert("org_role_extras", { role_id: id, org_id: orgId, color2: x.color2, mentionable: x.mentionable ? 1 : 0, auto_assign: x.autoEveryone ? "everyone" : "none", auto_before: null, updated_by: ownerId, updated_at: t });
    }
  });
  if (s.everyone) {
    w.insert("community_member_defaults", { org_id: orgId, added: JSON.stringify(s.everyone.added), removed: JSON.stringify(s.everyone.removed), updated_by: ownerId, updated_at: t });
  }
  const categoryIds = new Map<string, string>();
  for (const c of s.categories) {
    const id = insertCategory(w, orgId, ownerId, c.name, c.position, t);
    categoryIds.set(c.key, id);
    writeOverwrites(w, orgId, "category", id, c.overwrites, roleIds, ownerId, t);
  }
  return s.channels.map((c) => {
    const categoryId = c.category ? (categoryIds.get(c.category) ?? null) : null;
    const id = insertChannel(ctx, w, orgId, ownerId, { name: c.name, topic: c.topic, kind: c.kind, voice: c.voice, format: c.format, categoryId, position: c.position, slowmodeSec: c.slowmodeSec, forumTags: c.forumTags, guidelines: c.guidelines }, t);
    writeOverwrites(w, orgId, "channel", id, c.overwrites, roleIds, ownerId, t);
    if (c.options) {
      const o = c.options;
      const posters = o.posterRoles.flatMap((k) => roleIds.get(k) ?? []);
      w.insert("channel_options", { conversation_id: id, org_id: orgId, text_only: o.textOnly ? 1 : 0, no_gifs: o.noGifs ? 1 : 0, stage: o.stage ? 1 : 0, read_only: o.readOnly ? 1 : 0, poster_role_ids: JSON.stringify(posters), updated_by: ownerId, updated_at: t });
    }
    return id;
  });
}

export const snapshotCounts = (s: Snapshot) => ({ categories: s.categories.length, channels: s.channels.length, roles: s.roles.length });

/** The preview's channel list: uncategorised channels first (name null), then each category in order. */
export function previewCategories(s: Snapshot) {
  const view = (c: Snapshot["channels"][number]) => ({ name: c.name, kind: c.kind, voice: c.voice, format: c.format, topic: c.topic });
  const loose = s.channels.filter((c) => !c.category || !s.categories.some((k) => k.key === c.category));
  return [
    ...(loose.length > 0 ? [{ name: null, channels: loose.map(view) }] : []),
    ...[...s.categories].sort((a, b) => a.position - b.position).map((k) => ({ name: k.name, channels: s.channels.filter((c) => c.category === k.key).map(view) })),
  ];
}
