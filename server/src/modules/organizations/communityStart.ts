import type { ConversationRow } from "./authz.js";
import type { AppContext } from "../../app/context.js";
import { notifyConversation } from "./orgsRoutes.js";
import { newId, now } from "../../shared/utilities/util.js";
import type { RowReader, RowWriter } from "../../infrastructure/database/rows/index.js";

/**
 * The channels a new community starts with, so the first person who joins finds somewhere to go. Each starter
 * template (batch B2, Discord reference CREATE-CTRL-001) is a set of categories and channels; "starter" is the set every
 * community got before templates: a welcome and an announcements channel, general chat, introductions and a voice
 * channel. Added once, by POST /v1/orgs; nothing is added to an existing community.
 */
interface ChannelSpec {
  name: string;
  topic: string;
  kind: "PUBLIC" | "ANNOUNCEMENT";
  voice?: boolean;
  format?: "text" | "forum";
}

interface CategorySpec {
  category: string;
  channels: readonly ChannelSpec[];
}

export const TEMPLATE_IDS = ["starter", "friends", "gaming", "study", "club"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

const welcome: ChannelSpec = { name: "welcome", topic: "What this community is about and how it works", kind: "ANNOUNCEMENT" };
const announcements: ChannelSpec = { name: "announcements", topic: "News from the people who run the community", kind: "ANNOUNCEMENT" };
const general: ChannelSpec = { name: "general", topic: "Everyday conversation", kind: "PUBLIC" };

export const COMMUNITY_TEMPLATES: Readonly<Record<TemplateId, readonly CategorySpec[]>> = {
  starter: [
    { category: "Start here", channels: [welcome, announcements] },
    {
      category: "Talk",
      channels: [
        general,
        { name: "introductions", topic: "Say hello and tell people what brings you here", kind: "PUBLIC" },
        { name: "lounge", topic: "Drop in to talk", kind: "PUBLIC", voice: true },
      ],
    },
  ],
  friends: [
    {
      category: "Hang out",
      channels: [
        general,
        { name: "photos", topic: "Pictures and videos to share", kind: "PUBLIC" },
        { name: "plans", topic: "What we're doing and when", kind: "PUBLIC" },
      ],
    },
    { category: "Voice", channels: [{ name: "hangout", topic: "Drop in to talk", kind: "PUBLIC", voice: true }] },
  ],
  gaming: [
    { category: "Start here", channels: [welcome, announcements] },
    {
      category: "Play",
      channels: [
        general,
        { name: "looking-for-group", topic: "Find people to play with", kind: "PUBLIC" },
        { name: "clips", topic: "Highlights, screenshots and clips", kind: "PUBLIC", format: "forum" },
      ],
    },
    {
      category: "Voice",
      channels: [
        { name: "lobby", topic: "Hang out between games", kind: "PUBLIC", voice: true },
        { name: "squad", topic: "Play together", kind: "PUBLIC", voice: true },
      ],
    },
  ],
  study: [
    { category: "Start here", channels: [welcome, announcements] },
    {
      category: "Study",
      channels: [
        general,
        { name: "homework-help", topic: "Ask a question, help someone out", kind: "PUBLIC" },
        { name: "resources", topic: "Notes, links and guides worth keeping", kind: "PUBLIC", format: "forum" },
        { name: "study-room", topic: "Study together", kind: "PUBLIC", voice: true },
      ],
    },
  ],
  club: [
    { category: "Start here", channels: [welcome, announcements] },
    {
      category: "Club",
      channels: [
        general,
        { name: "introductions", topic: "Say hello and tell people what brings you here", kind: "PUBLIC" },
        { name: "ideas", topic: "Suggestions and plans for the club", kind: "PUBLIC", format: "forum" },
        { name: "meeting-room", topic: "Meetings and calls", kind: "PUBLIC", voice: true },
      ],
    },
  ],
};

/** Kept for code that reads the original set directly. */
export const COMMUNITY_START = COMMUNITY_TEMPLATES.starter;

/** The templates as GET /v1/community-templates lists them. */
export function templateList(): { id: TemplateId; categories: { name: string; channels: { name: string; voice: boolean; format: string; kind: string }[] }[] }[] {
  return TEMPLATE_IDS.map((id) => ({
    id,
    categories: COMMUNITY_TEMPLATES[id].map((g) => ({
      name: g.category,
      channels: g.channels.map((ch) => ({ name: ch.name, voice: !!ch.voice, format: ch.format ?? "text", kind: ch.kind })),
    })),
  }));
}

/** A category at [position] (no notification: the caller notifies once it's done). */
export function insertCategory(w: RowWriter, orgId: string, actorId: string, name: string, position: number, t = now()): string {
  const id = newId("cat");
  w.insert("channel_categories", { id, org_id: orgId, name, position, created_by: actorId, created_at: t, updated_at: t });
  return id;
}

export interface NewChannel {
  name: string;
  topic: string | null;
  kind: "PUBLIC" | "PRIVATE" | "ANNOUNCEMENT";
  voice: boolean;
  format: "text" | "forum";
  categoryId: string | null;
  position: number;
}

/**
 * A channel made by [actorId] (its admin). Public and announcement channels are joined by every member who may see them;
 * a private one starts with [actorId] only. Call inside a write unit; the caller notifies.
 */
export function insertChannel(ctx: Pick<AppContext, "authz">, w: RowWriter, orgId: string, actorId: string, ch: NewChannel, t = now()): string {
  const id = newId("c");
  const autoJoin = ch.kind !== "PRIVATE";
  w.insert("conversations", {
    id,
    type: "CHANNEL",
    org_id: orgId,
    scope: "ORG",
    scope_id: null,
    kind: ch.kind,
    name: ch.name,
    topic: ch.topic,
    auto_join: autoJoin ? 1 : 0,
    created_by: actorId,
    created_at: t,
    updated_at: t,
    voice: ch.voice ? 1 : 0,
    category_id: ch.categoryId,
    position: ch.position,
    format: ch.format,
  });
  w.insert("conversation_members", { conversation_id: id, user_id: actorId, role: "ADMIN", joined_at: t });
  if (autoJoin) {
    const conv = w.get<ConversationRow>("conversations", { id })!;
    for (const r of w.all<{ user_id: string }>("org_members", { where: { org_id: orgId, user_id: { ne: actorId } } })) {
      if (ctx.authz.scopeEligible(conv, r.user_id)) w.insert("conversation_members", { conversation_id: id, user_id: r.user_id, role: "MEMBER", joined_at: t }, { orIgnore: true });
    }
  }
  return id;
}

/** Channels in a community and in one category, for the limits (CHANNEL_LIMITS). */
export function channelCounts(rows: RowReader, orgId: string, categoryId: string | null): { total: number; inCategory: number } {
  const total = rows.count("conversations", { org_id: orgId, type: "CHANNEL" });
  const inCategory = categoryId ? rows.count("conversations", { category_id: categoryId }) : 0;
  return { total, inCategory };
}

/** Creates [template]'s categories and channels for a community [ownerId] just made. Returns the channel ids. */
export async function createCommunityStart(ctx: AppContext, orgId: string, ownerId: string, template: TemplateId = "starter"): Promise<string[]> {
  const t = now();
  const created = await ctx.ws.write((w) =>
    COMMUNITY_TEMPLATES[template].flatMap((group, g) => {
      const categoryId = insertCategory(w, orgId, ownerId, group.category, g, t);
      return group.channels.map((ch, i) =>
        insertChannel(ctx, w, orgId, ownerId, { name: ch.name, topic: ch.topic, kind: ch.kind, voice: !!ch.voice, format: ch.format ?? "text", categoryId, position: i }, t),
      );
    }),
  );
  for (const id of created) notifyConversation(ctx, id);
  ctx.audit({ actorId: ownerId, orgId, action: "community.start", detail: `${template}: ${created.length} channels` });
  return created;
}
