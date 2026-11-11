import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { RowWriter } from "../src/infrastructure/database/rows/index.js";
import { PlatformAudit } from "../src/modules/platformAdmin/audit.js";
import {
  AdminAlerts,
  AdminSearch,
} from "../src/shared/contracts/http/platformAdminInsights.js";
import { AccountClient, email, MemoryMailer } from "./support/accounts.js";
import {
  AdminBrowser,
  consoleAdmin,
  type ConsoleAdmin,
} from "./support/adminConsole.js";
import { startServer, type Harness } from "./support/harness.js";
import {
  AdminIncidentDetail,
  AdminIncidentSummary,
  AdminReportSummary,
} from "../src/shared/contracts/http/platformAdmin.js";

let h: Harness,
  support: ConsoleAdmin,
  owner: ConsoleAdmin,
  auditor: ConsoleAdmin,
  operations: ConsoleAdmin,
  person: AccountClient,
  other: AccountClient;
const mailer = new MemoryMailer();
let id: string;
const create = () => ({
  requestKey: randomUUID(),
  title: "Investigate payment access",
  kind: "support",
  severity: "sev2",
  description: "User supplied receipt reference; no private content.",
  accountRef: person.accountId,
});
beforeAll(async () => {
  h = await startServer(
    { ADMIN_CONSOLE_ORIGIN: "https://admin.example.test" },
    { mailer },
  );
  owner = await consoleAdmin(h, mailer, "super_admin", "caseowner");
  support = await consoleAdmin(h, mailer, "support_admin", "casesupport");
  auditor = await consoleAdmin(h, mailer, "auditor", "caseauditor");
  operations = await consoleAdmin(
    h,
    mailer,
    "operations_admin",
    "caseoperations",
  );
  person = await new AccountClient(h.baseUrl, email("caseperson")).signUp(
    mailer,
  );
  await person.signIn();
  await person.setUpIdentity(`casep${Date.now().toString(36)}`);
  other = await new AccountClient(h.baseUrl, email("caseother")).signUp(mailer);
  await other.signIn();
  await other.setUpIdentity(`caseo${Date.now().toString(36)}`);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await h.close();
});

