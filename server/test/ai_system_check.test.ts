import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HISTORY_KEPT } from "../src/modules/workforce/health/report.js";
import { AdminSystemCheck, AdminSystemChecks } from "../src/shared/contracts/http/platformAdminWorkforce.js";
import { SystemCheck } from "../src/modules/workforce/health/systemCheck.js";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { type Answer, chatText, type FakeCall, fakeProviders, openAiChat } from "./support/fakeAi.js";
import { type Harness, startServer } from "./support/harness.js";
import { type Community, community, configurePlatform, failure, install, REASON } from "./support/workforce.js";

/**
 * Run Full System Check (docs/implementation/PROGRESS.md phase 2): one action per community and one for the platform,
 * with evidence for each status, links to the records involved, stored history, and no AI model calls, messages or
 * spending while it runs. The provider is a fake (support/fakeAi.ts); storage, database and the invocation rule are
 * the real ones.
 */
const mailer = new MemoryMailer();
let h: Harness;
let admin: ConsoleAdmin;
let a: Community;
let general: string;
let providerFails = false;
const chats: string[] = [];

function answer(call: FakeCall): Answer | null {
  if (call.url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "gpt-test" }] } };
  if (!call.url.endsWith("/v1/chat/completions")) return null;
  const { system, user } = chatText(call);
  chats.push(system);
  if (user.includes("Reply with the single word")) return openAiChat("pong");
  if (providerFails) return { status: 500, body: { error: { message: "upstream down" } } };
  return openAiChat("Here is the answer.");
}

type Item = { key: string; status: string; evidence: string; verified: boolean; remediation: string | null; owner: string | null; links: { jobs?: string[]; installId?: string } };
type Report = { id: string; scope: string; worst: string; summary: Record<string, number>; items: Item[]; requestedBy: string };
const find = (r: Report, key: string) => r.items.find((i) => i.key === key)!;
const run = async (c: Community): Promise<Report> => (await c.owner.req("POST", `/v1/orgs/${c.orgId}/ai/system-check`)).report;

beforeAll(async () => {
  fakeProviders(answer);
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex"), AI_WORKFORCE_TICK_MS: "0" }, { mailer });
  admin = await consoleAdmin(h, mailer, "super_admin", "chksuper");
  await configurePlatform(admin, { models: [{ model: "gpt-test", capabilities: ["text"] }], agents: ["general_assistant", "content_writer"] });
  a = await community(h, "Checked");
  general = await install(a, "general_assistant");
}, 120_000);

afterAll(async () => h.close());

