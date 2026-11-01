import type { RowReader } from "../../infrastructure/database/rows/index.js";
import type { GiftRow } from "./gifts.js";

/** Counts accepted gifts without exposing payment rows outside their owning service. */
export function giftLeaderboard(rows: RowReader): { userId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const gift of rows.all<GiftRow>("mojo_gifts", { where: { status: { in: ["paid", "redeemed"] } } })) {
    if (!gift.buyer_user_id || (gift.refund_status && gift.refund_status !== "none") || gift.dispute_status) continue;
    counts.set(gift.buyer_user_id, (counts.get(gift.buyer_user_id) ?? 0) + 1);
  }
  return [...counts].map(([userId, count]) => ({ userId, count }));
}
