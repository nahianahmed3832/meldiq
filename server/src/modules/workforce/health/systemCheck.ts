import type { Deps } from "../access.js";
import { agentChecks, assignmentsCheck, invocationCheck, mediaCheck, modelChecks, readersCheck, switchesCheck, triggersCheck } from "./communityChecks.js";
import { allRouteChecks, catalogCheck, diskCheck, invocationRuleCheck, platformMediaCheck, platformSwitchesCheck, readingSettingCheck, secretsCheck } from "./platformChecks.js";
import { databaseProbe, type ProbeResult, storageProbe } from "./probes.js";
import { type CheckItem, type CheckLevel, type CheckReport, CheckReports, item } from "./report.js";
import { approvalsCheck, failuresCheck, lastSuccessCheck, limitsCheck, queueCheck, staleJobsCheck, tasksCheck, workerCheck } from "./runtimeChecks.js";

/**
 * Run Full System Check (docs/implementation/PROGRESS.md phase 2): one action that checks configuration, runtime and
 * safe smoke tests for a community (its admins) or the whole platform (console operators, and every
 * SCHEDULE_MS on its own), stores the report, and keeps the history. It never calls an AI model, sends a message,
 * publishes or spends: what can't be proved that way is "not_tested", with why.
 */
export const SCHEDULE_MS = 6 * 60 * 60_000;
/** A scheduled run that failed isn't tried again sooner than this. */
const SCHEDULE_RETRY_MS = 10 * 60_000;

type WorkerStatus = { lastTickAt: number | null; lastError: string | null };

export class SystemCheck {
  readonly reports: CheckReports;
  /** Runs in progress by scope key: a second request joins the first instead of running twice. */
  private readonly inFlight = new Map<string, Promise<CheckReport>>();
  private lastScheduledAttempt = 0;

  constructor(
    private readonly d: Deps,
    private readonly worker: () => WorkerStatus,
  ) {
    this.reports = new CheckReports(d.ctx.db);
  }

  community(orgId: string, requestedBy: string): Promise<CheckReport> {
    return this.once(`community:${orgId}`, () => this.run("community", orgId, requestedBy, () => this.communityItems(orgId)));
  }

  platform(requestedBy: string): Promise<CheckReport> {
    return this.once("platform", () => this.run("platform", null, requestedBy, () => this.platformItems()));
  }

  /** On the worker's tick: the platform check, when the last one is older than SCHEDULE_MS (its run, or null). */
  scheduled(): Promise<CheckReport | null> | null {
    const now = this.d.clock();
    const last = this.reports.latest("platform", null);
    if ((last && now - last.startedAt < SCHEDULE_MS) || now - this.lastScheduledAttempt < SCHEDULE_RETRY_MS) return null;
    this.lastScheduledAttempt = now;
    return this.platform("schedule").catch((e: unknown) => {
      this.d.ctx.log.error({ err: e }, "scheduled system check failed");
      return null;
    });
  }

