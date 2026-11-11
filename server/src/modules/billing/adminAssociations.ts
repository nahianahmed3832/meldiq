import type { RowReader } from "../../infrastructure/database/rows/index.js";

/** A support association uses canonical local records and returns only their ownership, never provider credentials. */
export function adminPaymentAssociation(
  rows: RowReader,
  kind: "invoice" | "gift" | "spark" | "collectible",
  id: string,
):
  | {
      account_id: string | null;
      org_id: string | null;
      subscription_id: string | null;
    }
  | undefined {
  if (kind === "invoice") {
    const row = rows.get<{
      account_id: string | null;
      org_id: string | null;
      subscription_id: string | null;
    }>("billing_invoices", { id });
    return row
      ? {
          account_id: row.account_id,
          org_id: row.org_id,
          subscription_id: row.subscription_id,
        }
      : undefined;
  }
  if (kind === "gift") {
    const row = rows.get<{ buyer_account_id: string }>("mojo_gifts", { id });
    return row
      ? {
          account_id: row.buyer_account_id,
          org_id: null,
          subscription_id: null,
        }
      : undefined;
  }
  if (kind === "spark") {
    const row = rows.get<{ buyer_account_id: string }>("spark_purchases", {
      id,
    });
    return row
      ? {
          account_id: row.buyer_account_id,
          org_id: null,
          subscription_id: null,
        }
      : undefined;
  }
  const row = rows.get<{ account_id: string }>("collectible_orders", { id });
  return row
    ? { account_id: row.account_id, org_id: null, subscription_id: null }
    : undefined;
}
