import {
  CommunityPayPal,
  type CommunityOffer,
} from "../src/modules/billing/providers/communityPayPal.js";
import { HttpPayPalApi } from "../src/modules/billing/providers/paypalApi.js";

function configured(key: string) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Configure ${key} with Sandbox values.`);
  return value;
}

try {
  const offers = ["supercharge", "boost", "super", "mega", "promoted"] as const;
  const ids = Object.fromEntries(
    offers.map((offer) => [
      offer,
      configured(`PAYPAL_SANDBOX_COMMUNITY_${offer.toUpperCase()}_PLAN_ID`),
    ]),
  ) as Record<CommunityOffer, string>;
  if (new Set(Object.values(ids)).size !== offers.length)
    throw new Error("Each offer requires a distinct PayPal plan.");
  const api = new HttpPayPalApi(
    configured("PAYPAL_SANDBOX_CLIENT_ID"),
    configured("PAYPAL_SANDBOX_CLIENT_SECRET"),
    "sandbox",
  );
  const checks = new CommunityPayPal(
    api,
    "sandbox",
    configured("PAYPAL_SANDBOX_COMMUNITY_PRODUCT_ID"),
    ids,
  );
  for (const offer of offers) {
    await checks.verify(offer);
    process.stdout.write(`${offer}: verified\n`);
  }
} catch {
  process.stderr.write(
    "Community PayPal verification failed. Check the Sandbox configuration and plan terms.\n",
  );
  process.exitCode = 1;
}
