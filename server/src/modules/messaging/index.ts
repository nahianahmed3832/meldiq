/**
 * The messaging module's public API (docs/architecture/ARCHITECTURE_1_0_PLAN.md §3.2): what other modules may use.
 */
export type { QueueInsert, QueueItemRow, RelayStats, RelayStore, Submission } from "./relay/store.js";
export { conversationMemberIds, conversationPeers, directPeers, sharesDirectConversation } from "./peers.js";
export { memberIds, memberUsers, type MemberRow } from "./memberUsers.js";
export { channelCounts } from "./platformQueries.js";
/** API 0.65.0 batch B: the server's one message path, which bots (modules/bots) send through like people. */
export { eventToWire, type Sender, sendServerMessage } from "./serverSend.js";
