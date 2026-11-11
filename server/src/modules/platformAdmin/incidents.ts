import { createHash } from "node:crypto";
import type { AppContext } from "../../app/context.js";
import type {
  RowWriter,
  Where,
} from "../../infrastructure/database/rows/index.js";
import { networkKey } from "../../app/middleware/abuse.js";
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { bugReport, userSummary } from "../accounts/index.js";
import { adminPaymentAssociation } from "../billing/index.js";
import { orgRecord } from "../organizations/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { decodeCursor, page } from "./pagination.js";
import { allowed } from "./permissions.js";
import type { PlatformAdminStore } from "./store.js";

type Severity = "sev1" | "sev2" | "sev3" | "sev4";
type StoredStatus = "open" | "investigating" | "mitigated" | "resolved";
export type Status =
  | "open"
  | "acknowledged"
  | "investigating"
  | "monitoring"
  | "resolved"
  | "closed";
type Kind = "incident" | "maintenance" | "support";
type PaymentKind = "invoice" | "gift" | "spark" | "collectible";
type EventKind = "note" | "status" | "severity" | "assign" | "created";
const STORED: Record<Status, StoredStatus> = {
  open: "open",
  acknowledged: "open",
  investigating: "investigating",
  monitoring: "mitigated",
  resolved: "resolved",
  closed: "resolved",
};
const STATUSES: Status[] = [
  "open",
  "acknowledged",
  "investigating",
  "monitoring",
  "resolved",
  "closed",
];
const EVENTS_SHOWN = 100;
const SEARCH_LIMIT = 5_000;

function lifecycle(
  r: Pick<IncidentRow, "status" | "acknowledged_at" | "closed_at">,
): Status {
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
  account_ref: string | null;
  subscription_ref: string | null;
  payment_ref: string | null;
  payment_kind: PaymentKind | null;
  intake_ref: string | null;
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
  version: number;
}
interface EventRow {
  id: number;
  at: number;
  kind: EventKind;
  body: string;
  actor_account_id: string;
}
interface Association {
  userRef?: string;
  orgRef?: string;
  accountRef?: string;
  subscriptionRef?: string;
  paymentRef?: string;
  paymentKind?: PaymentKind;
}
export interface IncidentQuery extends Association {
  q?: string;
  status?: Status | "active";
  severity?: Severity;
  source?: "manual" | "rule" | "feedback";
  kind?: Kind;
  assigneeAccountId?: string;
  cursor?: string;
  limit: number;
}
interface Create extends Association {
  feedbackRef?: string;
  requestKey: string;
  title: string;
  severity: Severity;
  kind: Kind;
  notice?: string;
  description: string;
  service?: string;
}
interface Patch {
  requestKey: string;
  version: number;
  status?: Status;
  severity?: Severity;
  assigneeAccountId?: string | null;
  notice?: string | null;
  resolution?: string | null;
  service?: string | null;
}
interface RequestRow {
  action: string;
  payload_hash: string;
  incident_id: string;
}
const STATUS_WHERE: Record<string, Where> = {
  active: { status: { ne: "resolved" } },
  closed: { closed_at: { ne: null } },
  resolved: { status: "resolved", closed_at: null },
  acknowledged: { status: "open", acknowledged_at: { ne: null } },
  open: { status: "open", acknowledged_at: null },
};

