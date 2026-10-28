import { createHash } from "node:crypto";
import type { Standing } from "./lifecycle.js";
import type { BillingOwner } from "./owners.js";
import type { Billing } from "./service.js";
import type { SubscriptionRow } from "./subscriptions.js";

/**
 * The one answer every client gets to "what does this account have?" (docs/BILLING.md › Entitlements API): the web
 * app, the website, Android, and the iOS, macOS and Windows apps to come. It is computed on the server from verified
 * subscriptions only (whatever provider verified them), from the signed-in account's identity and its organization
 * memberships as they are now. Nothing a client says (a plan name, a flag, a store receipt it hasn't had verified) is
 * an input. Signing in grants nothing: an account with no subscription gets the free answer.
 */
export interface MembershipInput {
  orgId: string;
  name: string;
  role: string;
}

export interface EntitlementsInput {
  accountId: string;
  /** The account's encryption identity, when it has one (users.id): organization membership hangs off it. */
  userId: string | null;
  organizations: readonly MembershipInput[];
}

/** An organization's limits as they apply now, with where each comes from (administration/entitlements.ts). */
export type OrgLimitsResolver = (orgId: string) => { key: string; limit: number | null; source: string }[];

const DAY_MS = 86_400_000;

/** A free period's view: where it comes from and when it ends (null for organizations and paid plans). */
type TrialView = { source: "signup" | "invite" | "invite_bonus" | "gift" | "operator"; endsAt: number } | null;

const TRIAL_SOURCE = { signup_trial: "signup", referral_invitee: "invite", referral_inviter: "invite_bonus", gift: "gift", operator: "operator" } as const;

function grant(billing: Billing, owner: BillingOwner, t: number, showSubscription: boolean) {
  const paid = subscriptionGrant(billing, owner, t, showSubscription);
  if (paid.plan || owner.kind !== "account") return { ...paid, trial: null as TrialView };
  // No subscription gives the plan: a free period (trial or invite bonus) may.
  const g = billing.grants.active(owner.accountId, t);
  const plan = g ? billing.catalog.byKey(g.plan_key) : null;
  if (!g) return { ...paid, trial: null as TrialView };
  const version = plan ? billing.catalog.current(plan.id) : null;
  return {
    ...paid,
    plan: { key: g.plan_key, name: plan?.name ?? g.plan_key },
    standing: "entitled" as const,
    accessUntil: g.ends_at,
    renews: false,
    quotaPlanId: version?.quota_plan_id ?? null,
    trial: { source: TRIAL_SOURCE[g.source], endsAt: g.ends_at } as TrialView,
  };
}

function subscriptionGrant(billing: Billing, owner: BillingOwner, t: number, showSubscription: boolean) {
  const s = billing.subscriptions.liveForOwner(owner);
  const v = s ? billing.catalog.version(s.plan_version_id) : null;
  const standing: Standing | "none" = s ? billing.subscriptions.standingOf(s, t) : "none";
  const granted = standing === "entitled" || standing === "grace";
  const plan = granted && v ? billing.catalog.plan(v.plan_id) : null;
  return {
    plan: plan ? { key: plan.key, name: plan.name } : null,
    standing,
    /** Until when the plan applies for sure (the paid-through or trial end; the grace end while a payment is failing). */
    accessUntil: s && v && granted ? accessUntil(s, standing as Standing, v.grace_days) : null,
    /** Whether it continues past [accessUntil] by itself (false: cancellation scheduled, or a payment is failing). */
    renews: granted && s ? standing === "entitled" && !s.cancel_at_period_end : null,
    quotaPlanId: granted ? (v?.quota_plan_id ?? null) : null,
    subscription:
      showSubscription && s && v
        ? {
            status: s.status,
            provider: s.provider,
            interval: v.interval,
            currentPeriodEnd: s.current_period_end,
            trialEnd: s.trial_end,
            cancelAtPeriodEnd: !!s.cancel_at_period_end,
          }
        : null,
  };
}

function accessUntil(s: SubscriptionRow, standing: Standing, graceDays: number): number | null {
  if (standing === "grace") return (s.past_due_since ?? 0) + graceDays * DAY_MS;
  if (s.status === "trialing") return s.trial_end ?? s.current_period_end;
  return s.current_period_end;
}

export function resolveEntitlements(billing: Billing, input: EntitlementsInput, orgLimits: OrgLimitsResolver, t: number) {
  const personal = grant(billing, { kind: "account", accountId: input.accountId }, t, true);
  const organizations = input.organizations.map((m) => {
    const owner = m.role === "OWNER";
    // Members get the organization's plan and limits; only its owners see the subscription's billing details.
    return { orgId: m.orgId, name: m.name, role: m.role, manageBilling: owner, ...grant(billing, { kind: "org", orgId: m.orgId }, t, owner), limits: orgLimits(m.orgId) };
  });
  const body = {
    accountId: input.accountId,
    billing: { available: !!billing.provider, mode: billing.provider?.mode ?? null },
    personal,
    organizations,
  };
  // Changes when anything in the answer changes, so clients can tell a refresh apart from a change.
  const revision = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...body, revision, evaluatedAt: t };
}
