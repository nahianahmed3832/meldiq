import type { AppContext } from "../../app/context.js";
import { allows, privacyOf, relation } from "./profile.js";
/** Privacy projection for community identity overrides, shared without exposing the identity row to other modules. */
export function profileAudience(ctx: AppContext, target: string, viewer: string) {
  const user = ctx.identity.get<any>("users", {
    id: target,
    disabled_at: null,
  });
  if (!user) return null;
  const r = relation(ctx, viewer, target);
  return { bio: allows(privacyOf(user).bio, r), theme: !r.blockedByTarget };
}