/** The same exact filters are used by list, aggregate counts and authorized exports. */
export function incidentWhere(q: Omit<IncidentQuery, "limit">): Where {
  const where: Where = {
    ...(STATUS_WHERE[q.status ?? ""] ??
      (q.status ? { status: STORED[q.status as Status] } : {})),
  };
  for (const [col, value] of [
    ["severity", q.severity],
    ["source", q.source],
    ["kind", q.kind],
    ["user_ref", q.userRef],
    ["org_ref", q.orgRef],
    ["account_ref", q.accountRef],
    ["subscription_ref", q.subscriptionRef],
    ["payment_ref", q.paymentRef],
    ["payment_kind", q.paymentKind],
  ] as const)
    if (value) where[col] = value;
  if (q.assigneeAccountId)
    where.assignee_account_id =
      q.assigneeAccountId === "unassigned" ? null : q.assigneeAccountId;
  return where;
}
async function names(
  ctx: AppContext,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(ids.filter((i): i is string => !!i))) {
    const account = await ctx.accounts.store.accountById(id);
    if (account) out.set(id, account.name);
  }
  return out;
}
const person = (n: Map<string, string>, id: string) => ({
  accountId: id,
  name: n.get(id) ?? null,
});
function view(r: IncidentRow, n: Map<string, string>, p: AdminPrincipal) {
  const canUsers = allowed(p.grant, "users.view"),
    canBilling = allowed(p.grant, "billing.view"),
    canOrgs = allowed(p.grant, "orgs.view");
  return {
    id: r.id,
    title: r.title,
    severity: r.severity,
    status: lifecycle(r),
    kind: r.kind,
    service: r.service,
    source:
      r.source === "rule"
        ? ("rule" as const)
        : r.source === "feedback"
          ? ("feedback" as const)
          : ("manual" as const),
    feedbackRef: r.intake_ref,
    ruleKey: r.dedupe_key?.startsWith("rule:") ? r.dedupe_key.slice(5) : null,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    acknowledgedAt: r.acknowledged_at,
    closedAt: r.closed_at,
    resolution: r.resolution,
    assignee: r.assignee_account_id ? person(n, r.assignee_account_id) : null,
    userRef: canUsers ? r.user_ref : null,
    accountRef: canUsers || canBilling ? r.account_ref : null,
    orgRef: canOrgs ? r.org_ref : null,
    subscriptionRef: canBilling ? r.subscription_ref : null,
    paymentRef: canBilling ? r.payment_ref : null,
    paymentKind: canBilling ? r.payment_kind : null,
    notice: r.notice,
    createdBy: person(n, r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
    version: r.version,
  };
}
const digest = (data: object) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(data).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    )
    .digest("hex");

