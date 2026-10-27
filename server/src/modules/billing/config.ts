import { SandboxProvider } from "./providers/sandbox.js";
import type { BillingProvider } from "./providers/types.js";

/**
 * Billing settings (docs/BILLING.md). BILLING_PROVIDER picks the adapter:
 * - "none" (default): no checkout, no webhooks; the catalog can be prepared, nothing can be bought;
 * - "sandbox": the test-mode provider, with BILLING_SANDBOX_WEBHOOK_SECRET (at least 32 characters). Never real money.
 * A live provider is added as another adapter; until then the server can't take a real payment.
 */
export interface BillingConfig {
  provider: BillingProvider | null;
  /** Why there is no provider, in plain words for operators (null when there is one). */
  unavailableReason: string | null;
}

export const NO_PROVIDER = "No billing provider is configured (BILLING_PROVIDER), so nothing can be bought yet. Plans can be prepared.";

export function billingConfig(env: NodeJS.ProcessEnv): BillingConfig {
  const name = (env.BILLING_PROVIDER ?? "none").trim().toLowerCase() || "none";
  if (name === "none") return { provider: null, unavailableReason: NO_PROVIDER };
  if (name === "sandbox") {
    const secret = env.BILLING_SANDBOX_WEBHOOK_SECRET ?? "";
    if (secret.length < 32) throw new Error("BILLING_SANDBOX_WEBHOOK_SECRET must be at least 32 characters with BILLING_PROVIDER=sandbox");
    return { provider: new SandboxProvider(secret), unavailableReason: null };
  }
  throw new Error(`BILLING_PROVIDER: unknown provider "${name}" (known: none, sandbox)`);
}
