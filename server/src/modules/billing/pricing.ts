/** Approved new-purchase terms. Existing agreements retain their immutable historical catalog version. */
export const PRICING_VERSION = "2026-11-02.plus-terms-v3";
export const PLUS_PRICE_MINOR = 499;
export const PRICING_EFFECTIVE_AT = Date.parse("2026-11-02T00:00:00+08:00");
export const PLUS_TERMS = {
 monthly: { key: "monthly", months: 1, amountMinor: 499, interval: "month", billingFrequency: 1 },
 quarterly: { key: "quarterly", months: 3, amountMinor: 1299, interval: "month", billingFrequency: 3 },
 yearly: { key: "yearly", months: 12, amountMinor: 4999, interval: "year", billingFrequency: 1 },
} as const;
export type PlusTerm = keyof typeof PLUS_TERMS;
export const PRICING = {
 free: { id: "free", name: "Meldiq Free", currency: "USD", amountMinor: 0, billingInterval: null, billingFrequency: 0, productId: "free", active: true },
 plus: { id: "plus", name: "Meldiq Plus", currency: "USD", amountMinor: PLUS_PRICE_MINOR, billingInterval: "month", billingFrequency: 1, productId: "plus", active: true },
} as const;
export function termOf(t: { interval: string; billingFrequency?: number; billing_frequency?: number }): PlusTerm | null {
 const frequency = t.billingFrequency ?? t.billing_frequency ?? 1;
 return Object.values(PLUS_TERMS).find(p => p.interval === t.interval && p.billingFrequency === frequency)?.key ?? null;
}
export function isOfficialPlus(t: { currency: string; amountMinor: number; interval: string; billingFrequency?: number; billing_frequency?: number }): boolean {
 const key = termOf(t); return t.currency === "USD" && key !== null && t.amountMinor === PLUS_TERMS[key].amountMinor;
}
export function plusTermViews() { return Object.values(PLUS_TERMS).map(p => ({ ...p, currency: "USD" as const, savingsMinor: PLUS_PRICE_MINOR * p.months - p.amountMinor, monthlyEquivalentMinor: Math.round(p.amountMinor / p.months), savingsPercent: Math.round((PLUS_PRICE_MINOR*p.months-p.amountMinor)*10000/(PLUS_PRICE_MINOR*p.months))/100 })); }
