import type { AppContext } from "../../../app/context.js";
import { NICKNAME_MAX } from "../../../shared/contracts/http/communityPermissions.js";
import { ApiError, badRequest, notFound } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { canActOn } from "../permissions/rules.js";
import { notifyOrg } from "../orgsRoutes.js";

/**
 * Per-community nicknames (community parity A1, docs/COMMUNITY_PERMISSIONS.md): shown in that community instead of the
 * display name. People change their own with `members.nickname`, others' with `members.nicknames` (only people they
 * may act on). Empty clears it. A nickname goes when its member leaves (foreign key on the membership).
 */

/** Control and direction-changing characters, which could disguise a name. */
const HIDDEN = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/;

/** Characters as people count them (an emoji with its skin tone is one). */
const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;

/** The nickname to store, or null to clear it. */
export function cleanNickname(raw: string | null): string | null {
  const nick = (raw ?? "").trim();
  if (!nick) return null;
  if (HIDDEN.test(nick)) throw badRequest("Nicknames can't contain control or invisible characters");
  if (graphemes(nick) > NICKNAME_MAX) throw badRequest(`Nicknames can be up to ${NICKNAME_MAX} characters`);
  return nick;
}

export async function setNickname(ctx: AppContext, orgId: string, actorId: string, targetId: string, raw: string | null) {
  const { authz, ws } = ctx;
  authz.requireOrgMember(orgId, actorId);
  const actor = authz.actor(orgId, actorId)!;
  const target = authz.actor(orgId, targetId);
  if (!target) throw notFound("Member not found");
  const self = actorId === targetId;
  if (self && !actor.perms.has("members.nickname") && !actor.perms.has("members.nicknames")) {
    throw new ApiError(403, "nickname_not_allowed", "Your role doesn't include changing your nickname here");
  }
  if (!self && (!actor.perms.has("members.nicknames") || !canActOn(actor, { base: target.base, perms: target.perms, self }))) {
    throw new ApiError(403, "nicknames_not_allowed", "You can't change this person's nickname");
  }
  const nickname = cleanNickname(raw);
  await ws.write((w) => {
    if (nickname === null) w.delete("org_nicknames", { org_id: orgId, user_id: targetId });
    else {
      const row = { org_id: orgId, user_id: targetId, nickname, updated_by: actorId, updated_at: now() };
      w.upsert("org_nicknames", row, { nickname, updated_by: actorId, updated_at: row.updated_at });
    }
  });
  ctx.audit({ actorId, orgId, action: "member.nickname", target: targetId, detail: nickname ?? "(cleared)" });
  notifyOrg(ctx, orgId);
  return { userId: targetId, nickname };
}
