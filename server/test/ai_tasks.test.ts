import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, consoleAdmin } from "./support/adminConsole.js";
import { type Answer, chatText, type FakeCall, fakeProviders, openAiChat } from "./support/fakeAi.js";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";
import { type Community, community, configurePlatform, failure, install } from "./support/workforce.js";

/**
 * Human tasks and the Agent Manager assigning work (docs/AI_WORKFORCE_2_PLAN.md, phase 4): only the assignee accepts,
 * starts, blocks and submits; submission needs evidence; only someone else approves or returns; the Manager gives
 * work only to people the community named, chosen by role and workload, and only for people who manage agents; a
 * person's submitted files reach the agent step waiting for them, an agent's deliverables reach the person's task;
 * reminders and escalation; the workforce report. The provider is a fake (support/fakeAi.ts).
 */
const mailer = new MemoryMailer();
let h: Harness;
let a: Community;
let photographer: GriipClient;
let packer: GriipClient;
let photographerRole: string;
let manager: string;
const prompts: { system: string; user: string }[] = [];
/** The Manager's next plan (set per test). */
let nextPlan: (installs: Map<string, string>) => unknown = () => ({ mode: "answer", answer: "ok" });

function answer(call: FakeCall): Answer | null {
  if (call.url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "gpt-test" }] } };
  if (!call.url.endsWith("/v1/chat/completions")) return null;
  const { system, user } = chatText(call);
  prompts.push({ system, user });
  if (user.includes("Reply with the single word")) return openAiChat("pong");
  if (system.includes("Which of these capabilities does the request need")) return openAiChat(JSON.stringify({ capabilities: [] }));
  if (system.includes("You coordinate a team of AI agents")) {
    const ids = new Map([...user.matchAll(/installId (agi_[A-Za-z0-9_-]+): ([^(]+)\(/g)].map((m) => [m[2]!.trim(), m[1]!]));
    return openAiChat(JSON.stringify(nextPlan(ids)));
  }
  if (/Write an? [a-z ]+ in a [a-z ]+ tone/.test(system)) return openAiChat(JSON.stringify({ title: "Shoot brief", body: Array.from({ length: 250 }, (_, i) => `angle${i}`).join(" "), headlines: [] }));
  return openAiChat("Done.");
}

beforeAll(async () => {
  fakeProviders(answer);
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex"), AI_WORKFORCE_TICK_MS: "0" }, { mailer });
  const admin = await consoleAdmin(h, mailer, "super_admin", "tksuper");
  await configurePlatform(admin, { models: [{ model: "gpt-test", capabilities: ["text"] }], agents: ["general_assistant", "content_writer", "agent_manager"] });
  a = await community(h, "Tasks");
  [photographer, packer] = await Promise.all([h.client("tkphoto"), h.client("tkpack")]);
  for (const c of [photographer, packer]) {
    const code = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/invites`, { role: "MEMBER", maxUses: 1 })).invite.code;
    await c.req("POST", "/v1/invites/accept", { code });
    await c.req("POST", `/v1/conversations/${a.channel}/join`).catch(() => undefined);
  }
  photographerRole = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/roles`, { name: "Photographer", permissions: [] })).role.id;
  await a.owner.req("PUT", `/v1/roles/${photographerRole}/members/${photographer.userId}`);
  await install(a, "general_assistant");
  await install(a, "content_writer");
  manager = await install(a, "agent_manager");
}, 120_000);

afterAll(async () => h.close());

beforeEach(() => {
  prompts.length = 0;
});

