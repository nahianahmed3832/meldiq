import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { StandardInvite } from "../../../shared/contracts/http/communitySettings.js";
import { humanCode, newId, sha256Hex } from "../../../shared/utilities/util.js";
import { NEVER_EXPIRES_AT, NO_USE_LIMIT, type OrgInviteRow, orgInviteProblem } from "../invites.js";

/**
 * A member's standard invite link (community parity A3, docs/COMMUNITY_SETTINGS_API.md): the one the invite dialog
 * shows, a member invitation that never expires and has no use limit. Its code is kept, so the dialog shows the same
 * link each time; once it stops working (revoked, or its maker can no longer invite) the next ask makes a new one.
 */

interface StandardRow {
  invite_id: string;
  code: string;
}

type View = z.infer<typeof StandardInvite>;

const display = (code: string) => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;

function view(code: string, inv: Pick<OrgInviteRow, "id" | "uses"> & { created_at: number }): View {
  return { id: inv.id, code, uses: inv.uses, createdAt: inv.created_at, neverExpires: true, noUseLimit: true };
}

/** [userId]'s standard link for [orgId] (the caller checked they may invite members); made or remade when needed. */
export async function standardInvite(ctx: AppContext, orgId: string, userId: string, t: number): Promise<{ invite: View; created: boolean }> {
  const kept = ctx.ws.get<StandardRow>("community_standard_invites", { org_id: orgId, user_id: userId });
  const inv = kept ? ctx.ws.get<OrgInviteRow & { created_at: number }>("invitations", { id: kept.invite_id }) : undefined;
  if (kept && inv && !orgInviteProblem(ctx.authz, inv)) return { invite: view(kept.code, inv), created: false };
  const code = humanCode(12);
  const id = newId("inv");
  await ctx.ws.write((w) => {
    if (kept) w.update("invitations", { id: kept.invite_id, revoked_at: null }, { revoked_at: t });
    w.insert("invitations", {
      id,
      org_id: orgId,
      code_hash: sha256Hex(code),
      code_hint: code.slice(-4),
      role: "MEMBER",
      max_uses: NO_USE_LIMIT,
      created_by: userId,
      created_at: t,
      expires_at: NEVER_EXPIRES_AT,
    });
    w.upsert("community_standard_invites", { org_id: orgId, user_id: userId, invite_id: id, code: display(code) }, "replace");
  });
  return { invite: view(display(code), { id, uses: 0, created_at: t }), created: true };
}
