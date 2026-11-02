import { assertCardAuthentication } from "./providers/paypal.js";
import { PayPalResourceNotFound } from "./providers/paypalApi.js";
import { z } from "zod/v4";
import { SecretBox } from "../../infrastructure/crypto/secretBox.js";
import type { Rows } from "../../infrastructure/database/rows/index.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import type { PayPalProvider } from "./providers/paypal.js";

interface Setup { id: string; account_id: string; provider_ref: string | null; status: string; expires_at: number; payment_method_id: string | null }
export interface CardMethod { id: string; account_id: string; provider: string; token_encrypted: string; customer_encrypted: string; brand: string; last_four: string; expiry: string | null; status: string; created_at: number; updated_at: number }
const providerId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+$/);
const tokenResult = z.object({ id: providerId, customer: z.object({ id: providerId }), payment_source: z.object({ card: z.object({ brand: z.string().min(1).max(40), last_digits: z.string().regex(/^\d{4}$/), expiry: z.string().regex(/^\d{4}-\d{2}$/).optional() }) }) });
const bound = (method: Pick<CardMethod, "id" | "account_id">, field: string) => `billing-card:${method.account_id}:${method.id}:${field}`;

/** Owner-bound setup intents and encrypted provider references. No API accepts raw card data or provider token IDs. */
export class CardVault {
  constructor(private readonly rows: Rows, readonly provider: PayPalProvider, private readonly secrets: SecretBox, private readonly returnUrl: string, private readonly clock: () => number = Date.now) {}
  private enabled() {
    if (!this.provider.options.cardCapabilities?.vault || !this.secrets.available) throw new ApiError(409, "billing_unavailable", "Saved card checkout is not enabled for this merchant.");
  }
  private setup(accountId: string, id: string): Setup {
    const setup = this.rows.get<Setup>("billing_card_setups", { id, account_id: accountId });
    if (!setup) throw notFound("Card setup not found");
    return setup;
  }
  list(accountId: string) {
    return this.rows.all<CardMethod>("billing_payment_methods", { where: { account_id: accountId, status: "active" }, orderBy: [["created_at", "desc"]] }).map(m => this.view(m));
  }
  private view(m: CardMethod) { return { id: m.id, brand: m.brand, lastFour: m.last_four, expiry: m.expiry, createdAt: m.created_at }; }
  owned(accountId: string, id: string): CardMethod {
    const method = this.rows.get<CardMethod>("billing_payment_methods", { id, account_id: accountId, status: "active" });
    if (!method) throw notFound("Payment method not found");
    return method;
  }
  /** Only payment processing code can recover a token. Responses always use view(), never this method. */
  reference(accountId: string, id: string) {
    const method = this.owned(accountId, id);
    return { token: this.secrets.open(method.token_encrypted, bound(method, "token")), customer: this.secrets.open(method.customer_encrypted, bound(method, "customer")) };
  }
  async start(accountId: string, requestKey: string) {
    this.enabled();
    const t = this.clock();
    const id = await this.rows.write(w => {
      const previous = w.get<Setup>("billing_card_setups", { account_id: accountId, request_key: requestKey });
      if (previous) return previous.id;
      const id = newId("cst");
      w.insert("billing_card_setups", { id, account_id: accountId, request_key: requestKey, provider: "paypal", provider_ref: null, status: "pending", created_at: t, expires_at: t + 30 * 60000, completed_at: null, payment_method_id: null });
      return id;
    });
    let setup = this.setup(accountId, id);
    if (setup.status !== "pending" || setup.expires_at <= t) throw conflict("This card setup has ended. Start a fresh setup.");
    if (!setup.provider_ref) {
      const created = z.object({ id: providerId }).parse(await this.provider.api.request("POST", "/v3/vault/setup-tokens", {
        customer: { merchant_customer_id: accountId },
        payment_source: { card: { verification_method: "SCA_WHEN_REQUIRED", experience_context: { brand_name: "Meldiq", return_url: this.returnUrl, cancel_url: this.returnUrl } } },
      }, `card-setup-${id}`));
      await this.rows.write(w => w.update("billing_card_setups", { id, account_id: accountId, status: "pending" }, { provider_ref: created.id }));
      setup = this.setup(accountId, id);
    }
    // A short-lived owned setup reference is required by the hosted SDK; saved payment tokens are never returned.
    return { id, setupToken: setup.provider_ref!, expiresAt: setup.expires_at };
  }
  async complete(accountId: string, id: string) {
    this.enabled();
    const setup = this.setup(accountId, id);
    if (setup.status === "completed" && setup.payment_method_id) return this.view(this.owned(accountId, setup.payment_method_id));
    if (!["pending", "completing"].includes(setup.status) || setup.status === "pending" && setup.expires_at <= this.clock() || !setup.provider_ref) throw conflict("This card setup has ended.");
    if (setup.status === "completing" && this.clock() - setup.expires_at > 3 * 3600000) throw conflict("This card verification needs reconciliation before another setup is started.");
    if (setup.status === "pending") {
    const verified = z.object({ id: providerId, status: z.literal("APPROVED"), payment_source: z.object({ card: z.unknown().optional() }).optional(), customer: z.object({ merchant_customer_id: z.string().optional() }).optional() }).parse(await this.provider.api.request("GET", `/v3/vault/setup-tokens/${encodeURIComponent(setup.provider_ref)}`));
    if (verified.payment_source?.card) assertCardAuthentication(verified.payment_source.card);
    if (verified.id !== setup.provider_ref || verified.customer?.merchant_customer_id && verified.customer.merchant_customer_id !== accountId) throw conflict("Card setup ownership could not be verified.");
    await this.rows.write(w => { const current = w.get<Setup>("billing_card_setups", { id, account_id: accountId }); if (!current || !["pending", "completing", "completed"].includes(current.status)) throw conflict("Card setup is no longer available."); if (current.status === "pending") w.update("billing_card_setups", { id, status: "pending" }, { status: "completing" }); });
    }
    const token = tokenResult.parse(await this.provider.api.request("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setup.provider_ref, type: "SETUP_TOKEN" } } }, `card-token-${id}`));
    const t = this.clock();
    const savedId = await this.rows.write(w => {
      const current = w.get<Setup>("billing_card_setups", { id, account_id: accountId })!;
      if (current.payment_method_id) return current.payment_method_id;
      if (current.status !== "completing") throw conflict("Card setup is no longer available.");
      const method = { id: newId("pm"), account_id: accountId };
      w.insert("billing_payment_methods", { ...method, provider: "paypal", token_encrypted: this.secrets.seal(token.id, bound(method, "token")), customer_encrypted: this.secrets.seal(token.customer.id, bound(method, "customer")), brand: token.payment_source.card.brand, last_four: token.payment_source.card.last_digits, expiry: token.payment_source.card.expiry ?? null, status: "active", created_at: t, updated_at: t });
      w.update("billing_card_setups", { id }, { status: "completed", completed_at: t, payment_method_id: method.id });
      return method.id;
    });
    return this.view(this.owned(accountId, savedId));
  }
  async sweep() {
    const t = this.clock();
    const expired = await this.rows.write(w => w.update("billing_card_setups", { status: "pending", expires_at: { lte: t } }, { status: "expired" }));
    for (const method of this.rows.all<CardMethod>("billing_payment_methods", { where: { status: "removing" }, limit: 20 })) { try { await this.remove(method.account_id, method.id); } catch { /* No card data in logs; retry the persisted removal next sweep. */ } }
    return expired;
  }
  async remove(accountId: string, id: string) {
    if (!this.secrets.available) throw new ApiError(503, "secrets_unavailable", "Card storage is temporarily unavailable.");
    const method = await this.rows.write(w => {
      const method = w.get<CardMethod>("billing_payment_methods", { id, account_id: accountId });
      if (!method) throw notFound("Payment method not found");
      if (method.status === "removed") return method;
      if (w.get("billing_card_mandates", { account_id: accountId, payment_method_id: id, status: { in: ["pending", "active", "past_due", "attention"] }, cancel_at: null })) throw conflict("Update or cancel the renewal before removing its payment method.");
      // Claim removal before the external API call: no new mandate can attach a method in this state.
      w.update("billing_payment_methods", { id, account_id: accountId }, { status: "removing", updated_at: this.clock() });
      return method;
    });
    if (method.status === "removed") return { removed: true as const };
    const ref = this.secrets.open(method.token_encrypted, bound(method, "token"));
    if (method.status === "removing") {
      try { await this.provider.api.request("GET", `/v3/vault/payment-tokens/${encodeURIComponent(ref)}`); }
      catch (e) {
        if (!(e instanceof PayPalResourceNotFound)) throw e;
        await this.rows.write(w => w.update("billing_payment_methods", { id, account_id: accountId, status: "removing" }, { status: "removed", updated_at: this.clock() }));
        return { removed: true as const };
      }
    }
    await this.provider.api.request("DELETE", `/v3/vault/payment-tokens/${encodeURIComponent(ref)}`);
    await this.rows.write(w => w.update("billing_payment_methods", { id, account_id: accountId, status: "removing" }, { status: "removed", updated_at: this.clock() }));
    return { removed: true as const };
  }
}
