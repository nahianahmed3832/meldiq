/**
 * The messaging module's public API (docs/architecture/ARCHITECTURE_1_0_PLAN.md §3.2): what other modules may use.
 */
export type { QueueInsert, QueueItemRow, RelayStats, RelayStore, Submission } from "./relay/store.js";
export { conversationMemberIds, conversationPeers, directPeers, sharesDirectConversation } from "./peers.js";
export { memberIds, memberUsers, type MemberRow } from "./memberUsers.js";
export { channelCounts } from "./platformQueries.js";
