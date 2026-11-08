import type { AppContext } from "../../app/context.js";
import type { RowReader } from "../../infrastructure/database/rows/index.js";

export function partnerCommunity(rows: RowReader, orgId: string): boolean {
  return (
    rows.get<{ status: string }>("org_partner_applications", { org_id: orgId })
      ?.status === "approved"
  );
}

export function partnerOwner(ctx: AppContext, userId: string): boolean {
  return ctx.ws
    .all<{ org_id: string }>("org_members", {
      where: { user_id: userId, role: "OWNER" },
    })
    .some(
      ({ org_id }) =>
        partnerCommunity(ctx.ws, org_id) &&
        !ctx.authz.platformSuspended(org_id),
    );
}
