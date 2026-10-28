import type { AppContext } from "../../app/context.js";
import { syntheticUserIds } from "../accounts/index.js";
import { platformSetting } from "./settings.js";
import type { PlatformAdminStore } from "./store.js";

/** Recomputed at most this often (and right after the settings change). */
const REFRESH_MS = 60_000;

export interface ExclusionSet {
  ids: string[];
  counts: { synthetic: number; listed: number; admins: number };
}

/**
 * Who analytics leaves out (docs/ANALYTICS_DEFINITIONS.md › Exclusions): load-test accounts always, the operator's list
 * (platform setting analytics.excluded_users), and console admins unless the setting says otherwise. Applied when
 * figures are read, so a change applies to past figures too; also handed to telemetry for the live counts.
 */
export class Exclusions {
  private cached: { at: number; set: ExclusionSet } | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly store: PlatformAdminStore,
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  async get(t = Date.now()): Promise<ExclusionSet> {
    if (this.cached && t - this.cached.at < REFRESH_MS) return this.cached.set;
    const synthetic = syntheticUserIds(this.ctx.identity);
    const listed = platformSetting(this.ctx.platform, "analytics.excluded_users");
    const admins: string[] = [];
    if (platformSetting(this.ctx.platform, "analytics.exclude_admins")) {
      for (const g of this.store.grants()) {
        if (g.revoked_at !== null) continue;
        const a = await this.ctx.accounts.store.accountById(g.account_id);
        if (a?.user_id) admins.push(a.user_id);
      }
    }
    const ids = [...new Set([...synthetic, ...listed, ...admins])];
    const set = { ids, counts: { synthetic: synthetic.length, listed: listed.length, admins: admins.length } };
    this.cached = { at: t, set };
    this.ctx.telemetry.setExcluded(ids);
    return set;
  }
}
