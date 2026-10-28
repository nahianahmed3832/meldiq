/**
 * SQLite's text rules, for filters that used to run as SQL and now run on rows from another store: `lower()`, `LIKE`
 * and NOCASE fold ASCII letters only (without the ICU extension), so a non-ASCII capital never matches its lowercase.
 */
export const foldAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** `value LIKE '%term%'` in SQLite: ASCII case ignored, NULL never matches. */
export function likeContains(value: string | null | undefined, term: string): boolean {
  return value != null && foldAscii(value).includes(foldAscii(term));
}

/** `value LIKE 'term%'` in SQLite: ASCII case ignored, NULL never matches. */
export function likeStarts(value: string | null | undefined, term: string): boolean {
  return value != null && foldAscii(value).startsWith(foldAscii(term));
}

/** SQLite's BINARY order for text (code units), for sorts that used to be ORDER BY. */
export const compareText = (a: string | null | undefined, b: string | null | undefined): number => {
  if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
