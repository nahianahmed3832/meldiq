import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, consoleAdmin } from "./support/adminConsole.js";
import { type Answer, chatText, type FakeCall, fakeProviders, hasFfmpeg, openAiChat, probeSeconds, testVideo } from "./support/fakeAi.js";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";
import { type Community, community, configurePlatform, install } from "./support/workforce.js";

/**
 * GriipBuddy's creative workflow end to end (docs/AI_WORKFORCE_2_PLAN.md phase 5, owner's brief §7), through the
 * real job engine, task system, file pipeline and ffmpeg: the owner asks the Agent Manager in #video-production; the
 * Social Media Manager writes a brief with shot ideas; the photographer gets a task that opens once the brief exists,
 * with the brief to work from; they hand in real footage; the Product Video Editor reads it, renders a real preview,
 * waits for a person's approval, exports the final video; the Social Media Manager writes posts from the edit's
 * captions; the Manager reports who did what. Nothing is published (no social account). The AI provider is a fake
 * (support/fakeAi.ts); the video files, the task records and the deliverables are real.
 */
const ffmpeg = hasFfmpeg();
const mailer = new MemoryMailer();
let h: Harness;
let a: Community;
let photographer: GriipClient;
let manager: string;
const prompts: { system: string; user: string }[] = [];
const SEGMENTS = [
  { start: 0.4, end: 1.8, text: "Meet the GriipBuddy grip" },
  { start: 2.0, end: 3.6, text: "Holds tight on every ride" },
];

