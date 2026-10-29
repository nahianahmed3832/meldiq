import type { z } from "zod/v4";
import type { RowReader } from "../infrastructure/database/rows/index.js";
import { SiteDetails } from "../shared/contracts/http/platformAdminInsights.js";

/**
 * Who runs Meldiq and its policies (docs/SITE_DETAILS.md): edited in the Platform Admin Console, read by the website
 * and apps from GET /v2/site/details. Stored in platform_settings under "site.details" beside the platform controls;
 * read on each request (one indexed row) and falling back to the defaults when unset or no longer valid.
 */
export type SiteDetailsValue = z.infer<typeof SiteDetails>;

export const SITE_DETAILS_KEY = "site.details";

/** Only what the owner decided (2026-10-28): GRIIPBUDDY LLC in the USA, a 14-day refund window. The rest is open. */
export const SITE_DETAILS_DEFAULTS: SiteDetailsValue = {
  operator: { legalName: "GRIIPBUDDY LLC", address: null, jurisdiction: null, registration: null, governingLaw: null },
  contacts: { supportEmail: null, privacyEmail: null, dpo: null },
  policies: {
    minimumAge: null,
    refundWindowDays: 14,
    refundRules: null,
    failedPaymentGraceDays: null,
    legalBases: null,
    billingRecordRetention: null,
    transferSafeguards: null,
  },
  legalUpdatedOn: "2026-10-28",
};

export function readSiteDetails(platform: RowReader): SiteDetailsValue {
  const row = platform.get<{ value: string }>("platform_settings", { key: SITE_DETAILS_KEY });
  if (!row) return SITE_DETAILS_DEFAULTS;
  try {
    const parsed = SiteDetails.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : SITE_DETAILS_DEFAULTS;
  } catch {
    return SITE_DETAILS_DEFAULTS;
  }
}

/** The details from platform_settings read directly (the operator CLI, which has the database but no rows). */
export function siteDetailsFromDb(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }): SiteDetailsValue {
  const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(SITE_DETAILS_KEY) as { value: string } | undefined;
  return readSiteDetails({ get: () => row } as unknown as RowReader);
}

/** The fields still to be decided (null), by path: what the website shows as "to be confirmed". */
export function missingDetails(d: SiteDetailsValue): string[] {
  const out: string[] = [];
  for (const [group, values] of Object.entries(d)) {
    if (values && typeof values === "object") for (const [k, v] of Object.entries(values)) if (v === null) out.push(`${group}.${k}`);
  }
  return out;
}
