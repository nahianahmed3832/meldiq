import type { z } from "zod/v4";
import { BOOST_TIERS, type BoostTier, DISCOVERY_LIMITS, type PromoteView } from "../../../shared/contracts/http/discovery.js";
import { ApiError, badRequest, notFound } from "../../../shared/errors.js";
import { newId } from "../../../shared/utilities/util.js";
import { NO_CHECKOUT, type PromoteCheckout } from "./checkout.js";
import { biggestTier, type Entry } from "./listing.js";
import type { Discovery } from "./service.js";
import type { BookingRow, BoostRow } from "./store.js";

const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Ended bookings stay in the community's Promote page this long (their views, clicks and joins). */
const ENDED_BOOKINGS_SHOWN_MS = 4 * WEEK_MS;

/** Mega Boost's guaranteed place: the top 20 from 1,000 members, the top 50 from 100, the top 100 below that. */
const MEGA_GUARANTEE = [
  { minMembers: 1000, top: 20 },
  { minMembers: 100, top: 50 },
  { minMembers: 0, top: 100 },
] as const;

/** Monday 00:00 UTC of [t]'s week. */
export function weekStartOf(t: number): number {
  const day = Math.floor(t / DAY_MS) * DAY_MS;
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return day - weekday * DAY_MS;
}

export function megaGuarantee(memberCount: number): number {
  return MEGA_GUARANTEE.find((g) => memberCount >= g.minMembers)!.top;
}

const boostView = (b: BoostRow) => ({ id: b.id, tier: b.tier, state: b.state, source: b.source, startsAt: b.starts_at, endsAt: b.ends_at });
const bookingView = (b: BookingRow) => ({ id: b.id, state: b.state, source: b.source, startsAt: b.starts_at, endsAt: b.ends_at, views: b.views, clicks: b.clicks, joins: b.joins });

/**
 * Promote (community parity batch E, feature "discovery-promote"): boosts (boost, super, mega) and the Promoted row's
 * 4 weekly spots, kept as records with a start, an end and a state. Buying goes through [checkout] (off while billing
 * is off); platform staff grant either from the console.
 */
export class Promote {
  checkout: PromoteCheckout = NO_CHECKOUT;

  constructor(private readonly d: Discovery) {}

  private get prices() {
    return this.d.config.prices;
  }

  requireEnabled(): void {
    this.d.requireEnabled();
    if (!this.d.config.promote) throw new ApiError(503, "feature_disabled", "Promote is switched off for now. Try again later.");
  }

  runningBookingsOf(orgId: string, t: number): BookingRow[] {
    return this.d.config.promote ? this.d.store.runningBookings(t).filter((b) => b.org_id === orgId) : [];
  }

  /** The Promoted row at [t]: running bookings of communities in [listed], oldest booking first, at most 4. */
  promotedRow(t: number, listed: readonly Entry[]): { booking: BookingRow; entry: Entry }[] {
    if (!this.d.config.promote) return [];
    const byId = new Map(listed.map((e) => [e.org.id, e]));
    return this.d.store
      .runningBookings(t)
      .flatMap((booking) => {
        const entry = byId.get(booking.org_id);
        return entry ? [{ booking, entry }] : [];
      })
      .slice(0, DISCOVERY_LIMITS.promotedSpots);
  }

  /** The first week from [from] (a week start) with a free spot [orgId] hasn't booked, within 8 weeks; null: all taken. */
  nextSpot(orgId: string, from: number): { startsAt: number; endsAt: number; spotsLeft: number } | null {
    for (let i = 0; i < DISCOVERY_LIMITS.horizonWeeks; i++) {
      const start = from + i * WEEK_MS;
      const taken = this.d.store.bookingsInWeek(start);
      if (taken.length < DISCOVERY_LIMITS.promotedSpots && !taken.some((b) => b.org_id === orgId)) {
        return { startsAt: start, endsAt: start + WEEK_MS, spotsLeft: DISCOVERY_LIMITS.promotedSpots - taken.length };
      }
    }
    return null;
  }

  private entry(orgId: string, t: number): Entry {
    const e = this.d.entries(t, [orgId])[0];
    if (!e) throw notFound("Community not found");
    return e;
  }

