/**
 * Scoped provisioning of synthetic load-test accounts (docs/LOADTEST_PROVISIONING.md).
 *
 * Authorization is the invite, not anything the client says: only the operator CLI creates a 'loadtest' registration
 * invite (its code is shown once, only the hash is stored), and only such an invite takes the load-test path. That
 * path skips the public per-network registration limits and is limited instead by its own hourly and daily quotas,
 * counted in the identity rows (persistent across restarts; checked inside the account's write unit, so concurrent requests can't
 * overshoot). Accounts made this way are synthetic and confined to synthetic communities.
 */
import type { RowReader, Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { DAY_MS, HOUR_MS, networkKey } from "../../app/middleware/abuse.js";
import { ApiError } from "../../shared/errors.js";
import { humanCode, newId, normalizeCode, now, sha256Hex } from "../../shared/utilities/util.js";

export const LOADTEST_PURPOSE = "loadtest";
/** Upper bounds for one operator invite. */
export const LOADTEST_INVITE_MAX_USES = 5000;
export const LOADTEST_INVITE_MAX_DAYS = 365;

export interface LoadtestPolicy {
  /** Synthetic accounts in any rolling hour / rolling 24 hours. Both must be above 0 for the path to be open. */
  hourly: number;
  daily: number;
  /** Networks (IPv4 addresses or IPv6 /64s, as networkKey writes them) allowed to use it; empty: any. */
  networks: string[];
}

export interface LoadtestInviteRow {
  id: string;
  max_uses: number;
  uses: number;
  expires_at: number;
  revoked_at: number | null;
}

export const loadtestEnabled = (p: LoadtestPolicy): boolean => p.hourly > 0 && p.daily > 0;

/** The usable load-test invite for this code, or undefined (also for ordinary registration invites). */
export function findLoadtestInvite(r: RowReader, code: string): LoadtestInviteRow | undefined {
  const inv = r.get<LoadtestInviteRow>("registration_invites", { code_hash: sha256Hex(normalizeCode(code)), purpose: LOADTEST_PURPOSE });
  return inv && !inv.revoked_at && inv.expires_at > now() && inv.uses < inv.max_uses ? inv : undefined;
}

/** Operator-only (admin CLI and tests): a load-test invite. The code is returned once and never stored. */
export async function createLoadtestInvite(rows: Rows, opts: { maxUses: number; days: number; note?: string | null }): Promise<{ id: string; code: string }> {
  if (!Number.isInteger(opts.maxUses) || opts.maxUses < 1 || opts.maxUses > LOADTEST_INVITE_MAX_USES) throw new Error(`uses must be 1–${LOADTEST_INVITE_MAX_USES}`);
  if (!(opts.days > 0 && opts.days <= LOADTEST_INVITE_MAX_DAYS)) throw new Error(`days must be more than 0 and at most ${LOADTEST_INVITE_MAX_DAYS}`);
  const code = humanCode(12);
  const id = newId("rinv");
  const t = now();
  await rows.write((w) =>
    w.insert("registration_invites", {
      id,
      code_hash: sha256Hex(code),
      code_hint: code.slice(-4),
      note: opts.note ?? null,
      max_uses: opts.maxUses,
      created_at: t,
      expires_at: t + Math.round(opts.days * DAY_MS),
      purpose: LOADTEST_PURPOSE,
    }),
  );
  return { id, code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` };
}

export interface QuotaState {
  lastHour: number;
  lastDay: number;
  /** When the next account fits again (0: it fits now). */
  retryAfterMs: number;
}

/** Synthetic accounts created in the rolling hour and rolling 24 hours before [at]. */
export function loadtestQuota(r: RowReader, policy: LoadtestPolicy, at: number): QuotaState {
  const count = (since: number) => r.count("loadtest_registrations", { created_at: { gt: since } });
  const lastHour = count(at - HOUR_MS);
  const lastDay = count(at - DAY_MS);
  // The oldest row inside a full window leaves it at created_at + window: that's when one more fits.
  const freeAt = (window: number, limit: number) => {
    const row = r.all<{ created_at: number }>("loadtest_registrations", { where: { created_at: { gt: at - window } }, orderBy: [["created_at", "desc"]], limit })[limit - 1];
    return row ? row.created_at + window - at : 0;
  };
  const retryAfterMs = Math.max(lastHour >= policy.hourly ? freeAt(HOUR_MS, policy.hourly) : 0, lastDay >= policy.daily ? freeAt(DAY_MS, policy.daily) : 0);
  return { lastHour, lastDay, retryAfterMs };
}

/** Refuses the load-test path for this request unless it's enabled and the network is allowed (before key work). */
export function checkLoadtestRequest(policy: LoadtestPolicy, ip: string): string {
  if (!loadtestEnabled(policy)) throw new ApiError(403, "loadtest_disabled", "Load-test provisioning isn't enabled on this server");
  const network = networkKey(ip);
  if (policy.networks.length && !policy.networks.includes(network)) {
    throw new ApiError(403, "loadtest_network", "Load-test provisioning isn't allowed from this network");
  }
  return network;
}

/**
 * Inside the registration's write unit: re-checks the invite and both quotas, then marks [userId] synthetic, uses the
 * invite once and records the registration. Throws (rolling the account back) when anything no longer holds.
 */
export function admitLoadtestAccount(w: RowWriter, policy: LoadtestPolicy, inviteId: string, userId: string, network: string, at: number): QuotaState {
  const inv = w.get<LoadtestInviteRow>("registration_invites", { id: inviteId, purpose: LOADTEST_PURPOSE });
  if (!inv || inv.revoked_at || inv.expires_at <= at || inv.uses >= inv.max_uses) {
    throw new ApiError(403, "invalid_invite", "This invitation code is invalid, expired or already used");
  }
  const q = loadtestQuota(w, policy, at);
  if (q.lastHour >= policy.hourly || q.lastDay >= policy.daily) {
    throw new ApiError(429, "loadtest_quota", "The load-test provisioning quota is used up for now", {
      retryAfter: Math.max(1, Math.ceil(q.retryAfterMs / 1000)),
      lastHour: q.lastHour,
      lastDay: q.lastDay,
    });
  }
  w.update("users", { id: userId }, { synthetic: 1, limited_until: null });
  w.update("registration_invites", { id: inviteId }, { uses: inv.uses + 1 });
  w.insert("loadtest_registrations", { user_id: userId, invite_id: inviteId, network, created_at: at });
  return { lastHour: q.lastHour + 1, lastDay: q.lastDay + 1, retryAfterMs: 0 };
}

/** Whether [userId] is a synthetic load-test account. */
export const isSynthetic = (r: RowReader, userId: string): boolean => r.get<{ synthetic: number }>("users", { id: userId })?.synthetic === 1;

/** A synthetic account may only start DMs and groups with other synthetic accounts. */
export function requireSyntheticScopeForPeople(r: RowReader, userId: string, others: string[]): void {
  if (!others.length || !isSynthetic(r, userId)) return;
  if (r.count("users", { synthetic: 0, id: { in: others } }) > 0) throw new ApiError(403, "synthetic_scope", "Load-test accounts can only talk to other load-test accounts");
}
