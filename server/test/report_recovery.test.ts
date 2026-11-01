import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import { recoverReportWorkflows } from "../src/modules/platformAdmin/index.js";
let h: Harness;
beforeAll(async () => {
  h = await startServer();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await h?.close();
});
const at = Date.now();
async function workflow(id: string, age: number, status = "pending") {
  await h.ctx.platform.write((w) => {
    w.insert("platform_report_cases", {
      report_id: id,
      assignee_account_id: null,
      priority: "normal",
      appeal_status: "none",
      sync_status: status,
      intended_status: "actioned",
      version: 1,
      updated_at: at - age,
    });
    w.insert("platform_report_events", {
      report_id: id,
      actor_account_id: "operator",
      at: at - age,
      kind: "updated",
      body: "Internal note",
    });
  });
}
it("reconciles confirmed crash results, exposes mismatches and leaves active requests alone", async () => {
  await workflow("rep_confirmed", 61000);
  await workflow("rep_unapplied", 61000);
  await workflow("rep_active", 1000);
  const get = vi
    .spyOn(h.ctx.reports, "get")
    .mockImplementation(
      async (id) =>
        ({ id, status: id === "rep_confirmed" ? "actioned" : "open" }) as any,
    );
  const set = vi.spyOn(h.ctx.reports, "setStatus");
  expect(await recoverReportWorkflows(h.ctx, at)).toBe(2);
  expect(
    h.ctx.platform.get("platform_report_cases", { report_id: "rep_confirmed" }),
  ).toMatchObject({ sync_status: "synced", intended_status: null, version: 2 });
  expect(
    h.ctx.platform.get("platform_report_cases", { report_id: "rep_unapplied" }),
  ).toMatchObject({ sync_status: "failed", intended_status: "actioned" });
  expect(
    h.ctx.platform.get("platform_report_cases", { report_id: "rep_active" }),
  ).toMatchObject({ sync_status: "pending", version: 1 });
  expect(set).not.toHaveBeenCalled();
  expect(await recoverReportWorkflows(h.ctx, at)).toBe(0);
  expect(
    h.ctx.platform.count("platform_audit", { action: "report.reconcile" }),
  ).toBe(2);
  get.mockRestore();
  set.mockRestore();
});
it("preserves pending intent when the canonical store is unavailable", async () => {
  await workflow("rep_outage", 61000);
  const get = vi
    .spyOn(h.ctx.reports, "get")
    .mockRejectedValueOnce(new Error("unavailable"));
  await expect(recoverReportWorkflows(h.ctx, at)).rejects.toThrow(
    "unavailable",
  );
  expect(
    h.ctx.platform.get("platform_report_cases", { report_id: "rep_outage" }),
  ).toMatchObject({ sync_status: "pending", version: 1 });
  get.mockRestore();
});
it("purges only absent workflows older than 90 days and preserves the audit chain", async () => {
  await workflow("rep_expired", 91 * 86400000, "synced");
  await workflow("rep_retained", 91 * 86400000, "synced");
  await workflow("rep_recent", 89 * 86400000, "synced");
  const get = vi
    .spyOn(h.ctx.reports, "get")
    .mockImplementation(async (id) =>
      id === "rep_retained" ? ({ id, status: "open" } as any) : null,
    );
  await recoverReportWorkflows(h.ctx, at);
  expect(
    h.ctx.platform.get("platform_report_cases", { report_id: "rep_expired" }),
  ).toBeUndefined();
  expect(
    h.ctx.platform.count("platform_report_events", {
      report_id: "rep_expired",
    }),
  ).toBe(0);
  expect(
    h.ctx.platform.get("platform_report_cases", { report_id: "rep_retained" }),
  ).toBeTruthy();
  expect(
    h.ctx.platform.get("platform_report_cases", { report_id: "rep_recent" }),
  ).toBeTruthy();
  expect(
    h.ctx.platform.count("platform_audit", {
      action: "report.workflow.purge",
      target_id: "rep_expired",
    }),
  ).toBe(1);
  get.mockRestore();
});
