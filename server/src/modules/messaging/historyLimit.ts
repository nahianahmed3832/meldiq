import type { HistoryPage } from "./store/messageStore.js";

/**
 * Community parity A1 (docs/COMMUNITY_PERMISSIONS.md): without `messages.history` in a channel, its history starts when
 * the person joined it. [since] null: the whole history. A page that reached that point has nothing older to offer.
 */
export function pageSince(page: HistoryPage, since: number | null): HistoryPage {
  if (since === null) return page;
  const messages = page.messages.filter((m) => m.server_ts >= since);
  if (messages.length === page.messages.length) return page;
  const kept = new Set(messages.map((m) => m.id));
  // Changes that point at hidden messages go too; read receipts (no target) stay.
  const changes = page.changes.filter((c) => c.target === null || kept.has(c.target));
  return { messages, changes, more: false };
}