describe("a community's System Check", () => {
  it("checks configuration, runtime and smoke tests with evidence, and calls no AI model", async () => {
    chats.length = 0;
    const r = await run(a);
    expect(chats).toEqual([]);
    expect(r.scope).toBe("community");
    expect(find(r, "config.switches").status).toBe("healthy");
    expect(find(r, `agent.${general}`)).toMatchObject({ status: "healthy", links: { installId: general } });
    // The General Assistant needs the quick-replies route; its state rests on the route's verification.
    expect(find(r, "model.fast")).toMatchObject({ status: "healthy", verified: true });
    // Real probes: the AI file store and the shared invocation rule in the channel.
    expect(find(r, "smoke.storage")).toMatchObject({ status: "healthy", verified: true });
    expect(find(r, "smoke.storage").evidence).toMatch(/SHA-256 matched/);
    expect(find(r, "smoke.invocation")).toMatchObject({ status: "healthy", verified: true });
    // Nothing has completed yet, and the worker's timer is off in tests: honestly not tested.
    expect(find(r, "smoke.job_path")).toMatchObject({ status: "not_tested", verified: false });
    expect(find(r, "smoke.job_path").remediation).toMatch(/Test/);
    expect(find(r, "runtime.worker").status).toBe("not_tested");
    expect(find(r, "runtime.queue").status).toBe("healthy");
    expect(r.summary.healthy + r.summary.not_tested + r.summary.warning + r.summary.failed + r.summary.not_configured).toBe(r.items.length);
  });

  it("a completed request proves the job path, with a link to it", async () => {
    const job = (await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/jobs`, { installId: general, input: { brief: "What is our refund window?" } })).job;
    await h.ctx.workforce.runtime.runUntilIdle();
    expect((await a.member.req("GET", `/v1/orgs/${a.orgId}/ai/jobs/${job.id}`)).job.state).toBe("completed");
    const path = find(await run(a), "smoke.job_path");
    expect(path).toMatchObject({ status: "healthy", verified: true, links: { jobs: [job.id] } });
  });

  it("failed jobs are reported by error code, with what to do and links to them", async () => {
    providerFails = true;
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/jobs`, { installId: general, input: { brief: `Failing ${i}?` } })).job.id);
      await h.ctx.workforce.runtime.runUntilIdle();
      const r = await run(a);
      const failures = find(r, "runtime.failures");
      expect(["warning", "failed"]).toContain(failures.status);
      expect(failures.evidence).toMatch(/failed:/);
      expect(failures.remediation).toBeTruthy();
      expect(failures.links.jobs!.length).toBeGreaterThan(0);
      expect(failures.links.jobs!.every((id) => ids.includes(id))).toBe(true);
      // The provider failing opened its circuit: the route is reported failed, though its verification passed.
      expect(find(r, "model.fast")).toMatchObject({ status: "failed", owner: "platform_operator" });
      expect(find(r, "model.fast").evidence).toMatch(/recent requests all failed/);
    } finally {
      providerFails = false;
    }
  });

  it("two agents a channel can't tell apart fail the invocation smoke test", async () => {
    const b = await community(h, "Twins");
    await install(b, "general_assistant", "Writer");
    await install(b, "content_writer", "Writer");
    const inv = find(await run(b), "smoke.invocation");
    expect(inv.status).toBe("warning");
    expect(inv.evidence).toMatch(/#work: "@Writer" calls another agent with the same name/);
  });

  it("with the AI kill switch off, says so once instead of failing every model route", async () => {
    await admin.browser.expect(200, "PUT", "/admin/v1/settings/ai.enabled", { value: false, reason: REASON });
    try {
      const r = await run(await community(h, "KillSwitch"));
      expect(find(r, "config.switches").evidence).toMatch(/AI requests are switched off/);
      const p = (await admin.browser.expect(201, "POST", "/admin/v1/ai/system-check")).report as Report;
      expect(p.items.filter((i) => i.key.startsWith("model.")).map((i) => i.status)).toEqual(Array(7).fill("not_tested"));
      expect(find(p, "config.switches").status).toBe("warning");
    } finally {
      await admin.browser.expect(200, "PUT", "/admin/v1/settings/ai.enabled", { value: true, reason: REASON });
    }
  });

  it("still runs when AI Workforce is switched off, and says so", async () => {
    await admin.browser.expect(200, "PUT", "/admin/v1/ai/workforce/controls", { workforceEnabled: false, reason: REASON });
    try {
      const sw = find(await run(a), "config.switches");
      expect(sw).toMatchObject({ status: "failed", owner: "platform_operator" });
      expect(sw.evidence).toMatch(/switched off on this platform/);
    } finally {
      await admin.browser.expect(200, "PUT", "/admin/v1/ai/workforce/controls", { workforceEnabled: true, reason: REASON });
    }
  });

  it("keeps a history and serves each report; only to people who manage agents in that community", async () => {
    const latest = await run(a);
    const listed = await a.owner.req("GET", `/v1/orgs/${a.orgId}/ai/system-check`);
    expect(listed.latest.id).toBe(latest.id);
    expect(listed.history.length).toBeGreaterThanOrEqual(5);
    expect(listed.history[0]).not.toHaveProperty("items");
    expect((await a.owner.req("GET", `/v1/orgs/${a.orgId}/ai/system-check/${latest.id}`)).report.items.length).toBe(latest.items.length);
    expect((await failure(a.member.req("POST", `/v1/orgs/${a.orgId}/ai/system-check`))).status).toBe(403);
    expect((await failure(a.member.req("GET", `/v1/orgs/${a.orgId}/ai/system-check`))).status).toBe(403);
    const other = await community(h, "Elsewhere");
    expect((await failure(other.owner.req("GET", `/v1/orgs/${other.orgId}/ai/system-check/${latest.id}`))).status).toBe(404);
    expect((await failure(other.owner.req("GET", `/v1/orgs/${a.orgId}/ai/system-check`))).status).toBe(404);
  });

  it(`keeps the newest ${HISTORY_KEPT} reports per community`, () => {
    const reports = h.ctx.workforce.health.reports;
    for (let i = 0; i < HISTORY_KEPT + 3; i++) reports.save({ scope: "community", orgId: "org_history", requestedBy: "test", startedAt: 1_000 + i, finishedAt: 1_000 + i, items: [] });
    const kept = reports.history("community", "org_history", 100);
    expect(kept).toHaveLength(HISTORY_KEPT);
    expect(kept[0]!.startedAt).toBe(1_000 + HISTORY_KEPT + 2);
  });

  it("a check that throws becomes a failed item, and the others still run", async () => {
    const blobs = h.ctx.blobs as { putFile: (...args: unknown[]) => Promise<void> };
    const real = blobs.putFile;
    blobs.putFile = async () => {
      throw new Error("disk is read-only");
    };
    try {
      const r = await run(a);
      expect(find(r, "smoke.storage")).toMatchObject({ status: "failed", evidence: "disk is read-only" });
      expect(find(r, "config.switches").status).toBe("healthy");
    } finally {
      blobs.putFile = real;
    }
  });
});

