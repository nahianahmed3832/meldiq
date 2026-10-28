import { endNewAccountLimits, hasNewAccountLimits } from "../../app/middleware/abuse.js";
import type { AppContext } from "../../app/context.js";
import type { RowReader, Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { type Authz, parsePermissionList } from "./authz.js";
import { roleAssignmentRefusal } from "./permissions/rules.js";
import { ApiError } from "../../shared/errors.js";
import { humanCode, newId, normalizeCode, now, sha256Hex } from "../../shared/utilities/util.js";
import { requireSyntheticScopeForOrg } from "./syntheticScope.js";

export interface OrgInviteRow {
  id: string;
  org_id: string;
  role: "ADMIN" | "MEMBER" | "GUEST";
  /** Kept from before communities; [grant_role_id] carries what a branch or team invitation now grants. */
  branch_id: string | null;
  team_id: string | null;
  /** A custom role the invitation hands out on joining (migration 032), or null. */
  grant_role_id?: string | null;
  max_uses: number;
  uses: number;
  expires_at: number;
  revoked_at: number | null;
  created_by: string;
}

export interface RegistrationInviteRow {
  id: string;
  code_hint: string;
  note: string | null;
  max_uses: number;
  uses: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const usable = (r: { revoked_at: number | null; expires_at: number; uses: number; max_uses: number } | undefined) =>
  !!r && !r.revoked_at && r.expires_at > now() && r.uses < r.max_uses;

/** Why an org invitation code can't be used, as the API reports it (status 404 for all of them, code tells which). */
export type InviteProblem = "invite_not_found" | "invite_revoked" | "invite_expired" | "invite_used_up" | "invite_unavailable";

export const INVITE_PROBLEMS: Record<InviteProblem, string> = {
  invite_not_found: "This invite code doesn't exist. Check the code with the person who sent it.",
  invite_revoked: "This invite was cancelled by the person who created it. Ask them for a new one.",
  invite_expired: "This invite has expired. Ask for a new one.",
  invite_used_up: "This invite has already been used as many times as it allows. Ask for a new one.",
  invite_unavailable: "This invite can no longer be used: whoever created it can't invite people there any more. Ask for a new one.",
};

/** The org invitation stored for this code (usable or not), or undefined if no invitation has that code. */
export function lookupOrgInvite(rows: RowReader, code: string): OrgInviteRow | undefined {
  return rows.get<OrgInviteRow>("invitations", { code_hash: sha256Hex(normalizeCode(code)) });
}

/**
 * Checks an org invitation: usable means not revoked, expired or used up, and its creator may still issue it (T3.1):
 * an invite made by someone who has since been demoted or removed stops working.
 */
export function orgInviteProblem(authz: Authz, inv: OrgInviteRow | undefined): InviteProblem | null {
  if (!inv) return "invite_not_found";
  if (inv.revoked_at) return "invite_revoked";
  if (inv.expires_at <= now()) return "invite_expired";
  if (inv.uses >= inv.max_uses) return "invite_used_up";
  if (!authz.canIssueInvite(inv.org_id, inv.created_by, inv.role)) return "invite_unavailable";
  if (inv.grant_role_id && !creatorMayStillGrant(authz, inv)) return "invite_unavailable";
  return null;
}

/**
 * A role carrying powers or restrictions is handed out only while the invitation's creator could still assign it by
 * hand. A role with neither (one a branch or team became: it only decides who sees a category) is given as the old
 * branch or team invitation would have added the person.
 */
function creatorMayStillGrant(authz: Authz, inv: OrgInviteRow): boolean {
  const role = authz.roleGrant(inv.grant_role_id!, inv.org_id);
  if (!role) return true; // archived or deleted: nothing is granted (joinOrgByInvite checks again)
  if (role.permissions.length === 0 && role.denies.length === 0) return true;
  const actor = authz.actor(inv.org_id, inv.created_by);
  return !!actor && roleAssignmentRefusal(actor, { base: "MEMBER", perms: new Set(), self: false }, role) === null;
}

/** A usable org invitation for this code, or undefined (see [orgInviteProblem] for why not). */
export function findOrgInvite(rows: RowReader, authz: Authz, code: string): OrgInviteRow | undefined {
  const inv = lookupOrgInvite(rows, code);
  return orgInviteProblem(authz, inv) ? undefined : inv;
}

/**
 * Whether accepting [inv] would change nothing for [userId]: they're already in its community with at least its role
 * and already hold the role it grants. Accepting it again then succeeds without using up the invite, so a retry or a
 * double tap never consumes a second use or fails with "used up".
 */
export function inviteAlreadySatisfied(authz: Authz, rows: RowReader, inv: OrgInviteRow, userId: string): boolean {
  const existing = authz.orgRole(inv.org_id, userId);
  if (!existing) return false;
  const rank: Record<string, number> = { GUEST: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
  if (rank[inv.role] > rank[existing]) return false;
  if (existing === "GUEST") return true; // guests don't receive an invitation's role
  if (inv.grant_role_id && !rows.get("org_role_members", { role_id: inv.grant_role_id, user_id: userId })) return false;
  return true;
}

/** A usable registration invite for this code. */
export function findRegistrationInvite(identity: RowReader, code: string): RegistrationInviteRow | undefined {
  // Load-test invites (purpose 'loadtest') only work on the load-test path (modules/accounts/loadtest.ts).
  const inv = identity.get<RegistrationInviteRow>("registration_invites", { code_hash: sha256Hex(normalizeCode(code)), purpose: "registration" });
  return usable(inv) ? inv : undefined;
}

/** Takes one use of a registration invite inside the identity unit [w]; false when it can no longer be used. */
export function consumeRegistrationInvite(w: RowWriter, inviteId: string): boolean {
  const inv = w.get<RegistrationInviteRow>("registration_invites", { id: inviteId });
  if (!inv || !usable(inv)) return false;
  w.update("registration_invites", { id: inviteId }, { uses: inv.uses + 1 });
  return true;
}

/**
 * Operator-only: creates a registration invite and returns its code, which is never stored.
 * Called from the admin CLI and tests; no HTTP route exposes it.
 */
export async function createRegistrationInvite(identity: Rows, opts: { maxUses: number; days: number; note?: string | null }): Promise<{ id: string; code: string }> {
  if (!Number.isInteger(opts.maxUses) || opts.maxUses < 1 || opts.maxUses > 1000) throw new Error("uses must be 1–1000");
  if (!(opts.days > 0 && opts.days <= 30)) throw new Error("days must be more than 0 and at most 30");
  const code = humanCode(12);
  const id = newId("rinv");
  const t = now();
  await identity.write((w) =>
    w.insert("registration_invites", {
      id,
      code_hash: sha256Hex(code),
      code_hint: code.slice(-4),
      note: opts.note ?? null,
      max_uses: opts.maxUses,
      created_at: t,
      expires_at: t + Math.round(opts.days * 86_400_000),
    }),
  );
  return { id, code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` };
}

/**
 * Joins `userId` to the invite's community (upgrade only: an invite never downgrades a member), gives them the role
 * the invite grants, consumes one use and auto-joins the public channels they may now see. Banned people are refused.
 * [consume] false: the use was already taken (an Orbit 2.0 sign-up reserves it, src/accounts/service.ts).
 * Part of the caller's write unit [w].
 */
export function joinOrgByInvite(ctx: AppContext, w: RowWriter, inv: OrgInviteRow, userId: string, t: number, consume = true): { orgId: string; inviteId: string; role: string } {
  const { authz } = ctx;
  const existing = authz.orgRole(inv.org_id, userId);
  const rank: Record<string, number> = { GUEST: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
  if (authz.isBanned(inv.org_id, userId)) throw new ApiError(403, "banned", "You've been banned from this community");
  requireSyntheticScopeForOrg(ctx, userId, inv.org_id);
  if (!existing) {
    // Batch B4: a community can pause joining for a while (Security actions).
    if (authz.pausedUntil(inv.org_id, "invites", t)) throw new ApiError(403, "invites_paused", "This community has paused new members for now. Try again later.");
    // Round 7: the workspace's member limit, if one applies (docs/USAGE_AND_PLANS.md).
    ctx.entitlements.check("members", w.count("org_members", { org_id: inv.org_id }), inv.org_id);
    // A guest invitation can carry an end date for the membership (round 7, docs/WORKSPACE_C5.md).
    const guestDays = inv.role === "GUEST" ? (inv as { guest_days?: number | null }).guest_days ?? null : null;
    w.insert("org_members", { org_id: inv.org_id, user_id: userId, role: inv.role, joined_at: t, expires_at: guestDays ? t + guestDays * 86_400_000 : null });
  } else if (rank[inv.role] > rank[existing]) {
    w.update("org_members", { org_id: inv.org_id, user_id: userId }, { role: inv.role });
  }
  const role = authz.orgRole(inv.org_id, userId)!;
  // The granted role, if it still exists (archived roles grant nothing). Guests don't get it: it may carry powers or
  // channel access a guest may not hold.
  if (role !== "GUEST" && inv.grant_role_id && w.get("org_roles", { id: inv.grant_role_id, org_id: inv.org_id, archived_at: null })) {
    w.insert("org_role_members", { role_id: inv.grant_role_id, org_id: inv.org_id, user_id: userId, assigned_by: inv.created_by, assigned_at: t }, { orIgnore: true });
  }
  if (consume) consumeInviteUse(w, inv.id);
  // An invitation from an established member ends new-account limits (docs/ABUSE_CONTROLS.md). One from an account
  // still under them doesn't, so nobody can vouch for their own extra accounts.
  // The identity rows' own unit (in SQLite it joins the caller's transaction); losing it only leaves the limits on.
  if (!hasNewAccountLimits(ctx.identity, inv.created_by, t)) {
    void endNewAccountLimits(ctx.identity, userId).catch((e) => ctx.log.error({ err: e }, "new-account limits not ended"));
  }
  authz.autoJoinScope(w, inv.org_id, userId, t);
  return { orgId: inv.org_id, inviteId: inv.id, role };
}

/** One more use of an invitation (inside a write unit: read and written in the same serialized step). */
export function consumeInviteUse(w: RowWriter, inviteId: string): void {
  const inv = w.get<{ uses: number }>("invitations", { id: inviteId });
  if (inv) w.update("invitations", { id: inviteId }, { uses: inv.uses + 1 });
}

/** Gives back a use [consumeInviteUse] took (never below zero). */
export function returnInviteUse(w: RowWriter, inviteId: string): void {
  const inv = w.get<{ uses: number }>("invitations", { id: inviteId });
  if (inv && inv.uses > 0) w.update("invitations", { id: inviteId }, { uses: inv.uses - 1 });
}
