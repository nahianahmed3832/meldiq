import type { FastifyInstance } from "fastify";
import { PERSONAL_WORKSPACE_ID } from "../workspaces.js";
import { type AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { parse } from "../../../shared/validation/index.js";
import { ApiError } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { PreferencesBody, WorkspaceParams } from "../../../shared/contracts/http/preferences.js";
import { EMPTY_PREFS, type NavPrefs, normalizePrefs, type StoredPrefs } from "./schema.js";

function view(workspaceId: string, s: StoredPrefs | null) {
  return { workspaceId, rev: s?.rev ?? 0, updatedAt: s?.updatedAt ?? null, prefs: s?.prefs ?? EMPTY_PREFS };
}

/**
 * Personal navigation preferences (docs/WORKSPACE_ADMINISTRATION.md › Personal sections): starred conversations, custom
 * sections, collapsed groups, notification levels and saved messages, kept on the server so every device of the person shows the same
 * Home. Only the person themselves can read or write theirs.
 */
export default async function preferenceRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };

  /** "personal", or an organisation the person belongs to. Same 404 for one that doesn't exist and one they aren't in. */
  const requireWorkspace = (workspaceId: string, userId: string) => {
    if (workspaceId === PERSONAL_WORKSPACE_ID) return;
    if (!ctx.authz.orgRole(workspaceId, userId)) throw new ApiError(404, "workspace_not_found", "Workspace not found");
  };

  app.get("/v1/me/preferences/:workspaceId", auth, async (req) => {
    const { userId } = me(req);
    const { workspaceId } = parse(WorkspaceParams, req.params);
    requireWorkspace(workspaceId, userId);
    return view(workspaceId, await ctx.prefs.get(userId, workspaceId));
  });

  app.put("/v1/me/preferences/:workspaceId", { ...auth, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const { userId, deviceId } = me(req);
    const { workspaceId } = parse(WorkspaceParams, req.params);
    const body = parse(PreferencesBody, req.body);
    requireWorkspace(workspaceId, userId);
    // Only the person's own conversations can be arranged; anything else (left meanwhile, never joined) is dropped.
    const mine = new Set(
      (ctx.db.prepare("SELECT conversation_id FROM conversation_members WHERE user_id = ?").all(userId) as { conversation_id: string }[]).map(
        (r) => r.conversation_id,
      ),
    );
    // A client that doesn't know saved messages leaves the field out: keep the stored list. If the document changed
    // since that copy was read, the revision check below refuses the write, so nothing stale is kept.
    const stored = (await ctx.prefs.get(userId, workspaceId))?.prefs;
    const saved = body.prefs.saved ?? stored?.saved ?? [];
    // The same for a community's own notification settings and the rail order (batch B2). Each lives in one kind of
    // document only: community settings in a community's, the rail order in the personal one.
    const personal = workspaceId === PERSONAL_WORKSPACE_ID;
    // A client that doesn't know the community mute (API 0.46.0) leaves it out of its copy: the stored one stays.
    const sentCommunity = body.prefs.community;
    const community = personal
      ? undefined
      : sentCommunity
        ? { ...sentCommunity, mutedUntil: sentCommunity.mutedUntil !== undefined ? sentCommunity.mutedUntil : stored?.community?.mutedUntil }
        : stored?.community;
    const myOrgs = new Set((ctx.db.prepare("SELECT org_id FROM org_members WHERE user_id = ?").all(userId) as { org_id: string }[]).map((r) => r.org_id));
    const railOrder = personal ? (body.prefs.railOrder ?? stored?.railOrder)?.filter((id) => myOrgs.has(id)) : undefined;
    // API 0.50.0: rail folders hold only communities the person is in; a folder left with none is dropped.
    const railFolders = personal
      ? (body.prefs.railFolders ?? stored?.railFolders)?.map((f) => ({ ...f, orgIds: f.orgIds.filter((id) => myOrgs.has(id)) })).filter((f) => f.orgIds.length > 0)
      : undefined;
    // Batch B3: timed mutes (any document), and a community's category levels and hidden channels (its document only):
    // only its own categories, and only its channels the person can see (joined or not).
    const mutedUntil = body.prefs.mutedUntil ?? stored?.mutedUntil;
    const categories = new Set<string>();
    let categoryNotify: NavPrefs["categoryNotify"];
    let hidden: string[] | undefined;
    const channelCategory = new Map<string, string | null>();
    if (!personal) {
      for (const r of ctx.db.prepare("SELECT id FROM channel_categories WHERE org_id = ?").all(workspaceId) as { id: string }[]) categories.add(r.id);
      for (const r of ctx.db.prepare("SELECT id, category_id FROM conversations WHERE org_id = ? AND type = 'CHANNEL'").all(workspaceId) as { id: string; category_id: string | null }[]) {
        channelCategory.set(r.id, r.category_id);
      }
      const cats = body.prefs.categoryNotify ?? stored?.categoryNotify;
      categoryNotify = cats ? (Object.fromEntries(Object.entries(cats).filter(([id]) => categories.has(id))) as NavPrefs["categoryNotify"]) : undefined;
      hidden = (body.prefs.hidden ?? stored?.hidden)?.filter((id) => {
        if (!channelCategory.has(id)) return false;
        const conv = ctx.authz.conversation(id);
        return !!conv && ctx.authz.canViewChannel(conv, userId);
      });
    }
    const communityLevel = community?.level ?? "all";
    const parentLevel = (id: string) => {
      const cat = channelCategory.get(id);
      return (cat && categoryNotify?.[cat]) || communityLevel;
    };
    const prefs = normalizePrefs({ ...body.prefs, saved, community, railOrder, railFolders, mutedUntil, categoryNotify, hidden }, (id) => mine.has(id), parentLevel);
    const result = await ctx.prefs.put(userId, workspaceId, prefs, body.baseRev, now());
    if (!result.ok) {
      throw new ApiError(409, "stale_preferences", "These preferences changed on another device. Apply your change to this copy and try again.", {
        current: view(workspaceId, result.current),
      });
    }
    // The person's other devices fetch the new copy (no content in the frame).
    ctx.hub.sendToUser(userId, { t: "prefs.updated", workspaceId, rev: result.doc.rev }, deviceId);
    return view(workspaceId, result.doc);
  });
}