const base = () => `/v1/orgs/${a.orgId}/ai/tasks`;
type Task = { id: string; rev: number; state: string; assignee: { id: string; name: string }; can: Record<string, boolean>; files: { id: string }[]; references: { id: string }[]; overdue: boolean };
const get = async (c: GriipClient, id: string) => (await c.req("GET", `${base()}/${id}`)) as { task: Task; events: { kind: string; actor: { id: string } | null }[] };
const act = async (c: GriipClient, id: string, action: string, body: Record<string, unknown> = {}) => (await c.req("POST", `${base()}/${id}/${action}`, { rev: (await get(c, id)).task.rev, ...body })).task as Task;
const upload = async (c: GriipClient, name: string, text: string) => (await c.req("POST", `/v1/orgs/${a.orgId}/ai/files?name=${name}&type=text/plain`, undefined, Buffer.from(text))).file.id as string;
const run = async () => {
  await h.ctx.workforce.runtime.runUntilIdle();
  h.ctx.workforce.taskService.tick();
  await h.ctx.workforce.runtime.runUntilIdle();
};
const ask = async (brief: string) => (await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/jobs`, { installId: manager, input: { brief }, conversationId: a.channel, requestText: brief })).job as { id: string };
const job = async (id: string) => (await a.owner.req("GET", `/v1/orgs/${a.orgId}/ai/jobs/${id}`)).job;

describe("a task by hand", () => {
  it("only the assignee works on it, evidence is required, and someone else approves it", async () => {
    // Members can't hand out work; people who manage agents can.
    expect((await failure(a.member.req("POST", base(), { title: "Count stock", instructions: "Count shelf B", assigneeId: packer.userId }))).status).toBe(403);
    const created = (await a.owner.req("POST", base(), { title: "Count stock", instructions: "Count shelf B and report the number.", deliverables: "The count and a photo", assigneeId: packer.userId, dueAt: Date.now() + 86_400_000 })).task as Task;
    expect(created).toMatchObject({ state: "open", assignee: { id: packer.userId } });
    expect(created.can).toMatchObject({ accept: false, approve: false, cancel: true });
    // Someone else can't see it, let alone accept it.
    expect((await failure(photographer.req("GET", `${base()}/${created.id}`))).status).toBe(404);
    expect((await failure(a.owner.req("POST", `${base()}/${created.id}/accept`, { rev: created.rev }))).status).toBe(403);
    expect((await act(packer, created.id, "accept")).state).toBe("accepted");
    expect((await failure(act(packer, created.id, "block"))).body.error.message).toMatch(/Say what's blocking it/);
    expect((await act(packer, created.id, "block", { reason: "Shelf B is locked." })).state).toBe("blocked");
    expect((await act(packer, created.id, "start")).state).toBe("in_progress");
    expect((await failure(act(packer, created.id, "submit"))).body.error.message).toMatch(/a note, files, or both/);
    // Files must be the assignee's own uploads.
    const ownersFile = await upload(a.owner, "owner.txt", "not the packer's");
    expect((await failure(act(packer, created.id, "submit", { fileIds: [ownersFile] }))).body.error.message).toMatch(/isn't yours/);
    const evidence = await upload(packer, "count.txt", "Shelf B: 42 units");
    const submitted = await act(packer, created.id, "submit", { note: "42 units.", fileIds: [evidence] });
    expect(submitted).toMatchObject({ state: "submitted", files: [{ id: evidence }] });
    // The assignee never approves their own work; a reviewer may return it with a reason, then approve.
    expect((await failure(act(packer, created.id, "approve"))).status).toBe(403);
    expect((await act(a.owner, created.id, "return", { reason: "Add the photo." })).state).toBe("in_progress");
    expect((await act(packer, created.id, "submit", { note: "Photo added." })).state).toBe("submitted");
    expect((await act(a.owner, created.id, "approve")).state).toBe("done");
    const { events } = await get(a.owner, created.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "accepted", "blocked", "started", "submitted", "returned", "submitted", "approved"]);
    // The handed-in file is readable by the reviewer, not by others.
    await a.owner.req("GET", `/v1/orgs/${a.orgId}/ai/files/${evidence}`);
    expect((await failure(photographer.req("GET", `/v1/orgs/${a.orgId}/ai/files/${evidence}`))).status).toBe(404);
  });
});

describe("the Agent Manager assigns work", () => {
  it("only to people the community named, and only for people who manage agents", async () => {
    nextPlan = () => ({ mode: "delegate", steps: [{ key: "shoot", kind: "person", title: "Product photos", task: "Shoot the new grip.", deliverables: "Five photos", dueInHours: 24, role: "Photographer", dependsOn: [] }] });
    // Nobody named yet: the plan's person step is refused, and the Manager is told nobody may be given work.
    const refused = await ask("Get photos of the new grip.");
    await run();
    // The plan is refused (the job retries once, as for any unusable plan), and no task exists.
    expect(await job(refused.id)).toMatchObject({ state: "queued", error: { message: "The plan couldn't be used (no one may be given work for this request)." } });
    expect(h.ctx.db.prepare("SELECT COUNT(*) n FROM ai_tasks WHERE job_id = ?").get(refused.id)).toEqual({ n: 0 });
    await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/jobs/${refused.id}/cancel`);
    expect(prompts.find((p) => p.system.includes("You coordinate"))!.system).toMatch(/nobody may be given work by you yet/);
    // The settings name the role; the eligible list shows who that makes eligible.
    expect((await failure(a.member.req("PUT", `${base()}/settings`, { roles: [photographerRole], users: [] }))).status).toBe(403);
    const s = (await a.owner.req("PUT", `${base()}/settings`, { roles: [photographerRole], users: [packer.userId] })).settings;
    expect(s.eligible.map((p: { id: string }) => p.id).sort()).toEqual([photographer.userId, packer.userId].sort());
    expect((await a.owner.req("GET", `${base()}/settings`)).settings).toEqual(s);
    // A member asking the Manager can't make it assign work to colleagues.
    prompts.length = 0;
    const byMember = (await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/jobs`, { installId: manager, input: { brief: "Get photos." } })).job;
    await run();
    expect(prompts.find((p) => p.system.includes("You coordinate"))!.system).toMatch(/can't give work to people for this request/);
    // Its plan's person step is refused; no task was created.
    expect((await a.member.req("GET", `/v1/orgs/${a.orgId}/ai/jobs/${byMember.id}`)).job.error.message).toMatch(/no one may be given work/);
    expect(h.ctx.db.prepare("SELECT COUNT(*) n FROM ai_tasks WHERE job_id = ?").get(byMember.id)).toEqual({ n: 0 });
    await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/jobs/${byMember.id}/cancel`);
  });

  it("a person's submission reaches the agent step waiting for it, and the report says who did what", async () => {
    nextPlan = (ids) => ({
      mode: "delegate",
      steps: [
        { key: "notes", kind: "person", title: "Shot notes", task: "Write notes from the shoot.", deliverables: "A text file", dueInHours: 24, role: "Photographer", dependsOn: [] },
        { key: "sum", installId: ids.get("General Assistant"), task: "Summarise the shot notes.", dependsOn: ["notes"] },
      ],
    });
    const j = await ask("Get the shoot notes and summarise them.");
    await run();
    // The task went to the Photographer (the role named); the agent step waits.
    const mine = (await photographer.req("GET", `${base()}?scope=mine`)).tasks as { id: string; title: string; state: string }[];
    const task = mine.find((t) => t.title === "Shot notes")!;
    expect(task.state).toBe("open");
    expect((await job(j.id)).state).toBe("running");
    const posts = (await a.owner.req("GET", `/v1/conversations/${a.channel}/ai/posts`)).posts as { body: string }[];
    expect(posts.some((p) => /New task for .*"Shot notes"/.test(p.body))).toBe(true);
    const file = await upload(photographer, "notes.txt", "SHOOT-NOTES-7731: three angles, white backdrop.");
    await act(photographer, task.id, "accept");
    await act(photographer, task.id, "submit", { note: "Notes attached.", fileIds: [file] });
    await run();
    expect((await job(j.id)).state).toBe("running");
    await act(a.owner, task.id, "approve");
    await run();
    // The General Assistant read what the photographer handed in.
    expect(prompts.some((p) => p.user.includes("SHOOT-NOTES-7731"))).toBe(true);
    const done = await job(j.id);
    expect(done.state).toBe("completed");
    expect(done.output.steps).toEqual([
      expect.objectContaining({ kind: "person", jobId: task.id, state: "completed", fileIds: [file], assignee: expect.any(String) }),
      expect.objectContaining({ kind: "agent", agentId: "general_assistant", state: "completed" }),
    ]);
  });

  it("a person's task waits for the agent step it needs, then gets its deliverables to work from", async () => {
    nextPlan = (ids) => ({
      mode: "delegate",
      steps: [
        { key: "brief", installId: ids.get("Content Writer"), task: "Write a shoot brief for the new grip.", dependsOn: [] },
        { key: "shoot", kind: "person", title: "Shoot from the brief", task: "Shoot as the brief says.", deliverables: "Photos", dueInHours: 48, role: null, dependsOn: ["brief"] },
      ],
    });
    // The photographer has open work, so the packer has the least.
    await a.owner.req("POST", base(), { title: "Retouch", instructions: "Retouch yesterday's photos.", assigneeId: photographer.userId });
    const j = await ask("Brief and shoot the new grip.");
    await run();
    const waiting = h.ctx.db.prepare("SELECT id, assignee_id FROM ai_tasks WHERE job_id = ?").get(j.id) as { id: string; assignee_id: string };
    // No role named: the eligible person with the least open work gets it.
    expect(waiting.assignee_id).toBe(packer.userId);
    const opened = await get(packer, waiting.id);
    // It was created waiting for the brief, and opened (with the brief to work from) once the brief was written.
    expect(opened.events.map((e) => e.kind)).toEqual(["created", "opened"]);
    expect(h.ctx.db.prepare("SELECT detail FROM ai_task_events WHERE task_id = ? AND kind = 'created'").get(waiting.id)).toEqual({ detail: JSON.stringify({ assignee: packer.userId, by: "agent", waitingOn: 1 }) });
    expect(opened.task.state).toBe("open");
    expect(opened.task.references.length).toBeGreaterThan(0);
    // The assignee can read the brief the agent wrote.
    await packer.req("GET", `/v1/orgs/${a.orgId}/ai/files/${opened.task.references[0]!.id}`);
    await act(a.owner, waiting.id, "cancel", { reason: "Not needed after all." });
    await run();
    const done = await job(j.id);
    expect(done.state).toBe("completed");
    expect(done.output.steps[1]).toMatchObject({ kind: "person", state: "cancelled", error: "the task was cancelled" });
  });
});

