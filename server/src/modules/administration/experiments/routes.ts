import type { FastifyInstance } from "fastify";
import { type AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { AnalyticsBatch, ExperimentReportQuery } from "../../../shared/contracts/http/experiments.js";
import { parse } from "../../../shared/validation/index.js";
import { forbidden } from "../../../shared/errors.js";
import { type Assignment, assignments, effectiveStatus } from "./assign.js";
import { EXPERIMENTS } from "./definitions.js";
import { ANALYTICS_EVENTS, type CleanEvent, cleanEvents } from "./events.js";
import type { RowWriter } from "../../../infrastructure/database/rows/index.js";
import { compareText } from "../../../shared/utilities/sqlText.js";

/** Analytics batches per person per minute: an app sends one every minute or so at most. */
const ANALYTICS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };
const DAY_MS = 86_400_000;

/**
 * Experiments and product analytics (docs/product/EXPERIMENTS.md). Off unless the operator turns them on
 * (EXPERIMENTS_MODE, ANALYTICS_ENABLED); the reports are for platform admins only.
 */
export default async function experimentRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const cfg = ctx.config.experiments;
  const isPlatformAdmin = (userId: string) => ctx.config.platformAdmins.has(userId);
  const assignmentsFor = (userId: string): Assignment[] => assignments(cfg, userId, isPlatformAdmin(userId));

  app.get("/v1/experiments", auth, async (req) => {
    const { userId } = me(req);
    return { mode: cfg.mode, analytics: ctx.config.analyticsEnabled, assignments: assignmentsFor(userId) };
  });

  /** Adds one event (and its value, when it has one) to the day's count for its key. */
  const bump = (w: RowWriter, key: { day: string; event: string; dims: string; platform: string; experiment: string; variant: string }, value: number | null) => {
    const before = w.get<{ count: number; value_count: number; value_sum: number }>("analytics_daily", key);
    const counts = {
      count: (before?.count ?? 0) + 1,
      value_count: (before?.value_count ?? 0) + (value === null ? 0 : 1),
      value_sum: (before?.value_sum ?? 0) + (value ?? 0),
    };
    w.upsert("analytics_daily", { ...key, ...counts }, counts);
  };
  const record = (events: CleanEvent[], platform: string, inExperiments: Assignment[], day: string) =>
    ctx.ws.write((w) => {
      for (const e of events) {
        const base = { day, event: e.name, dims: e.dims, platform };
        bump(w, { ...base, experiment: "", variant: "" }, e.value);
        for (const a of inExperiments) bump(w, { ...base, experiment: a.experiment, variant: a.variant }, e.value);
      }
    });

  app.post("/v1/analytics/events", { ...auth, config: { rateLimit: ANALYTICS_RATE_LIMIT } }, async (req, reply) => {
    if (!ctx.config.analyticsEnabled) return reply.code(202).send({ accepted: 0, enabled: false });
    const batch = parse(AnalyticsBatch, req.body);
    const events = cleanEvents(batch);
    const day = new Date().toISOString().slice(0, 10);
    await record(events, batch.platform, assignmentsFor(me(req).userId), day);
    return reply.code(202).send({ accepted: events.length, enabled: true });
  });

  app.get("/v1/admin/experiments", auth, async (req) => {
    const { userId } = me(req);
    if (!isPlatformAdmin(userId)) throw forbidden("Only platform administrators can do that");
    const q = parse(ExperimentReportQuery, req.query);
    const from = new Date(Date.now() - (q.days - 1) * DAY_MS).toISOString().slice(0, 10);
    const totals = new Map<string, { experiment: string; variant: string; event: string; count: number; valueCount: number; valueSum: number }>();
    for (const r of ctx.ws.all<{ day: string; experiment: string; variant: string; event: string; count: number; value_count: number; value_sum: number }>("analytics_daily")) {
      if (r.day < from) continue;
      const k = JSON.stringify([r.experiment, r.variant, r.event]);
      const t = totals.get(k) ?? { experiment: r.experiment, variant: r.variant, event: r.event, count: 0, valueCount: 0, valueSum: 0 };
      totals.set(k, { ...t, count: t.count + r.count, valueCount: t.valueCount + r.value_count, valueSum: t.valueSum + r.value_sum });
    }
    const rows = [...totals.values()].sort((a, b) => compareText(a.experiment, b.experiment) || compareText(a.variant, b.variant) || compareText(a.event, b.event));
    return {
      mode: cfg.mode,
      analytics: ctx.config.analyticsEnabled,
      from,
      events: Object.entries(ANALYTICS_EVENTS).map(([name, d]) => ({ name, value: d.value, description: d.description })),
      overall: rows.filter((r) => r.experiment === "").map(({ event, count, valueCount, valueSum }) => ({ event, count, valueCount, valueSum })),
      experiments: EXPERIMENTS.map((d) => ({
        ...d,
        effectiveStatus: effectiveStatus(cfg, d),
        results: rows.filter((r) => r.experiment === d.id).map(({ variant, event, count, valueCount, valueSum }) => ({ variant, event, count, valueCount, valueSum })),
      })),
    };
  });
}
