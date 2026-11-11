import { createHash } from "node:crypto";
import type { AdminDeps } from "./dataRoutes.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { conflict } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { recoverReportWorkflows } from "./reportRecovery.js";

interface Run {
  id: string;
  actor_account_id: string;
  request_key: string;
  request_hash: string;
  status: "running" | "completed" | "failed";
  started_at: number;
  completed_at: number | null;
  affected: number | null;
  error_kind: string | null;
}
const view = (run: Run) => ({
  id: run.id,
  actorAccountId: run.actor_account_id,
  status:
    run.status === "running" && run.started_at < now() - 60_000
      ? ("uncertain" as const)
      : run.status,
  startedAt: run.started_at,
  completedAt: run.completed_at,
  affected: run.affected,
  errorKind: run.error_kind,
});
/** A single allowlisted, bounded task. Repairs bookkeeping from canonical reports; never repeats sanctions or notifications. */
export class ReportRecoveryOperations {
  constructor(private readonly d: AdminDeps) {}
  history() {
    return {
      runs: this.d.ctx.platform
        .all<Run>("platform_recovery_runs", {
          orderBy: [
            ["started_at", "desc"],
            ["id", "desc"],
          ],
          limit: 20,
        })
        .map(view),
    };
  }
  async run(
    p: AdminPrincipal,
    body: { requestKey: string; reason: string },
    meta: RequestMeta,
  ) {
    const at = now(),
      hash = createHash("sha256").update(body.reason).digest("hex");
    const prepared = await this.d.ctx.platform.write((w) => {
      const existing = w.get<Run>("platform_recovery_runs", {
        actor_account_id: p.account.id,
        request_key: body.requestKey,
      });
      if (existing) {
        if (existing.request_hash !== hash)
          throw conflict(
            "This request key already belongs to another recovery request.",
          );
        return { run: existing, fresh: false };
      }
      if (
        w.get<Run>("platform_recovery_runs", {
          status: "running",
          started_at: { gt: at - 60_000 },
        })
      )
        throw conflict(
          "A report recovery check is already running. Refresh its recorded outcome first.",
        );
      const run: Run = {
        id: newId("rrun"),
        actor_account_id: p.account.id,
        request_key: body.requestKey,
        request_hash: hash,
        status: "running",
        started_at: at,
        completed_at: null,
        affected: null,
        error_kind: null,
      };
      w.insert("platform_recovery_runs", { ...run });
      this.d.audit.append(w, {
        actorAccountId: p.account.id,
        actorRole: p.grant.role,
        action: "report.recovery_requested",
        outcome: "success",
        targetType: "job",
        targetId: run.id,
        reason: body.reason,
        requestId: meta.requestId,
        detail: { operation: body.requestKey, job: "report-recovery" },
      });
      return { run, fresh: true };
    });
    if (!prepared.fresh) return view(prepared.run);
    try {
      const affected = await this.d.ctx.metrics.timeJob(
        "report-recovery.admin",
        () => recoverReportWorkflows(this.d.ctx),
      );
      await this.d.ctx.platform.write((w) => {
        w.update(
          "platform_recovery_runs",
          { id: prepared.run.id },
          { status: "completed", completed_at: now(), affected },
        );
        this.d.audit.append(w, {
          actorAccountId: p.account.id,
          actorRole: p.grant.role,
          action: "report.recovery_completed",
          outcome: "success",
          targetType: "job",
          targetId: prepared.run.id,
          requestId: meta.requestId,
          detail: { affected },
        });
      });
    } catch {
      await this.d.ctx.platform.write((w) => {
        w.update(
          "platform_recovery_runs",
          { id: prepared.run.id },
          {
            status: "failed",
            completed_at: now(),
            error_kind: "recovery_failed",
          },
        );
        this.d.audit.append(w, {
          actorAccountId: p.account.id,
          actorRole: p.grant.role,
          action: "report.recovery_completed",
          outcome: "failed",
          targetType: "job",
          targetId: prepared.run.id,
          requestId: meta.requestId,
        });
      });
    }
    return view(
      this.d.ctx.platform.get<Run>("platform_recovery_runs", {
        id: prepared.run.id,
      })!,
    );
  }
}
