import { SandboxProvider } from "./providers/sandbox.js";
import { StripeProvider, stripeKeyMode } from "./providers/stripe.js";
import type { BillingProvider } from "./providers/types.js";

/**
 * Billing settings (docs/BILLING.md). BILLING_PROVIDER picks the adapter:
 * - "none" (default): no checkout, no webhooks; the catalog can be prepared, nothing can be bought;
 * - "sandbox": the test-mode provider, with BILLING_SANDBOX_WEBHOOK_SECRET (at least 32 characters). Never real money;
 * - "stripe": Stripe Billing, with STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and BILLING_RETURN_URL. A live key
 *   (sk_live_/rk_live_) is refused unless BILLING_ALLOW_LIVE=true and APP_ENV=production.
 */
export interface BillingConfig {
  provider: BillingProvider | null;
  /** Why there is no provider, in plain words for operators (null when there is one). */
  unavailableReason: string | null;
  /**
   * The page people come back to from the provider's checkout and portal (the website's billing page). Fixed here, so
   * no client can send anyone elsewhere. null: the provider has no hosted pages (sandbox) or none is configured.
   */
  returnUrl: string | null;
  /** Free Meldiq Mojo periods (trials and invite links, grants.ts); null: off. */
  trials: TrialConfig | null;
  /** STRIPE_PORTAL_CONFIGURATION: the customer portal configuration to open (bpc_…); null: the account's default. */
  portalConfiguration: string | null;
}

/**
 * BILLING_TRIAL_STARTS_AT (an ISO date or time) turns trials on from that moment: accounts created before it get their
 * trial from then, newer ones from sign-up. Unset: no trials and no invite bonuses.
 */
export interface TrialConfig {
  startsAt: number;
  /** The plan a grant gives (BILLING_TRIAL_PLAN, a plan key; default "plus"). */
  planKey: string;
  /** BILLING_TRIAL_DAYS (default 14): every account's trial. */
  days: number;
  /** BILLING_REFERRAL_DAYS (default 30): the trial through an invite link, and each inviter's bonus. */
  referralDays: number;
  /** BILLING_REFERRAL_YEARLY_CAP_DAYS (default 90): at most this many bonus days per inviter in any 365 days. */
  referralCapDays: number;
  /** BILLING_REFERRAL_CLAIM_DAYS (default 7): an invite link counts only for an account at most this old. */
  claimWindowDays: number;
}

function wholeDays(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const raw = (env[key] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${key} must be a whole number of days from 0 to ${max}`);
  return n;
}

export function trialConfig(env: NodeJS.ProcessEnv): TrialConfig | null {
  const raw = (env.BILLING_TRIAL_STARTS_AT ?? "").trim();
  if (!raw) return null;
  const startsAt = Date.parse(raw);
  if (Number.isNaN(startsAt)) throw new Error("BILLING_TRIAL_STARTS_AT must be an ISO date or time, e.g. 2026-11-01T00:00:00Z");
  const planKey = (env.BILLING_TRIAL_PLAN ?? "plus").trim();
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(planKey)) throw new Error("BILLING_TRIAL_PLAN must be a plan key, e.g. plus");
  return {
    startsAt,
    planKey,
    days: wholeDays(env, "BILLING_TRIAL_DAYS", 14, 365),
    referralDays: wholeDays(env, "BILLING_REFERRAL_DAYS", 30, 365),
    referralCapDays: wholeDays(env, "BILLING_REFERRAL_YEARLY_CAP_DAYS", 90, 3650),
    claimWindowDays: wholeDays(env, "BILLING_REFERRAL_CLAIM_DAYS", 7, 90),
  };
}

export const NO_PROVIDER = "No billing provider is configured (BILLING_PROVIDER), so nothing can be bought yet. Plans can be prepared.";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** BILLING_RETURN_URL: an absolute https address (http only for this computer), without a query or fragment. */
function returnUrl(raw: string | undefined, production: boolean): string {
  let u: URL;
  try {
    u = new URL((raw ?? "").trim());
  } catch {
    throw new Error("BILLING_RETURN_URL must be an absolute URL, e.g. https://meldiq.app/account/billing");
  }
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && !production)) throw new Error("BILLING_RETURN_URL must use https");
  if (u.search || u.hash || u.username || u.password) throw new Error("BILLING_RETURN_URL must not have a query, fragment or credentials");
  return u.toString().replace(/\/$/, "");
}

export function billingConfig(env: NodeJS.ProcessEnv): BillingConfig {
  const portal = (env.STRIPE_PORTAL_CONFIGURATION ?? "").trim();
  if (portal && !/^bpc_[A-Za-z0-9]+$/.test(portal)) throw new Error("STRIPE_PORTAL_CONFIGURATION must be a portal configuration id (bpc_…)");
  return { ...providerConfig(env), trials: trialConfig(env), portalConfiguration: portal || null };
}

function providerConfig(env: NodeJS.ProcessEnv): Omit<BillingConfig, "trials" | "portalConfiguration"> {
  const name = (env.BILLING_PROVIDER ?? "none").trim().toLowerCase() || "none";
  const production = (env.APP_ENV ?? "development") === "production";
  if (name === "none") return { provider: null, unavailableReason: NO_PROVIDER, returnUrl: null };
  if (name === "sandbox") {
    const secret = env.BILLING_SANDBOX_WEBHOOK_SECRET ?? "";
    if (secret.length < 32) throw new Error("BILLING_SANDBOX_WEBHOOK_SECRET must be at least 32 characters with BILLING_PROVIDER=sandbox");
    return { provider: new SandboxProvider(secret), unavailableReason: null, returnUrl: env.BILLING_RETURN_URL ? returnUrl(env.BILLING_RETURN_URL, production) : null };
  }
  if (name === "stripe") {
    const key = (env.STRIPE_SECRET_KEY ?? "").trim();
    const mode = stripeKeyMode(key);
    if (!mode) throw new Error("STRIPE_SECRET_KEY must be a Stripe secret key (sk_test_… or rk_test_…) with BILLING_PROVIDER=stripe");
    if (mode === "live" && !(env.BILLING_ALLOW_LIVE === "true" && production)) {
      throw new Error("STRIPE_SECRET_KEY is a live key: live charges need BILLING_ALLOW_LIVE=true and APP_ENV=production");
    }
    const webhookSecret = (env.STRIPE_WEBHOOK_SECRET ?? "").trim();
    if (!/^whsec_[A-Za-z0-9]{16,}$/.test(webhookSecret)) throw new Error("STRIPE_WEBHOOK_SECRET must be the endpoint's signing secret (whsec_…) with BILLING_PROVIDER=stripe");
    const promo = (env.STRIPE_ALLOW_PROMOTION_CODES ?? "false").trim();
    if (promo !== "true" && promo !== "false") throw new Error("STRIPE_ALLOW_PROMOTION_CODES must be true or false");
    return {
      provider: new StripeProvider({ secretKey: key, webhookSecret, allowPromotionCodes: promo === "true" }),
      unavailableReason: null,
      returnUrl: returnUrl(env.BILLING_RETURN_URL, production),
    };
  }
  throw new Error(`BILLING_PROVIDER: unknown provider "${name}" (known: none, sandbox, stripe)`);
}
