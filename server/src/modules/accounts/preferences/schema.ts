import { z } from "zod";

/**
 * Personal navigation preferences (docs/WORKSPACE_ADMINISTRATION.md › Personal sections): one document per person and
 * workspace. They only arrange what the person can already see; they never grant access to anything.
 */

/** Conversation ids: "c_…" (local) or "cf_…" (federated DMs). */
export const zConversationId = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);
/** Home's built-in groups ("dms", "channels", "branch:<id>", "team:<id>", …): a short opaque key chosen by the app. */
const zGroupKey = z.string().min(1).max(80).regex(/^[A-Za-z0-9_:.-]+$/);
const zSectionId = z.string().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/);
/** Organisation (community) ids as the server assigns them. */
export const zOrgId = z.string().min(3).max(64).regex(/^o_[A-Za-z0-9_-]+$/);
/** Message ids as the server assigns them. */
const zMessageId = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const NOTIFY_LEVELS = ["all", "mentions", "none"] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

export const LIMITS = { starred: 200, sections: 30, itemsPerSection: 200, collapsed: 200, notify: 1000, saved: 500, railOrder: 200, mutedUntil: 1000, categories: 200, hidden: 500, railFolders: 50 } as const;
/** Category ids as the server assigns them. */
const zCategoryId = z.string().min(3).max(64).regex(/^cat_[A-Za-z0-9_-]+$/);

/**
 * A community's own notification settings (batch B2, Discord reference COMM-CTRL-002), in that community's document:
 * the level its channels follow unless a channel has its own ([NavPrefs.notify]), and whether @everyone counts as a
 * mention. Decided on the person's devices (wake-ups carry nothing); kept here so every device agrees.
 */
