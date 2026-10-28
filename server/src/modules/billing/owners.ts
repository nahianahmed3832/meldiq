import type { OwnerRef } from "./providers/types.js";

/**
 * Who billing belongs to (docs/BILLING.md › Owners): an organization (its OWNER role manages it, its members get its
 * plan), or a person's account (accounts.id: the permanent sign-in identity, which every client signs in to). The owner
 * of a checkout comes from the signed-in session only; the owner of a subscription only from our own checkout.
 */
export type BillingOwner = { kind: "org"; orgId: string } | { kind: "account"; accountId: string };

export const ownerParam = (o: BillingOwner): string => (o.kind === "org" ? o.orgId : o.accountId);

/**
 * The SQL condition selecting an owner's rows in the billing tables (with [ownerParam] as its one parameter); [alias]
 * qualifies the columns ("c." for a table aliased c).
 */
export const ownerClause = (o: BillingOwner, alias = ""): string =>
  o.kind === "org" ? `${alias}owner_kind = 'org' AND ${alias}org_id = ?` : `${alias}owner_kind = 'account' AND ${alias}account_id = ?`;

export function ownerOfRow(r: { owner_kind: "org" | "account"; org_id: string | null; account_id: string | null }): BillingOwner {
  return r.owner_kind === "org" ? { kind: "org", orgId: r.org_id! } : { kind: "account", accountId: r.account_id! };
}

export const ownerRef = (o: BillingOwner): OwnerRef => ({ kind: o.kind, id: ownerParam(o) });
