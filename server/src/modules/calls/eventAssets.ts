import type { RowReader } from "../../infrastructure/database/rows/index.js";
/** Cover blobs to settle before the conversation's event rows cascade. */
export function eventCoverIds(
  rows: RowReader,
  conversationId: string,
): string[] {
  return rows
    .all<{ cover_id: string | null }>("meetings", {
      where: { room_id: conversationId },
    })
    .flatMap((row) => (row.cover_id ? [row.cover_id] : []));
}
