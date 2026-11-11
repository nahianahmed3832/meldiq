import type { AppContext } from "../../app/context.js";
import { ApiError, forbidden } from "../../shared/errors.js";
import type { AdminAuthService, AdminPrincipal } from "./auth.js";
import { guardAdminActor, readAdminAccountAuthority } from "./authority.js";

/** Authority linearizes at this short platform unit after provider reads. No lock spans provider I/O. */
export async function currentFinancialPrincipal(ctx: AppContext, auth: AdminAuthService | undefined, previous: AdminPrincipal): Promise<AdminPrincipal> {
  if (!auth) throw forbidden("Financial authority is unavailable. Sign in again.");
  const [account, authority] = await Promise.all([ctx.accounts.store.accountById(previous.account.id), readAdminAccountAuthority(ctx, previous.account.id)]);
  if (!account || auth.credentials.standing(account)) throw forbidden("Your account standing changed. Sign in again.");
  const snapshot = new Map([[account.id, authority]]);
  return ctx.platform.write(w => {
    const grant = guardAdminActor(w, account.id, "billing.manage", snapshot)!;
    const session = auth.store.sessionByTokenHash(previous.session.token_hash), t = Date.now();
    if (!session || session.id !== previous.session.id || session.account_id !== account.id || session.revoked_at !== null || session.expires_at <= t || session.idle_expires_at <= t || account.password_changed_at > session.created_at) throw forbidden("Your console session ended. Sign in again.");
    const fresh: AdminPrincipal = { account, grant: grant as AdminPrincipal["grant"], session };
    if (!auth.recentlyVerified(fresh)) throw new ApiError(403, "reauth_required", "Confirm with your passkey again before this financial operation.");
    return fresh;
  });
}
