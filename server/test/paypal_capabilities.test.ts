import { assertCardAuthentication } from "../src/modules/billing/providers/paypal.js";
import { describe, expect, it } from "vitest";
import { paypalCardCapabilities } from "../src/modules/billing/providers/paypalCapabilities.js";

describe("PayPal embedded card activation gates", () => {
  it("preserves existing wallet sales without activating new card capabilities", () => {
    expect(paypalCardCapabilities({}, "live")).toMatchObject({ oneTime: false, vault: false, recurring: false, productionApproved: false });
  });
  it("allows explicitly configured sandbox cards and encrypted vaulting", () => {
    expect(paypalCardCapabilities({ PAYPAL_ADVANCED_CHECKOUT_ENABLED: "true", PAYPAL_VAULT_ENABLED: "true", PAYPAL_CARD_RECURRING_ENABLED: "true", PLATFORM_SECRETS_KEY: "configured" }, "sandbox")).toMatchObject({ oneTime: true, vault: true, recurring: true, productionApproved: false });
  });
  it("refuses live card flags without merchant and compliance verification", () => {
    expect(() => paypalCardCapabilities({ PAYPAL_ADVANCED_CHECKOUT_ENABLED: "true" }, "live")).toThrow(/country/);
  });
  it("does not treat Advanced Checkout approval as vault or recurring approval", () => {
    const env = { PAYPAL_ADVANCED_CHECKOUT_ENABLED: "true", PAYPAL_ADVANCED_CHECKOUT_APPROVED: "true", PAYPAL_CARD_COMPLIANCE_CONFIRMED: "true", PAYPAL_MERCHANT_COUNTRY: "US", PAYPAL_VAULT_ENABLED: "true", PLATFORM_SECRETS_KEY: "configured" };
    expect(() => paypalCardCapabilities(env, "live")).toThrow(/vault approval/);
    expect(() => paypalCardCapabilities({ ...env, PAYPAL_VAULT_APPROVED: "true", PAYPAL_CARD_RECURRING_ENABLED: "true" }, "live")).toThrow(/recurring approval/);
  });
  it("fails closed on invalid or incomplete settings", () => {
    expect(() => paypalCardCapabilities({ PAYPAL_VAULT_ENABLED: "true" }, "sandbox")).toThrow(/Advanced Checkout/);
    expect(() => paypalCardCapabilities({ PAYPAL_ADVANCED_CHECKOUT_ENABLED: "yes" }, "sandbox")).toThrow(/true or false/);
    expect(() => paypalCardCapabilities({ PAYPAL_MERCHANT_COUNTRY: "USA" }, "sandbox")).toThrow(/country code/);
  });
});

it("refuses explicit bank-authentication failures independently of the SDK callback", () => {
  expect(() => assertCardAuthentication({ authentication_result: { three_d_secure: { authentication_status: "N" } } })).toThrow(/authenticate/);
  expect(() => assertCardAuthentication({ authentication_result: { authentication_status: "R" } })).toThrow(/authenticate/);
  expect(() => assertCardAuthentication({ authentication_result: { three_d_secure: { authentication_status: "Y" } } })).not.toThrow();
  expect(() => assertCardAuthentication(undefined)).not.toThrow();
});
