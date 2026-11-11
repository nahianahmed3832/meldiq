import type { FastifyInstance } from "fastify";
import { newId, now, sha256Hex } from "../../shared/utilities/util.js";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { AdminExportJobBody } from "../../shared/contracts/http/platformAdminInsights.js";
import type { AdminPrincipal } from "./auth.js";
import type { AdminDeps } from "./dataRoutes.js";
import { Exclusions } from "./exclusions.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import { allowed, effectivePermissions } from "./permissions.js";
import { AdminSearchExport, EXPORT_NEEDS, type ExportKind, type ExportRequest } from "./searchExport.js";
import type { RequestMeta } from "./credentials.js";

interface Job {
  id: string; actor_account_id: string; request_key: string; kind: ExportKind; query_json: string;
  state: "queued" | "running" | "ready" | "failed" | "expired"; rows_count: number;
  created_at: number; started_at: number | null; completed_at: number | null; expires_at: number;
  error: string | null; filename: string | null; csv: string | null;
}
const LEASE_MS = 120_000;
const TTL_MS = 24 * 60 * 60_000;
const active = new Set<string>();

/** Durable, bounded export artifacts. A restart can resume a read-only generation; access is rechecked on every poll/download. */
export class AdminExportJobs {
  private readonly source: AdminSearchExport;
  constructor(private readonly d: AdminDeps) { this.source = new AdminSearchExport(d.ctx, d.audit, new Exclusions(d.ctx, d.store)); }