/** Operational support records. No message reader, impersonation, payment mutation or outbound notification. */
export class AdminIncidents {
  constructor(
    private readonly ctx: AppContext,
    private readonly store: PlatformAdminStore,
    private readonly audit: PlatformAudit,
  ) {}
  private row(id: string): IncidentRow {
    const row = this.ctx.platform.get<IncidentRow>("platform_incidents", {
      id,
    });
    if (!row) throw notFound("No such incident or case");
    return row;
  }
  private event(
    w: RowWriter,
    id: string,
    kind: EventKind,
    body: string,
    actor: string,
    at: number,
  ): void {
    w.insert("platform_incident_events", {
      incident_id: id,
      at,
      actor_account_id: actor,
      kind,
      body,
    });
  }
  private record(
    w: RowWriter,
    p: AdminPrincipal,
    action: string,
    id: string,
    meta: RequestMeta,
    detail: Record<string, string | number | null>,
  ): void {
    this.audit.append(w, {
      action,
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "incident",
      targetId: id,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail,
    });
  }
  private replay(
    w: RowWriter,
    p: AdminPrincipal,
    action: string,
    requestKey: string,
    hash: string,
  ): string | undefined {
    const previous = w.get<RequestRow>("platform_incident_requests", {
      actor_account_id: p.account.id,
      request_key: requestKey,
    });
    if (!previous) return;
    if (previous.action !== action || previous.payload_hash !== hash)
      throw conflict(
        "This request key already belongs to a different change. Reload and review the current case.",
      );
    return previous.incident_id;
  }
  private remember(
    w: RowWriter,
    p: AdminPrincipal,
    action: string,
    key: string,
    hash: string,
    id: string,
    at: number,
  ): void {
    w.insert("platform_incident_requests", {
      actor_account_id: p.account.id,
      request_key: key,
      action,
      payload_hash: hash,
      incident_id: id,
      created_at: at,
    });
  }
  private authorizeReferences(p: AdminPrincipal, b: Association): void {
    if (b.userRef && !allowed(p.grant, "users.view"))
      throw forbidden("Viewing people is required to use a person reference.");
    if (b.orgRef && !allowed(p.grant, "orgs.view"))
      throw forbidden(
        "Viewing communities is required to use a community reference.",
      );
    if (
      b.accountRef &&
      !allowed(p.grant, "users.view") &&
      !allowed(p.grant, "billing.view")
    )
      throw forbidden(
        "Viewing accounts is required to use an account reference.",
      );
    if (
      (b.subscriptionRef || b.paymentRef || b.paymentKind) &&
      !allowed(p.grant, "billing.view")
    )
      throw forbidden(
        "Viewing billing is required to use a billing reference.",
      );
  }
  private async associations(
    p: AdminPrincipal,
    b: Association,
  ): Promise<Association> {
    this.authorizeReferences(p, b);
    const refs = { ...b };
    if (refs.userRef && !userSummary(this.ctx.identity, refs.userRef))
      throw badRequest("No person has that user ID.");
    if (refs.orgRef && !orgRecord(this.ctx.ws, refs.orgRef))
      throw badRequest("No community has that ID.");
    if (!!refs.paymentKind !== !!refs.paymentRef)
      throw badRequest("A payment reference needs its record kind and ID.");
    let owner: { account_id: string | null; org_id: string | null } | undefined;
    if (refs.subscriptionRef) {
      const subscription = this.ctx.billing.subscriptions.get(refs.subscriptionRef);
      if (!subscription) throw badRequest("No subscription has that ID.");
      owner = subscription;
    }
    if (refs.paymentRef && refs.paymentKind) {
      const payment = adminPaymentAssociation(this.ctx.billing.rows, refs.paymentKind, refs.paymentRef);
      if (!payment) throw badRequest("No payment record has that ID and kind.");
      const paymentOwner = {
        account_id: payment.account_id,
        org_id: payment.org_id ?? null,
      };
      if (
        owner &&
        (owner.account_id !== paymentOwner.account_id ||
          owner.org_id !== paymentOwner.org_id)
      )
        throw badRequest(
          "The payment and subscription belong to different billing owners.",
        );
      if (
        refs.paymentKind === "invoice" &&
        refs.subscriptionRef &&
        payment.subscription_id !== refs.subscriptionRef
      )
        throw badRequest("The invoice belongs to another subscription.");
      if (refs.paymentKind === "invoice" && payment.subscription_id)
        refs.subscriptionRef = payment.subscription_id;
      owner = paymentOwner;
    }
    if (owner) {
      if (refs.accountRef && owner.account_id !== refs.accountRef)
        throw badRequest("The billing record belongs to a different account.");
      if (refs.orgRef && owner.org_id && owner.org_id !== refs.orgRef)
        throw badRequest(
          "The billing record belongs to a different community.",
        );
      if (owner.account_id) refs.accountRef = owner.account_id;
      if (owner.org_id) refs.orgRef = owner.org_id;
    }
    if (refs.accountRef) {
      const account = await this.ctx.accounts.store.accountById(
        refs.accountRef,
      );
      if (!account) throw badRequest("No account has that ID.");
      if (refs.userRef && account.user_id !== refs.userRef)
        throw badRequest(
          "The person and account references must identify the same account.",
        );
      if (account.user_id) refs.userRef = account.user_id;
    }
    return refs;
  }
  async assignees() {
    const ids = this.store
      .grants()
      .filter((g) => g.revoked_at === null && allowed(g, "incidents.manage"))
      .map((g) => g.account_id);
    const n = await names(this.ctx, ids);
    return { assignees: ids.map((id) => person(n, id)) };
  }
  private filtered(p: AdminPrincipal, q: IncidentQuery): IncidentRow[] {
    this.authorizeReferences(p, q);
    const where = incidentWhere(q);
    const after = decodeCursor(q.cursor);
    if (after)
      where.$or = [
        { created_at: { lt: after.createdAt } },
        { created_at: after.createdAt, id: { lt: after.id } },
      ];
    // Exact IDs remain useful even when title search needs a narrower queue.
    if (q.q) {
      const exact = this.ctx.platform.get<IncidentRow>("platform_incidents", { ...where, id: q.q });
      if (exact) return [exact];
    }
    const rows = this.ctx.platform.all<IncidentRow>("platform_incidents", {
      where,
      orderBy: [
        ["created_at", "desc"],
        ["id", "desc"],
      ],
      limit: q.q ? SEARCH_LIMIT + 1 : q.limit + 1,
    });
    if (!q.q) return rows;
    if (rows.length > SEARCH_LIMIT)
      throw new ApiError(422, "case_search_too_broad",
        "Narrow the status, account, community or assignee filters before searching more than 5,000 cases.",
      );
    const needle = q.q.toLowerCase();
    return rows.filter(
      (r) =>
        r.id.toLowerCase() === needle || r.title.toLowerCase().includes(needle),
    );
  }
  async list(p: AdminPrincipal, q: IncidentQuery) {
    const result = page(this.filtered(p, q).slice(0, q.limit + 1), q.limit);
    const n = await names(
      this.ctx,
      result.rows.flatMap((r) => [r.created_by, r.assignee_account_id]),
    );
    return {
      incidents: result.rows.map((r) => view(r, n, p)),
      nextCursor: result.nextCursor,
    };
  }
  summary(p: AdminPrincipal, q: IncidentQuery) {
    this.authorizeReferences(p, q);
    const where = incidentWhere(q);
    const matches = q.q
      ? this.filtered(p, { ...q, cursor: undefined, limit: SEARCH_LIMIT })
      : null;
    const count = (extra: Where) =>
      this.ctx.platform.count("platform_incidents", { ...where, ...extra });
    const bySeverity = Object.fromEntries(
      (["sev1", "sev2", "sev3", "sev4"] as const).map((severity) => [
        severity,
        q.severity && q.severity !== severity
          ? 0
          : matches
            ? matches.filter((r) => r.severity === severity).length
            : count({ severity }),
      ]),
    );
    const byStatus = Object.fromEntries(
      STATUSES.map((status) => [
        status,
        q.status &&
        q.status !== status &&
        !(q.status === "active" && status !== "resolved" && status !== "closed")
          ? 0
          : matches
            ? matches.filter((r) => lifecycle(r) === status).length
            : this.ctx.platform.count(
                "platform_incidents",
                incidentWhere({ ...q, status }),
              ),
      ]),
    );
    return {
      generatedAt: now(),
      total: matches ? matches.length : count({}),
      bySeverity,
      byStatus,
    };
  }
  async detail(p: AdminPrincipal, id: string, before?: number) {
    const row = this.row(id);
    const events = this.ctx.platform.all<EventRow>("platform_incident_events", {
      where: { incident_id: id, ...(before ? { id: { lt: before } } : {}) },
      orderBy: [["id", "desc"]],
      limit: EVENTS_SHOWN + 1,
    });
    const shown = events.slice(0, EVENTS_SHOWN).reverse();
    const n = await names(this.ctx, [
      row.created_by,
      row.assignee_account_id,
      ...shown.map((e) => e.actor_account_id),
    ]);
    return {
      incident: view(row, n, p),
      nextEventsBefore: events.length > EVENTS_SHOWN ? shown[0].id : null,
      events: shown.map((e) => ({
        at: e.at,
        kind: e.kind,
        body: e.body,
        actor: person(n, e.actor_account_id),
      })),
    };
  }
  async create(p: AdminPrincipal, b: Create, meta: RequestMeta) {
    const refs = await this.associations(p, b);
    if (
      b.feedbackRef &&
      bugReport(this.ctx.safety, b.feedbackRef)?.user_id !== refs.userRef
    )
      throw badRequest(
        "That submitted feedback is unavailable for this person.",
      );
    const hash = digest(b),
      at = now();
    const id = await this.ctx.platform.write((w) => {
      const previous = this.replay(w, p, "create", b.requestKey, hash);
      if (previous) return previous;
      const linked = b.feedbackRef
        ? w.get<{ id: string }>("platform_incidents", {
            intake_ref: b.feedbackRef,
          })
        : undefined;
      if (linked) {
        this.remember(w, p, "create", b.requestKey, hash, linked.id, at);
        return linked.id;
      }
      const id = newId("inc");
      w.insert("platform_incidents", {
        id,
        title: b.title,
        severity: b.severity,
        status: "open",
        kind: b.kind,
        assignee_account_id: null,
        user_ref: refs.userRef ?? null,
        org_ref: refs.orgRef ?? null,
        account_ref: refs.accountRef ?? null,
        subscription_ref: refs.subscriptionRef ?? null,
        payment_ref: refs.paymentRef ?? null,
        payment_kind: refs.paymentKind ?? null,
        notice: b.notice || null,
        created_by: p.account.id,
        created_at: at,
        updated_at: at,
        resolved_at: null,
        service: b.service ?? null,
        intake_ref: b.feedbackRef ?? null,
        source: b.feedbackRef ? "feedback" : "manual",
        first_seen_at: at,
        last_seen_at: at,
        version: 0,
      });
      this.event(w, id, "created", b.description, p.account.id, at);
      this.record(w, p, "incident.create", id, meta, {
        severity: b.severity,
        kind: b.kind,
        account: refs.accountRef ?? null,
        subscription: refs.subscriptionRef ?? null,
        payment: refs.paymentRef ?? null,
        operation: b.requestKey,
      });
      this.remember(w, p, "create", b.requestKey, hash, id, at);
      return id;
    });
    return this.detail(p, id);
  }
  async update(p: AdminPrincipal, id: string, patch: Patch, meta: RequestMeta) {
    const assignee = patch.assigneeAccountId
      ? this.store.activeGrant(patch.assigneeAccountId)
      : undefined;
    if (
      patch.assigneeAccountId &&
      (!assignee || !allowed(assignee, "incidents.manage"))
    )
      throw badRequest(
        "Cases can only be assigned to an admin who manages incidents.",
      );
    const n = await names(this.ctx, [patch.assigneeAccountId ?? null]);
    const hash = digest({ ...patch, id }),
      at = now();
    await this.ctx.platform.write((w) => {
      if (this.replay(w, p, "update", patch.requestKey, hash)) return;
      const row = w.get<IncidentRow>("platform_incidents", { id });
      if (!row) throw notFound("No such incident or case");
      if (row.version !== patch.version)
        throw conflict(
          "This case changed. Your input was kept. Reload the latest case and review the changes before saving.",
        );
      const current = lifecycle(row),
        next = patch.status ?? current;
      const resolution =
        patch.resolution === undefined
          ? row.resolution
          : patch.resolution || null;
      if ((next === "resolved" || next === "closed") && !resolution)
        throw badRequest(
          "Write a resolution summary before resolving or closing a case.",
        );
      const changes: [EventKind, string][] = [];
      if (next !== current) changes.push(["status", `${current} → ${next}`]);
      if (patch.severity && patch.severity !== row.severity)
        changes.push(["severity", `${row.severity} → ${patch.severity}`]);
      if (
        patch.assigneeAccountId !== undefined &&
        patch.assigneeAccountId !== row.assignee_account_id
      )
        changes.push([
          "assign",
          patch.assigneeAccountId
            ? `Assigned to ${n.get(patch.assigneeAccountId) ?? patch.assigneeAccountId}`
            : "Unassigned",
        ]);
      const noticeChanged =
        patch.notice !== undefined && (patch.notice || null) !== row.notice;
      if (noticeChanged)
        changes.push([
          "note",
          patch.notice ? `Notice updated: ${patch.notice}` : "Notice removed",
        ]);
      if (resolution !== row.resolution)
        changes.push([
          "note",
          resolution ? `Resolution: ${resolution}` : "Resolution removed",
        ]);
      const serviceChanged =
        patch.service !== undefined && (patch.service || null) !== row.service;
      if (serviceChanged)
        changes.push(["note", `Affected service: ${patch.service || "none"}`]);
      if (changes.length) {
        w.update(
          "platform_incidents",
          { id, version: patch.version },
          {
            status: STORED[next],
            severity: patch.severity ?? row.severity,
            assignee_account_id:
              patch.assigneeAccountId === undefined
                ? row.assignee_account_id
                : patch.assigneeAccountId,
            notice: noticeChanged ? patch.notice || null : row.notice,
            updated_at: at,
            version: row.version + 1,
            resolved_at:
              STORED[next] === "resolved" ? (row.resolved_at ?? at) : null,
            acknowledged_at:
              next === "open" ? null : (row.acknowledged_at ?? at),
            closed_at: next === "closed" ? (row.closed_at ?? at) : null,
            resolution,
            service: serviceChanged ? patch.service || null : row.service,
          },
        );
        for (const [kind, body] of changes)
          this.event(w, id, kind, body, p.account.id, at);
        this.record(w, p, "incident.update", id, meta, {
          ...Object.fromEntries(
            changes.map(([kind, body], i) => [`${kind}${i}`, body]),
          ),
          operation: patch.requestKey,
          beforeVersion: row.version,
          version: row.version + 1,
        });
      }
      this.remember(w, p, "update", patch.requestKey, hash, id, at);
    });
    return this.detail(p, id);
  }
  async note(
    p: AdminPrincipal,
    id: string,
    b: { body: string; requestKey: string },
    meta: RequestMeta,
  ) {
    const hash = digest({ ...b, id }),
      at = now();
    await this.ctx.platform.write((w) => {
      if (this.replay(w, p, "note", b.requestKey, hash)) return;
      const row = w.get<IncidentRow>("platform_incidents", { id });
      if (!row) throw notFound("No such incident or case");
      this.event(w, id, "note", b.body, p.account.id, at);
      w.update(
        "platform_incidents",
        { id },
        { updated_at: at, version: row.version + 1 },
      );
      this.record(w, p, "incident.note", id, meta, { operation: b.requestKey });
      this.remember(w, p, "note", b.requestKey, hash, id, at);
    });
    return this.detail(p, id);
  }
}
