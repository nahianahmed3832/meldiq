import type { RowReader } from "../../infrastructure/database/rows/index.js";
/** Internal filter resolution only. Callers must independently authorize every returned message and never expose this identity list. */
export function messageFilterIdentities(
  rows: RowReader,
  query: string,
  name: string,
): string[] {
  return rows
    .all<{ id: string; username: string; display_name: string }>("users")
    .filter(
      (u) =>
        u.id === query ||
        u.username.toLowerCase().includes(name) ||
        u.display_name.toLowerCase().includes(name),
    )
    .map((u) => u.id);
}