function answer(call: FakeCall): Answer | null {
  if (call.url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "gpt-test" }, { id: "whisper-1" }] } };
  if (call.url.endsWith("/v1/audio/transcriptions")) return { status: 200, body: { text: SEGMENTS.map((s) => s.text).join(" "), segments: SEGMENTS } };
  if (!call.url.endsWith("/v1/chat/completions")) return null;
  const { system, user } = chatText(call);
  prompts.push({ system, user });
  if (user.includes("Reply with the single word")) return openAiChat("pong");
  if (system.includes("Which of these capabilities does the request need")) return openAiChat(JSON.stringify({ capabilities: [] }));
  if (system.includes("You coordinate a team of AI agents")) {
    const ids = new Map([...user.matchAll(/installId (agi_[A-Za-z0-9_-]+): ([^(]+)\(/g)].map((m) => [m[2]!.trim(), m[1]!]));
    return openAiChat(
      JSON.stringify({
        mode: "delegate",
        steps: [
          { key: "brief", installId: ids.get("Social Media Manager"), task: "Write two posts with shot ideas for a teaser of the new grip.", dependsOn: [] },
          { key: "shoot", kind: "person", title: "Film the grip teaser", task: "Film the new grip following the brief's shot ideas.", deliverables: "One video clip", dueInHours: 24, role: "Photographer", dependsOn: ["brief"] },
          { key: "edit", installId: ids.get("Product Video Editor"), task: "Edit a short teaser from the photographer's footage.", dependsOn: ["shoot"] },
          { key: "posts", installId: ids.get("Social Media Manager"), task: "Write two posts for the edited teaser, quoting its captions.", dependsOn: ["edit"] },
        ],
      }),
    );
  }
  if (system.includes("social posts for")) {
    const quotes = user.includes("Holds tight on every ride");
    return openAiChat(JSON.stringify({ posts: [{ platform: "x", text: quotes ? "Holds tight on every ride. The new GriipBuddy grip." : "Teaser: the new grip.", hashtags: ["griipbuddy"], visual: quotes ? "" : "Close-up of the grip on a handlebar; slow pan." }] }));
  }
  if (system.includes("You plan product video edits")) {
    const ids = [...user.matchAll(/File (aif_[A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
    return openAiChat(JSON.stringify({ clips: [{ fileId: ids[0], startSec: 0.3, endSec: 3.8, reason: "the grip" }], title: "GriipBuddy" }));
  }
  return openAiChat("Done.");
}

beforeAll(async () => {
  if (!ffmpeg) return;
  fakeProviders(answer);
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex"), AI_WORKFORCE_TICK_MS: "0" }, { mailer });
  const admin = await consoleAdmin(h, mailer, "super_admin", "cwsuper");
  await configurePlatform(admin, {
    models: [
      { model: "gpt-test", capabilities: ["text"] },
      { model: "whisper-1", capabilities: ["transcription"] },
    ],
    agents: ["agent_manager", "social_media_manager", "product_video_editor"],
  });
  a = await community(h, "GriipBuddy");
  photographer = await h.client("cwphoto");
  const code = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/invites`, { role: "MEMBER", maxUses: 1 })).invite.code;
  await photographer.req("POST", "/v1/invites/accept", { code });
  await photographer.req("POST", `/v1/conversations/${a.channel}/join`).catch(() => undefined);
  const role = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/roles`, { name: "Photographer", permissions: [] })).role.id;
  await a.owner.req("PUT", `/v1/roles/${role}/members/${photographer.userId}`);
  await a.owner.req("PUT", `/v1/orgs/${a.orgId}/ai/tasks/settings`, { roles: [role], users: [] });
  await install(a, "social_media_manager");
  await install(a, "product_video_editor");
  manager = await install(a, "agent_manager");
}, 120_000);

afterAll(async () => h?.close());

const run = async () => {
  for (let i = 0; i < 3; i++) {
    await h.ctx.workforce.runtime.runUntilIdle();
    h.ctx.workforce.taskService.tick();
  }
};
const job = (id: string) => a.owner.req("GET", `/v1/orgs/${a.orgId}/ai/jobs/${id}`).then((r) => r.job);

describe.skipIf(!ffmpeg)("the creative workflow", () => {
  it("brief → photographer's task → real footage → a real edit, approved → posts from its captions → the Manager's report", async () => {
    const ask = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/jobs`, { installId: manager, input: { brief: "Plan, shoot and edit a teaser for the new grip, then propose posts." }, conversationId: a.channel, requestText: "Plan, shoot and edit a teaser for the new grip, then propose posts." })).job;
    await run();

    // 1–3: the brief exists; the photographer's task opened with it to work from, and the channel was told.
    const mine = (await photographer.req("GET", `/v1/orgs/${a.orgId}/ai/tasks?scope=mine`)).tasks as { id: string; title: string; state: string }[];
    const task = mine.find((t) => t.title === "Film the grip teaser")!;
    expect(task.state).toBe("open");
    const detail = (await photographer.req("GET", `/v1/orgs/${a.orgId}/ai/tasks/${task.id}`)).task;
    expect(detail.references.map((f: { name: string }) => f.name)).toContain("social-posts.md");
    const brief: Buffer = await photographer.req("GET", `/v1/orgs/${a.orgId}/ai/files/${detail.references.find((f: { name: string }) => f.name === "social-posts.md").id}`);
    expect(brief.toString("utf8")).toMatch(/Close-up of the grip/);
    expect(((await a.owner.req("GET", `/v1/conversations/${a.channel}/ai/posts`)).posts as { body: string }[]).some((p) => /New task for .*"Film the grip teaser"/.test(p.body))).toBe(true);

    // 4: the photographer accepts and hands in real footage.
    let rev = detail.rev;
    rev = (await photographer.req("POST", `/v1/orgs/${a.orgId}/ai/tasks/${task.id}/accept`, { rev })).task.rev;
    const footage = (await photographer.req("POST", `/v1/orgs/${a.orgId}/ai/files?name=grip.mp4&type=video/mp4`, undefined, testVideo(5, "testsrc", 440))).file.id as string;
    rev = (await photographer.req("POST", `/v1/orgs/${a.orgId}/ai/tasks/${task.id}/submit`, { rev, note: "Filmed on the handlebar.", fileIds: [footage] })).task.rev;
    await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/tasks/${task.id}/approve`, { rev });
    await run();

    // 5–7: the editor read that footage and rendered a real preview, which waits for a person.
    expect(prompts.some((p) => p.system.includes("You plan product video edits") && p.user.includes(footage))).toBe(true);
    const editJob = h.ctx.db.prepare("SELECT id FROM ai_jobs WHERE parent_job_id = ? AND agent_id = 'product_video_editor'").get(ask.id) as { id: string };
    const edit = await job(editJob.id);
    expect(edit.state).toBe("awaiting_approval");
    const preview = edit.files.find((f: { kind: string }) => f.kind === "preview");
    const bytes: Buffer = await a.owner.req("GET", `/v1/orgs/${a.orgId}/ai/files/${preview.id}`);
    expect(probeSeconds(bytes)).toBeGreaterThan(2.5);
    const approvals = (await a.owner.req("GET", `/v1/orgs/${a.orgId}/ai/approvals`)).approvals as { id: string; jobId: string }[];
    await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/approvals/${approvals.find((x) => x.jobId === editJob.id)!.id}`, { decision: "approved" });
    await run();
    const final = (await job(editJob.id)).files.find((f: { kind: string }) => f.kind === "final");
    expect(final).toMatchObject({ mime: "video/mp4" });

    // 8: posts written from what's said in the edit (its captions), not published.
    expect(prompts.some((p) => p.system.includes("social posts for") && p.user.includes("Holds tight on every ride"))).toBe(true);

    // 9–10: the Manager's report says who did what.
    const done = await job(ask.id);
    expect(done.state).toBe("completed");
    expect(done.output.steps.map((s: { kind: string; state: string }) => [s.kind, s.state])).toEqual([
      ["agent", "completed"],
      ["person", "completed"],
      ["agent", "completed"],
      ["agent", "completed"],
    ]);
    expect(done.output.steps[1]).toMatchObject({ jobId: task.id, fileIds: [footage] });
    const posts = (await a.owner.req("GET", `/v1/conversations/${a.channel}/ai/posts`)).posts as { kind: string; files: { id: string }[] }[];
    expect(posts.some((p) => p.files?.some((f) => f.id === preview.id))).toBe(true);
  }, 120_000);
});
