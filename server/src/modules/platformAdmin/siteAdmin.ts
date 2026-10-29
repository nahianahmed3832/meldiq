import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { missingDetails, readSiteDetails, SITE_DETAILS_KEY, type SiteDetailsValue } from "../../app/siteDetails.js";
import { now } from "../../shared/utilities/util.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { flatDetail } from "./quotasAdmin.js";

/**
 * The console's view and changes of the site and legal details (docs/SITE_DETAILS.md). A change is stored and audited
 * (before, after and the operator's reason) in one unit; the website reads it on its next page load.
 */
export class AdminSite {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
  ) {}

  async view() {
    const row = this.ctx.platform.get<{ updated_by: string; updated_at: number }>("platform_settings", { key: SITE_DETAILS_KEY });
    const details = readSiteDetails(this.ctx.platform);
    const admin = row ? await this.ctx.accounts.store.accountById(row.updated_by) : undefined;
    return {
      details,
      missing: missingDetails(details),
      updatedBy: row ? { accountId: row.updated_by, name: admin?.name ?? null } : null,
      updatedAt: row?.updated_at ?? null,
    };
  }

  async set(p: AdminPrincipal, details: SiteDetailsValue, reason: string, meta: RequestMeta) {
    await this.ctx.platform.write((w) => {
      const before = readSiteDetails(w);
      const stored = { value: JSON.stringify(details), updated_by: p.account.id, updated_at: now() };
      w.upsert("platform_settings", { key: SITE_DETAILS_KEY, ...stored }, stored);
      // Only what changed, field by field, so the audit trail reads as a list of edits.
      const changed: Record<string, unknown> = {};
      for (const group of ["operator", "contacts", "policies"] as const) {
        for (const [k, v] of Object.entries(details[group])) {
          const was = (before[group] as Record<string, unknown>)[k];
          if (was !== v) changed[`${group}.${k}`] = `${JSON.stringify(was)} -> ${JSON.stringify(v)}`;
        }
      }
      if (before.legalUpdatedOn !== details.legalUpdatedOn) changed.legalUpdatedOn = `${before.legalUpdatedOn} -> ${details.legalUpdatedOn}`;
      this.audit.append(w, {
        action: "site.update",
        outcome: "success",
        actorAccountId: p.account.id,
        actorRole: p.grant.role,
        targetType: "site",
        targetId: "details",
        reason,
        requestId: meta.requestId,
        network: networkKey(meta.ip),
        detail: flatDetail(changed),
      });
    });
    return this.view();
  }
}
