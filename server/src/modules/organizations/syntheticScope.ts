/** Load-test communities (docs/LOADTEST_PROVISIONING.md): synthetic accounts may only join communities synthetic accounts made. */
import type { RowReader, RowWriter } from "../../infrastructure/database/rows/index.js";
import { ApiError } from "../../shared/errors.js";
import { isSynthetic } from "../accounts/index.js";

/** Marks a community its synthetic creator just made as a load-test community (part of the caller's write unit). */
export function markSyntheticOrg(identity: RowReader, w: RowWriter, orgId: string, creatorId: string): void {
  if (isSynthetic(identity, creatorId)) w.update("orgs", { id: orgId }, { synthetic: 1 });
}

/** A synthetic account may only join load-test communities. */
export function requireSyntheticScopeForOrg(ctx: { identity: RowReader; ws: RowReader }, userId: string, orgId: string): void {
  if (!isSynthetic(ctx.identity, userId)) return;
  const org = ctx.ws.get<{ synthetic: number }>("orgs", { id: orgId });
  if (org?.synthetic !== 1) throw new ApiError(403, "synthetic_scope", "Load-test accounts can only join load-test communities");
}
