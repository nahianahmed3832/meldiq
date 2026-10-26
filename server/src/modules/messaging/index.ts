/**
 * The messaging module's public API (docs/architecture/ARCHITECTURE_1_0_PLAN.md §3.2): what other modules may use.
 */
export type { QueueInsert, QueueItemRow, RelayStats, RelayStore, Submission } from "./relay/store.js";
export { conversationMemberIds, conversationPeers, sharesDirectConversation } from "./peers.js";
export { channelCounts } from "./platformQueries.js";
export { botDm, openChannelIds } from "./botConversations.js";
