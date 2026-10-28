import type { RowReader, Rows } from "../../infrastructure/database/rows/index.js";
import { ApiError } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";

/**
 * Account standing (API 0.46.0, docs/ACCOUNT_SAFETY.md): warnings from Meldiq's staff, each counting for a set number of
 * days. The number of active warnings decides what the account may do, and the server enforces it:
 *
 * | Active warnings | Level | Can't |
 * |---|---|---|
 * | 0 | good | nothing is limited |
 * | 1 | limited | start communities or make invitations |
 * | 2 | very_limited | also start direct messages or groups, or join communities |
 * | 3 or more | suspended | also send messages |
 *
 * Staff add and lift warnings with the operator CLI (`admin.js warn`, `unwarn`); people see theirs in Settings.
 */
export type StandingLevel = "good" | "limited" | "very_limited" | "suspended";
export type LimitedAction = "create_community" | "invite" | "start_conversation" | "join_community" | "send_message";

const LEVELS: StandingLevel[] = ["good", "limited", "very_limited", "suspended"];
/** The lowest level at which each action is refused. */
const REFUSED_FROM: Record<LimitedAction, StandingLevel> = {
  create_community: "limited",
  invite: "limited",
  start_conversation: "very_limited",
  join_community: "very_limited",
  send_message: "suspended",
};
const WHAT: Record<LimitedAction, string> = {
  create_community: "start communities",
  invite: "make invitations",
  start_conversation: "start new conversations",
  join_community: "join communities",
  send_message: "send messages",
};
export const DEFAULT_WARNING_DAYS = 14;
export const MAX_WARNING_DAYS = 365;

export interface WarningView {
  id: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export function activeWarnings(safety: RowReader, userId: string, at: number = now()): WarningView[] {
  return safety
    .all<{ id: string; reason: string; created_at: number; expires_at: number }>("account_warnings", {
      where: { user_id: userId, revoked_at: null, expires_at: { gt: at } },
      orderBy: [["created_at", "desc"]],
    })
    .map((r) => ({ id: r.id, reason: r.reason, createdAt: r.created_at, expiresAt: r.expires_at }));
}

export function standingOf(safety: RowReader, userId: string, at: number = now()): { level: StandingLevel; warnings: WarningView[] } {
  const warnings = activeWarnings(safety, userId, at);
  return { level: LEVELS[Math.min(warnings.length, LEVELS.length - 1)], warnings };
}

/** Refuses [action] when the account's standing doesn't allow it (one indexed query; nothing when there are no warnings). */
export function requireStanding(safety: RowReader, userId: string, action: LimitedAction): void {
  const { level } = standingOf(safety, userId);
  if (LEVELS.indexOf(level) >= LEVELS.indexOf(REFUSED_FROM[action])) {
    throw new ApiError(403, "account_limited", `Warnings from Meldiq's staff limit your account, so you can't ${WHAT[action]} for now. See Settings › My Account › Account standing.`);
  }
}

export async function addWarning(safety: Rows, userId: string, reason: string, days: number, by: string | null): Promise<WarningView> {
  const text = reason.trim().slice(0, 500);
  if (!text) throw new Error("A warning needs a reason");
  const d = Math.max(1, Math.min(MAX_WARNING_DAYS, Math.round(days)));
  const t = now();
  const id = newId("warn");
  await safety.write((w) => w.insert("account_warnings", { id, user_id: userId, reason: text, created_by: by, created_at: t, expires_at: t + d * 86_400_000, revoked_at: null }));
  return { id, reason: text, createdAt: t, expiresAt: t + d * 86_400_000 };
}

export function revokeWarning(safety: Rows, id: string): Promise<boolean> {
  return safety.write((w) => w.update("account_warnings", { id, revoked_at: null }, { revoked_at: now() }) === 1);
}
