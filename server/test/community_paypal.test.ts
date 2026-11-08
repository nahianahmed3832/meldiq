import { describe, expect, it, vi } from "vitest";
import {
  COMMUNITY_OFFERS,
  CommunityPayPal,
  communityQuote,
  type CommunityOffer,
} from "../src/modules/billing/providers/communityPayPal.js";

const ids = {
  supercharge: "P-CHARGE1",
  boost: "P-BOOST1",
  super: "P-SUPER1",
  mega: "P-MEGA1",
  promoted: "P-PROMOTED1",
};
const product = "PROD-TEST1";
const plan = (key: CommunityOffer) => ({
  id: ids[key],
  product_id: product,
  status: "ACTIVE",
  quantity_supported: COMMUNITY_OFFERS[key].quantity,
  billing_cycles: [
    {
      tenure_type: "REGULAR",
      sequence: 1,
      total_cycles: 0,
      frequency: {
        interval_unit: COMMUNITY_OFFERS[key].interval,
        interval_count: 1,
      },
      pricing_scheme: {
        fixed_price: {
          currency_code: "USD",
          value: (COMMUNITY_OFFERS[key].cents / 100).toFixed(2),
        },
      },
    },
  ],
});

describe("community PayPal preparation", () => {
  it("quotes all quantities and verifies the fixed prices, quantity support and cadences", async () => {
    expect(
      [2, 7, 14].map(
        (quantity) => communityQuote("supercharge", quantity).amountMinor,
      ),
    ).toEqual([598, 2093, 4186]);
    expect(() => communityQuote("mega", 2)).toThrow();
    for (const key of Object.keys(ids) as CommunityOffer[]) {
      const api = { request: vi.fn(async () => plan(key)) };
      await expect(
        new CommunityPayPal(api, "sandbox", product, ids).verify(key),
      ).resolves.toBe(ids[key]);
    }
    const wrong = {
      request: vi.fn(async () => ({
        ...plan("supercharge"),
        quantity_supported: false,
      })),
    };
    await expect(
      new CommunityPayPal(wrong, "sandbox", product, ids).verify("supercharge"),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
  });

  it("uses Sandbox approval only and binds the agreement to the immutable quote", async () => {
    const api = {
      request: vi
        .fn()
        .mockResolvedValueOnce(plan("supercharge"))
        .mockResolvedValueOnce({
          id: "I-TEST1",
          links: [
            {
              rel: "approve",
              href: "https://www.sandbox.paypal.com/checkout/test",
            },
          ],
        })
        .mockResolvedValueOnce({
          id: "I-TEST1",
          plan_id: ids.supercharge,
          quantity: "7",
          custom_id: "reference",
          status: "APPROVAL_PENDING",
        })
        .mockResolvedValueOnce({
          id: "I-TEST1",
          plan_id: ids.supercharge,
          quantity: "2",
          custom_id: "reference",
          status: "ACTIVE",
        }),
    };
    const gateway = new CommunityPayPal(api, "sandbox", product, ids);
    await expect(
      gateway.createSandboxApproval(
        "supercharge",
        7,
        "reference",
        "https://example.test/return",
        "https://example.test/cancel",
      ),
    ).resolves.toMatchObject({ amountMinor: 2093, subscriptionId: "I-TEST1" });
    expect(api.request.mock.calls[1]?.[2]).toMatchObject({
      plan_id: ids.supercharge,
      quantity: "7",
      custom_id: "reference",
    });
    await expect(
      gateway.verifyAgreement("supercharge", 7, "reference", "I-TEST1"),
    ).resolves.toEqual({ status: "APPROVAL_PENDING" });
    await expect(
      gateway.verifyAgreement("supercharge", 7, "reference", "I-TEST1"),
    ).rejects.toThrow();
    const live = { request: vi.fn() };
    await expect(
      new CommunityPayPal(live, "live", product, ids).createSandboxApproval(
        "supercharge",
        7,
        "reference",
        "https://example.test/return",
        "https://example.test/cancel",
      ),
    ).rejects.toThrow();
    expect(live.request).not.toHaveBeenCalled();
  });
});
