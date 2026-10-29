import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { LobbyLiveRoom, LobbyPickRoles, LobbyStaff } from "../../../shared/contracts/http/communityLobbyView.js";
import { personCards } from "../../accounts/index.js";
import { type ConversationRow } from "../authz.js";
import { isPermission, type Permission } from "../permissions/catalog.js";

/**
 * What the lobby shows from the rest of the community (community parity B): who runs it, voice rooms with people in
 * them, the rules channel, links and the onboarding questions that give roles. Each reads what the viewer may see.
 */

type Staff = z.infer<typeof LobbyStaff>;
type LiveRoom = z.infer<typeof LobbyLiveRoom>;
type PickRoles = z.infer<typeof LobbyPickRoles>;

/** People listed under "Who runs it", at most. */
const STAFF_MAX = 25;
/** People shown in each live room, at most (the count says how many there are). */
const ROOM_FACES = 8;

/**
 * Moderating: banning or timing people out, and managing messages once that key exists (community parity A adds
 * it; until then the filter keeps the list to keys this server knows).
 */
const MODERATION: readonly Permission[] = ["members.ban", "members.timeout", "messages.manage"].filter(isPermission);
const RUNS_IT: readonly Permission[] = ["workspace.edit", ...MODERATION];

const BADGE_ORDER = { owner: 0, admin: 1, mod: 2 } as const;

/** The badge [userId] wears in [orgId]'s "Who runs it", or null when they neither edit nor moderate it. */
function badgeOf(ctx: AppContext, orgId: string, userId: string, base: string): Staff["badge"] | null {
  if (base === "OWNER") return "owner";
  if (base === "ADMIN" || ctx.authz.can(orgId, userId, "workspace.edit")) return "admin";
  return MODERATION.some((p) => ctx.authz.can(orgId, userId, p)) ? "mod" : null;
}

/**
 * The owner, admins and anyone a custom role lets edit the community or moderate it. Only owners, admins and holders of
 * roles carrying one of those keys are checked, so a big community isn't walked member by member.
 */
export function whoRunsIt(ctx: AppContext, orgId: string): Staff[] {
  const members = ctx.ws.all<{ user_id: string; role: string }>("org_members", { where: { org_id: orgId, role: { in: ["OWNER", "ADMIN", "MEMBER"] } } });
  const roleIds = ctx.ws
    .all<{ id: string; permissions: string }>("org_roles", { where: { org_id: orgId, archived_at: null } })
    .filter((r) => RUNS_IT.some((p) => r.permissions.includes(`"${p}"`)))
    .map((r) => r.id);
  const holders = new Set(roleIds.length ? ctx.ws.all<{ user_id: string }>("org_role_members", { where: { org_id: orgId, role_id: { in: roleIds } } }).map((m) => m.user_id) : []);
  const staff = members
    .filter((m) => m.role !== "MEMBER" || holders.has(m.user_id))
    .flatMap((m) => {
      const badge = badgeOf(ctx, orgId, m.user_id, m.role);
      return badge ? [{ userId: m.user_id, badge }] : [];
    });
  const cards = personCards(ctx, staff.map((s) => s.userId));
  return staff
    .flatMap((s) => {
      const user = cards.get(s.userId);
      return user ? [{ user, badge: s.badge }] : [];
    })
    .sort((a, b) => BADGE_ORDER[a.badge] - BADGE_ORDER[b.badge] || a.user.displayName.localeCompare(b.user.displayName))
    .slice(0, STAFF_MAX);
}

/** Voice channels among [visible] with people in them now, the busiest first. */
export async function liveNow(ctx: AppContext, visible: readonly ConversationRow[]): Promise<LiveRoom[]> {
  const voice = new Map(visible.filter((c) => c.voice === 1).map((c) => [c.id, c]));
  if (voice.size === 0) return [];
  const calls = await ctx.calls.liveIn([...voice.keys()]);
  const rooms = await Promise.all(
    calls.map(async (call) => ({ call, people: [...new Set((await ctx.calls.present(call.id)).map((p) => p.user_id))] })),
  );
  const seen = new Set<string>();
  const live = rooms.filter((r) => r.people.length > 0 && !seen.has(r.call.conversation_id) && seen.add(r.call.conversation_id));
  const cards = personCards(ctx, live.flatMap((r) => r.people.slice(0, ROOM_FACES)));
  return live
    .map((r) => ({
      channelId: r.call.conversation_id,
      name: voice.get(r.call.conversation_id)?.name ?? null,
      callId: r.call.id,
      startedAt: r.call.created_at,
      participantCount: r.people.length,
      participants: r.people.slice(0, ROOM_FACES).flatMap((id) => cards.get(id) ?? []),
    }))
    .sort((a, b) => b.participantCount - a.participantCount || a.startedAt - b.startedAt);
}

/** The rules channel (feature rules-channel) when the viewer can see it. */
export function rulesChannel(ctx: AppContext, orgId: string, viewerId: string): { channelId: string } | null {
  const id = ctx.authz.rulesChannelId(orgId);
  const conv = id ? ctx.authz.conversation(id) : undefined;
  return conv && conv.org_id === orgId && !conv.archived_at && ctx.authz.canViewChannel(conv, viewerId) ? { channelId: conv.id } : null;
}

/** What a community-links module offers (community parity A adds `communitySettings.profile(orgId).links`). */
interface LinksSource {
  profile(orgId: string): { links?: { label: string; url: string }[] };
}

/**
 * The community's links, read through community parity A's settings when this server has them; none otherwise. A
 * small adapter so the lobby works with or without that module.
 */
export function communityLinks(ctx: AppContext, orgId: string): { label: string; url: string }[] {
  const source = (ctx as unknown as { communitySettings?: LinksSource }).communitySettings;
  if (typeof source?.profile !== "function") return [];
  return (source.profile(orgId).links ?? []).map((l) => ({ label: l.label, url: l.url }));
}

interface StoredPrompt {
  id: string;
  title: string;
  single?: boolean;
  options?: { id: string; title: string; emoji?: string | null; roleIds?: string[] }[];
}

/** The onboarding questions (when onboarding is on) with their answers that give roles, and the viewer's answers. */
export function pickRoles(ctx: AppContext, orgId: string, viewerId: string): PickRoles {
  const row = ctx.ws.get<{ enabled: number; prompts: string }>("community_onboarding", { org_id: orgId });
  let prompts: StoredPrompt[] = [];
  try {
    prompts = row?.enabled ? (JSON.parse(row.prompts) as StoredPrompt[]) : [];
  } catch {
    prompts = [];
  }
  const roles = new Map(ctx.ws.all<{ id: string; name: string; color: string | null }>("org_roles", { where: { org_id: orgId, archived_at: null } }).map((r) => [r.id, r]));
  const out = prompts.flatMap((p) => {
    const options = (p.options ?? [])
      .map((o) => ({ id: o.id, title: o.title, emoji: o.emoji ?? null, roles: (o.roleIds ?? []).flatMap((id) => roles.get(id) ?? []).map((r) => ({ id: r.id, name: r.name, color: r.color })) }))
      .filter((o) => o.roles.length > 0);
    return options.length ? [{ id: p.id, title: p.title, single: !!p.single, options }] : [];
  });
  const answer = ctx.ws.get<{ option_ids: string }>("onboarding_answers", { org_id: orgId, user_id: viewerId });
  let answered: string[] = [];
  try {
    answered = answer ? (JSON.parse(answer.option_ids) as string[]) : [];
  } catch {
    answered = [];
  }
  return { prompts: out, answered };
}
