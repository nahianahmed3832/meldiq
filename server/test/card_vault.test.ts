import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../src/infrastructure/database/db.js";
import { describeTables } from "../src/infrastructure/database/mongo/catalog.js";
import { SqliteRows } from "../src/infrastructure/database/rows/index.js";
import { SecretBox } from "../src/infrastructure/crypto/secretBox.js";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";
import type { PayPalApi } from "../src/modules/billing/providers/paypalApi.js";
import { CardVault } from "../src/modules/billing/cardVault.js";
class VaultApi implements PayPalApi {
  approved = false;
  removed = false;
  customer = "owner-a";
  calls: string[] = [];
  async request(method: string, path: string) {
    this.calls.push(`${method} ${path}`);
    if (path === "/v3/vault/setup-tokens") return { id: "SETUP-OWNED" };
    if (path === "/v3/vault/setup-tokens/SETUP-OWNED") return { id: "SETUP-OWNED", status: this.approved ? "APPROVED" : "CREATED", customer: { merchant_customer_id: this.customer } };
    if (path === "/v3/vault/payment-tokens") return { id: "TOKEN-PRIVATE", customer: { id: "CUSTOMER-PRIVATE" }, payment_source: { card: { brand: "VISA", last_digits: "1111", expiry: "2030-12" } } };
    if (method === "DELETE" && path === "/v3/vault/payment-tokens/TOKEN-PRIVATE") { this.removed = true; return undefined; }
    throw new Error("Unexpected vault request");
  }
}
const opened: DB[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
function fixture() {
  const db = openDatabase(":memory:"); opened.push(db);
  const rows = new SqliteRows(db, describeTables(db).filter(t => t.domain === "billing"));
  const api = new VaultApi();
  const provider = new PayPalProvider({ environment: "sandbox", clientId: "public", clientSecret: "private", webhookId: "hook", merchantId: "merchant", plusPlanId: "P-PLUS", subscriptionsApproved: true, api, cardCapabilities: { oneTime: true, vault: true, recurring: false, merchantCountry: "CN", productionApproved: false, reason: null } });
  let now = 1800000000000;
  const vault = new CardVault(rows, provider, new SecretBox(randomBytes(32)), "https://web.example/settings/billing", () => now);
  return { db, rows, api, vault, advance: () => { now += 31 * 60000; } };
}
describe("owner-bound saved card setup", () => {
  it("requires authoritative approval, keeps references encrypted and completes idempotently", async () => {
    const { vault, api, rows } = fixture();
    const requestKey = randomUUID();
    const setup = await vault.start("owner-a", requestKey);
    expect(await vault.start("owner-a", requestKey)).toEqual(setup);
    expect(api.calls.filter(c => c === "POST /v3/vault/setup-tokens")).toHaveLength(1);
    await expect(vault.complete("owner-a", setup.id)).rejects.toThrow();
    await expect(vault.complete("owner-b", setup.id)).rejects.toMatchObject({ statusCode: 404 });
    api.approved = true;
    const [a, b] = await Promise.all([vault.complete("owner-a", setup.id), vault.complete("owner-a", setup.id)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ brand: "VISA", lastFour: "1111" });
    expect(rows.count("billing_payment_methods")).toBe(1);
    expect(JSON.stringify(rows.all("billing_payment_methods"))).not.toContain("TOKEN-PRIVATE");
    expect(JSON.stringify(vault.list("owner-a"))).not.toMatch(/TOKEN-PRIVATE|CUSTOMER-PRIVATE|encrypted/);
    expect(vault.list("owner-b")).toEqual([]);
    expect(() => vault.reference("owner-b", a.id)).toThrow();
    expect(vault.reference("owner-a", a.id).token).toBe("TOKEN-PRIVATE");
    await expect(vault.remove("owner-b", a.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await vault.remove("owner-a", a.id)).toEqual({ removed: true });
    expect(api.removed).toBe(true);
    expect(vault.list("owner-a")).toEqual([]);
    expect(await vault.remove("owner-a", a.id)).toEqual({ removed: true });
  });
  it("rejects expired setups and mismatched provider ownership", async () => {
    const a = fixture(); const first = await a.vault.start("owner-a", randomUUID()); a.api.approved = true; a.api.customer = "owner-b";
    await expect(a.vault.complete("owner-a", first.id)).rejects.toThrow(/ownership/);
    a.api.customer = "owner-a"; a.advance();
    await expect(a.vault.complete("owner-a", first.id)).rejects.toThrow(/ended/);
  });
});
