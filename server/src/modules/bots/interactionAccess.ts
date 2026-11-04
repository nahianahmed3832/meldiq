import type { AppContext } from "../../app/context.js";
import type { ConversationRow } from "../organizations/index.js";
import { requireStanding } from "../accounts/index.js";
import { ApiError, forbidden } from "../../shared/errors.js";

/** Commands and components are explicit human posts, under the same native community gates. */
export async function admitInteractionActor(
  ctx: AppContext,
  userId: string,
  conv: ConversationRow,
) {
  requireStanding(ctx.safety, userId, "send_message");
  if (!ctx.authz.canPost(conv, userId))
    throw forbidden("You can't post in this channel");
  if (conv.type === "DM") ctx.bots.directMessages.admit(conv.id);
  if (conv.org_id && ctx.authz.mustFinishOnboarding(conv.org_id, userId))
    throw new ApiError(
      403,
      "onboarding_not_finished",
      "Finish this community's onboarding before you post or react",
      { orgId: conv.org_id },
    );
  if (conv.org_id && ctx.authz.mustAgreeRules(conv.org_id, userId))
    throw new ApiError(
      403,
      "rules_not_agreed",
      "Agree to this community's rules before you post or react",
      { orgId: conv.org_id },
    );
  await ctx.communitySafety.admitPost(conv, userId, "post", false);
}
