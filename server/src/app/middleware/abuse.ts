import net from "node:net";
import { now } from "../../shared/utilities/util.js";
import type { RowReader, Rows } from "../../infrastructure/database/rows/index.js";

/**
 * Abuse controls shared by several routes (docs/ABUSE_CONTROLS.md). Counters live in memory only: they hold network
 * addresses and user ids for at most a day, are never written to disk, and start empty after a restart.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * The network a request comes from, for per-address limits: an IPv4 address, or the /64 an IPv6 address is in (one
 * home or phone gets a whole /64, so counting single IPv6 addresses would be trivial to dodge).
 */
export function networkKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
}

/** Counts events per key over a sliding window, remembering at most [max] events per key and [maxKeys] keys. */
export class SlidingWindow {
  private hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  private recent(key: string, t: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((at) => at > t - this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Whether another event is allowed now (0 means no limit). Doesn't count it. */
  allows(key: string, t = now()): boolean {
    return this.max === 0 || this.recent(key, t).length < this.max;
  }

  /** Milliseconds until the oldest counted event leaves the window (0 when another is allowed). */
  retryAfterMs(key: string, t = now()): number {
    const list = this.recent(key, t);
    if (this.max === 0 || list.length < this.max) return 0;
    return Math.max(list[0] + this.windowMs - t, 0);
  }

  record(key: string, t = now()): void {
    if (this.max === 0) return;
    const list = this.recent(key, t);
    this.hits.set(key, [...list, t].slice(-this.max));
    if (this.hits.size > this.maxKeys) this.prune(t);
  }

  /** Forgets [key]'s events. */
  clear(key: string): void {
    this.hits.delete(key);
  }

  /** Forgets the events of every key starting with [prefix]. */
  clearPrefix(prefix: string): void {
    for (const k of [...this.hits.keys()]) if (k.startsWith(prefix)) this.hits.delete(k);
  }

  /** Forgets every key whose events have all left the window; if that isn't enough, the oldest keys. */
  private prune(t: number): void {
    for (const k of [...this.hits.keys()]) this.recent(k, t);
    for (const k of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}

/** Whether an account is still under new-account limits (docs/ABUSE_CONTROLS.md › New accounts). */
export function hasNewAccountLimits(identity: RowReader, userId: string, t = now()): boolean {
  const r = identity.get<{ limited_until: number | null }>("users", { id: userId });
  return !!r?.limited_until && r.limited_until > t;
}

/** The accounts still under new-account limits (their files share one allowance). */
export function limitedUserIds(identity: RowReader, t = now()): string[] {
  return identity.all<{ id: string }>("users", { where: { limited_until: { gt: t } } }).map((r) => r.id);
}

/** Ends an account's new-account limits. Returns whether it had any. */
export function endNewAccountLimits(identity: Rows, userId: string): Promise<boolean> {
  return identity.write((w) => w.update("users", { id: userId, limited_until: { ne: null } }, { limited_until: null }) > 0);
}

/**
 * Open registrations (no invitation) on this server in the last 24 hours, from the audit log: v1 sign-ups
 * ("user.register") and Orbit 2.0 account sign-ups ("account.register"). Setting up encryption for an account is logged
 * with a detail, so one person isn't counted twice.
 */
export function openRegistrationsToday(rows: RowReader, t = now()): number {
  return rows.count("audit_log", { action: { in: ["user.register", "account.register"] }, detail: null, at: { gt: t - DAY_MS } });
}

