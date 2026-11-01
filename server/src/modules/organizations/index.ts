/**
 * The organizations module's public API for other modules (docs/architecture/ARCHITECTURE_1_0_PLAN.md §3.2). Started
 * 2026-10-23 for the Platform Admin Console's read model; older cross-module imports are in the boundary allowlist.
 */
export {
  auditActionCount,
  authHistory,
  type MembershipRow,
  membershipsOf,
  orgMemberIds,
  orgsCreatedBetween,
  orgsWithMembers,
  orgComposition,
  orgCounts,
  type OrgKind,
  orgNames,
  orgRecord,
  type OrgRecordRow,
  type OrgSummaryRow,
  searchOrgs,
  securityEvents,
} from "./platformQueries.js";
// The Platform Admin Console removes a member the same way a community manager does (everything else follows).
export { eraseWorkspace, removeFromWorkspace } from "./orgsRoutes.js";
export { communityCount, orgMates, presenceWatchers, sharedCommunityCounts } from "./orgMates.js";
// API 0.65.0 batch B: bots joining and leaving communities (modules/bots decides who may add which bot).
export { addBotMember, type BotChannelView, botChannels, removeBotMember, requireBotManager } from "./botMembers.js";
// Community parity batch D: what official bots (modules/officialBots) need from communities.
export { activeRoleName, botRoleGivableBy, communityFacts, giveRoleAsBot, holdsRole, officialBotAssigner, publicTextChannel } from "./botMembers.js";
export type { ConversationRow } from "./authz.js";
export { leaderboardChannels } from "./lobby/view.js";

export type { ReportRow, AdminReportQuery } from "./reports/store.js";

export { orgPlatformRestriction, setOrgPlatformRestriction } from "./platformQueries.js";

export { REPORT_RETENTION_MS } from "./reports/routes.js";