  private once(key: string, run: () => Promise<CheckReport>): Promise<CheckReport> {
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = run().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async run(scope: "community" | "platform", orgId: string | null, requestedBy: string, items: () => Promise<CheckItem[]>): Promise<CheckReport> {
    const startedAt = this.d.clock();
    const found = await items();
    return this.reports.save({ scope, orgId, requestedBy, startedAt, finishedAt: this.d.clock(), items: found });
  }

  private async communityItems(orgId: string): Promise<CheckItem[]> {
    const d = this.d;
    const installs = d.store.installsOf(orgId);
    return settle(d.clock(), [
      ["config.switches", "configuration", async (now) => [switchesCheck(d, orgId, now)]],
      ["agents", "configuration", (now) => agentChecks(d, installs, now)],
      ["config.channels", "configuration", async (now) => [assignmentsCheck(d, installs, now)]],
      ["config.triggers", "configuration", async (now) => [triggersCheck(d, orgId, now)]],
      ["models", "configuration", async (now) => modelChecks(d, installs, now)],
      ["runtime.worker", "runtime", async (now) => [workerCheck(d.ctx.config.aiWorkforceTickMs, this.worker(), now)]],
      ["runtime.queue", "runtime", async (now) => [queueCheck(d, orgId, now), staleJobsCheck(d, orgId, now)]],
      ["runtime.failures", "runtime", async (now) => [failuresCheck(d, orgId, now)]],
      ["runtime.people", "runtime", async (now) => [approvalsCheck(d, orgId, now), tasksCheck(d, orgId, now)]],
      ["runtime.limits", "runtime", async (now) => [limitsCheck(d, { type: "org", id: orgId }, now)]],
      ["runtime.readers", "runtime", async (now) => [await readersCheck(d, installs, now)]],
      ["smoke.invocation", "smoke", async (now) => [invocationCheck(d, installs, now)]],
      ["smoke.job_path", "smoke", async (now) => [lastSuccessCheck(d, orgId, now)]],
      ["smoke.storage", "smoke", async (now) => [probeItem(now, "smoke.storage", "Storing and reading agent files", await storageProbe(d.ctx.blobs), ["Files sent to and made by agents"])]],
      ["smoke.media", "smoke", async (now) => [await mediaCheck(installs, now)].filter((x): x is CheckItem => x !== null)],
    ]);
  }

  private async platformItems(): Promise<CheckItem[]> {
    const d = this.d;
    return settle(d.clock(), [
      ["config.switches", "configuration", async (now) => [platformSwitchesCheck(d, now)]],
      ["models", "configuration", async (now) => allRouteChecks(d, now)],
      ["config.catalog", "configuration", async (now) => [catalogCheck(d, now)]],
      ["config.secrets_key", "configuration", async (now) => [secretsCheck(d, now)]],
      ["config.channel_reading", "configuration", async (now) => [readingSettingCheck(d, now)]],
      ["runtime.worker", "runtime", async (now) => [workerCheck(d.ctx.config.aiWorkforceTickMs, this.worker(), now)]],
      ["runtime.queue", "runtime", async (now) => [queueCheck(d, null, now), staleJobsCheck(d, null, now)]],
      ["runtime.failures", "runtime", async (now) => [failuresCheck(d, null, now)]],
      ["runtime.limits", "runtime", async (now) => [limitsCheck(d, { type: "global", id: "" }, now)]],
      ["runtime.disk", "runtime", async (now) => [diskCheck(d.ctx.config.dataDir, now)]],
      ["smoke.database", "smoke", async (now) => [probeItem(now, "smoke.database", "Database writes and reads", await databaseProbe(d.ctx.db), ["Everything"])]],
      ["smoke.storage", "smoke", async (now) => [probeItem(now, "smoke.storage", "Storing and reading agent files", await storageProbe(d.ctx.blobs), ["Files sent to and made by agents"])]],
      ["smoke.media", "smoke", async (now) => [await platformMediaCheck(now)]],
      ["smoke.invocation", "smoke", async (now) => [invocationRuleCheck(now)]],
      ["smoke.job_path", "smoke", async (now) => [lastSuccessCheck(d, null, now)]],
    ]);
  }
}

type Check = [key: string, level: CheckLevel, run: (now: number) => Promise<CheckItem[]>];

/** Runs every check; one that throws becomes a failed item naming the error, and the rest still run. */
async function settle(now: number, checks: readonly Check[]): Promise<CheckItem[]> {
  const results = await Promise.all(
    checks.map(async ([key, level, run]) => {
      try {
        return await run(now);
      } catch (e) {
        const why = e instanceof Error ? e.message.slice(0, 300) : "unknown error";
        return [item(now, { key, level, title: `Check "${key}"`, status: "failed", evidence: `The check itself failed: ${why}`, remediation: "Look at the server's logs for this error.", owner: "platform_operator" })];
      }
    }),
  );
  return results.flat();
}

function probeItem(now: number, key: string, title: string, r: ProbeResult, impacts: string[]): CheckItem {
  return r.ok
    ? item(now, { key, level: "smoke", title, status: "healthy", evidence: `${r.detail} in ${r.ms} ms.`, verified: true })
    : item(now, { key, level: "smoke", title, status: "failed", severity: "critical", evidence: r.detail, impacts, remediation: "Check the server's storage and logs.", owner: "platform_operator", verified: true });
}
