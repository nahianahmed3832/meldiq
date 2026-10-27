import { z } from "zod/v4";
import { zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Personal navigation preferences (docs/WORKSPACE_ADMINISTRATION.md › Personal sections): one document per person and
 * workspace ("personal" or a community they belong to), kept on the server so every device shows the same Home. They
 * only arrange what the person can already see. Writes name the revision they're based on (optimistic concurrency).
 * The stored form is validated by src/modules/accounts/preferences/schema.ts, which these limits mirror.
 */

export const NotifyLevel = z.enum(["all", "mentions", "none"]);

export const PREFS_LIMITS = {
  starred: 200,
  sections: 30,
  itemsPerSection: 200,
  collapsed: 200,
  notify: 1000,
  saved: 500,
  railOrder: 200,
  mutedUntil: 1000,
  categories: 200,
  hidden: 500,
} as const;

/** Conversation ids: "c_…" (local) or "cf_…" (federated DMs). */
const zConversationId = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);
/** Home's built-in groups ("dms", "channels", "branch:<id>", "team:<id>", …): a short opaque key chosen by the app. */
const zGroupKey = z.string().min(1).max(80).regex(/^[A-Za-z0-9_:.-]+$/);
const zSectionId = z.string().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/);
/** Community ids as the server assigns them. */
const zOrgId = z.string().min(3).max(64).regex(/^o_[A-Za-z0-9_-]+$/);
const zMessageId = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);
/** Category ids as the server assigns them. */
const zCategoryId = z.string().min(3).max(64).regex(/^cat_[A-Za-z0-9_-]+$/);

/** A community's own notification level, and whether @everyone counts as a mention (community documents only). */
export const CommunityNotify = z.strictObject({
  level: NotifyLevel.default("all"),
  suppressEveryone: z.boolean().default(false),
  /** API 0.46.0: the whole community muted until then (epoch ms), its channels' own levels included; null: not muted. */
  mutedUntil: z.number().int().min(0).nullable().optional(),
});

export const NavSection = z.object({
  id: zSectionId,
  name: z.string().trim().min(1).max(60),
  items: z.array(zConversationId).max(PREFS_LIMITS.itemsPerSection),
  collapsed: z.boolean().default(false),
});

/** A message saved for later: only ids and times, never its content. [done] keeps it listed as finished until removed. */
export const SavedItem = z.strictObject({
  conversationId: zConversationId,
  messageId: zMessageId,
  savedAt: z.number().int().min(0),
  remindAt: z.number().int().min(0).nullable().default(null),
  done: z.boolean().default(false),
});

const prefsFields = {
  starred: z.array(zConversationId).max(PREFS_LIMITS.starred).default([]),
  sections: z.array(NavSection).max(PREFS_LIMITS.sections).default([]),
  collapsed: z.array(zGroupKey).max(PREFS_LIMITS.collapsed).default([]),
  /** Per-conversation notification levels. */
  notify: z
    .record(zConversationId, NotifyLevel)
    .default({})
    .refine((m) => Object.keys(m).length <= PREFS_LIMITS.notify, { message: `At most ${PREFS_LIMITS.notify} notification settings` }),
  /** Saved messages. Left out, the stored list is kept. */
  saved: z.array(SavedItem).max(PREFS_LIMITS.saved).optional(),
  /** Community documents only. Left out, the stored settings are kept. */
  community: CommunityNotify.optional(),
  /** Personal document only: the person's communities in rail order. Left out, the stored order is kept. */
  railOrder: z.array(zOrgId).max(PREFS_LIMITS.railOrder).optional(),
  /** Mutes that end by themselves: conversation id → epoch ms. Left out, the stored ones are kept. */
  mutedUntil: z
    .record(zConversationId, z.number().int().min(0))
    .refine((m) => Object.keys(m).length <= PREFS_LIMITS.mutedUntil, { message: `At most ${PREFS_LIMITS.mutedUntil} timed mutes` })
    .optional(),
  /** Community documents only: a category's own level, which its channels follow unless they have one. */
  categoryNotify: z
    .record(zCategoryId, NotifyLevel)
    .refine((m) => Object.keys(m).length <= PREFS_LIMITS.categories, { message: `At most ${PREFS_LIMITS.categories} category settings` })
    .optional(),
  /** Community documents only: channels hidden from the person's channel list (they stay joined). */
  hidden: z.array(zConversationId).max(PREFS_LIMITS.hidden).optional(),
};

export const NavPrefs = z.strictObject(prefsFields);

export const WorkspaceParams = z.object({ workspaceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });
export const PreferencesBody = z.object({ baseRev: z.number().int().min(0), prefs: NavPrefs });

/** A document as stored: rev 0 and updatedAt null before the first write. */
export const PreferencesView = z.strictObject({
  workspaceId: z.string(),
  rev: z.number().int().nonnegative(),
  updatedAt: zTime.nullable(),
  prefs: z.strictObject({ ...prefsFields, sections: z.array(z.strictObject(NavSection.shape)).max(PREFS_LIMITS.sections) }),
});

export const preferenceRoutes = [
  route({
    method: "GET",
    url: "/v1/me/preferences/:workspaceId",
    tag: "preferences",
    summary: "Your navigation preferences for a workspace (\"personal\" or a community you belong to).",
    auth: true,
    params: WorkspaceParams,
    response: PreferencesView,
    errors: ["workspace_not_found"],
  }),
  route({
    method: "PUT",
    url: "/v1/me/preferences/:workspaceId",
    tag: "preferences",
    summary: "Replace your navigation preferences for a workspace, based on revision baseRev (409 with the current copy if it changed).",
    auth: true,
    params: WorkspaceParams,
    body: PreferencesBody,
    response: PreferencesView,
    errors: ["workspace_not_found", "stale_preferences"],
  }),
];
