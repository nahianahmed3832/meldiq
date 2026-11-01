import type { AppContext } from "../../app/context.js";
import { blockedEitherWay, sharesCommunity } from "./relationships/rules.js";
import { privacyOf } from "./profile.js";
import { avatarMediaOf, styleOf } from "./profileMedia.js";
import { personCards } from "./peopleCards.js";
/** Apply account privacy and synthetic/bot exclusions within the account module before publishing ranked cards. */
export function leaderboardPeople(
  ctx: AppContext,
  viewer: string,
  totals: { userId: string; count: number }[],
  minimum: number,
) {
  const cards = personCards(
    ctx,
    totals.map((t) => t.userId),
  );
  return totals
    .flatMap((t) => {
      if (!Number.isSafeInteger(t.count) || t.count <= minimum) return [];
      const card = cards.get(t.userId);
      const user = ctx.identity.get<{
        kind: string;
        synthetic: number;
        disabled_at: number | null;
        home_server_id: string | null;
        privacy: string | null;
        avatar_media: string | null;
        profile_style: string | null;
      }>("users", { id: t.userId });
      if (
        !card ||
        !user ||
        user.kind !== "person" ||
        user.synthetic ||
        user.disabled_at ||
        user.home_server_id ||
        blockedEitherWay(ctx, viewer, t.userId)
      )
        return [];
      if (
        t.userId !== viewer &&
        privacyOf(user).findByUsername !== "everyone" &&
        !sharesCommunity(ctx, viewer, t.userId)
      )
        return [];
      return [
        {
          user: {
            ...card,
            avatarMedia:
              privacyOf(user).photo === "everyone" ? avatarMediaOf(user) : null,
            decoration: styleOf(user).decoration,
          },
          value: t.count,
        },
      ];
    })
    .sort((a, b) => b.value - a.value || a.user.id.localeCompare(b.user.id));
}