describe("support workflow durability and authority", () => {
  it("creates once under concurrent duplicate submission, binds account identity, survives reload and audits once", async () => {
    const body = create();
    const [a, b] = await Promise.all([
      support.browser.expect(200, "POST", "/admin/v1/incidents", body),
      support.browser.expect(200, "POST", "/admin/v1/incidents", body),
    ]);
    expect(a.incident.id).toBe(b.incident.id);
    id = a.incident.id;
    expect(AdminIncidentDetail.safeParse(a).success).toBe(true);
    expect(a.incident).toMatchObject({
      accountRef: person.accountId,
      userRef: person.userId,
      version: 0,
      status: "open",
    });
    expect(
      (await support.browser.expect(200, "GET", `/admin/v1/incidents/${id}`))
        .incident.id,
    ).toBe(id);
    expect(
      h.ctx.platform.count("platform_audit", {
        action: "incident.create",
        target_id: id,
      }),
    ).toBe(1);
    await support.browser.expect(409, "POST", "/admin/v1/incidents", {
      ...body,
      title: "Different action using an old key",
    });
    await support.browser.expect(400, "POST", "/admin/v1/incidents", {
      ...create(),
      userRef: other.userId,
    });
  });
  it("links a canonical payment to its buyer and prevents mismatched ownership without exposing billing fields", async () => {
    const at = Date.now();
    await h.ctx.billing.rows.write((w) =>
      w.insert("mojo_gifts", {
        id: "gft_case_link",
        buyer_account_id: person.accountId,
        buyer_user_id: person.userId,
        recipient_user_id: other.userId,
        plan_key: "plus",
        months: 1,
        currency: "USD",
        amount_minor: 399,
        note: null,
        status: "paid",
        provider: "paypal",
        provider_session_ref: "CASEORDER",
        provider_payment_ref: "CASEPAYMENT",
        grant_id: null,
        created_at: at,
        expires_at: at + 86400000,
        paid_at: at,
        redeemed_at: null,
        updated_at: at,
      }),
    );
    const linked = await support.browser.expect(
      200,
      "POST",
      "/admin/v1/incidents",
      { ...create(), paymentKind: "gift", paymentRef: "gft_case_link" },
    );
    expect(linked.incident).toMatchObject({
      accountRef: person.accountId,
      paymentKind: "gift",
      paymentRef: "gft_case_link",
    });
    await support.browser.expect(400, "POST", "/admin/v1/incidents", {
      ...create(),
      accountRef: other.accountId,
      paymentKind: "gift",
      paymentRef: "gft_case_link",
    });
    const redacted = await operations.browser.expect(
      200,
      "GET",
      `/admin/v1/incidents/${linked.incident.id}`,
    );
    expect(redacted.incident).toMatchObject({
      paymentRef: null,
      paymentKind: null,
      subscriptionRef: null,
    });
    // Keep this separate closed fixture out of the active workload fixture below.
    await support.browser.expect(
      200,
      "PATCH",
      `/admin/v1/incidents/${linked.incident.id}`,
      {
        requestKey: randomUUID(),
        version: 0,
        status: "resolved",
        resolution: "Payment owner confirmed.",
      },
    );
  });
  it("uses optimistic revision checks and preserves one winner under concurrent edits", async () => {
    const results = await Promise.all([
      support.browser.req("PATCH", `/admin/v1/incidents/${id}`, {
        requestKey: randomUUID(),
        version: 0,
        status: "investigating",
      }),
      support.browser.req("PATCH", `/admin/v1/incidents/${id}`, {
        requestKey: randomUUID(),
        version: 0,
        severity: "sev1",
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await support.browser.expect(200, "GET", `/admin/v1/incidents/${id}`))
        .incident.version,
    ).toBe(1);
    await support.browser.expect(400, "PATCH", `/admin/v1/incidents/${id}`, {
      status: "closed",
    });
  });
  it("deduplicates internal notes and replays a committed update without overwriting newer changes", async () => {
    const note = {
      requestKey: randomUUID(),
      body: "Internal investigation: provider receipt checked.",
    };
    await support.browser.expect(
      200,
      "POST",
      `/admin/v1/incidents/${id}/notes`,
      note,
    );
    await support.browser.expect(
      200,
      "POST",
      `/admin/v1/incidents/${id}/notes`,
      note,
    );
    let d = await support.browser.expect(
      200,
      "GET",
      `/admin/v1/incidents/${id}`,
    );
    expect(
      d.events.filter((event: any) => event.body === note.body),
    ).toHaveLength(1);
    const patch = {
      requestKey: randomUUID(),
      version: d.incident.version,
      status: "resolved",
      resolution: "Access matches the canonical subscription.",
    };
    d = await support.browser.expect(
      200,
      "PATCH",
      `/admin/v1/incidents/${id}`,
      patch,
    );
    const closed = await support.browser.expect(
      200,
      "PATCH",
      `/admin/v1/incidents/${id}`,
      {
        requestKey: randomUUID(),
        version: d.incident.version,
        status: "closed",
      },
    );
    const retried = await support.browser.expect(
      200,
      "PATCH",
      `/admin/v1/incidents/${id}`,
      patch,
    );
    expect(retried.incident).toMatchObject({
      status: "closed",
      version: closed.incident.version,
    });
    expect(
      h.ctx.platform.count("platform_audit", {
        action: "incident.note",
        target_id: id,
      }),
    ).toBe(1);
  });
  it("denies read-only/community direct requests and permission-restricted association filters", async () => {
    await auditor.browser.expect(403, "POST", "/admin/v1/incidents", create());
    await new AdminBrowser(h).expect(401, "GET", `/admin/v1/incidents/${id}`);
    await operations.browser.expect(
      403,
      "GET",
      "/admin/v1/incidents?subscriptionRef=sub_unknown",
    );
    await operations.browser.expect(403, "POST", "/admin/v1/incidents", {
      ...create(),
      paymentKind: "invoice",
      paymentRef: "inv_unknown",
    });
    await support.browser.expect(400, "POST", "/admin/v1/incidents", {
      ...create(),
      paymentKind: "invoice",
      paymentRef: "inv_unknown",
    });
  });
  it("paginates same-time rows, aggregates all matching records and exposes all event pages", async () => {
    const original = h.ctx.platform.get<any>("platform_incidents", { id })!;
    await h.ctx.platform.write((w) => {
      for (let i = 0; i < 115; i++)
        w.insert("platform_incidents", {
          ...original,
          id: `inc_casefixture_${String(i).padStart(3, "0")}`,
          title: `Queue case ${i}`,
          status: "open",
          acknowledged_at: null,
          closed_at: null,
          resolved_at: null,
          resolution: null,
          created_at: 12345,
          version: 0,
        });
      for (let i = 0; i < 130; i++)
        w.insert("platform_incident_events", {
          incident_id: id,
          at: 12345 + i,
          kind: "note",
          body: `Safe note ${i}`,
          actor_account_id: support.account.accountId,
        });
    });
    const summary = await support.browser.expect(
      200,
      "GET",
      `/admin/v1/incidents/summary?status=active&kind=support&accountRef=${person.accountId}`,
    );
    expect(AdminIncidentSummary.safeParse(summary).success).toBe(true);
    expect(summary).toMatchObject({
      total: 115,
      byStatus: { open: 115 },
      bySeverity: { [original.severity]: 115 },
    });
    const found: string[] = [];
    let cursor = "";
    do {
      const p = await support.browser.expect(
        200,
        "GET",
        `/admin/v1/incidents?status=active&kind=support&limit=25${cursor ? `&cursor=${cursor}` : ""}`,
      );
      found.push(...p.incidents.map((v: any) => v.id));
      cursor = p.nextCursor ?? "";
    } while (cursor);
    expect(new Set(found).size).toBe(115);
    expect(found).toHaveLength(115);
    const latest = await support.browser.expect(
      200,
      "GET",
      `/admin/v1/incidents/${id}`,
    );
    expect(latest.events).toHaveLength(100);
    expect(latest.nextEventsBefore).toBeGreaterThan(0);
    const earlier = await support.browser.expect(
      200,
      "GET",
      `/admin/v1/incidents/${id}?before=${latest.nextEventsBefore}`,
    );
    expect(earlier.events[0].kind).toBe("created");
    expect(earlier.nextEventsBefore).toBeNull();
    expect(
      (
        await support.browser.expect(
          200,
          "GET",
          "/admin/v1/incidents?q=Queue%20case%20110",
        )
      ).incidents.map((r: any) => r.title),
    ).toEqual(["Queue case 110"]);
  });
  it("rejects a foreign device ID before disconnecting another person's sockets", async () => {
    const device = h.ctx.identity.get<{ id: string }>("devices", {
      user_id: other.userId,
    })!;
    const disconnect = vi.spyOn(h.ctx.hub, "disconnectDevice");
    await support.browser.expect(404, "POST", "/admin/v1/presence/disconnect", {
      userId: person.userId,
      deviceId: device.id,
      reason: "Investigate this person's stalled connection",
    });
    expect(disconnect).not.toHaveBeenCalled();
    disconnect.mockRestore();
  });
  it("counts reports beyond the old 100-row sample using the canonical report store", async () => {
    const reporter = await h.client("case_reporter");
    const result = await reporter.req("POST", "/v1/reports", {
      targetUserId: person.userId,
      reason: "spam",
    });
    const original = (await h.ctx.reports.get(result.report.id))!;
    for (let i = 0; i < 110; i++)
      await h.ctx.reports.create({
        ...original,
        id: `rep_casefixture_${i}`,
        status: i < 105 ? "open" : "dismissed",
        created_at: 12345 + i,
      });
    const summary = await support.browser.expect(
      200,
      "GET",
      "/admin/v1/reports/summary",
    );
    expect(AdminReportSummary.safeParse(summary).success).toBe(true);
    expect(summary).toMatchObject({ open: 106, dismissed: 5, total: 111 });
    const filtered = await support.browser.expect(
      200,
      "GET",
      "/admin/v1/reports/summary?status=dismissed",
    );
    expect(filtered).toMatchObject({ open: 0, dismissed: 5, total: 5 });
  });
  it("manages intentionally submitted feedback and links exactly one support case", async () => {
    const sent = await person.req("POST", "/v1/bug-reports", {
      summary: "Settings checkbox fails to persist",
      details:
        "Safe disposable feedback: reopen the settings page after saving.",
    });
    const feedbackId = sent.report.id;
    const queue = await support.browser.expect(
      200,
      "GET",
      "/admin/v1/support/feedback?status=open",
    );
    expect(queue.feedback.find((f: any) => f.id === feedbackId)).toMatchObject({
      summary: "Settings checkbox fails to persist",
      status: "open",
      userId: person.userId,
    });
    await auditor.browser.expect(
      403,
      "PATCH",
      `/admin/v1/support/feedback/${feedbackId}`,
      {},
    );
    const reviewed = await support.browser.expect(
      200,
      "PATCH",
      `/admin/v1/support/feedback/${feedbackId}`,
      {
        requestKey: randomUUID(),
        expectedUpdatedAt: sent.report.updatedAt,
        status: "confirmed",
        staffNote: "We reproduced this issue in a disposable test.",
        reason: "Confirmed the settings persistence reproduction",
      },
    );
    expect(reviewed.feedback.status).toBe("confirmed");
    const own = await person.req("GET", "/v1/bug-reports");
    expect(own.bugHunter).toBe(true);
    expect(own.reports.find((f: any) => f.id === feedbackId).staffNote).toBe(
      "We reproduced this issue in a disposable test.",
    );
    await support.browser.expect(
      409,
      "PATCH",
      `/admin/v1/support/feedback/${feedbackId}`,
      {
        requestKey: randomUUID(),
        expectedUpdatedAt: sent.report.updatedAt,
        status: "duplicate",
        staffNote: null,
        reason: "Stale review must not overwrite the newer finding",
      },
    );
    const a = await support.browser.expect(
      200,
      "POST",
      `/admin/v1/support/feedback/${feedbackId}/case`,
      {
        requestKey: randomUUID(),
        reason: "Investigate the confirmed settings persistence issue",
      },
    );
    const b = await support.browser.expect(
      200,
      "POST",
      `/admin/v1/support/feedback/${feedbackId}/case`,
      {
        requestKey: randomUUID(),
        reason: "Investigate the confirmed settings persistence issue",
      },
    );
    expect(a.incident.id).toBe(b.incident.id);
    expect(a.incident).toMatchObject({
      feedbackRef: feedbackId,
      source: "feedback",
      userRef: person.userId,
      kind: "support",
    });
    expect(
      (
        await support.browser.expect(
          200,
          "GET",
          `/admin/v1/support/feedback/${feedbackId}`,
        )
      ).feedback.caseId,
    ).toBe(a.incident.id);
    expect(
      h.ctx.platform.count("platform_audit", {
        action: "feedback.review",
        target_id: feedbackId,
        outcome: "success",
      }),
    ).toBe(1);
  });
  it("recovers an accepted feedback review after bookkeeping failure without repeating its canonical effect", async () => {
    const sent = await person.req("POST", "/v1/bug-reports", {
      summary: "Safe recovery case",
      details: "Intentional simulated storage failure during finalization.",
    });
    const body = {
      requestKey: randomUUID(),
      expectedUpdatedAt: sent.report.updatedAt,
      status: "fixed",
      staffNote: "The repair has been verified.",
      reason: "Verify recovery of accepted feedback review",
    };
    const originalWrite = h.ctx.platform.write.bind(h.ctx.platform);
    let finalizationFailed = false;
    const fail = vi
      .spyOn(h.ctx.platform, "write")
      .mockImplementation(async (fn) =>
        originalWrite((writer) =>
          fn(
            new Proxy(writer, {
              get(target, property) {
                if (property === "update")
                  return (...args: Parameters<RowWriter["update"]>) => {
                    if (
                      args[0] === "platform_feedback_reviews" &&
                      args[2].status === "applied" &&
                      !finalizationFailed
                    ) {
                      finalizationFailed = true;
                      throw new Error("simulated finalization failure");
                    }
                    return target.update(...args);
                  };
                const value = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ),
      );
    await support.browser.expect(
      500,
      "PATCH",
      `/admin/v1/support/feedback/${sent.report.id}`,
      body,
    );
    fail.mockRestore();
    expect(finalizationFailed).toBe(true);
    const accepted = h.ctx.safety.get<any>("bug_reports", {
      id: sent.report.id,
    });
    expect(accepted.status).toBe("fixed");
    const replayed = await support.browser.expect(
      200,
      "PATCH",
      `/admin/v1/support/feedback/${sent.report.id}`,
      body,
    );
    expect(replayed.feedback.updatedAt).toBe(accepted.updated_at);
    expect(replayed.reviews[0].status).toBe("applied");
    expect(
      h.ctx.platform.count("platform_audit", {
        action: "feedback.review",
        target_id: sent.report.id,
        outcome: "success",
      }),
    ).toBe(1);
  });
  it("records bounded recovery outcomes, duplicate requests and failures without repeating moderation decisions", async () => {
    await h.ctx.platform.write((w) =>
      w.insert("platform_report_cases", {
        report_id: "rep_casefixture_0",
        assignee_account_id: null,
        priority: "normal",
        appeal_status: "none",
        sync_status: "pending",
        intended_status: "actioned",
        version: 0,
        updated_at: Date.now() - 120000,
      }),
    );
    const set = vi.spyOn(h.ctx.reports, "setStatus");
    const body = {
      requestKey: randomUUID(),
      reason: "Reconcile interrupted report workflow metadata",
    };
    const first = await owner.browser.expect(
      200,
      "POST",
      "/admin/v1/reports/recovery",
      body,
    );
    expect(first).toMatchObject({ status: "completed", affected: 1 });
    const duplicate = await owner.browser.expect(
      200,
      "POST",
      "/admin/v1/reports/recovery",
      body,
    );
    expect(duplicate.id).toBe(first.id);
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
    expect(
      (await owner.browser.expect(200, "GET", "/admin/v1/reports/recovery"))
        .runs[0].id,
    ).toBe(first.id);
    await owner.browser.expect(409, "POST", "/admin/v1/reports/recovery", {
      ...body,
      reason: "Different operation attempting to reuse an existing key",
    });
    await auditor.browser.expect(403, "POST", "/admin/v1/reports/recovery", {
      requestKey: randomUUID(),
      reason: "Read-only admin cannot request recovery",
    });
    await h.ctx.platform.write((w) =>
      w.insert("platform_report_cases", {
        report_id: "rep_casefixture_1",
        assignee_account_id: null,
        priority: "normal",
        appeal_status: "none",
        sync_status: "pending",
        intended_status: "actioned",
        version: 0,
        updated_at: Date.now() - 120000,
      }),
    );
    const outage = vi
      .spyOn(h.ctx.reports, "get")
      .mockRejectedValueOnce(new Error("simulated canonical store failure"));
    const failed = await owner.browser.expect(
      200,
      "POST",
      "/admin/v1/reports/recovery",
      {
        requestKey: randomUUID(),
        reason: "Record a simulated report store outage",
      },
    );
    outage.mockRestore();
    expect(failed).toMatchObject({
      status: "failed",
      affected: null,
      errorKind: "recovery_failed",
    });
    expect(
      h.ctx.platform.get("platform_report_cases", {
        report_id: "rep_casefixture_1",
      }),
    ).toMatchObject({ sync_status: "pending" });
    expect(
      h.ctx.platform.count("platform_audit", {
        action: "report.recovery_completed",
        target_id: first.id,
      }),
    ).toBe(1);
  });
  it("requires a reviewed alert revision, rejects competing saves and rolls back if its audit cannot commit", async () => {
    const url = "/admin/v1/alerts/host.cpu";
    const original = (
      await operations.browser.expect(200, "GET", "/admin/v1/alerts")
    ).rules.find((r: any) => r.key === "host.cpu");
    expect(original.updatedAt).toBeNull();
    const body = {
      enabled: true,
      threshold: 41,
      windowMinutes: 10,
      severity: "sev3",
      reason: "Review disposable host CPU alert threshold",
    };
    await operations.browser.expect(400, "PUT", url, body);
    await auditor.browser.expect(403, "PUT", url, {
      ...body,
      expectedUpdatedAt: original.updatedAt,
    });
    const first = await operations.browser.expect(200, "PUT", url, {
      ...body,
      expectedUpdatedAt: original.updatedAt,
    });
    expect(AdminAlerts.safeParse(first).success).toBe(true);
    const revision = first.rules.find(
      (r: any) => r.key === "host.cpu",
    ).updatedAt;
    const concurrent = await Promise.all(
      [42, 43].map((threshold) =>
        operations.browser.req("PUT", url, {
          ...body,
          threshold,
          expectedUpdatedAt: revision,
        }),
      ),
    );
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = concurrent
      .find((r) => r.status === 200)!
      .body.rules.find((r: any) => r.key === "host.cpu");
    const saved = (
      await auditor.browser.expect(200, "GET", "/admin/v1/alerts")
    ).rules.find((r: any) => r.key === "host.cpu");
    expect(saved).toMatchObject({
      threshold: winner.threshold,
      updatedAt: winner.updatedAt,
      isDefault: false,
    });
    expect(saved.updatedAt).toBeGreaterThan(revision);
    const audits = h.ctx.platform.all<any>("platform_audit", {
      where: { action: "alerts.rule_update", target_id: "host.cpu" },
      orderBy: [["id", "desc"]],
    });
    expect(audits).toHaveLength(2);
    expect(JSON.parse(JSON.parse(audits[0].detail).before)).toMatchObject({
      threshold: 41,
      updatedAt: revision,
    });
    expect(JSON.parse(JSON.parse(audits[0].detail).after)).toMatchObject({
      threshold: winner.threshold,
      updatedAt: winner.updatedAt,
    });
    const append = PlatformAudit.prototype.append;
    const failedAudit = vi
      .spyOn(PlatformAudit.prototype, "append")
      .mockImplementation(function (w, entry, at) {
        if (entry.action === "alerts.rule_update")
          throw new Error("simulated audit persistence failure");
        return append.call(this, w, entry, at);
      });
    await operations.browser.expect(500, "PUT", url, {
      ...body,
      threshold: 44,
      expectedUpdatedAt: saved.updatedAt,
    });
    failedAudit.mockRestore();
    expect(
      h.ctx.platform.get("alert_rules", { key: "host.cpu" }),
    ).toMatchObject({
      threshold: winner.threshold,
      updated_at: winner.updatedAt,
    });
    expect(
      h.ctx.platform.count("platform_audit", {
        action: "alerts.rule_update",
        target_id: "host.cpu",
      }),
    ).toBe(2);
  });
  it("keeps global results and exact case IDs usable when title search exceeds the bounded case queue", async () => {
    const original = h.ctx.platform.get<any>("platform_incidents", { id })!;
    await h.ctx.platform.write((w) => {
      for (let i = 0; i < 5001; i++)
        w.insert("platform_incidents", {
          ...original,
          id: `inc_largesearch_${i}`,
          title: `Large safe queue ${i}`,
          intake_ref: null,
          dedupe_key: null,
        });
    });
    const result = await auditor.browser.expect(
      200,
      "GET",
      `/admin/v1/search?q=${person.username}`,
    );
    expect(AdminSearch.safeParse(result).success).toBe(true);
    expect(result.users.map((u: any) => u.id)).toContain(person.userId);
    expect(result.partialSections).toEqual([
      {
        section: "incidents",
        reason: expect.stringContaining("narrower queue"),
      },
    ]);
    expect(result.sections).not.toContain("incidents");
    const broad = await auditor.browser.expect(
      422,
      "GET",
      "/admin/v1/incidents?q=Large",
    );
    expect(broad.error.code).toBe("case_search_too_broad");
    const exact = await auditor.browser.expect(
      200,
      "GET",
      `/admin/v1/search?q=${id}`,
    );
    expect(exact.incidents).toEqual([expect.objectContaining({ id })]);
    expect(exact.partialSections).toEqual([]);
    const summary = await auditor.browser.expect(
      200,
      "GET",
      `/admin/v1/incidents/summary?q=${id}`,
    );
    expect(summary.total).toBe(1);
  });
  it("cannot concurrently suspend every enabled super administrator", async () => {
    const first = await consoleAdmin(
        h,
        mailer,
        "super_admin",
        "case_first_super",
      ),
      second = await consoleAdmin(
        h,
        mailer,
        "super_admin",
        "case_second_super",
      );
    await first.account.setUpIdentity(`casefirst${Date.now().toString(36)}`);
    await second.account.setUpIdentity(`casesecond${Date.now().toString(36)}`);
    await h.ctx.accounts.store.updateAccount(
      owner.account.accountId,
      { disabled_at: Date.now() },
      Date.now(),
    );
    const results = await Promise.all([
      first.browser.req(
        "POST",
        `/admin/v1/users/${second.account.userId}/suspend`,
        { reason: "Disposable simultaneous admin restriction test" },
      ),
      second.browser.req(
        "POST",
        `/admin/v1/users/${first.account.userId}/suspend`,
        { reason: "Disposable simultaneous admin restriction test" },
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 403 || r.status === 401),
    ).toHaveLength(1);
    const states = await Promise.all(
      [first, second].map((a) =>
        h.ctx.accounts.store.accountById(a.account.accountId),
      ),
    );
    expect(states.filter((a) => a?.disabled_at === null)).toHaveLength(1);
  });
});
