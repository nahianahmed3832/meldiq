import type { AppContext } from "../../app/context.js";
import { likeContains } from "../../shared/utilities/sqlText.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { forbidden } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { devicesPage, searchUsers } from "../accounts/index.js";
import { quotaAdmin } from "../quotas/index.js";
import { searchOrgs } from "../organizations/index.js";
import { analytics, utcDay } from "../telemetry/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import type { Exclusions } from "./exclusions.js";
import { can, type Permission } from "./permissions.js";
import { statusOf, userExtras } from "./users.js";

const SEARCH_EACH = 8;
/** Rows an export may hold (beyond it, narrow the date range). */
export const EXPORT_MAX_ROWS = 5000;
const DAY_MS = 86_400_000;

/** One CSV cell: quoted when needed, and never starting like a formula (spreadsheets would run it). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "number" && v > 1e12 && v < 1e14 ? new Date(v).toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

type ExportKind = "users" | "organizations" | "devices" | "audit" | "incidents" | "quota-events" | "active-users";

const NEEDS: Record<ExportKind, Permission> = {
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

  search(p: AdminPrincipal, q: string) {
    const { platform, ws } = this.ctx;
    const role = p.grant.role;
    const sections: string[] = [];
    const users = can(role, "users.view")
      ? searchUsers(this.ctx.identity, { q, limit: SEARCH_EACH }).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, status: statusOf(u) }))
      : null;
    if (users) sections.push("users");
    const organizations = can(role, "orgs.view") ? searchOrgs(ws, { q, limit: SEARCH_EACH }).map((o) => ({ id: o.id, name: o.name, kind: o.kind })) : null;
    if (organizations) sections.push("organizations");
    const incidents = can(role, "incidents.view")
      ? platform
          .all<{ id: string; title: string; status: string; closed_at: number | null }>("platform_incidents", { orderBy: [["created_at", "desc"]] })
          .filter((i) => i.id === q || likeContains(i.title, q))
          .slice(0, SEARCH_EACH)
          .map((i) => ({ id: i.id, title: i.title, status: i.closed_at ? "closed" : i.status === "mitigated" ? "monitoring" : i.status }))
      : null;
    if (incidents) sections.push("incidents");
    const devices = can(role, "devices.view") ? devicesPage(this.ctx.identity, { ids: [q], limit: SEARCH_EACH }).map((d) => ({ id: d.id, userId: d.user_id, name: d.name })) : null;
    if (devices) sections.push("devices");
    const audit = can(role, "audit.view")
      ? platform
          .all<{ id: number; at: number; action: string }>("platform_audit", { where: { $or: [{ request_id: q }, { target_id: q }] }, orderBy: [["id", "desc"]], limit: SEARCH_EACH })
          .map((a) => ({ id: a.id, at: a.at, action: a.action }))
      : null;
    if (audit) sections.push("audit");
    return { users, organizations, incidents, devices, audit, sections };
  }

  async export(p: AdminPrincipal, kind: ExportKind, q: { from?: string; to?: string; reason: string }, meta: RequestMeta): Promise<{ filename: string; csv: string; rows: number }> {
    if (!can(p.grant.role, NEEDS[kind])) {
      await this.audit.record({ action: "export.create", outcome: "denied", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "export", targetId: kind, reason: q.reason, requestId: meta.requestId, network: networkKey(meta.ip) });
      throw forbidden("Your console role doesn't allow that.");
    }
    const t = now();
    const to = q.to ?? utcDay(t);
    const from = q.from ?? utcDay(t - 29 * DAY_MS);
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
    const { platform, ws } = this.ctx;
    let header: string[];
    let rows: unknown[][];
    switch (kind) {
      case "users": {
        const list = searchUsers(this.ctx.identity, { limit: EXPORT_MAX_ROWS, createdFrom: fromMs, createdTo: toMs });
        const extras = userExtras(this.ctx, list.map((u) => u.id));
        header = ["id", "username", "display_name", "status", "created_at", "last_active_at", "active_devices", "last_seen_at"];
        rows = list.map((u) => [u.id, u.username, u.display_name, statusOf(u), u.created_at, extras.get(u.id)?.lastActiveAt ?? "", u.active_devices, u.last_seen_at ?? ""]);
        break;
      }
      case "organizations": {
        header = ["id", "name", "kind", "visibility", "members", "created_at"];
        rows = searchOrgs(ws, { limit: EXPORT_MAX_ROWS }).map((o) => [o.id, o.name, o.kind, o.visibility, o.members, o.created_at]);
        break;
      }
      case "devices": {
        header = ["id", "user_id", "username", "name", "created_at", "last_seen_at", "revoked_at"];
        rows = devicesPage(this.ctx.identity, { limit: EXPORT_MAX_ROWS }).map((d) => [d.id, d.user_id, d.username ?? "", d.name, d.created_at, d.last_seen_at ?? "", d.revoked_at ?? ""]);
        break;
      }
      case "audit": {
        header = ["id", "at", "request_id", "actor_account_id", "actor_role", "action", "target_type", "target_id", "outcome", "reason"];
        rows = platform
          .all<Record<string, unknown>>("platform_audit", { where: { at: { gte: fromMs } }, orderBy: [["id", "asc"]] })
          .filter((r) => (r.at as number) < toMs)
          .slice(0, EXPORT_MAX_ROWS)
          .map((r) => header.map((h) => r[h]));
        break;
      }
      case "incidents": {
        header = ["id", "title", "severity", "status", "kind", "service", "source", "created_at", "acknowledged_at", "resolved_at", "closed_at"];
        rows = platform
          .all<Record<string, unknown>>("platform_incidents", { where: { created_at: { gte: fromMs } }, orderBy: [["created_at", "asc"]] })
          .filter((r) => (r.created_at as number) < toMs)
          .slice(0, EXPORT_MAX_ROWS)
          .map((r) => header.map((h) => r[h]));
        break;
      }
      case "quota-events": {
        header = ["id", "at", "quota", "scope_type", "scope_id", "outcome", "amount", "used", "limit", "detail"];
        rows = quotaAdmin.eventsPage(platform, { from: fromMs, to: toMs, limit: EXPORT_MAX_ROWS }).map((e) => [e.id, e.at, e.quota_key, e.scope_type, e.scope_id, e.outcome, e.amount, e.used, e.limit_value ?? "", e.detail ?? ""]);
        break;
      }
      case "active-users": {
        const ex = await this.exclusions.get(t);
        header = ["day", "dau", "wau", "mau", "new_active", "returning_active"];
        rows = analytics.activeUsers(this.ctx, from, to, ex.ids).map((d) => [d.day, d.dau, d.wau, d.mau, d.newActive, d.returningActive]);
        break;
      }
    }
    await this.audit.record({
      action: "export.create",
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "export",
      targetId: kind,
      reason: q.reason,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail: { rows: rows.length, from, to, truncated: rows.length >= EXPORT_MAX_ROWS },
    });
    return { filename: `meldiq-${kind}-${from}-${to}.csv`, csv: toCsv(header, rows), rows: rows.length };
  }
}