describe("the platform's System Check", () => {
  it("runs from the console with real database, storage and invocation probes", async () => {
    chats.length = 0;
    const answer = await admin.browser.expect(201, "POST", "/admin/v1/ai/system-check");
    // The console validates with these schemas (its copy of platformAdminWorkforce.ts).
    expect(AdminSystemCheck.safeParse(answer).success).toBe(true);
    const r = answer.report as Report;
    expect(chats).toEqual([]);
    expect(r.scope).toBe("platform");
    expect(find(r, "smoke.database")).toMatchObject({ status: "healthy", verified: true });
    expect(find(r, "smoke.storage")).toMatchObject({ status: "healthy", verified: true });
    expect(find(r, "smoke.invocation")).toMatchObject({ status: "healthy", verified: true });
    expect(find(r, "config.catalog").status).toBe("healthy");
    expect(find(r, "config.secrets_key").status).toBe("healthy");
    expect(find(r, "model.fast").evidence).toMatch(/gpt-test/);
    // A route nobody set up is reported as such, not as healthy.
    expect(find(r, "model.image_generation").status).toBe("not_configured");
    expect(["healthy", "warning", "failed"]).toContain(find(r, "runtime.disk").status);
    const listed = await admin.browser.expect(200, "GET", "/admin/v1/ai/system-check");
    expect(AdminSystemChecks.safeParse(listed).success).toBe(true);
    expect(listed.latest.id).toBe(r.id);
    expect((await admin.browser.expect(200, "GET", `/admin/v1/ai/system-check/${r.id}`)).report.id).toBe(r.id);
    // A community's report isn't served to the console.
    const mine = await run(await community(h, "ConsoleCannotSee"));
    await admin.browser.expect(404, "GET", `/admin/v1/ai/system-check/${mine.id}`);
  });

  it("runs on schedule when the last report is old, and not again before then", async () => {
    h.ctx.db.prepare("DELETE FROM ai_system_checks WHERE scope = 'platform'").run();
    // A fresh service (the module's own already ran on the worker's ticks in this file).
    const health = new SystemCheck(h.ctx.workforce, () => h.ctx.workforce.runtime.status());
    const first = await health.scheduled();
    expect(first?.requestedBy).toBe("schedule");
    expect(health.scheduled()).toBeNull();
    expect(h.ctx.workforce.health.reports.history("platform", null)).toHaveLength(1);
  });

  it("is refused to people without a console role", async () => {
    const r = await a.owner.req("POST", "/admin/v1/ai/system-check").catch((e: { status: number }) => e);
    expect((r as { status: number }).status).toBeGreaterThanOrEqual(400);
  });
});
