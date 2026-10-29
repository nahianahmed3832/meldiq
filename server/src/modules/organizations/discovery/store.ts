import type { RowReader, Rows } from "../../../infrastructure/database/rows/index.js";
import type { BoostTier } from "../../../shared/contracts/http/discovery.js";

/** How a community shows in Discovery (community_discovery, migration 075). */
export interface DiscoveryRow {
  org_id: string;
  discoverable: number;
  blurb: string | null;
  tags: string;
  removed_at: number | null;
  removed_reason: string | null;
  official: number;
  updated_by: string;
  updated_at: number;
}

export type RecordState = "pending" | "active" | "cancelled";
export type RecordSource = "grant" | "purchase";

export interface BoostRow {
  id: string;
  org_id: string;
  tier: BoostTier;
  state: RecordState;
  source: RecordSource;
  price_cents: number;
  starts_at: number;
  ends_at: number;
  note: string | null;
  created_by: string;
  created_at: number;
}

export interface BookingRow {
  id: string;
  org_id: string;
  week_start: number;
  state: RecordState;
  source: RecordSource;
  price_cents: number;
  starts_at: number;
  ends_at: number;
  views: number;
  clicks: number;
  joins: number;
  note: string | null;
  created_by: string;
  created_at: number;
}

/** Discover's visit records are kept this many days (the weekly estimate needs 7). */
const VISIT_DAYS_KEPT = 14;
const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" in UTC. */
export const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

export function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Discovery's rows (migration 075): in the workspace domain, so SQLite or MongoDB with an in-memory copy, read
 * synchronously like the rest of a community's configuration.
 */
export class DiscoveryStore {
  constructor(readonly rows: Rows) {}

  settings(orgId: string, r: RowReader = this.rows): DiscoveryRow | undefined {
    return r.get<DiscoveryRow>("community_discovery", { org_id: orgId });
  }

  allSettings(orgIds: readonly string[]): Map<string, DiscoveryRow> {
    return new Map(this.rows.all<DiscoveryRow>("community_discovery", { where: { org_id: { in: orgIds } } }).map((r) => [r.org_id, r]));
  }

  /** Sets [patch] on [orgId]'s row, made with the defaults when there's none yet. */
  async patchSettings(orgId: string, patch: Partial<Omit<DiscoveryRow, "org_id">>, actorId: string, t: number): Promise<void> {
    await this.rows.write((w) => {
      const current = this.settings(orgId, w);
      const base: DiscoveryRow = current ?? { org_id: orgId, discoverable: 1, blurb: null, tags: "[]", removed_at: null, removed_reason: null, official: 0, updated_by: actorId, updated_at: t };
      w.upsert("community_discovery", { ...base, ...patch, updated_by: actorId, updated_at: t }, "replace");
    });
  }

  // ── Boosts and Promoted bookings ──

  /** Boosts of [orgIds] (all communities when left out) that are active and running at [t]. */
  runningBoosts(t: number, orgIds?: readonly string[]): BoostRow[] {
    return this.rows.all<BoostRow>("discovery_boosts", { where: { state: "active", starts_at: { lte: t }, ends_at: { gt: t }, ...(orgIds ? { org_id: { in: orgIds } } : {}) } });
  }

  /** [orgId]'s boosts that haven't ended at [t], soonest first. */
  boostsOf(orgId: string, t: number): BoostRow[] {
    return this.rows.all<BoostRow>("discovery_boosts", { where: { org_id: orgId, state: { ne: "cancelled" }, ends_at: { gt: t } }, orderBy: [["starts_at", "asc"], ["id", "asc"]] });
  }

  boost(id: string): BoostRow | undefined {
    return this.rows.get<BoostRow>("discovery_boosts", { id });
  }

  async addBoost(row: BoostRow): Promise<void> {
    await this.rows.write((w) => w.insert("discovery_boosts", { ...row }));
  }

  /** Bookings running at [t] (the Promoted row), oldest booking first. */
  runningBookings(t: number): BookingRow[] {
    return this.rows.all<BookingRow>("promoted_bookings", { where: { state: "active", starts_at: { lte: t }, ends_at: { gt: t } }, orderBy: [["created_at", "asc"], ["id", "asc"]] });
  }