  view(orgId: string): z.infer<typeof PromoteView> {
    const t = this.d.clock();
    const e = this.entry(orgId, t);
    const reason = this.d.reasonFor(e);
    const rank = reason === null ? this.d.listed(t).findIndex((x) => x.org.id === orgId) + 1 : 0;
    const running = this.d.store.runningBoosts(t, [orgId]);
    const tier = biggestTier(running);
    const next = this.nextSpot(orgId, weekStartOf(t) + WEEK_MS);
    return {
      billing: { available: this.checkout.available, reason: this.checkout.reason },
      currency: this.prices.currency,
      tiers: BOOST_TIERS.map((k) => ({ tier: k, weeklyCents: this.prices[k], guaranteedTop: k === "mega" ? megaGuarantee(e.memberCount) : null })),
      boost: tier ? boostView(running.find((b) => b.tier === tier)!) : null,
      boosts: this.d.store.boostsOf(orgId, t).map(boostView),
      rank: rank > 0 ? rank : null,
      listed: reason === null,
      reason,
      promoted: {
        weeklyCents: this.prices.promoted,
        spotsPerWeek: DISCOVERY_LIMITS.promotedSpots,
        nextSpot: next,
        allTaken: next === null,
        bookings: this.d.store.bookingsOf(orgId, t - ENDED_BOOKINGS_SHOWN_MS).map(bookingView),
      },
      visitors: { weekly: this.d.store.weeklyVisitors(t) },
    };
  }

  // ── Buying (billing off: 503) ──

  async buyBoost(orgId: string, buyerId: string, tier: BoostTier): Promise<{ url: string }> {
    this.entry(orgId, this.d.clock());
    return this.checkout.start({ kind: "boost", orgId, buyerId, tier, priceCents: this.prices[tier], currency: this.prices.currency });
  }

  async buyPromoted(orgId: string, buyerId: string, weekStart?: number): Promise<{ url: string }> {
    const t = this.d.clock();
    this.entry(orgId, t);
    const from = weekStartOf(t) + WEEK_MS;
    const week = this.pickWeek(orgId, from, weekStart);
    return this.checkout.start({ kind: "promoted", orgId, buyerId, weekStart: week, priceCents: this.prices.promoted, currency: this.prices.currency });
  }

  /** [wanted] when it's a free week from [from] on, or the next free one; 409 promoted_full when there's none. */
  private pickWeek(orgId: string, from: number, wanted?: number): number {
    if (wanted !== undefined) {
      if (wanted !== weekStartOf(wanted) || wanted < from || wanted >= from + DISCOVERY_LIMITS.horizonWeeks * WEEK_MS) {
        throw badRequest(`weekStart must be a Monday 00:00 UTC in the next ${DISCOVERY_LIMITS.horizonWeeks} weeks`);
      }
      const spot = this.nextSpot(orgId, wanted);
      if (!spot || spot.startsAt !== wanted) throw new ApiError(409, "promoted_full", "Every Promoted spot that week is taken (or already yours). Pick another week.", { nextSpot: this.nextSpot(orgId, from) });
      return wanted;
    }
    const spot = this.nextSpot(orgId, from);
    if (!spot) throw new ApiError(409, "promoted_full", "Every Promoted spot is taken for the next weeks. Try again later.");
    return spot.startsAt;
  }

  // ── Granted by platform staff (the console) ──

  async grantBoost(orgId: string, tier: BoostTier, weeks: number, actor: string, note: string): Promise<BoostRow> {
    const t = this.d.clock();
    this.entry(orgId, t);
    const row: BoostRow = { id: newId("bst"), org_id: orgId, tier, state: "active", source: "grant", price_cents: 0, starts_at: t, ends_at: t + weeks * WEEK_MS, note, created_by: actor, created_at: t };
    await this.d.store.addBoost(row);
    return row;
  }

  /** A Promoted week for [orgId]: [weekStart], or this week if a spot is free, otherwise the next free week. */
  async grantPromoted(orgId: string, actor: string, note: string, weekStart?: number): Promise<BookingRow> {
    const t = this.d.clock();
    this.entry(orgId, t);
    const week = this.pickWeek(orgId, weekStartOf(t), weekStart);
    const row: BookingRow = {
      id: newId("pmb"),
      org_id: orgId,
      week_start: week,
      state: "active",
      source: "grant",
      price_cents: 0,
      starts_at: week,
      ends_at: week + WEEK_MS,
      views: 0,
      clicks: 0,
      joins: 0,
      note,
      created_by: actor,
      created_at: t,
    };
    if (!(await this.d.store.addBooking(row, DISCOVERY_LIMITS.promotedSpots))) throw new ApiError(409, "promoted_full", "That week filled up meanwhile. Try again.");
    return row;
  }

  /** What the console shows for [orgId]: staff settings, boosts and bookings (ended ones too). */
  adminView(orgId: string) {
    const t = this.d.clock();
    this.entry(orgId, t);
    const s = this.d.store.settings(orgId);
    return {
      removedAt: s?.removed_at ?? null,
      removedReason: s?.removed_reason ?? null,
      official: s?.official === 1,
      boosts: this.d.store.boostsOf(orgId, 0).map(boostView),
      bookings: this.d.store.bookingsOf(orgId, 0).map(bookingView),
    };
  }
}
