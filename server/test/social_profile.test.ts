import { describe, expect, it } from "vitest";
import {
  displayName,
  providerDisplayName,
} from "../src/modules/accounts/social/profile.js";

describe("provider profile defaults", () => {
  it("normalizes names without corrupting non-Latin text or emoji", () => {
    expect(displayName("  নাহিয়ান\n Ahmed\u202e  ")).toBe("নাহিয়ান Ahmed");
    expect(displayName("😀".repeat(41))).toBe("😀".repeat(40));
    expect(displayName("X".repeat(100))).toHaveLength(80);
  });
  it.each([undefined, null, 42, {}, " \n\u202e "])(
    "ignores missing or malformed cosmetic metadata %j",
    (value) => {
      expect(displayName(value)).toBeUndefined();
    },
  );
  it("falls back from empty Discord display names without deriving names from email", () => {
    expect(
      providerDisplayName("discord", {
        custom_claims: { global_name: " " },
        full_name: "handle",
      }),
    ).toBe("handle");
    expect(
      providerDisplayName("google", { name: {}, full_name: " Google Name " }),
    ).toBe("Google Name");
    expect(
      providerDisplayName("google", { email: "private@example.test" }),
    ).toBeUndefined();
  });
});
