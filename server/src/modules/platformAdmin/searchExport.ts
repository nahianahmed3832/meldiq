import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError, badRequest, forbidden } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { devicesPage, searchUsers } from "../accounts/index.js";
import { searchOrgs } from "../organizations/index.js";
import { utcDay } from "../telemetry/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import type { Exclusions } from "./exclusions.js";
import { allowed, type Permission } from "./permissions.js";
import { AdminUsers, statusOf } from "./users.js";
import { AdminDevices } from "./devicesView.js";
import { AdminIncidents } from "./incidents.js";
import { AdminAuditView } from "./auditView.js";
import { AdminQuotas } from "./quotasAdmin.js";
import { PlatformAdminStore } from "./store.js";
import { activityReport } from "./reporting.js";
import { parse } from "../../shared/validation/index.js";
import { AdminUsersQuery, AdminOrgsQuery, AdminAuditQuery, AdminIncidentsQuery } from "../../shared/contracts/http/platformAdmin.js";
import { AdminDevicesQuery, AdminQuotaEventsQuery } from "../../shared/contracts/http/platformAdminInsights.js";
import type { z } from "zod/v4";

const SEARCH_EACH = 8;
/** Rows an export may hold (beyond it, narrow the date range). */
export const EXPORT_MAX_ROWS = 5000;
const DAY_MS = 86_400_000;

/** One CSV cell: quoted when needed, and never starting like a formula (spreadsheets would run it). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "number" && v > 1e12 && v < 1e14 ? new Date(v).toISOString() : String(v);
  if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export type ExportKind = "users" | "organizations" | "devices" | "audit" | "incidents" | "quota-events" | "active-users";

export const EXPORT_NEEDS: Record<ExportKind, Permission> = {
  users: "users.view",
  organizations: "orgs.view",
  devices: "devices.view",
  audit: "audit.view",
  incidents: "incidents.view",
  "quota-events": "quotas.view",
  "active-users": "analytics.view",
};

/**
 * Global search and CSV exports (docs/PLATFORM_ADMIN_CONSOLE.md › Search). Search looks only in what the admin's role
 * may see, and returns ids, names and states. Exports need exports.create and the view permission of what they hold,
 * are bounded, carry no email addresses, keys or content, and are audited with their reason and size.
 */
