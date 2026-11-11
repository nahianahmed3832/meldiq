import type { AppContext } from "../../app/context.js";
import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { forbidden } from "../../shared/errors.js";
import { allowed, type Permission } from "./permissions.js";
import type {
  AdminAccountAuthority,
  AdminGrantRow,
  PlatformAdminStore,
} from "./store.js";
import { userSummary } from "../accounts/index.js";

export type AuthoritySnapshot =
  ReadonlyMap<string, AdminAccountAuthority> | undefined;

/** Read async account authority before a platform unit; never await inside RowWriter. */
export async function readAdminAccountAuthority(
  ctx: AppContext,
  accountId: string,
): Promise<AdminAccountAuthority> {
  const account = await ctx.accounts.store.accountById(accountId);
  const identity = account?.user_id
    ? userSummary(ctx.identity, account.user_id)
    : undefined;
  return {
    enabled:
      !!account &&
      account.email_verified_at !== null &&
      account.disabled_at === null &&
      (!account.user_id ||
        (!!identity &&
          identity.disabled_at === null &&
          identity.deleted_at === null)),
    userId: account?.user_id ?? null,
  };
}

export async function snapshotAdminAuthority(
  store: PlatformAdminStore,
  extra: (string | null | undefined)[] = [],
): Promise<AuthoritySnapshot> {
  if (!store.accountAuthority) return undefined; // Trusted operator bootstrap can run before an app context exists.
  const ids = new Set([
    ...store
      .grants()
      .filter((g) => g.role === "super_admin" && g.revoked_at === null)
      .map((g) => g.account_id),
    ...extra.filter((id): id is string => !!id),
  ]);
  return new Map(
    await Promise.all(
      [...ids].map(
        async (id) => [id, await store.accountAuthority!(id)] as const,
      ),
    ),
  );
}

/** Reservations stay restrictive until canonical account/identity restoration finishes, even after a timer expires. */
export function accountAuthorityAvailable(
  w: RowReader,
  accountId: string,
  snapshot?: AuthoritySnapshot,
): boolean {
  const state = snapshot?.get(accountId);
  if (snapshot && !state?.enabled) return false;
  if (
    w.get("platform_restrictions", {
      user_id: `account:${accountId}`,
      kind: "suspension",
    })
  )
    return false;
  return (
    !state?.userId ||
    !w.get("platform_restrictions", {
      user_id: state.userId,
      kind: "suspension",
    })
  );
}

export function usableAdmin(
  w: RowReader,
  accountId: string,
  snapshot?: AuthoritySnapshot,
): AdminGrantRow | undefined {
  const grant = w.get<AdminGrantRow>("platform_admins", {
    account_id: accountId,
    revoked_at: null,
  });
  return grant &&
    accountAuthorityAvailable(w, accountId, snapshot) &&
    w.count("platform_admin_passkeys", { account_id: accountId }) > 0
    ? grant
    : undefined;
}

export function guardAdminActor(
  w: RowReader,
  accountId: string | null,
  permission: Permission,
  snapshot?: AuthoritySnapshot,
): AdminGrantRow | undefined {
  if (!accountId) return undefined;
  const grant = usableAdmin(w, accountId, snapshot);
  if (!grant || !allowed(grant, permission))
    throw forbidden("Your console authority changed. Sign in again.");
  return grant;
}

export function requireAnotherUsableSuper(
  w: RowReader,
  targetId: string,
  snapshot?: AuthoritySnapshot,
) {
  const remains = w
    .all<AdminGrantRow>("platform_admins", {
      where: { role: "super_admin", revoked_at: null },
    })
    .some(
      (g) =>
        g.account_id !== targetId && !!usableAdmin(w, g.account_id, snapshot),
    );
  if (!remains)
    throw forbidden(
      "Keep at least one enabled platform super administrator with a passkey.",
    );
}

export function guardAccountStatusWrite(
  w: RowReader,
  actorId: string,
  accountId: string | undefined,
  suspend: boolean,
  snapshot: AuthoritySnapshot,
) {
  const actor = guardAdminActor(
    w,
    actorId,
    suspend ? "users.suspend" : "users.restore",
    snapshot,
  )!;
  if (actorId === accountId)
    throw forbidden("You cannot change your own account status.");
  const target = accountId
    ? w.get<AdminGrantRow>("platform_admins", {
        account_id: accountId,
        revoked_at: null,
      })
    : undefined;
  if (target && actor.role !== "super_admin")
    throw forbidden(
      "Only a super admin can act on another platform administrator.",
    );
  if (suspend && target?.role === "super_admin")
    requireAnotherUsableSuper(w, target.account_id, snapshot);
}
