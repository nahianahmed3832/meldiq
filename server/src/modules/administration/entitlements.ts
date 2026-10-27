import type { DB } from "../../infrastructure/database/db.js";
import { ApiError } from "../../shared/errors.js";

/**
 * Entitlements (docs/PLANS.md, docs/BILLING.md): the one place where limits live, so the apps and the routes never
 * hard-code what a plan allows. By default every capability is available and nothing is limited. The first layer that
 * says something about a key decides it:
 *
 * 1. a workspace's own limit, set by platform admins with a reason and usually an end date (expired ones stop applying);
 * 2. the plan of the workspace's subscription, while it grants one (billing/lifecycle.ts: trialing, active, or past due
 *    within the grace days);
 * 3. server-wide limits set by the operator (ENTITLEMENT_LIMITS, for example "roles.custom=10,members=500");
 * 4. none.
 *
 * Limits are enforced on the server when something is added; reaching one never removes or hides what exists. No
 * upgrade is offered here: the owners' billing page lists the plans that can be bought, if any.
 */
export const ENTITLEMENT_KEYS = [
  "roles.custom",
  // Round 7 (docs/USAGE_AND_PLANS.md).
  "members",
  "storage.bytes",
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

/**
 * Limits for modules the community rebuild removed (apps, workflows, documents, groups, developer keys, AI, inbox).
 * An environment file that still names one starts the server and the limit is ignored.
 */
const RETIRED_KEYS: readonly string[] = [
  "integrations.installed",
  "integrations.webhooks",
  "integrations.notifications",
  "workflows",
  "documents",
  "groups",
  "api_keys",
  "webhooks.outgoing",
  "inbox.accounts",
];

export const LABELS: Record<EntitlementKey, string> = {
  "roles.custom": "Custom roles",
  members: "Members (including guests)",
  "storage.bytes": "Stored file bytes",
};

/** The plan limits a workspace's subscription grants at [t], if any (billing/subscriptions.ts). */
export type PlanLimitsResolver = (orgId: string, t: number) => { limits: Partial<Record<EntitlementKey, number>>; planName: string } | null;

export interface EntitlementConfig {
  limits: Readonly<Partial<Record<EntitlementKey, number>>>;
}

export function isEntitlementKey(k: string): k is EntitlementKey {
  return (ENTITLEMENT_KEYS as readonly string[]).includes(k);
}

export function entitlementConfig(env: NodeJS.ProcessEnv): EntitlementConfig {
  const limits: Partial<Record<EntitlementKey, number>> = {};
  for (const part of (env.ENTITLEMENT_LIMITS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (RETIRED_KEYS.includes(key)) continue;
    if (!isEntitlementKey(key)) throw new Error(`ENTITLEMENT_LIMITS: unknown capability "${key}" (known: ${ENTITLEMENT_KEYS.join(", ")})`);
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`ENTITLEMENT_LIMITS: ${key} needs a whole number`);
    limits[key] = n;
  }
  return { limits };
}

export interface EntitlementView {
  key: EntitlementKey;
  label: string;
  /** null: no limit. */
  limit: number | null;
  used: number;
  available: boolean;
  /** Where the limit comes from: this workspace's own, its plan, the server's, or none. */
  source: "workspace" | "plan" | "server" | "none";
}

export class Entitlements {
  constructor(
    private readonly config: EntitlementConfig,
    private readonly db?: DB,
    private readonly plans?: PlanLimitsResolver,
    private readonly clock: () => number = Date.now,
  ) {}

  private overrides(orgId: string | undefined): Partial<Record<EntitlementKey, number>> {
    if (!orgId || !this.db?.open) return {};
    const rows = this.db.prepare("SELECT key, limit_value FROM org_entitlements WHERE org_id = ? AND (expires_at IS NULL OR expires_at > ?)").all(orgId, this.clock()) as {
      key: string;
      limit_value: number;
    }[];
    return Object.fromEntries(rows.filter((r) => isEntitlementKey(r.key)).map((r) => [r.key, r.limit_value]));
  }

  private planOf(orgId: string | undefined) {
    return orgId && this.plans && this.db?.open ? this.plans(orgId, this.clock()) : null;
  }

  /** The limit that applies to [orgId] for [key], and where it comes from. */
  limitFor(key: EntitlementKey, orgId?: string): { limit: number | null; source: EntitlementView["source"] } {
    const own = this.overrides(orgId)[key];
    if (own !== undefined) return { limit: own, source: "workspace" };
    const plan = this.planOf(orgId)?.limits[key];
    if (plan !== undefined) return { limit: plan, source: "plan" };
    const server = this.config.limits[key];
    return server !== undefined ? { limit: server, source: "server" } : { limit: null, source: "none" };
  }

  /** What a workspace has: its plan's name while a subscription grants one (else null), and the limits that apply. */
  plan(usage: Readonly<Partial<Record<EntitlementKey, number>>>, orgId?: string) {
    const capabilities: EntitlementView[] = ENTITLEMENT_KEYS.map((key) => {
      const { limit, source } = this.limitFor(key, orgId);
      const used = usage[key] ?? 0;
      return { key, label: LABELS[key], limit, used, available: limit === null || used < limit, source };
    });
    const granted = this.planOf(orgId);
    const source = capabilities.some((c) => c.source === "workspace") ? "workspace" : granted ? "plan" : Object.keys(this.config.limits).length ? "server" : "none";
    return { plan: granted ? { name: granted.planName } : null, source, capabilities, upgrade: null };
  }

  /** Refuses adding [adding] more of [key] once the limit that applies would be passed (409, with the limit). */
  check(key: EntitlementKey, used: number, orgId?: string, adding = 1): void {
    const { limit, source } = this.limitFor(key, orgId);
    if (limit !== null && used + adding > limit) {
      const who = source === "workspace" || source === "plan" ? "This community's plan allows" : "This server allows";
      const amount = key === "storage.bytes" ? `${Math.round(limit / 1_048_576)} MB of stored files` : `${limit} ${LABELS[key].toLowerCase()}`;
      throw new ApiError(409, "limit_reached", `${who} ${amount}${key === "storage.bytes" ? "" : " per workspace"}, and this workspace has reached it.`, { key, limit });
    }
  }

  /**
   * Platform admins only (the caller checks): sets or clears ([null]) a workspace's own limits, each until [expiresAt]
   * (null: no end).
   */
  setLimits(orgId: string, actorId: string, limits: Partial<Record<EntitlementKey, number | null>>, at: number, expiresAt: number | null = null, reason: string | null = null): void {
    if (!this.db) throw new Error("entitlements without a database");
    const db = this.db;
    db.transaction(() => {
      for (const [key, value] of Object.entries(limits)) {
        if (value === null || value === undefined) db.prepare("DELETE FROM org_entitlements WHERE org_id = ? AND key = ?").run(orgId, key);
        else
          db.prepare(
            "INSERT INTO org_entitlements (org_id, key, limit_value, set_by, set_at, expires_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET limit_value = excluded.limit_value, set_by = excluded.set_by, set_at = excluded.set_at, expires_at = excluded.expires_at, reason = excluded.reason",
          ).run(orgId, key, value, actorId, at, expiresAt, reason);
      }
    })();
  }
}

/** Every organization's own limits still in force, newest first (the Platform Admin Console's billing page). */
export function orgLimitOverrides(db: DB, t: number, limit = 500): { org_id: string; key: string; limit_value: number; set_at: number; expires_at: number | null; reason: string | null }[] {
  return db.prepare("SELECT org_id, key, limit_value, set_at, expires_at, reason FROM org_entitlements WHERE expires_at IS NULL OR expires_at > ? ORDER BY set_at DESC LIMIT ?").all(t, limit) as {
    org_id: string;
    key: string;
    limit_value: number;
    set_at: number;
    expires_at: number | null;
    reason: string | null;
  }[];
}
