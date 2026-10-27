/**
 * The quotas the engine knows (docs/QUOTAS.md). Each has one accounting rule, so the same operation is never charged
 * twice to one scope:
 *
 * - counter: an amount used per period (UTC day or month), charged when the operation is accepted (reserved first when
 *   it can fail part-way, then committed or released);
 * - gauge: an amount held now (stored bytes, open sockets), measured from its source at check time, plus what open
 *   reservations hold;
 * - per_request: a ceiling on one operation (the size of one upload), nothing accumulates.
 *
 * Scopes a key may be limited at are listed per key. A person's usage and their organization's are separate
 * counters: an upload into a community counts once against the uploader and once against the community, and each
 * limit is checked against its own counter (never the same counter twice).
 */
export type QuotaKind = "counter" | "gauge" | "per_request";
export type QuotaPeriod = "day" | "month" | "none";
export type ScopeType = "global" | "pool" | "plan" | "org" | "user";

export interface QuotaKeyDef {
  label: string;
  unit: "bytes" | "count" | "tokens" | "micro_usd" | "seconds";
  kind: QuotaKind;
  period: QuotaPeriod;
  /** Scopes whose own usage this key is checked against (plan policies apply to the plan's members' scopes). */
  scopes: readonly ("global" | "pool" | "org" | "user")[];
  /** Modes beyond observe/warn this key may use (sign-in and essential flows are never blocked). */
  enforceable: readonly ("soft" | "throttle" | "block")[];
  /** Where it's enforced, in plain words (shown in the console). */
  enforcedAt: string;
}

export const QUOTA_KEYS = {
  "storage.bytes": {
    label: "Stored file bytes",
    unit: "bytes",
    kind: "gauge",
    period: "none",
    scopes: ["global", "org", "user"],
    enforceable: ["soft", "block"],
    enforcedAt: "File uploads (before anything is received)",
  },
  "files.upload_bytes": {
    label: "Uploaded bytes per month",
    unit: "bytes",
    kind: "counter",
    period: "month",
    scopes: ["global", "org", "user"],
    enforceable: ["soft", "block"],
    enforcedAt: "File uploads (reserved at start, committed when stored, released if it fails)",
  },
  "files.download_bytes": {
    label: "Downloaded bytes per month",
    unit: "bytes",
    kind: "counter",
    period: "month",
    scopes: ["global", "org", "user"],
    enforceable: ["soft", "block"],
    enforcedAt: "File downloads (bytes asked for, charged when the download is allowed)",
  },
  "files.max_upload_bytes": {
    label: "Largest single upload",
    unit: "bytes",
    kind: "per_request",
    period: "none",
    scopes: ["global", "org", "user"],
    enforceable: ["block"],
    enforcedAt: "File uploads; never above the server's FILE_MAX_BYTES",
  },
  "ws.connections": {
    label: "Open realtime connections",
    unit: "count",
    kind: "gauge",
    period: "none",
    scopes: ["pool", "user"],
    enforceable: ["block"],
    enforcedAt: "Opening a realtime connection",
  },
  "sessions.active": {
    label: "Signed-in app sessions",
    unit: "count",
    kind: "gauge",
    period: "none",
    scopes: ["user"],
    enforceable: [],
    enforcedAt: "Sign-in (observed and warned only: signing in is never blocked by a quota)",
  },
  "api.requests": {
    label: "API requests per day",
    unit: "count",
    kind: "counter",
    period: "day",
    scopes: ["global", "org", "user"],
    enforceable: [],
    enforcedAt: "Every authenticated request (observed and warned only; the per-minute rate limiter throttles)",
  },
} as const satisfies Record<string, QuotaKeyDef>;

export type QuotaKey = keyof typeof QUOTA_KEYS;

export const isQuotaKey = (k: string): k is QuotaKey => Object.hasOwn(QUOTA_KEYS, k);

export const MODES = ["observe", "warn", "soft", "throttle", "block"] as const;
export type QuotaMode = (typeof MODES)[number];

/** The accounting period containing [t] for [period]: "2026-10-24", "2026-10" or "all". */
export function periodOf(period: QuotaPeriod, t: number): string {
  const iso = new Date(t).toISOString();
  return period === "day" ? iso.slice(0, 10) : period === "month" ? iso.slice(0, 7) : "all";
}

/** When the period containing [t] ends (the reset time), or null for keys that don't reset. */
export function periodEnd(period: QuotaPeriod, t: number): number | null {
  const d = new Date(t);
  if (period === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  if (period === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return null;
}
