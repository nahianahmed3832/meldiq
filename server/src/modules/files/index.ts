/**
 * The files module's public API (docs/architecture/ARCHITECTURE_1_0_PLAN.md §3.2): what other modules may use.
 */
export { KEPT_FOREVER } from "./store.js";
export type { AttachmentRow, FileStore, Usage, UsageFilter } from "./store.js";
// Removing a blob that was stored but not used (modules/organizations/discord).
export { deleteBlobNow } from "./routes.js";

// Message publication validates and retains completed encrypted attachments.
export { messageAttachments, retainMessageAttachments } from "./messageAttachments.js";
