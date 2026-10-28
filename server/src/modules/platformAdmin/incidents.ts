import type { AppContext } from "../../app/context.js";
import type { RowWriter, Where } from "../../infrastructure/database/rows/index.js";
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

/** The lifecycle statuses that aren't one stored status. */
const STATUS_WHERE: Record<string, Where> = {
  active: { status: { ne: "resolved" } },
  closed: { closed_at: { ne: null } },
  resolved: { status: "resolved", closed_at: null },
  acknowledged: { status: "open", acknowledged_at: { ne: null } },
  open: { status: "open", acknowledged_at: null },
};

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
    const r = this.ctx.platform.get<IncidentRow>("platform_incidents", { id });
    if (!r) throw notFound("No such incident");
    return r;
  }

  private event(w: RowWriter, incidentId: string, kind: EventKind, body: string, actor: string, t: number): void {
    w.insert("platform_incident_events", { incident_id: incidentId, at: t, actor_account_id: actor, kind, body });
  }

  private record(w: RowWriter, p: AdminPrincipal, action: string, incidentId: string, meta: RequestMeta, detail: Record<string, string | null>): void {
    this.audit.append(w, { action, outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "incident", targetId: incidentId, requestId: meta.requestId, network: networkKey(meta.ip), detail });
  }

  async assignees() {
    const ids = this.store.grants().filter((g) => g.revoked_at === null && can(g.role, "incidents.manage")).map((g) => g.account_id);
    const n = await names(this.ctx, ids);
    return { assignees: ids.map((id) => person(n, id)) };
  }

  async list(q: { status?: Status | "active"; severity?: Severity; source?: "manual" | "rule"; kind?: Kind; userRef?: string; orgRef?: string; cursor?: string; limit: number }) {
    const where: Where = { ...(STATUS_WHERE[q.status ?? ""] ?? (q.status ? { status: STORED[q.status as Status] } : {})) };
    for (const [col, v] of [["severity", q.severity], ["source", q.source], ["kind", q.kind], ["user_ref", q.userRef], ["org_ref", q.orgRef]] as const) {
      if (v) where[col] = v;
    }
    const after = decodeCursor(q.cursor);
    // Ids compare as text, which the rows language doesn't: rows sharing the cursor's time are filtered here.
    if (after) where.created_at = { lte: after.createdAt };
    const rows = this.ctx.platform
      .all<IncidentRow>("platform_incidents", { where, orderBy: [["created_at", "desc"], ["id", "desc"]] })
      .filter((r) => !after || r.created_at < after.createdAt || r.id < after.id)
      .slice(0, q.limit + 1);
    const { rows: shown, nextCursor } = page(rows, q.limit);
    const n = await names(this.ctx, shown.flatMap((r) => [r.created_by, r.assignee_account_id]));
    return { incidents: shown.map((r) => view(r, n)), nextCursor };
  }

  async detail(id: string) {
    const r = this.row(id);
    const events = this.ctx.platform.all<EventRow>("platform_incident_events", { where: { incident_id: id }, orderBy: [["id", "asc"]], limit: EVENTS_SHOWN });
    const n = await names(this.ctx, [r.created_by, r.assignee_account_id, ...events.map((e) => e.actor_account_id)]);
    return { incident: view(r, n), events: events.map((e) => ({ at: e.at, kind: e.kind, body: e.body, actor: person(n, e.actor_account_id) })) };
  }

  async create(p: AdminPrincipal, b: { title: string; severity: Severity; kind: Kind; userRef?: string; orgRef?: string; notice?: string; description: string; service?: string }, meta: RequestMeta) {
    if (b.userRef && !userSummary(this.ctx.identity, b.userRef)) throw badRequest("No person has that user id.");
    if (b.orgRef && !orgRecord(this.ctx.ws, b.orgRef)) throw badRequest("No workspace or community has that id.");
    const id = newId("inc");
    const t = now();
    await this.ctx.platform.write((w) => {
      w.insert("platform_incidents", {
        id,
        title: b.title,
        severity: b.severity,
        status: "open",
        kind: b.kind,
        assignee_account_id: null,
        user_ref: b.userRef ?? null,
        org_ref: b.orgRef ?? null,
        notice: b.notice || null,
        created_by: p.account.id,
        created_at: t,
        updated_at: t,
        resolved_at: null,
        service: b.service ?? null,
        source: "manual",
        first_seen_at: t,
        last_seen_at: t,
      });
      this.event(w, id, "created", b.description, p.account.id, t);
      this.record(w, p, "incident.create", id, meta, { severity: b.severity, kind: b.kind });
    });
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
    await this.ctx.platform.write((w) => {
      w.update(
        "platform_incidents",
        { id },
        {
          status: stored,
          severity: patch.severity ?? r.severity,
          assignee_account_id: patch.assigneeAccountId === undefined ? r.assignee_account_id : patch.assigneeAccountId,
          notice: noticeChanged ? patch.notice || null : r.notice,
          updated_at: t,
          resolved_at: stored === "resolved" ? (r.resolved_at ?? t) : null,
          acknowledged_at: acknowledgedAt,
          closed_at: next === "closed" ? (r.closed_at ?? t) : null,
          resolution,
          service: serviceChanged ? patch.service || null : r.service,
        },
      );
      for (const [kind, body] of changes) this.event(w, id, kind, body, p.account.id, t);
      this.record(w, p, "incident.update", id, meta, Object.fromEntries(changes.map(([k, v], i) => [`${k}${i}`, v])));
    });
    return this.detail(id);
  }

  async note(p: AdminPrincipal, id: string, body: string, meta: RequestMeta) {
    this.row(id);
    const t = now();
    await this.ctx.platform.write((w) => {
      this.event(w, id, "note", body, p.account.id, t);
      w.update("platform_incidents", { id }, { updated_at: t });
      this.record(w, p, "incident.note", id, meta, {});
    });
    return this.detail(id);
  }
}
