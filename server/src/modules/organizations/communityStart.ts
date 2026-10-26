import type { ConversationRow } from "./authz.js";
import type { AppContext } from "../../app/context.js";
import { notifyConversation } from "./orgsRoutes.js";
import { newId, now } from "../../shared/utilities/util.js";

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
export function insertCategory(ctx: AppContext, orgId: string, actorId: string, name: string, position: number, t = now()): string {
  const id = newId("cat");
  ctx.db.prepare("INSERT INTO channel_categories (id, org_id, name, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, orgId, name, position, actorId, t, t);
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
 * a private one starts with [actorId] only. Call inside a transaction; the caller notifies.
 */
export function insertChannel(ctx: AppContext, orgId: string, actorId: string, ch: NewChannel, t = now()): string {
  const { db, authz } = ctx;
  const id = newId("c");
  const autoJoin = ch.kind !== "PRIVATE";
  db.prepare(
    `INSERT INTO conversations (id, type, org_id, scope, scope_id, kind, name, topic, auto_join, created_by, created_at, updated_at, voice, category_id, position, format)
     VALUES (?, 'CHANNEL', ?, 'ORG', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, orgId, ch.kind, ch.name, ch.topic, autoJoin ? 1 : 0, actorId, t, t, ch.voice ? 1 : 0, ch.categoryId, ch.position, ch.format);
  db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'ADMIN', ?)").run(id, actorId, t);
  if (autoJoin) {
    const conv = authz.conversation(id) as ConversationRow;
    for (const r of db.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND user_id != ?").all(orgId, actorId) as { user_id: string }[]) {
      if (authz.scopeEligible(conv, r.user_id)) db.prepare("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)").run(id, r.user_id, t);
    }
  }
  return id;
}

/** Channels in a community and in one category, for the limits (CHANNEL_LIMITS). */
export function channelCounts(ctx: AppContext, orgId: string, categoryId: string | null): { total: number; inCategory: number } {
  const total = (ctx.db.prepare("SELECT COUNT(*) n FROM conversations WHERE org_id = ? AND type = 'CHANNEL'").get(orgId) as { n: number }).n;
  const inCategory = categoryId ? (ctx.db.prepare("SELECT COUNT(*) n FROM conversations WHERE category_id = ?").get(categoryId) as { n: number }).n : 0;
  return { total, inCategory };
}

/** Creates [template]'s categories and channels for a community [ownerId] just made. Returns the channel ids. */
export function createCommunityStart(ctx: AppContext, orgId: string, ownerId: string, template: TemplateId = "starter"): string[] {
  const created: string[] = [];
  const t = now();
  ctx.db.transaction(() => {
    COMMUNITY_TEMPLATES[template].forEach((group, g) => {
      const categoryId = insertCategory(ctx, orgId, ownerId, group.category, g, t);
      group.channels.forEach((ch, i) => {
        created.push(
          insertChannel(ctx, orgId, ownerId, { name: ch.name, topic: ch.topic, kind: ch.kind, voice: !!ch.voice, format: ch.format ?? "text", categoryId, position: i }, t),
        );
      });
    });
  })();
  for (const id of created) notifyConversation(ctx, id);
  ctx.audit({ actorId: ownerId, orgId, action: "community.start", detail: `${template}: ${created.length} channels` });
  return created;
}
