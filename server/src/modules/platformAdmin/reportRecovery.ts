import type { AppContext } from "../../app/context.js";
import { REPORT_RETENTION_MS } from "../organizations/index.js";
import { PlatformAudit } from "./audit.js";

interface Workflow {
  report_id: string;
  version: number;
  updated_at: number;
  sync_status: string;
  intended_status: string | null;
}
const cursors = new WeakMap<AppContext, string>();

/** Repairs bookkeeping only: never repeats a moderation decision or opens evidence. A mismatch requires a human retry. */
export async function recoverReportWorkflows(
  ctx: AppContext,
  at = Date.now(),
): Promise<number> {
  const audit = new PlatformAudit(ctx.platform);
  let changed = 0;
  const pending = ctx.platform.all<Workflow>("platform_report_cases", {
    where: { sync_status: "pending", updated_at: { lte: at - 60_000 } },
    orderBy: [["updated_at", "asc"]],
    limit: 100,
  });
  for (const c of pending) {
    const report = await ctx.reports.get(c.report_id); // Store failures preserve the pending intent for the next sweep.
    const synced = !!report && report.status === c.intended_status;
    changed += await ctx.platform.write((w) => {
      const current = w.get<Workflow>("platform_report_cases", {
        report_id: c.report_id,
      });
      if (
        !current ||
        current.version !== c.version ||
        current.sync_status !== "pending" ||
        current.updated_at !== c.updated_at
      )
        return 0;
      w.update(
        "platform_report_cases",
        { report_id: c.report_id },
        {
          sync_status: synced ? "synced" : "failed",
          intended_status: synced ? null : c.intended_status,
          updated_at: at,
          version: c.version + 1,
        },
      );
      w.insert("platform_report_events", {
        report_id: c.report_id,
        actor_account_id: "system:report-recovery",
        at,
        kind: "reconciled",
        body: synced
          ? "Canonical report confirms the requested status."
          : "Interrupted resolution needs an explicit moderator retry.",
      });
      audit.append(
        w,
        {
          action: "report.reconcile",
          outcome: synced ? "success" : "failed",
          targetType: "report",
          targetId: c.report_id,
          detail: {
            requestedStatus: c.intended_status,
            canonicalStatus: report?.status ?? null,
          },
        },
        at,
      );
      return 1;
    });
  }
  // Match canonical report retention. A rotating bounded scan avoids starving old cases behind a still-live report.
  const stale = ctx.platform.all<Workflow>("platform_report_cases", {
    where: {
      updated_at: { lte: at - REPORT_RETENTION_MS },
      report_id: { gt: cursors.get(ctx) ?? "" },
    },
    orderBy: [["report_id", "asc"]],
    limit: 100,
  });
  for (const c of stale) {
    if (await ctx.reports.get(c.report_id)) continue;
    changed += await ctx.platform.write((w) => {
      const current = w.get<Workflow>("platform_report_cases", {
        report_id: c.report_id,
      });
      if (
        !current ||
        current.version !== c.version ||
        current.updated_at !== c.updated_at
      )
        return 0;
      w.delete("platform_report_events", { report_id: c.report_id });
      w.delete("platform_report_cases", { report_id: c.report_id });
      audit.append(
        w,
        {
          action: "report.workflow.purge",
          outcome: "success",
          targetType: "report",
          targetId: c.report_id,
          reason:
            "Canonical report absent; workflow older than the 90-day report retention period.",
        },
        at,
      );
      return 1;
    });
  }
  cursors.set(
    ctx,
    stale.length === 100 ? stale[stale.length - 1].report_id : "",
  );
  return changed;
}
