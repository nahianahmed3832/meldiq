import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthStart, nextMonthStart } from "../src/modules/workforce/budget.js";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, consoleAdmin } from "./support/adminConsole.js";
import { type Answer, chatText, type FakeCall, fakeProviders, openAiChat } from "./support/fakeAi.js";
import { type Harness, startServer } from "./support/harness.js";
import { type Community, community, configurePlatform, failure, install } from "./support/workforce.js";

/**
 * An agent's monthly AI budget (migration 055): set by people who manage agents, enforced when a job is admitted and
 * before each model request, shown in readiness and the System Check. The fake model is priced so each request costs
 * exactly 6,000 micro-USD ($2/M input × 1,000 + $8/M output × 500).
 */
const PER_REQUEST = 6_000;
const mailer = new MemoryMailer();
let h: Harness;
let a: Community;
let general: string;

function answer(call: FakeCall): Answer | null {
  if (call.url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "gpt-test" }] } };
  if (!call.url.endsWith("/v1/chat/completions")) return null;
  if (chatText(call).user.includes("Reply with the single word")) return openAiChat("pong");
  return openAiChat("Thirty days.", { in: 1_000, out: 500 });
}

const agent = async () => (await a.owner.req("GET", `/v1/orgs/${a.orgId}/ai/agents/${general}`)).agent;
const setBudget = async (micro: number | null) => {
  const cur = await agent();
  return (await a.owner.req("PATCH", `/v1/orgs/${a.orgId}/ai/agents/${general}`, { rev: cur.rev, maxCostMicroPerMonth: micro })).agent;
};
const ask = (brief = "What is our refund window?") => a.member.req("POST", `/v1/orgs/${a.orgId}/ai/jobs`, { installId: general, input: { brief } });
const usageRows = () => h.ctx.db.prepare("SELECT COUNT(*) n FROM ai_usage WHERE install_id = ?").pluck().get(general) as number;
const budgetCheck = async () => ((await a.owner.req("GET", `/v1/orgs/${a.orgId}/ai/agents/${general}/readiness`)).readiness.checks as { key: string; status: string; detail: string }[]).find((c) => c.key === "budget");

beforeAll(async () => {
  fakeProviders(answer);
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex"), AI_WORKFORCE_TICK_MS: "0" }, { mailer });
  const admin = await consoleAdmin(h, mailer, "super_admin", "budgetsuper");
  await configurePlatform(admin, { models: [{ model: "gpt-test", capabilities: ["text"], inputPriceMicro: 2_000_000, outputPriceMicro: 8_000_000 }], agents: ["general_assistant"] });
  a = await community(h, "Budget");
  general = await install(a, "general_assistant");
}, 120_000);

afterAll(async () => h.close());

describe("an agent's monthly AI budget", () => {
  it("months are calendar months in UTC", () => {
    const t = Date.UTC(2026, 9, 25, 18, 30);
    expect(monthStart(t)).toBe(Date.UTC(2026, 9, 1));
    expect(nextMonthStart(t)).toBe(Date.UTC(2026, 10, 1));
    expect(nextMonthStart(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
  });

  it("only people who manage agents set it, within bounds", async () => {
    const cur = await agent();
    expect((await failure(a.member.req("PATCH", `/v1/orgs/${a.orgId}/ai/agents/${general}`, { rev: cur.rev, maxCostMicroPerMonth: 1 }))).status).toBe(403);
    expect((await failure(a.owner.req("PATCH", `/v1/orgs/${a.orgId}/ai/agents/${general}`, { rev: cur.rev, maxCostMicroPerMonth: -1 }))).status).toBe(400);
    expect(await budgetCheck()).toBeUndefined();
  });

  it("counts what the agent's requests cost this month, and refuses new work once it's used up", async () => {
    expect((await setBudget(10_000)).maxCostMicroPerMonth).toBe(10_000);
    await ask();
    await h.ctx.workforce.runtime.runUntilIdle();
    expect((await agent()).costMicroThisMonth).toBe(PER_REQUEST);
    expect((await budgetCheck())!.status).toBe("ok");

    // Budget left when it starts: it runs, and may finish past the budget (one request in flight).
    await ask("Second question?");
    await h.ctx.workforce.runtime.runUntilIdle();
    expect((await agent()).costMicroThisMonth).toBe(2 * PER_REQUEST);

    const refused = await failure(ask("Third question?"));
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("quota_exceeded");
    expect(refused.body.error.message).toMatch(/used its monthly AI budget here \(\$0\.01 of \$0\.01\); it resets on \d{4}-\d{2}-01/);
    const check = (await budgetCheck())!;
    expect(check.status).toBe("missing");
    expect(check.detail).toMatch(/no new work until it resets or is raised/);
    // The System Check reports the agent as unable to work, with why.
    const report = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/system-check`)).report as { items: { key: string; status: string; evidence: string }[] };
    expect(report.items.find((i) => i.key === `agent.${general}`)).toMatchObject({ status: "failed", evidence: expect.stringMatching(/Monthly AI budget/) });
  });

  it("stops a running job before its next model request once the budget is gone", async () => {
    await setBudget(null);
    const job = (await ask("Admitted while there's budget.")).job;
    await setBudget(1);
    const before = usageRows();
    await h.ctx.workforce.runtime.runUntilIdle();
    const done = (await a.member.req("GET", `/v1/orgs/${a.orgId}/ai/jobs/${job.id}`)).job;
    expect(done.state).toBe("failed");
    expect(done.error.code).toBe("quota_exceeded");
    expect(usageRows()).toBe(before);
  });

  it("raising it, or removing it, lets the agent work again", async () => {
    await setBudget(null);
    expect((await ask("Back to work.")).job.state).toBe("queued");
    await h.ctx.workforce.runtime.runUntilIdle();
    expect(await budgetCheck()).toBeUndefined();
  });
});
