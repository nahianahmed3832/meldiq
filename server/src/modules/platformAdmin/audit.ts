import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { now, sha256Hex } from "../../shared/utilities/util.js";

/**
 * The platform audit trail (migration 046): append-only (in SQLite, triggers refuse UPDATE and DELETE) and hash-chained,
 * each row's hash covering the previous row's hash and its own fields, so an edited, inserted or removed row breaks the
 * chain at that point. It records who did what to which target, the outcome and the reason; never passwords, tokens,
 * codes, passkey material or message content ([detail] takes only short scalar values).
 */
export type AuditOutcome = "success" | "denied" | "failed";

export interface AuditEntry {
  action: string;
  outcome: AuditOutcome;
  actorAccountId?: string | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  network?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

export interface AuditRow {
  id: number;
  at: number;
  request_id: string | null;
  actor_account_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: AuditOutcome;
  reason: string | null;
  network: string | null;
  detail: string | null;
  prev_hash: string;
  hash: string;
}

export const GENESIS_HASH = "0".repeat(64);
const MAX_DETAIL_KEYS = 12;
const MAX_DETAIL_VALUE = 200;

/** The fields a row's hash covers, in a fixed order (adding a column means a new version of this list). */
const HASHED: readonly (keyof AuditRow)[] = ["id", "at", "request_id", "actor_account_id", "actor_role", "action", "target_type", "target_id", "outcome", "reason", "network", "detail"];

export function rowHash(prevHash: string, row: Omit<AuditRow, "prev_hash" | "hash">): string {
  return sha256Hex(prevHash + "\n" + JSON.stringify(HASHED.map((k) => row[k as keyof typeof row] ?? null)));
}

function detailJson(detail: AuditEntry["detail"]): string | null {
  if (!detail) return null;
  const entries = Object.entries(detail).slice(0, MAX_DETAIL_KEYS);
  if (entries.length === 0) return null;
  return JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, typeof v === "string" ? v.slice(0, MAX_DETAIL_VALUE) : v])));
}

export class PlatformAudit {
  /** [platform]: the platform domain's rows, which hold platform_audit. */
  constructor(private readonly platform: Rows) {}

  /** Appends [e] in its own unit; resolves once it is durable. */
  record(e: AuditEntry, t = now()): Promise<AuditRow> {
    return this.platform.write((w) => this.append(w, e, t));
  }

  /**
   * Appends [e] inside the caller's platform unit [w], so a change and its record land together. Units run one at a
   * time and the last row is read inside the unit, so two appends can't chain onto the same row.
   */
  append(w: RowWriter, e: AuditEntry, t = now()): AuditRow {
    const last = w.get<{ id: number; hash: string }>("platform_audit", {}, [["id", "desc"]]);
    const body = {
      id: (last?.id ?? 0) + 1,
      at: t,
      request_id: e.requestId ?? null,
      actor_account_id: e.actorAccountId ?? null,
      actor_role: e.actorRole ?? null,
      action: e.action,
      target_type: e.targetType ?? null,
      target_id: e.targetId ?? null,
      outcome: e.outcome,
      reason: e.reason ?? null,
      network: e.network ?? null,
      detail: detailJson(e.detail),
    };
    const prev = last?.hash ?? GENESIS_HASH;
    const row: AuditRow = { ...body, prev_hash: prev, hash: rowHash(prev, body) };
    w.insert("platform_audit", { ...row });
    return row;
  }

  /** Walks the whole chain in id order; the first row whose link or hash doesn't match, or null when all do. */
  verify(): { rows: number; brokenAt: number | null; lastHash: string } {
    let prev = GENESIS_HASH;
    let expectedId = 1;
    let rows = 0;
    for (const r of this.platform.all<AuditRow>("platform_audit", { orderBy: [["id", "asc"]] })) {
      const { prev_hash, hash, ...body } = r;
      if (r.id !== expectedId || prev_hash !== prev || rowHash(prev, body) !== hash) return { rows, brokenAt: r.id, lastHash: prev };
      prev = hash;
      expectedId++;
      rows++;
    }
    return { rows, brokenAt: null, lastHash: prev };
  }
}