  /** Bookings that hold a spot in the week starting [weekStart] (paid, granted or waiting for payment). */
  bookingsInWeek(weekStart: number, r: RowReader = this.rows): BookingRow[] {
    return r.all<BookingRow>("promoted_bookings", { where: { week_start: weekStart, state: { ne: "cancelled" } } });
  }

  /** [orgId]'s bookings ending after [since], soonest first. */
  bookingsOf(orgId: string, since: number): BookingRow[] {
    return this.rows.all<BookingRow>("promoted_bookings", { where: { org_id: orgId, state: { ne: "cancelled" }, ends_at: { gt: since } }, orderBy: [["starts_at", "asc"], ["id", "asc"]] });
  }

  booking(id: string): BookingRow | undefined {
    return this.rows.get<BookingRow>("promoted_bookings", { id });
  }

  /** Adds [row] if its week still has fewer than [spots] bookings and none is [row]'s community's; false otherwise. */
  async addBooking(row: BookingRow, spots: number): Promise<boolean> {
    return this.rows.write((w) => {
      const taken = this.bookingsInWeek(row.week_start, w);
      if (taken.length >= spots || taken.some((b) => b.org_id === row.org_id)) return false;
      w.insert("promoted_bookings", { ...row });
      return true;
    });
  }

  async cancel(table: "discovery_boosts" | "promoted_bookings", id: string): Promise<boolean> {
    return (await this.rows.write((w) => w.update(table, { id, state: { ne: "cancelled" } }, { state: "cancelled" }))) > 0;
  }

  /** Adds one to [column] of each booking in [ids]. */
  async countOn(ids: readonly string[], column: "views" | "clicks" | "joins"): Promise<void> {
    if (ids.length === 0) return;
    await this.rows.write((w) => {
      for (const b of w.all<BookingRow>("promoted_bookings", { where: { id: { in: ids } } })) w.update("promoted_bookings", { id: b.id }, { [column]: b[column] + 1 });
    });
  }

  // ── What Discover records ──

  /** Notes that [userId] opened Discover on [t]'s day (once a day), dropping records older than two weeks. */
  async noteVisit(userId: string, t: number): Promise<void> {
    const day = utcDay(t);
    if (this.rows.get("discovery_visits", { day, user_id: userId })) return;
    const firstToday = !this.rows.get("discovery_visits", { day });
    await this.rows.write((w) => {
      w.insert("discovery_visits", { day, user_id: userId }, { orIgnore: true });
      if (firstToday) w.delete("discovery_visits", { day: { lt: utcDay(t - VISIT_DAYS_KEPT * DAY_MS) } });
    });
  }

  /** Different people who opened Discover in the 7 days up to [t]. */
  weeklyVisitors(t: number): number {
    const rows = this.rows.all<{ user_id: string }>("discovery_visits", { where: { day: { gte: utcDay(t - 6 * DAY_MS) } } });
    return new Set(rows.map((r) => r.user_id)).size;
  }

  async noteClick(orgId: string, userId: string, t: number): Promise<void> {
    await this.rows.write((w) => w.upsert("discovery_clicks", { org_id: orgId, user_id: userId, at: t }, { at: t }));
  }

  clickedAt(orgId: string, userId: string): number | null {
    return this.rows.get<{ at: number }>("discovery_clicks", { org_id: orgId, user_id: userId })?.at ?? null;
  }

  /** Account deletion: what Discover recorded about [userId], and their bots' directory listings. */
  async deleteForUser(userId: string): Promise<void> {
    const mine = { visits: { user_id: userId }, clicks: { user_id: userId }, listings: { owner_id: userId } };
    if (this.rows.count("discovery_visits", mine.visits) + this.rows.count("discovery_clicks", mine.clicks) + this.rows.count("bot_listings", mine.listings) === 0) return;
    await this.rows.write((w) => {
      w.delete("discovery_visits", mine.visits);
      w.delete("discovery_clicks", mine.clicks);
      w.delete("bot_listings", mine.listings);
    });
  }
}
