import type { AppContext } from "../../app/context.js";
import { badRequest } from "../../shared/errors.js";
import { analytics, utcDay } from "../telemetry/index.js";

const DAY_MS = 86_400_000;
export const MAX_REPORT_DAYS = 120;

/** Calendar ranges are inclusive UTC dates; no current-day result claims to be a full day. */
export function reportDays(q: { from?: string; to?: string }, at: number) {
  const today = utcDay(at);
  const to = q.to && q.to < today ? q.to : today;
  const from = q.from ?? analytics.addDays(to, -29);
  if (from > to) throw badRequest("The range starts after it ends.");
  if (analytics.daysBetween(from, to, MAX_REPORT_DAYS + 1).length > MAX_REPORT_DAYS) throw badRequest(`A range is at most ${MAX_REPORT_DAYS} days.`);
  return { from, to };
}

export function dayCoverage(day: string, collectingSince: number | null, at: number, span = 1): "unavailable" | "partial" | "observed" {
  const start = Date.parse(`${analytics.addDays(day, -(span - 1))}T00:00:00Z`);
  const end = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
  if (collectingSince === null || collectingSince >= end || start >= at) return "unavailable";
  return collectingSince > start || end > at ? "partial" : "observed";
}

/** Used by the JSON report AND its export. Daily telemetry is flushed about once a minute, not an immutable snapshot. */
export function activityReport(ctx: AppContext, excluded: readonly string[], q: { from?: string; to?: string }, at: number) {
  const { from, to } = reportDays(q, at);
  const since = ctx.telemetry.since("activity");
  const days = analytics.activeUsers(ctx, from, to, excluded).map((d) => {
    const coverage = dayCoverage(d.day, since, at);
    const observed = coverage !== "unavailable";
    // A rolling unique count requires its full lookback. Today's own partial count remains useful and is labelled.
    const lookbackAvailable = (span: number) => since !== null && Date.parse(`${analytics.addDays(d.day, -(span - 1))}T00:00:00Z`) >= since;
    return {
      day: d.day,
      dau: observed ? d.dau : null,
      wau: lookbackAvailable(7) ? d.wau : null,
      mau: lookbackAvailable(30) ? d.mau : null,
      newActive: observed ? d.newActive : null,
      returningActive: observed ? d.returningActive : null,
      collected: observed,
      partial: coverage === "partial",
    };
  });
  return {
    from,
    to,
    generatedAt: at,
    timezone: "UTC" as const,
    collectingSince: since === null ? null : utcDay(since),
    definition: "DAU: distinct local people with successful qualifying app activity on the UTC day, excluding synthetic, configured internal and console-admin identities. WAU / MAU: distinct people over the 7 / 30 UTC days ending that day; unavailable until the entire lookback was collected. New: the messaging identity was created that day. Partial means the current day or collection started during that day. Counts refresh after telemetry is flushed (normally once a minute); exports run at their own displayed generation time.",
    days,
  };
}
