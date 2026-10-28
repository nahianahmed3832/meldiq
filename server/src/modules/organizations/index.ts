/**
 * The organizations module's public API for other modules (docs/architecture/ARCHITECTURE_1_0_PLAN.md §3.2). Started
 * 2026-10-23 for the Platform Admin Console's read model; older cross-module imports are in the boundary allowlist.
 */
export { auditActionCount, authHistory, type MembershipRow, membershipsOf, orgMemberIds, orgsCreatedBetween, orgsWithMembers, orgComposition, orgCounts, type OrgKind, orgNames, orgRecord, type OrgRecordRow, type OrgSummaryRow, searchOrgs, securityEvents } from "./platformQueries.js";
// The Platform Admin Console removes a member the same way a community manager does (everything else follows).
export { removeFromWorkspace } from "./orgsRoutes.js";
export { orgMates, presenceWatchers } from "./orgMates.js";