export const zCommunityNotify = z
  .object({
    level: z.enum(NOTIFY_LEVELS).default("all"),
    suppressEveryone: z.boolean().default(false),
    /**
     * API 0.46.0: the whole community muted until then (epoch ms), every channel in it included, even those with a level
     * of their own; null or left out: not muted. Ended ones are dropped.
     */
    mutedUntil: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export const zSection = z.object({
  id: zSectionId,
  name: z.string().trim().min(1).max(60),
  items: z.array(zConversationId).max(LIMITS.itemsPerSection),
  collapsed: z.boolean().default(false),
});

/**
 * A message saved for later (Home › Later, 2026-10-19): only the ids and times, never the message content (which stays
 * end-to-end encrypted). An optional reminder time; [done] keeps it listed as finished until removed.
 */
export const zSavedItem = z
  .object({
    conversationId: zConversationId,
    messageId: zMessageId,
    savedAt: z.number().int().min(0),
    remindAt: z.number().int().min(0).nullable().default(null),
    done: z.boolean().default(false),
  })
  .strict();

export const zRailFolder = z
  .object({
    id: z.string().regex(/^f_[A-Za-z0-9_-]{4,40}$/),
    name: z.string().trim().max(40).default(""),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .default(null),
    orgIds: z.array(zOrgId).min(1).max(LIMITS.railOrder),
  })
  .strict();

export const zNavPrefs = z
  .object({
    starred: z.array(zConversationId).max(LIMITS.starred).default([]),
    sections: z.array(zSection).max(LIMITS.sections).default([]),
    collapsed: z.array(zGroupKey).max(LIMITS.collapsed).default([]),
    notify: z
      .record(zConversationId, z.enum(NOTIFY_LEVELS))
      .default({})
      .refine((m) => Object.keys(m).length <= LIMITS.notify, { message: `At most ${LIMITS.notify} notification settings` }),
    /**
     * Saved messages. Optional on the wire: a client that doesn't know the field (an older app, the web app) leaves it
     * out, and the stored list is kept (routes.ts) instead of being emptied.
     */
    saved: z.array(zSavedItem).max(LIMITS.saved).optional(),
    /** Community documents only. Optional on the wire like [saved]: left out, the stored settings are kept. */
    community: zCommunityNotify.optional(),
    /** Personal document only: the person's communities in rail order (B2, NAV-11). Left out, the stored order is kept. */
    railOrder: z.array(zOrgId).max(LIMITS.railOrder).optional(),
    /**
     * API 0.50.0, personal document only: folders of communities on the rail (an id, a name, a colour, its communities
     * in order). Where a folder sits is where its first community sits in [railOrder]. Left out, the stored ones are kept.
     */
    railFolders: z.array(zRailFolder).max(LIMITS.railFolders).optional(),
    /**
     * Batch B3: mutes that end by themselves, conversation id → epoch ms (any document; DMs in the personal one). Until
     * then the conversation behaves as "none". Ended ones are dropped. Left out, the stored ones are kept.
     */
    mutedUntil: z
      .record(zConversationId, z.number().int().min(0))
      .refine((m) => Object.keys(m).length <= LIMITS.mutedUntil, { message: `At most ${LIMITS.mutedUntil} timed mutes` })
      .optional(),
    /** Batch B3, community documents only: a category's own level, which its channels follow unless they have one. */
    categoryNotify: z
      .record(zCategoryId, z.enum(NOTIFY_LEVELS))
      .refine((m) => Object.keys(m).length <= LIMITS.categories, { message: `At most ${LIMITS.categories} category settings` })
      .optional(),
    /** Batch B3, community documents only: channels hidden from the person's channel list (they stay joined). */
    hidden: z.array(zConversationId).max(LIMITS.hidden).optional(),
  })
  .strict();

export type NavSection = z.infer<typeof zSection>;
export type SavedItem = z.infer<typeof zSavedItem>;
export type CommunityNotify = z.infer<typeof zCommunityNotify>;
export type NavPrefs = z.infer<typeof zNavPrefs>;

export const EMPTY_PREFS: NavPrefs = { starred: [], sections: [], collapsed: [], notify: {}, saved: [] };

/** A stored document: the preferences plus the revision every write must name (optimistic concurrency). */
export interface StoredPrefs {
  userId: string;
  workspaceId: string;
  prefs: NavPrefs;
  rev: number;
  updatedAt: number;
}

/**
 * The canonical form of a document: each conversation listed once across Starred and every section (the first place
 * wins), section ids unique, duplicate group keys dropped, and "all" left out of [notify] when the community's own
 * level is "all" too (otherwise "all" is a real override of a quieter community default). [keep]
 * says which conversation ids may stay (the person's own conversations); the rest are dropped rather than refused, so a
 * conversation left on another device never makes a write fail.
 */
export function normalizePrefs(
  p: NavPrefs,
  keep: (conversationId: string) => boolean,
  /** The level a channel would follow without its own (its category's, else the community's). */
  parentLevel: (conversationId: string) => NotifyLevel = () => p.community?.level ?? "all",
  at: number = Date.now(),
): NavPrefs {
  const seen = new Set<string>();
  const take = (ids: readonly string[]): string[] =>
    ids.filter((id) => {
      if (seen.has(id) || !keep(id)) return false;
      seen.add(id);
      return true;
    });
  const starred = take(p.starred);
  const sectionIds = new Set<string>();
  const sections = p.sections
    .filter((s) => !sectionIds.has(s.id) && (sectionIds.add(s.id), true))
    .map((s) => ({ ...s, items: take(s.items) }));
  const notify = Object.fromEntries(
    Object.entries(p.notify)
      .filter(([id, level]) => (level !== "all" || parentLevel(id) !== "all") && keep(id))
      .sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, NotifyLevel>;
  const savedIds = new Set<string>();
  const saved = (p.saved ?? []).filter((item) => keep(item.conversationId) && !savedIds.has(item.messageId) && (savedIds.add(item.messageId), true));
  return {
    starred,
    sections,
    collapsed: [...new Set(p.collapsed)],
    notify,
    saved,
    ...(p.community ? { community: liveCommunity(p.community, at) } : {}),
    ...(p.railOrder ? { railOrder: [...new Set(p.railOrder)] } : {}),
    ...(p.railFolders ? { railFolders: normalizeFolders(p.railFolders) } : {}),
    ...(p.mutedUntil ? { mutedUntil: Object.fromEntries(Object.entries(p.mutedUntil).filter(([id, until]) => until > at && keep(id))) } : {}),
    ...(p.categoryNotify ? { categoryNotify: p.categoryNotify } : {}),
    ...(p.hidden ? { hidden: [...new Set(p.hidden)] } : {}),
  };
}

/** Each community in at most one folder (the first wins); folders left empty are dropped; colours in lower case. */
function normalizeFolders(folders: z.infer<typeof zRailFolder>[]): z.infer<typeof zRailFolder>[] {
  const placed = new Set<string>();
  const ids = new Set<string>();
  return folders.flatMap((f) => {
    if (ids.has(f.id)) return [];
    ids.add(f.id);
    const orgIds = f.orgIds.filter((id) => !placed.has(id) && (placed.add(id), true));
    return orgIds.length ? [{ ...f, color: f.color ? f.color.toLowerCase() : null, orgIds }] : [];
  });
}

/** Every conversation id a document mentions. */
export function referencedConversations(p: NavPrefs): string[] {
  return [...new Set([...p.starred, ...p.sections.flatMap((s) => s.items), ...Object.keys(p.notify), ...(p.saved ?? []).map((s) => s.conversationId)])];
}

/** A community's settings without a mute that has ended. */
function liveCommunity(c: z.infer<typeof zCommunityNotify>, at: number): z.infer<typeof zCommunityNotify> {
  const { mutedUntil, ...rest } = c;
  return mutedUntil && mutedUntil > at ? { ...rest, mutedUntil } : rest;
}
