import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { Config } from "../../../app/config.js";
import { DISCOVERY_LIMITS, DISCOVERY_MIN_MEMBERS, type DiscoverListing, type DiscoverListQuery, type DiscoverySettings, type DiscoverySettingsBody } from "../../../shared/contracts/http/discovery.js";
import { ApiError, forbidden, notFound } from "../../../shared/errors.js";
import { biggestTier, card, compareEntries, discoveryOrder, type Entry, matches, matchesSize, type OrgRow, type UnlistedReason, unlistedReason } from "./listing.js";
import { Promote } from "./promote.js";
import { DiscoveryStore, parseTags } from "./store.js";

/** "Board Games " → "board games": lower case, single spaces; repeats dropped. */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean))];
}

/**
 * Discovery (community parity batch E, feature "discovery-listing", docs/COMMUNITY_PARITY_API.md › Discovery): the
 * Discover listing, each community's Discovery settings, and what Discover records (visits, clicks, joins from it).
 * Boosts and Promoted spots are [promote].
 */
export class Discovery {
  readonly store: DiscoveryStore;
  readonly promote: Promote;

  constructor(
    readonly ctx: AppContext,
    readonly config: Config["discovery"],
    readonly clock: () => number = Date.now,
  ) {
    this.store = new DiscoveryStore(ctx.ws);
    this.promote = new Promote(this);
  }

  requireEnabled(): void {
    if (!this.config.enabled) throw new ApiError(503, "feature_disabled", "Discovery is switched off for now. Try again later.");
  }

  /** The community's id after the checks: 404 for people outside it, 403 without Edit community. */
  requireEditor(orgId: string, userId: string, what: string): void {
    this.ctx.authz.requireOrgMember(orgId, userId);
    if (!this.ctx.authz.can(orgId, userId, "workspace.edit")) throw forbidden(`Your role doesn't include changing the community's ${what}`);
  }

  // ── Who is listed ──

  /** Every community Discovery considers (public ones, or [orgIds]), with its settings, size and boost at [t]. */
  entries(t: number, orgIds?: readonly string[]): Entry[] {
    const ws = this.ctx.ws;
    const orgs = ws.all<OrgRow>("orgs", { where: orgIds ? { id: { in: orgIds } } : { visibility: "public" } });
    const ids = orgs.map((o) => o.id);
    const settings = this.store.allSettings(ids);
    const promoteOn = this.config.promote;
    const boosts = promoteOn ? this.store.runningBoosts(t, ids) : [];
    const promoted = new Set(promoteOn ? this.store.runningBookings(t).map((b) => b.org_id) : []);
    return orgs.map((org) => {
      const tier = biggestTier(boosts.filter((b) => b.org_id === org.id));
      return { org, settings: settings.get(org.id), memberCount: ws.count("org_members", { org_id: org.id }), tier, paid: tier !== null || promoted.has(org.id) };
    });
  }

  reasonFor(e: Entry): UnlistedReason | null {
    return unlistedReason(e, this.ctx.communitySafety.lockedUntil(e.org.id) !== null, this.config.blockedWords);
  }

  /** Discovery's list at [t], in order. */
  listed(t: number): Entry[] {
    return this.entries(t)
      .filter((e) => this.reasonFor(e) === null)
      .sort(compareEntries);
  }

  /** GET /v1/discover for [viewerId]: the Promoted row (first page without a search) and a page of the list. */
  async discover(viewerId: string, q: z.infer<typeof DiscoverListQuery>): Promise<z.infer<typeof DiscoverListing>> {
    const t = this.clock();
    const banned = new Set(this.ctx.ws.all<{ org_id: string }>("org_bans", { where: { user_id: viewerId } }).map((b) => b.org_id));
    const all = this.listed(t).filter((e) => !banned.has(e.org.id));
    const term = q.q ?? "";
    const tag = normalizeTags([q.tag ?? ""])[0] ?? "";
    const sized = all.filter((entry) => matchesSize(entry.memberCount, q.size ?? "any"));
    const found = sized.filter((entry) => matches(entry, term, tag));
    if (q.sort && q.sort !== "recommended") found.sort(discoveryOrder[q.sort]);
    const page = found.slice(q.cursor, q.cursor + DISCOVERY_LIMITS.page);
    const home = !term && !tag && q.cursor === 0;
    const spots = home ? this.promote.promotedRow(t, sized) : [];
    await this.store.noteVisit(viewerId, t);
    await this.store.countOn(spots.map((s) => s.booking.id), "views");
    return {
      promoted: spots.map((s) => card(this.ctx, s.entry, viewerId, "promoted")),
      communities: page.map((e) => card(this.ctx, e, viewerId, e.tier)),
      nextCursor: found.length > q.cursor + DISCOVERY_LIMITS.page ? q.cursor + DISCOVERY_LIMITS.page : null,
    };
  }