export class AdminSearchExport {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
    private readonly exclusions: Exclusions,
  ) {}

  async search(p: AdminPrincipal, q: string) {
    const { platform, ws } = this.ctx;
    const sections: string[] = [];
    const users = allowed(p.grant, "users.view")
      ? searchUsers(this.ctx.identity, { q, limit: SEARCH_EACH }).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, status: statusOf(u) }))
      : null;
    if (users) sections.push("users");
    const organizations = allowed(p.grant, "orgs.view") ? searchOrgs(ws, { q, limit: SEARCH_EACH }).map((o) => ({ id: o.id, name: o.name, kind: o.kind })) : null;
    if (organizations) sections.push("organizations");
    const partialSections: { section: "incidents"; reason: string }[] = [];
    let incidents: { id: string; title: string; status: string }[] | null = null;
    if (allowed(p.grant, "incidents.view")) {
      incidents = [];
      try {
        incidents = (await new AdminIncidents(this.ctx, new PlatformAdminStore(this.ctx.platform, this.ctx.ephemeral), this.audit).list(p, { q, limit: SEARCH_EACH })).incidents.map(i => ({ id: i.id, title: i.title, status: i.status }));
        sections.push("incidents");
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "case_search_too_broad") throw error;
        partialSections.push({ section: "incidents", reason: "Case title search needs a narrower queue. Open cases and filter by status, account, community or assignee, or search an exact case ID." });
      }
    }
    const devices = allowed(p.grant, "devices.view") ? devicesPage(this.ctx.identity, { ids: [q], limit: SEARCH_EACH }).map((d) => ({ id: d.id, userId: d.user_id, name: d.name })) : null;
    if (devices) sections.push("devices");
    const audit = allowed(p.grant, "audit.view")
      ? platform
          .all<{ id: number; at: number; action: string }>("platform_audit", { where: { $or: [{ request_id: q }, { target_id: q }] }, orderBy: [["id", "desc"]], limit: SEARCH_EACH })
          .map((a) => ({ id: a.id, at: a.at, action: a.action }))
      : null;
    if (audit) sections.push("audit");
    return { users, organizations, incidents, devices, audit, sections, partialSections };
  }

  async export(p: AdminPrincipal, kind: ExportKind, q: ExportRequest, meta: RequestMeta, maximum = EXPORT_MAX_ROWS, progress?: (rows: number) => Promise<void>) {
    if (!allowed(p.grant, "exports.create") || !allowed(p.grant, EXPORT_NEEDS[kind])) {
      await this.audit.record({ action: "export.create", outcome: "denied", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "export", targetId: kind, reason: q.reason, requestId: meta.requestId });
      throw forbidden("Your console role doesn't allow that export.");
    }
    if ((q.from || q.to) && !["users", "audit", "active-users"].includes(kind)) throw badRequest("Use this dataset's supported record filters; it does not accept calendar range filters.");
    const startedAt = now();
    let filters: Record<string, unknown> = {};
    try { filters = q.filters ? JSON.parse(q.filters) : {}; } catch { throw badRequest("The export filters are invalid."); }
    if (!filters || Array.isArray(filters) || typeof filters !== "object" || "cursor" in filters || "limit" in filters)
      throw badRequest("Export filters must describe all matching records, without a page cursor or limit.");
    const store = new PlatformAdminStore(this.ctx.platform, this.ctx.ephemeral);
    let header: string[];
    let rows: unknown[][] = [];
    let byteCount = 0;
    const append = (row: unknown[]) => {
      byteCount += Buffer.byteLength(row.map(csvCell).join(",") + "\r\n", "utf8");
      if (byteCount > 10 * 1024 * 1024 - 4096) throw new ApiError(422, "export_too_large", "The export exceeds 10 MiB. Narrow the filters; no incomplete file was published.");
      rows.push(row);
    };
    // Each page uses the same domain service and field permissions as the operational table.
    // A job has bounded pages and rows; data can change during generation, so timestamps are exposed rather than claiming a historical snapshot.
    const collect = async <T>(load: (cursor?: string) => Promise<{ items: T[]; next: string | null }>, row: (item: T) => unknown[]) => {
      let cursor: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const result = await load(cursor);
        for (const item of result.items) append(row(item));
        if (rows.length > maximum) throw new ApiError(422, "export_too_large", `More than ${maximum.toLocaleString("en-US")} rows match. Narrow the filters or date range; no incomplete file was produced.`);
        if (progress) await progress(rows.length);
        if (!result.next) return;
        if (cursor === result.next) throw new ApiError(500, "export_cursor", "The export did not advance. Retry after refreshing the source.");
        cursor = result.next;
      }
      throw new ApiError(422, "export_too_large", "This search spans too much history. Narrow the filters or dates.");
    };
    const filter = <S extends z.ZodType>(schema: S, extra: Record<string, unknown> = {}) => parse(schema, { ...filters, ...extra, limit: 100 });
    switch (kind) {
      case "users": {
        const query = filter(AdminUsersQuery, { ...(q.from ? { createdFrom: q.from } : {}), ...(q.to ? { createdTo: q.to } : {}) });
        const source = new AdminUsers(this.ctx, store, this.audit);
        header = ["id", "username", "display_name", "status", "created_at", "last_active_at", "active_devices", "last_seen_at"];
        await collect(async (cursor) => { const r = await source.search(p, { ...query, cursor }); return { items: r.users, next: r.nextCursor }; }, u => [u.id, u.username, u.displayName, u.status, u.createdAt, u.lastActiveAt, u.activeDevices, u.lastSeenAt]);
        break;
      }
      case "organizations": {
        const query = filter(AdminOrgsQuery);
        const { decodeCursor, page } = await import("./pagination.js");
        header = ["id", "name", "kind", "visibility", "members", "created_at"];
        await collect(async (cursor) => { const r = page(searchOrgs(this.ctx.ws, { q: query.q, kind: query.kind, after: decodeCursor(cursor), limit: 251 }), 250); return { items: r.rows, next: r.nextCursor }; }, o => [o.id, o.name, o.kind, o.visibility, o.members, o.created_at]);
        break;
      }
      case "devices": {
        const query = filter(AdminDevicesQuery);
        const source = new AdminDevices(this.ctx, store, this.audit, this.exclusions);
        header = ["id", "user_id", "username", "name", "platform", "created_at", "last_seen_at", "revoked_at"];
        await collect(async cursor => { const r = await source.inventory({ ...query, cursor }); return { items: r.devices, next: r.nextCursor }; }, d => [d.id, d.userId, d.username, d.name, d.platform, d.createdAt, d.lastSeenAt, d.revokedAt]);
        break;
      }
      case "audit": {
        const query = filter(AdminAuditQuery, { ...(q.from ? { from: Date.parse(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { to: Date.parse(`${q.to}T00:00:00Z`) + DAY_MS - 1 } : {}) });
        const source = new AdminAuditView(this.ctx, this.audit);
        header = ["id", "at", "request_id", "actor_account_id", "actor_role", "action", "target_type", "target_id", "outcome", "reason"];
        await collect(async cursor => { const r = await source.search({ ...query, cursor: cursor ? Number(cursor) : undefined }); return { items: r.events, next: r.nextCursor }; }, e => [e.id, e.at, e.requestId, e.actor?.accountId, e.actorRole, e.action, e.targetType, e.targetId, e.outcome, e.reason]);
        break;
      }
      case "incidents": {
        const query = filter(AdminIncidentsQuery);
        const source = new AdminIncidents(this.ctx, store, this.audit);
        header = ["id", "title", "severity", "status", "kind", "service", "source", "user_ref", "org_ref", "account_ref", "subscription_ref", "payment_ref", "created_at", "resolved_at", "closed_at"];
        await collect(async cursor => { const r = await source.list(p, { ...query, cursor }); return { items: r.incidents, next: r.nextCursor }; }, i => [i.id, i.title, i.severity, i.status, i.kind, i.service, i.source, i.userRef, i.orgRef, i.accountRef, i.subscriptionRef, i.paymentRef, i.createdAt, i.resolvedAt, i.closedAt]);
        break;
      }
      case "quota-events": {
        const query = filter(AdminQuotaEventsQuery);
        const source = new AdminQuotas(this.ctx, this.audit);
        header = ["id", "at", "quota", "scope_type", "scope_id", "outcome", "amount", "used", "limit", "detail"];
        await collect(async cursor => { const r = await source.events({ ...query, cursor: cursor ? Number(cursor) : undefined }); return { items: r.events, next: r.nextCursor === null ? null : String(r.nextCursor) }; }, e => [e.id, e.at, e.key, e.scopeType, e.scopeId, e.outcome, e.amount, e.used, e.limit, e.detail]);
        break;
      }
      case "active-users": {
        if (Object.keys(filters).length) throw badRequest("Activity exports accept date filters only.");
        const ex = await this.exclusions.get(startedAt);
        const report = activityReport(this.ctx, ex.ids, q, startedAt);
        header = ["day", "dau", "wau", "mau", "new_active", "returning_active", "collected", "partial", "generated_at", "timezone"];
        rows = report.days.map(d => [d.day, d.dau, d.wau, d.mau, d.newActive, d.returningActive, d.collected, d.partial, report.generatedAt, report.timezone]);
        break;
      }
    }
    const csv = toCsv(header, rows);
    if (Buffer.byteLength(csv, "utf8") > 10 * 1024 * 1024) throw new ApiError(422, "export_too_large", "The export exceeds 10 MiB. Narrow the filters; no incomplete file was published.");
    const completedAt = now();
    await this.audit.record({ action: "export.create", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "export", targetId: kind, reason: q.reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { rows: rows.length, startedAt, completedAt, truncated: false } });
    return { filename: `meldiq-${kind}-${utcDay(startedAt)}.csv`, csv, rows: rows.length, startedAt, completedAt };
  }
}

export interface ExportRequest { from?: string; to?: string; reason: string; filters?: string }