describe("reminders, escalation and the report", () => {
  it("reminds the assignee before and after the due time, then tells the creator once", async () => {
    const t = (await a.owner.req("POST", base(), { title: "Dispatch orders", instructions: "Dispatch today's orders.", assigneeId: packer.userId, dueAt: Date.now() + 3_600_000 })).task as Task;
    h.ctx.workforce.taskService.tick();
    expect((await get(a.owner, t.id)).events.map((e) => e.kind)).toContain("reminded");
    // Overdue, reminded twice already: the next round escalates, once.
    h.ctx.db.prepare("UPDATE ai_tasks SET due_at = ?, reminders = 2, last_reminder_at = ? WHERE id = ?").run(Date.now() - 3_600_000, Date.now() - 2 * 86_400_000, t.id);
    h.ctx.workforce.taskService.tick();
    h.ctx.db.prepare("UPDATE ai_tasks SET last_reminder_at = ? WHERE id = ?").run(Date.now() - 2 * 86_400_000, t.id);
    h.ctx.workforce.taskService.tick();
    const kinds = (await get(a.owner, t.id)).events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "escalated")).toHaveLength(1);
    expect((await get(packer, t.id)).task.overdue).toBe(true);
    // The workforce report: for people who manage agents only.
    expect((await failure(a.member.req("GET", `${base()}?scope=all`))).status).toBe(403);
    const r = (await a.owner.req("GET", `${base()}?scope=all`)).report;
    expect(r.overdue).toBeGreaterThanOrEqual(1);
    expect(r.byAssignee.find((p: { person: { id: string } }) => p.person.id === packer.userId)).toMatchObject({ overdue: expect.any(Number) });
    // Reassigning starts it over for the new person: open, reminders reset.
    const moved = await act(a.owner, t.id, "reassign", { assigneeId: photographer.userId });
    expect(moved).toMatchObject({ state: "open", assignee: { id: photographer.userId } });
    expect((await failure(get(packer, t.id))).status).toBe(404);
  });
});