  /**
   * Whether the older GET /v1/communities/discover may show [orgId]: it keeps listing small public communities, but
   * leaves out ones turned off, removed by staff, locked or with a blocked name. Everything shows while Discovery is off.
   */
  shownToOlderApps(orgId: string): boolean {
    if (!this.config.enabled) return true;
    const e = this.entries(this.clock(), [orgId])[0];
    if (!e) return false;
    const reason = this.reasonFor(e);
    return reason === null || reason === "too_few_members";
  }

  // ── A community's settings ──

  settingsView(orgId: string): z.infer<typeof DiscoverySettings> {
    const e = this.entries(this.clock(), [orgId])[0];
    if (!e) throw notFound("Community not found");
    const s = e.settings;
    const reason = this.reasonFor(e);
    return {
      discoverable: s ? s.discoverable === 1 : true,
      description: s?.blurb ?? null,
      tags: s ? parseTags(s.tags) : [],
      listed: reason === null,
      reason,
      memberCount: e.memberCount,
      minMembers: DISCOVERY_MIN_MEMBERS,
      communityDescription: e.org.description ?? null,
      official: s?.official === 1,
      updatedAt: s?.updated_at ?? null,
    };
  }

  /** Saves what [body] changes; the names of the fields that changed. */
  async update(orgId: string, actorId: string, body: z.infer<typeof DiscoverySettingsBody>): Promise<string[]> {
    const before = this.settingsView(orgId);
    const patch: { discoverable?: number; blurb?: string | null; tags?: string } = {};
    const changed: string[] = [];
    if (body.discoverable !== undefined && body.discoverable !== before.discoverable) {
      patch.discoverable = body.discoverable ? 1 : 0;
      changed.push(body.discoverable ? "shown" : "hidden");
    }
    if (body.description !== undefined) {
      const blurb = body.description ? body.description : null;
      if (blurb !== before.description) {
        patch.blurb = blurb;
        changed.push("description");
      }
    }
    if (body.tags !== undefined) {
      const tags = normalizeTags(body.tags).slice(0, DISCOVERY_LIMITS.tags);
      if (JSON.stringify(tags) !== JSON.stringify(before.tags)) {
        patch.tags = JSON.stringify(tags);
        changed.push("tags");
      }
    }
    if (changed.length > 0) await this.store.patchSettings(orgId, patch, actorId, this.clock());
    return changed;
  }

  // ── What Discover records ──

  /** Someone opened [orgId] from Discover: remembered for joins, and counted for its running Promoted spot. */
  async click(orgId: string, userId: string): Promise<boolean> {
    const org = this.ctx.ws.get<{ visibility: string }>("orgs", { id: orgId });
    if (!org || org.visibility !== "public") throw notFound("Community not found");
    const t = this.clock();
    await this.store.noteClick(orgId, userId, t);
    await this.store.countOn(this.promote.runningBookingsOf(orgId, t).map((b) => b.id), "clicks");
    return true;
  }

  /** [userId] joined [orgId]: a join for its running Promoted spot when they opened it from Discover during it. */
  async noteJoin(orgId: string, userId: string): Promise<void> {
    if (!this.config.enabled || !this.config.promote) return;
    const clicked = this.store.clickedAt(orgId, userId);
    if (clicked === null) return;
    const t = this.clock();
    const spots = this.promote.runningBookingsOf(orgId, t).filter((b) => clicked >= b.starts_at);
    await this.store.countOn(spots.map((b) => b.id), "joins");
  }
}
