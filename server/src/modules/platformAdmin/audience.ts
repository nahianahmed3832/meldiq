import type { Rows } from "../../infrastructure/database/rows/index.js";
/** Public audience query; callers never reach into platform-owned tables. */
export function hasPlatformAdminAccount(rows: Rows, accountId: string): boolean { return !!rows.get("platform_admins", { account_id: accountId, revoked_at: null }); }
