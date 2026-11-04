import type { RowWriter } from "../../infrastructure/database/rows/index.js";
export function erasePrivateMessagingState(
  rows: RowWriter,
  userId: string,
): void {
  rows.delete("managed_poll_votes", { user_id: userId });
  rows.delete("thread_preferences", { user_id: userId });
}
