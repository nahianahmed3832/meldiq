import type { PayPalEnvironment } from "./paypalApi.js";

export interface PayPalCardCapabilities {
  oneTime: boolean;
  vault: boolean;
  recurring: boolean;
  merchantCountry: string | null;
  productionApproved: boolean;
  reason: string | null;
}
const flag = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name] ?? "false";
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
};

/** An app checkbox is evidence, not permission to start untested live recurring card charges. */
export function paypalCardCapabilities(env: NodeJS.ProcessEnv, environment: PayPalEnvironment): PayPalCardCapabilities {
  const oneTime = flag(env, "PAYPAL_ADVANCED_CHECKOUT_ENABLED");
  const vault = flag(env, "PAYPAL_VAULT_ENABLED");
  const recurring = flag(env, "PAYPAL_CARD_RECURRING_ENABLED");
  const advancedApproved = flag(env, "PAYPAL_ADVANCED_CHECKOUT_APPROVED");
  const vaultApproved = flag(env, "PAYPAL_VAULT_APPROVED");
  const recurringApproved = flag(env, "PAYPAL_CARD_RECURRING_APPROVED");
  const compliance = flag(env, "PAYPAL_CARD_COMPLIANCE_CONFIRMED");
  const country = env.PAYPAL_MERCHANT_COUNTRY?.trim().toUpperCase() || null;
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error("PAYPAL_MERCHANT_COUNTRY must be an ISO 3166-1 alpha-2 country code");
  if (vault && !oneTime) throw new Error("PAYPAL_VAULT_ENABLED requires Advanced Checkout");
  if (recurring && !vault) throw new Error("PAYPAL_CARD_RECURRING_ENABLED requires card vaulting");
  if ((vault || recurring) && !env.PLATFORM_SECRETS_KEY) throw new Error("Card vaulting requires PLATFORM_SECRETS_KEY for encrypted token storage");
  if (environment === "live" && oneTime && (!country || !advancedApproved || !compliance)) throw new Error("Live embedded cards require confirmed merchant country, Advanced Checkout approval and applicable PCI compliance");
  if (environment === "live" && vault && !vaultApproved) throw new Error("Live card vaulting requires explicit PayPal vault approval");
  if (environment === "live" && recurring && !recurringApproved) throw new Error("Live recurring cards require explicit merchant-initiated recurring approval and completed sandbox verification");
  return { oneTime, vault, recurring, merchantCountry: country, productionApproved: environment === "live" && advancedApproved && compliance, reason: oneTime ? null : "Embedded card checkout has not been enabled for this merchant. PayPal Wallet is a separate payment option." };
}
