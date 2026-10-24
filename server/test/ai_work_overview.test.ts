import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, consoleAdmin } from "./support/adminConsole.js";
import { type Answer, chatText, type FakeCall, fakeProviders, openAiChat } from "./support/fakeAi.js";
import { type Harness, startServer } from "./support/harness.js";
import { type Community, community, configurePlatform, install } from "./support/workforce.js";

/**
 * The work overview (docs/implementation/PROGRESS.md phase 3): one answer with what needs this person, what agents and
 * people are doing, what finished and failed, and what the agents' work cost; managers see the community, others their
 * own. The provider is a fake with prices, so costs are real numbers from the usage records.
 */
const mailer = new MemoryMailer();
let h: Harness;
let a: Community;
let general: string;
let providerFails = false;

function answer(call: FakeCall): Answer | null {
  if (call.url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "gpt-test" }] } };
  if (!call.url.endsWith("/v1/chat/completions")) return null;
  const { user } = chatText(call);
  if (user.includes("Reply with the single word")) return openAiChat("pong");
  if (providerFails) return { status: 400, body: { error: { message: "bad request" } } };
  return openAiChat("Thirty days.", { in: 1_000, out: 500 });
}

type Item = { kind: string; title: string; owner: { kind: string; name: string }; requestedBy: { name: string }; reason: string | null; action: string; jobId: string | null; taskId: string | null; approvalId: string | null; costMicro: number | null; state: string };
type Overview = { scope: string; attention: Item[]; active: Item[]; finished: Item[]; failed: Item[]; totals: Record<string, number>; health: { worst: string } | null };
const overview = async (c: Community["owner"], orgId: string): Promise<Overview> => c.req("GET", `/v1/orgs/${orgId}/ai/work`);
const ask = async (brief: string) => (await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/jobs`, { installId: general, input: { brief } })).job.id as string;

beforeAll(async () => {
  fakeProviders(answer);
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex"), AI_WORKFORCE_TICK_MS: "0" }, { mailer });
  const admin = await consoleAdmin(h, mailer, "super_admin", "worksuper");
  await configurePlatform(admin, { models: [{ model: "gpt-test", capabilities: ["text"], inputPriceMicro: 2_000_000, outputPriceMicro: 8_000_000 }], agents: ["general_assistant"] });
  a = await community(h, "Works");
  general = await install(a, "general_assistant");
}, 120_000);

afterAll(async () => h.close());

describe("the work overview", () => {
  it("shows a finished request with its title, agent, who asked and what it cost", async () => {
    const id = await ask("What is our refund window?\nPlease be brief.");
    await h.ctx.workforce.runtime.runUntilIdle();
    const mine = await overview(a.member, a.orgId);
    expect(mine.scope).toBe("mine");
    const done = mine.finished.find((i) => i.jobId === id)!;
    expect(done).toMatchObject({ kind: "job", title: "What is our refund window?", owner: { kind: "agent", name: "General Assistant" }, state: "completed", action: "open" });
    expect(done.costMicro).toBeGreaterThan(0);
    expect(mine.totals.modelRequests).toBeGreaterThanOrEqual(1);
    expect(mine.totals.costMicro).toBe(done.costMicro);
  });

  it("puts a new task in the assignee's attention, and handed-in work in the creator's", async () => {
    const task = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/tasks`, { title: "Count shelf B", instructions: "Count the grips on shelf B.", assigneeId: a.member.userId })).task;
    const forMember = await overview(a.member, a.orgId);
    expect(forMember.attention.find((i) => i.taskId === task.id)).toMatchObject({ reason: "A new task for you", action: "do", owner: { kind: "person" } });
    // For the owner who gave it, it's work in progress, not theirs to act on yet.
    const forOwner = await overview(a.owner, a.orgId);
    expect(forOwner.scope).toBe("all");
    expect(forOwner.attention.some((i) => i.taskId === task.id)).toBe(false);
    expect(forOwner.active.some((i) => i.taskId === task.id)).toBe(true);

    let rev = (await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/tasks/${task.id}/accept`, { rev: task.rev })).task.rev;
    rev = (await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/tasks/${task.id}/submit`, { rev, note: "42 grips." })).task.rev;
    expect((await overview(a.owner, a.orgId)).attention.find((i) => i.taskId === task.id)).toMatchObject({ reason: "Handed in: review it", action: "review" });
    expect((await overview(a.member, a.orgId)).attention.some((i) => i.taskId === task.id)).toBe(false);
  });

  it("lists failed requests for whoever may see them, and no one else's", async () => {
    providerFails = true;
    let id: string;
    try {
      id = await ask("This one fails.");
      await h.ctx.workforce.runtime.runUntilIdle();
      // Waiting to retry after the provider's error: active, with the error shown.
      expect((await overview(a.member, a.orgId)).active.find((i) => i.jobId === id)).toMatchObject({ state: "queued", error: "provider_error" });
      // Bring each retry forward until the attempts run out.
      for (let i = 0; i < 5 && h.ctx.db.prepare("SELECT state FROM ai_jobs WHERE id = ?").pluck().get(id) === "queued"; i++) {
        h.ctx.db.prepare("UPDATE ai_jobs SET next_at = 0 WHERE id = ?").run(id);
        await h.ctx.workforce.runtime.runUntilIdle();
      }
    } finally {
      providerFails = false;
    }
    expect((await overview(a.member, a.orgId)).failed.some((i) => i.jobId === id)).toBe(true);
    expect((await overview(a.owner, a.orgId)).failed.find((i) => i.jobId === id)).toMatchObject({ requestedBy: { name: expect.any(String) } });
    // Someone else in the community sees only their own work.
    const other = await h.client("worksother");
    const code = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/invites`, { role: "MEMBER", maxUses: 1 })).invite.code;
    await other.req("POST", "/v1/invites/accept", { code });
    const theirs = await overview(other, a.orgId);
    expect([...theirs.failed, ...theirs.finished, ...theirs.active, ...theirs.attention]).toEqual([]);
  });

  it("an approval waiting on an approver is in their attention, linked to the request", async () => {
    const id = await ask("Needs an approval.");
    await h.ctx.workforce.runtime.runUntilIdle();
    const approval = h.ctx.workforce.approvals.request({ orgId: a.orgId, jobId: id, action: "channel.post", summary: "Post the answer in #work" });
    try {
      const item = (await overview(a.owner, a.orgId)).attention.find((i) => i.approvalId === approval.id)!;
      expect(item).toMatchObject({ jobId: id, action: "approve", reason: "Approve: Post the answer in #work" });
      // The member who asked can't approve: it isn't in their attention.
      expect((await overview(a.member, a.orgId)).attention.some((i) => i.approvalId === approval.id)).toBe(false);
    } finally {
      h.ctx.workforce.approvals.invalidateJob(id);
    }
  });

  it("shows managers the latest System Check, and is only for members", async () => {
    await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/system-check`);
    expect((await overview(a.owner, a.orgId)).health).toMatchObject({ worst: expect.any(String) });
    expect((await overview(a.member, a.orgId)).health).toBeNull();
    const outsider = await h.client("worksoutsider");
    await expect(overview(outsider, a.orgId)).rejects.toMatchObject({ status: 404 });
  });
});
