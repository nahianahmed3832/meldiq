/**
 * Subscription lifecycle (docs/BILLING.md). The states are the provider's, mapped to one internal vocabulary; the
 * server never moves a subscription between them on its own: every change comes from a verified provider event.
 *
 * Whether a state grants the plan's entitlements is decided here, in one place:
 * - trialing, active: yes (also while a cancellation is scheduled for the period end: the period is paid for);
 * - past_due: yes during the plan version's grace days, counted from when the payment first failed; no after;
 * - incomplete, paused, canceled, incomplete_expired: no.
 * Losing entitlements never deletes anything: the organization falls back to operator or server limits, and its
 * existing files and members stay (limits only refuse adding more).
 */
export const SUBSCRIPTION_STATUSES = ["incomplete", "trialing", "active", "past_due", "paused", "canceled", "incomplete_expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** States a subscription doesn't leave (a new subscription is a new row). */
export const TERMINAL: ReadonlySet<SubscriptionStatus> = new Set(["canceled", "incomplete_expired"]);

/** Which state may follow which. A provider event asking for anything else is recorded as failed, not applied. */
const NEXT: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  incomplete: ["incomplete", "trialing", "active", "past_due", "incomplete_expired", "canceled"],
  trialing: ["trialing", "active", "past_due", "paused", "canceled"],
  active: ["active", "past_due", "paused", "canceled"],
  past_due: ["past_due", "active", "paused", "canceled"],
  paused: ["paused", "active", "trialing", "canceled"],
  canceled: ["canceled"],
  incomplete_expired: ["incomplete_expired"],
};

export function isSubscriptionStatus(s: string): s is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(s);
}

export function canMove(from: SubscriptionStatus | null, to: SubscriptionStatus): boolean {
  return from === null || NEXT[from].includes(to);
}

const DAY_MS = 86_400_000;

export interface EntitlementState {
  status: SubscriptionStatus;
  pastDueSince: number | null;
  graceDays: number;
}

/** Why a subscription does or doesn't grant its plan right now. */
export type Standing = "entitled" | "grace" | "grace_ended" | "not_entitled";

export function standing(s: EntitlementState, t: number): Standing {
  if (s.status === "trialing" || s.status === "active") return "entitled";
  if (s.status !== "past_due") return "not_entitled";
  const since = s.pastDueSince ?? t;
  return t < since + s.graceDays * DAY_MS ? "grace" : "grace_ended";
}

export const grantsPlan = (s: EntitlementState, t: number): boolean => {
  const st = standing(s, t);
  return st === "entitled" || st === "grace";
};
