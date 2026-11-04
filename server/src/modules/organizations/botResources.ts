import type { Rows } from "../../infrastructure/database/rows/index.js";

/** Community-owned resource lookup for scoped transport adapters. Controllers still check native authority. */
export function botResourceCommunity(
  rows: Rows,
  kind: "role" | "category" | "expression",
  id: string,
): string | null {
  const table = {
    role: "org_roles",
    category: "channel_categories",
    expression: "community_expressions",
  }[kind];
  return rows.get<{ org_id: string }>(table, { id })?.org_id ?? null;
}
