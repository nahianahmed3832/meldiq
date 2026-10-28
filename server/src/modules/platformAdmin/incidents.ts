import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { badRequest, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { userSummary } from "../accounts/index.js";
import { orgRecord } from "../organizations/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { decodeCursor, page } from "./pagination.js";
import { can } from "./permissions.js";
import type { PlatformAdminStore } from "./store.js";

type Severity = "sev1" | "sev2" | "sev3" | "sev4";
/** Stored statuses (migration 046's constraint); acknowledged and closed are timestamps on top of them. */
type StoredStatus = "open" | "investigating" | "mitigated" | "resolved";
/** The lifecycle the console shows: open → acknowledged → investigating → monitoring → resolved → closed. */
export type Status = "open" | "acknowledged" | "investigating" | "monitoring" | "resolved" | "closed";
type Kind = "incident" | "maintenance" | "support";
type EventKind = "note" | "status" | "severity" | "assign" | "created";

const STORED: Record<Status, StoredStatus> = { open: "open", acknowledged: "open", investigating: "investigating", monitoring: "mitigated", resolved: "resolved", closed: "resolved" };

/** The lifecycle status of a stored row. */
function lifecycle(r: Pick<IncidentRow, "status" | "acknowledged_at" | "closed_at">): Status {
  if (r.closed_at) return "closed";
  if (r.status === "resolved") return "resolved";
  if (r.status === "mitigated") return "monitoring";
  if (r.status === "investigating") return "investigating";
  return r.acknowledged_at ? "acknowledged" : "open";
}

interface IncidentRow {
  id: string;
  title: string;
  severity: Severity;
  status: StoredStatus;
  kind: Kind;
  assignee_account_id: string | null;
  user_ref: string | null;
  org_ref: string | null;
  notice: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  service: string | null;
  source: string;
  dedupe_key: string | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
  acknowledged_at: number | null;
  closed_at: number | null;
  resolution: string | null;
}

interface EventRow {
  at: number;
  kind: EventKind;
  body: string;
  actor_account_id: string;
}

const EVENTS_SHOWN = 200;

/** Account names for display, one lookup per distinct id (the account store may be MongoDB). */
async function names(ctx: AppContext, ids: (string | null)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(ids.filter((i): i is string => !!i))) {
    const a = await ctx.accounts.store.accountById(id);
    if (a) out.set(id, a.name);
  }
  return out;
}

const person = (n: Map<string, string>, id: string) => ({ accountId: id, name: n.get(id) ?? null });