  private grant(p: AdminPrincipal, kind: ExportKind, binding?: string) {
    const grant = this.d.store.activeGrant(p.account.id);
    if (!grant || !allowed(grant, "exports.create") || !allowed(grant, EXPORT_NEEDS[kind])) throw forbidden("Your console role does not allow this export.");
    if (binding) {
      let recorded: string | undefined;
      try { recorded = JSON.parse(binding).grantFingerprint; } catch { /* Legacy/unreadable artifacts are never served. */ }
      if (recorded !== this.fingerprint(grant)) throw forbidden("Your administrative access changed. Create a fresh export with your current permissions.");
    }
    return { ...p, grant };
  }
  private fingerprint(grant: AdminPrincipal["grant"]) { return sha256Hex(JSON.stringify([grant.role, grant.updated_at, effectivePermissions(grant)])); }
  private row(p: AdminPrincipal, id: string) {
    const job = this.d.ctx.platform.get<Job>("platform_export_jobs", { id, actor_account_id: p.account.id });
    if (!job) throw notFound("No export has that ID for this admin.");
    this.grant(p, job.kind, job.query_json);
    return job;
  }
  private view(j: Job) {
    return { id: j.id, kind: j.kind, state: j.expires_at <= now() ? "expired" as const : j.state, rows: j.rows_count, createdAt: j.created_at, startedAt: j.started_at, completedAt: j.completed_at, expiresAt: j.expires_at, error: j.error, filename: j.filename };
  }
  private async expire() {
    await this.d.ctx.platform.write(w => { w.delete("platform_export_jobs", { expires_at: { lte: now() } }); });
  }
  async create(p: AdminPrincipal, b: { kind: ExportKind; requestKey: string; query: ExportRequest }, meta: RequestMeta) {
    const authorized = this.grant(p, b.kind);
    await this.expire();
    const query = JSON.stringify({ request: b.query, grantFingerprint: this.fingerprint(authorized.grant) });
    const id = await this.d.ctx.platform.write(w => {
      const old = w.get<Job>("platform_export_jobs", { actor_account_id: p.account.id, request_key: b.requestKey });
      if (old) {
        if (old.kind !== b.kind || old.query_json !== query) throw new ApiError(409, "conflict", "This export request belongs to different filters. Start a new export.");
        return old.id;
      }
      if (w.count("platform_export_jobs", { actor_account_id: p.account.id, state: { in: ["queued", "running"] } }) >= 2)
        throw new ApiError(429, "export_busy", "Two exports are already queued. Wait for one to finish.");
      if (w.count("platform_export_jobs", { actor_account_id: p.account.id }) >= 20)
        throw new ApiError(429, "export_limit", "The daily export artifact limit is 20. Existing downloads remain available for 24 hours.");
      const id = newId("export"), at = now();
      w.insert("platform_export_jobs", { id, actor_account_id: p.account.id, request_key: b.requestKey, kind: b.kind, query_json: query, state: "queued", rows_count: 0, created_at: at, expires_at: at + TTL_MS });
      this.d.audit.append(w, { action: "export.queued", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "export_job", targetId: id, reason: b.query.reason, requestId: meta.requestId, detail: { kind: b.kind } });
      return id;
    });
    const job = this.row(p, id);
    this.schedule(p, job, meta);
    return this.view(job);
  }
  async list(p: AdminPrincipal, meta: RequestMeta) {
    await this.expire();
    const jobs = this.d.ctx.platform.all<Job>("platform_export_jobs", { where: { actor_account_id: p.account.id }, orderBy: [["created_at", "desc"]], limit: 20 })
      .filter(j => { try { this.grant(p, j.kind, j.query_json); return true; } catch { return false; } });
    for (const j of jobs) this.schedule(p, j, meta);
    return { jobs: jobs.map(j => this.view(j)) };
  }
  get(p: AdminPrincipal, id: string, meta: RequestMeta) { const j = this.row(p, id); this.schedule(p, j, meta); return this.view(j); }
  download(p: AdminPrincipal, id: string) {
    const j = this.row(p, id);
    if (j.expires_at <= now()) throw new ApiError(410, "export_expired", "This download expired. Generate a fresh export.");
    if (j.state !== "ready" || j.csv === null || !j.filename) throw new ApiError(409, "export_not_ready", "This export is not ready to download.");
    return { csv: j.csv, filename: j.filename };
  }
  async retry(p: AdminPrincipal, id: string, meta: RequestMeta) {
    const j = this.row(p, id);
    if (j.state !== "failed" && !(j.state === "running" && (j.started_at ?? 0) < now() - LEASE_MS)) throw new ApiError(409, "export_state", "Only failed or interrupted exports can be retried.");
    await this.d.ctx.platform.write(w => {
      w.update("platform_export_jobs", { id, state: j.state, started_at: j.started_at }, { state: "queued", error: null, rows_count: 0, started_at: null });
      this.d.audit.append(w, { action: "export.retry_requested", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "export_job", targetId: id, requestId: meta.requestId });
    });
    return this.get(p, id, meta);
  }
  private schedule(p: AdminPrincipal, j: Job, meta: RequestMeta) {
    if (j.expires_at <= now() || active.has(j.id) || active.size >= 2 || (j.state !== "queued" && !(j.state === "running" && (j.started_at ?? 0) < now() - LEASE_MS))) return;
    active.add(j.id);
    setImmediate(() => { void this.run(p, j, meta).catch(() => undefined).finally(() => active.delete(j.id)); });
  }
  private async run(p: AdminPrincipal, j: Job, meta: RequestMeta) {
    const token = now();
    const claimed = await this.d.ctx.platform.write(w => w.update("platform_export_jobs", { id: j.id, state: j.state, started_at: j.started_at }, { state: "running", started_at: token, error: null, rows_count: 0 }));
    if (!claimed) return;
    const where = { id: j.id, state: "running", started_at: token };
    try {
      const out = await this.source.export(this.grant(p, j.kind, j.query_json), j.kind, JSON.parse(j.query_json).request, meta, 50_000, async rows => {
        this.grant(p, j.kind, j.query_json);
        await this.d.ctx.platform.write(w => { w.update("platform_export_jobs", where, { rows_count: rows }); });
      });
      this.grant(p, j.kind, j.query_json);
      await this.d.ctx.platform.write(w => { w.update("platform_export_jobs", where, { state: "ready", rows_count: out.rows, completed_at: out.completedAt, filename: out.filename, csv: out.csv }); });
    } catch (e) {
      const error = e instanceof ApiError && [400,403,422].includes(e.statusCode) ? e.message : "Export generation failed. Retry this job; no download was published.";
      await this.d.ctx.platform.write(w => {
        w.update("platform_export_jobs", where, { state: "failed", error, csv: null, completed_at: now() });
        this.d.audit.append(w, { action: "export.failed", outcome: "failed", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "export_job", targetId: j.id, requestId: meta.requestId });
      });
    }
  }
}

export async function exportJobRoutes(app: FastifyInstance, d: AdminDeps) {
  const jobs = new AdminExportJobs(d);
  const options = { preHandler: requirePermission(d.auth, d.audit, "exports.create") };
  const id = (params: unknown) => { const v = (params as { id?: unknown }).id; if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(v)) throw notFound("No such export."); return v; };
  app.post("/admin/v1/export-jobs", options, async req => jobs.create(principal(req), parse(AdminExportJobBody, req.body), metaOf(req)));
  app.get("/admin/v1/export-jobs", options, async req => jobs.list(principal(req), metaOf(req)));
  app.get("/admin/v1/export-jobs/:id", options, async req => jobs.get(principal(req), id(req.params), metaOf(req)));
  app.post("/admin/v1/export-jobs/:id/retry", options, async req => jobs.retry(principal(req), id(req.params), metaOf(req)));
  app.get("/admin/v1/export-jobs/:id/download", options, async (req, reply) => {
    const out = jobs.download(principal(req), id(req.params));
    await d.audit.record({ action: "export.download", outcome: "success", actorAccountId: principal(req).account.id, actorRole: principal(req).grant.role, targetType: "export_job", targetId: id(req.params), requestId: String(req.id) });
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${out.filename}"`).send(out.csv);
  });
}