function view(r: IncidentRow, n: Map<string, string>) {
  return {
    id: r.id,
    title: r.title,
    severity: r.severity,
    status: lifecycle(r),
    kind: r.kind,
    service: r.service,
    source: r.source === "rule" ? ("rule" as const) : ("manual" as const),
    ruleKey: r.dedupe_key?.startsWith("rule:") ? r.dedupe_key.slice(5) : null,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    acknowledgedAt: r.acknowledged_at,
    closedAt: r.closed_at,
    resolution: r.resolution,
    assignee: r.assignee_account_id ? person(n, r.assignee_account_id) : null,
    userRef: r.user_ref,
    orgRef: r.org_ref,
    notice: r.notice,
    createdBy: person(n, r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

/**
 * Incidents, maintenance and support cases (phase 4): Meldiq had no tracker, so this is a minimal one. Nothing is ever
 * deleted; every change is an event on the incident and a row in the platform audit. A notice is text for a service
 * announcement; the console doesn't publish it anywhere by itself.
 */
export class AdminIncidents {
  constructor(
    private readonly ctx: AppContext,
    private readonly store: PlatformAdminStore,
    private readonly audit: PlatformAudit,
  ) {}

  private row(id: string): IncidentRow {
    const r = this.ctx.db.prepare("SELECT * FROM platform_incidents WHERE id = ?").get(id) as IncidentRow | undefined;
    if (!r) throw notFound("No such incident");
    return r;
  }

  private event(incidentId: string, kind: EventKind, body: string, actor: string, t: number): void {
    this.ctx.db.prepare("INSERT INTO platform_incident_events (incident_id, at, actor_account_id, kind, body) VALUES (?, ?, ?, ?, ?)").run(incidentId, t, actor, kind, body);
  }

  private record(p: AdminPrincipal, action: string, incidentId: string, meta: RequestMeta, detail: Record<string, string | null>): void {
    this.audit.record({ action, outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "incident", targetId: incidentId, requestId: meta.requestId, network: networkKey(meta.ip), detail });
  }

  async assignees() {
    const ids = this.store.grants().filter((g) => g.revoked_at === null && can(g.role, "incidents.manage")).map((g) => g.account_id);
    const n = await names(this.ctx, ids);
    return { assignees: ids.map((id) => person(n, id)) };
  }

  async list(q: { status?: Status | "active"; severity?: Severity; source?: "manual" | "rule"; kind?: Kind; userRef?: string; orgRef?: string; cursor?: string; limit: number }) {
    const where: string[] = ["1 = 1"];
    const args: (string | number)[] = [];
    if (q.status === "active") where.push("status != 'resolved'");
    else if (q.status === "closed") where.push("closed_at IS NOT NULL");
    else if (q.status === "resolved") where.push("status = 'resolved' AND closed_at IS NULL");
    else if (q.status === "acknowledged") where.push("status = 'open' AND acknowledged_at IS NOT NULL");
    else if (q.status === "open") where.push("status = 'open' AND acknowledged_at IS NULL");
    else if (q.status) {
      where.push("status = ?");
      args.push(STORED[q.status]);
    }
    for (const [col, v] of [["severity", q.severity], ["source", q.source], ["kind", q.kind], ["user_ref", q.userRef], ["org_ref", q.orgRef]] as const) {
      if (v) {
        where.push(`${col} = ?`);
        args.push(v);
      }
    }
    const after = decodeCursor(q.cursor);
    if (after) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(after.createdAt, after.createdAt, after.id);
    }
    const rows = this.ctx.db.prepare(`SELECT * FROM platform_incidents WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, q.limit + 1) as IncidentRow[];
    const { rows: shown, nextCursor } = page(rows, q.limit);
    const n = await names(this.ctx, shown.flatMap((r) => [r.created_by, r.assignee_account_id]));
    return { incidents: shown.map((r) => view(r, n)), nextCursor };
  }

  async detail(id: string) {
    const r = this.row(id);
    const events = this.ctx.db.prepare("SELECT at, kind, body, actor_account_id FROM platform_incident_events WHERE incident_id = ? ORDER BY id LIMIT ?").all(id, EVENTS_SHOWN) as EventRow[];
    const n = await names(this.ctx, [r.created_by, r.assignee_account_id, ...events.map((e) => e.actor_account_id)]);
    return { incident: view(r, n), events: events.map((e) => ({ at: e.at, kind: e.kind, body: e.body, actor: person(n, e.actor_account_id) })) };
  }

  async create(p: AdminPrincipal, b: { title: string; severity: Severity; kind: Kind; userRef?: string; orgRef?: string; notice?: string; description: string; service?: string }, meta: RequestMeta) {
    if (b.userRef && !userSummary(this.ctx.db, b.userRef)) throw badRequest("No person has that user id.");
    if (b.orgRef && !orgRecord(this.ctx.ws, b.orgRef)) throw badRequest("No workspace or community has that id.");
    const id = newId("inc");
    const t = now();
    this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare(
          `INSERT INTO platform_incidents (id, title, severity, status, kind, assignee_account_id, user_ref, org_ref, notice, created_by, created_at, updated_at, resolved_at, service, source, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, 'open', ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, 'manual', ?, ?)`,
        )
        .run(id, b.title, b.severity, b.kind, b.userRef ?? null, b.orgRef ?? null, b.notice || null, p.account.id, t, t, b.service ?? null, t, t);
      this.event(id, "created", b.description, p.account.id, t);
      this.record(p, "incident.create", id, meta, { severity: b.severity, kind: b.kind });
    })();
    return this.detail(id);
  }

  async update(
    p: AdminPrincipal,
    id: string,
    patch: { status?: Status; severity?: Severity; assigneeAccountId?: string | null; notice?: string | null; resolution?: string | null; service?: string | null },
    meta: RequestMeta,
  ) {
    const r = this.row(id);
    const assignee = patch.assigneeAccountId ? this.store.activeGrant(patch.assigneeAccountId) : undefined;
    if (patch.assigneeAccountId && (!assignee || !can(assignee.role, "incidents.manage"))) throw badRequest("Incidents can only be assigned to an admin who manages incidents.");
    const t = now();
    const current = lifecycle(r);
    const next = patch.status ?? current;
    const resolution = patch.resolution === undefined ? r.resolution : patch.resolution || null;
    if ((next === "resolved" || next === "closed") && current !== "resolved" && current !== "closed" && !resolution) {
      throw badRequest("Write a resolution summary to resolve an incident: what happened and what fixed it.");
    }
    if (next === "closed" && current !== "resolved" && current !== "closed" && patch.status === "closed" && !resolution) throw badRequest("Resolve the incident before closing it.");
    const changes: [EventKind, string][] = [];
    if (next !== current) changes.push(["status", `${current} → ${next}`]);
    if (patch.severity && patch.severity !== r.severity) changes.push(["severity", `${r.severity} → ${patch.severity}`]);
    if (patch.assigneeAccountId !== undefined && patch.assigneeAccountId !== r.assignee_account_id) {
      const n = await names(this.ctx, [patch.assigneeAccountId]);
      changes.push(["assign", patch.assigneeAccountId ? `Assigned to ${n.get(patch.assigneeAccountId) ?? patch.assigneeAccountId}` : "Unassigned"]);
    }
    const noticeChanged = patch.notice !== undefined && (patch.notice || null) !== r.notice;
    if (noticeChanged) changes.push(["note", patch.notice ? `Notice updated: ${patch.notice}` : "Notice removed"]);
    if (resolution !== r.resolution && resolution) changes.push(["note", `Resolution: ${resolution}`]);
    const serviceChanged = patch.service !== undefined && (patch.service || null) !== r.service;
    if (serviceChanged) changes.push(["note", `Affected service: ${patch.service || "none"}`]);
    if (changes.length === 0) return this.detail(id);
    const stored = STORED[next];
    // Acknowledged once anyone moves it past "open"; reopening keeps when it was first acknowledged.
    const acknowledgedAt = next === "open" ? r.acknowledged_at && current === "acknowledged" ? null : r.acknowledged_at : (r.acknowledged_at ?? t);
    this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare(
          `UPDATE platform_incidents SET status = ?, severity = ?, assignee_account_id = ?, notice = ?, updated_at = ?,
             resolved_at = ?, acknowledged_at = ?, closed_at = ?, resolution = ?, service = ? WHERE id = ?`,
        )
        .run(
          stored,
          patch.severity ?? r.severity,
          patch.assigneeAccountId === undefined ? r.assignee_account_id : patch.assigneeAccountId,
          noticeChanged ? patch.notice || null : r.notice,
          t,
          stored === "resolved" ? (r.resolved_at ?? t) : null,
          acknowledgedAt,
          next === "closed" ? (r.closed_at ?? t) : null,
          resolution,
          serviceChanged ? patch.service || null : r.service,
          id,
        );
      for (const [kind, body] of changes) this.event(id, kind, body, p.account.id, t);
      this.record(p, "incident.update", id, meta, Object.fromEntries(changes.map(([k, v], i) => [`${k}${i}`, v])));
    })();
    return this.detail(id);
  }

  async note(p: AdminPrincipal, id: string, body: string, meta: RequestMeta) {
    this.row(id);
    const t = now();
    this.ctx.db.transaction(() => {
      this.event(id, "note", body, p.account.id, t);
      this.ctx.db.prepare("UPDATE platform_incidents SET updated_at = ? WHERE id = ?").run(t, id);
      this.record(p, "incident.note", id, meta, {});
    })();
    return this.detail(id);
  }
}
