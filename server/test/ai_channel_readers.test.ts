import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { type Answer, chatText, type FakeCall, fakeProviders, openAiChat } from "./support/fakeAi.js";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";
import { type Community, community, configurePlatform, failure, install, REASON } from "./support/workforce.js";

/**
 * Agents reading conversations (docs/AI_WORKFORCE_2_PLAN.md phase 5), with real end-to-end encryption: the reference
 * client encrypts like the apps and the server's reader device decrypts. Readers only where the platform allows and a
 * channel's managers switch them on; each member's own choice decides whether their messages reach it; older clients
 * never share; a mention, a command or a reply to the agent becomes one job, as its author, answered in the thread;
 * read and write are separate; the Manager reads other channels only those the person asking can see; direct
 * conversations; switching off revokes and erases. The AI provider is a fake (support/fakeAi.ts).
 */
const mailer = new MemoryMailer();
let h: Harness;
let admin: ConsoleAdmin;
let a: Community;
let general: string;
let manager: string;
let secret: string;
const prompts: { system: string; user: string }[] = [];

function answer(call: FakeCall): Answer | null {
  if (call.url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "gpt-test" }] } };
  if (!call.url.endsWith("/v1/chat/completions")) return null;
  const { system, user } = chatText(call);
  prompts.push({ system, user });
  if (user.includes("Reply with the single word")) return openAiChat("pong");
  if (system.includes("Which of these capabilities does the request need")) return openAiChat(JSON.stringify({ capabilities: [] }));
  if (system.includes("You coordinate a team of AI agents")) return openAiChat(JSON.stringify({ mode: "answer", answer: "Here is the summary." }));
  return openAiChat("The answer is 4.");
}

beforeAll(async () => {
  fakeProviders(answer);
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex"), AI_WORKFORCE_TICK_MS: "0" }, { mailer });
  admin = await consoleAdmin(h, mailer, "super_admin", "rdsuper");
  await configurePlatform(admin, { models: [{ model: "gpt-test", capabilities: ["text"] }], agents: ["general_assistant", "agent_manager"] });
  a = await community(h, "Readers");
  general = await install(a, "general_assistant");
  manager = await install(a, "agent_manager");
  // A private channel the member isn't in, with the owner's notes.
  secret = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/channels`, { name: "leadership", kind: "PRIVATE" })).channel.id;
}, 120_000);

afterAll(async () => h.close());

beforeEach(() => {
  prompts.length = 0;
  a.owner.aiReaders = null;
  a.member.aiReaders = null;
});

const setting = (value: boolean) => admin.browser.expect(200, "PUT", "/admin/v1/settings/ai.workforce.channel_reading", { value, reason: REASON });
const turnOn = (c: GriipClient, installId: string, conversationId: string) => c.req("POST", `/v1/orgs/${a.orgId}/ai/agents/${installId}/readers`, { conversationId, reason: REASON });
const say = async (c: GriipClient, conversationId: string, text: string, extra: Record<string, unknown> = {}) => {
  const id = crypto.randomUUID();
  await c.send(conversationId, { type: "text", text, ...extra }, "message", id);
  return id;
};
const work = async () => {
  await h.ctx.workforce.readerWorker.drain();
  await h.ctx.workforce.runtime.runUntilIdle();
};
const jobFor = (messageId: string) => h.ctx.db.prepare("SELECT * FROM ai_jobs WHERE idempotency_key = ?").all(`msg:${messageId}`) as { id: string; state: string; requested_by: string; thread_root: string; install_id: string }[];
const posts = async (c: GriipClient, conversationId: string) => (await c.req("GET", `/v1/conversations/${conversationId}/ai/posts`)).posts as { kind: string; body: string; threadRoot: string | null; jobId: string | null }[];
const readerOf = (installId: string, conversationId: string) => h.ctx.workforce.readers.readerOf(installId, conversationId)!;

describe("switching a reader on", () => {
  it("needs the platform setting, a channel, and someone who manages agents and that channel", async () => {
    expect((await failure(turnOn(a.owner, general, a.channel))).body.error.code).toBe("ai_reading_not_allowed");
    await setting(true);
    expect((await failure(turnOn(a.member, general, a.channel))).status).toBe(403);
    const dm = (await a.owner.req("POST", "/v1/conversations/dm", { userId: a.member.userId })).conversation.id;
    expect((await failure(a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/agents/${general}/readers`, { conversationId: dm, reason: REASON }))).body.error.code).toBe("ai_reading_not_allowed");
    const r = (await turnOn(a.owner, general, a.channel)).reader;
    expect(r).toMatchObject({ installId: general, mode: "channel", state: "on", turnedOnBy: { id: a.owner.userId }, reason: REASON });
    // Everyone in the channel is told, and nobody has chosen yet.
    expect((await posts(a.member, a.channel)).some((p) => /can now read new messages here, from members who choose to share theirs/.test(p.body))).toBe(true);
    const mine = await a.member.req("GET", `/v1/conversations/${a.channel}/ai/readers`);
    expect(mine).toMatchObject({ readingEnabled: true, readers: [{ readerId: r.readerId, myChoice: null }] });
    // The agent's bot identity can't be messaged or found as a person.
    expect((await failure(a.member.req("POST", "/v1/conversations/dm", { userId: r.agentUserId }))).status).toBeGreaterThanOrEqual(400);
  });
});

describe("what senders' apps send", () => {
  it("older apps never see a reader; apps that do wrap to it only when their person chose to share", async () => {
    const legacy = (await a.member.req("GET", `/v1/conversations/${a.channel}/devices`)).users as { agent?: unknown }[];
    expect(legacy.some((u) => u.agent)).toBe(false);
    a.member.aiReaders = "keep";
    const capable = (await a.member.req("GET", `/v1/conversations/${a.channel}/devices`, undefined)).users as { agent?: unknown }[];
    expect(capable.some((u) => u.agent)).toBe(false); // the header is only sent by conversationKeys
    const keys = await a.member.conversationKeys(a.channel);
    expect(keys.filter((u) => u.agent)).toHaveLength(1);
    // Kept out: nothing reaches the reader, so nothing happens.
    const kept = await say(a.member, a.channel, "@General Assistant what is 2+2?");
    await work();
    expect(jobFor(kept)).toEqual([]);
    // An older app's message is accepted without the reader, and never reaches it.
    a.member.aiReaders = null;
    const old = await say(a.member, a.channel, "@General Assistant hello from an older app");
    await work();
    expect(jobFor(old)).toEqual([]);
  });

  it("a wrap to a device that isn't this conversation's reader is refused", async () => {
    const other = (await a.owner.req("POST", `/v1/orgs/${a.orgId}/channels`, { name: "elsewhere" })).channel.id;
    await turnOn(a.owner, general, other);
    const stranger = readerOf(general, other);
    const keys = await a.owner.conversationKeys(a.channel);
    const people = keys.filter((u) => !u.agent).flatMap((u) => a.owner.verifiedDevices(u)).filter((d) => d.id !== a.owner.deviceId);
    const dev = h.ctx.db.prepare("SELECT id, signing_key signingKey, encryption_key encryptionKey, certificate FROM devices WHERE id = ?").get(stranger.device_id) as { id: string; signingKey: string; encryptionKey: string; certificate: string };
    const env = await a.owner.encrypt(a.channel, { type: "text", text: "hi" }, "message", [...people, dev]);
    expect((await failure(a.owner.req("POST", "/v1/messages", env))).body.error.code).toBe("device_mismatch");
  });
});

describe("a mention becomes one job, as its author, answered in its thread", () => {
  it("with the channel's recent shared messages as context", async () => {
    a.member.aiReaders = "share";
    await a.member.req("PUT", `/v1/conversations/${a.channel}/ai/readers/${readerOf(general, a.channel).id}/choice`, { choice: "share" });
    await say(a.member, a.channel, "EARLIER-CONTEXT-55: the launch is on Friday.");
    const asked = await say(a.member, a.channel, "@General Assistant when is the launch?");
    await work();
    const [job] = jobFor(asked);
    expect(job).toMatchObject({ state: "completed", requested_by: a.member.userId, thread_root: asked, install_id: general });
    expect(prompts.some((p) => p.user.includes("EARLIER-CONTEXT-55"))).toBe(true);
    // The answer is in the thread of the question; no "shared N messages" note (the channel already knows).
    const ps = await posts(a.owner, a.channel);
    expect(ps.some((p) => p.jobId === job!.id && p.threadRoot === asked && p.kind === "result")).toBe(true);
    expect(ps.some((p) => p.jobId === job!.id && /Shared/.test(p.body))).toBe(false);
  });

  it("a command or a reply in its thread calls it too; anything else doesn't", async () => {
    a.member.aiReaders = "share";
    const plain = await say(a.member, a.channel, "Nothing for the agent here.");
    const command = await say(a.member, a.channel, "/generalassistant what about Monday?");
    await work();
    expect(jobFor(plain)).toEqual([]);
    expect(jobFor(command)).toHaveLength(1);
    const answer = (await posts(a.owner, a.channel)).find((p) => p.jobId === jobFor(command)[0]!.id && p.kind === "result")!;
    const thread = await say(a.member, a.channel, "and Tuesday?", { threadRoot: (await a.owner.req("GET", `/v1/conversations/${a.channel}/ai/posts`)).posts.find((p: { jobId: string | null; kind: string }) => p.jobId === jobFor(command)[0]!.id && p.kind === "result").id });
    await work();
    expect(jobFor(thread)).toHaveLength(1);
    expect(answer).toBeTruthy();
  });

  it("answers the apps' command name and a mention at the end of a message, with the call left out of the brief", async () => {
    a.member.aiReaders = "share";
    const dashed = await say(a.member, a.channel, "/general-assistant what about Wednesday?");
    const trailing = await say(a.member, a.channel, "can you work with fewer tokens @General Assistant?");
    await work();
    expect(jobFor(dashed)).toHaveLength(1);
    expect(jobFor(trailing)).toHaveLength(1);
    const brief = (id: string) => JSON.parse((h.ctx.db.prepare("SELECT input FROM ai_jobs WHERE id = ?").get(id) as { input: string }).input).brief;
    expect(brief(jobFor(dashed)[0]!.id)).toBe("what about Wednesday?");
    expect(brief(jobFor(trailing)[0]!.id)).toBe("can you work with fewer tokens?");
  });

  it("the same message never acts twice, and a message from an agent identity never acts", async () => {
    a.member.aiReaders = "share";
    const asked = await say(a.member, a.channel, "@General Assistant once only");
    const r = readerOf(general, a.channel);
    const queued = await h.ctx.relay.backlog(r.device_id, Date.now(), 50);
    await work();
    // The very same envelope again (a retried delivery): already handled.
    await h.ctx.relay.enqueue(queued.map(({ id: _id, ...q }) => q));
    await work();
    expect(jobFor(asked)).toHaveLength(1);
    h.ctx.db.prepare("UPDATE users SET kind = 'agent' WHERE id = ?").run(a.member.userId);
    try {
      const fromAgent = await say(a.member, a.channel, "@General Assistant from an agent");
      await work();
      expect(jobFor(fromAgent)).toEqual([]);
    } finally {
      h.ctx.db.prepare("UPDATE users SET kind = 'person' WHERE id = ?").run(a.member.userId);
    }
  });

  it("edits and deletes reach what it kept", async () => {
    a.member.aiReaders = "share";
    const id = await say(a.member, a.channel, "TYPO-77 in the plan");
    await work();
    const r = readerOf(general, a.channel);
    await a.member.send(a.channel, { type: "edit", target: id, text: "FIXED-77 in the plan" }, "control");
    await work();
    expect(h.ctx.workforce.readers.context(r, 100).find((m) => m.messageId === id)!.text).toBe("FIXED-77 in the plan");
    await a.member.send(a.channel, { type: "delete", target: id }, "control");
    await work();
    expect(h.ctx.workforce.readers.context(r, 100).some((m) => m.messageId === id)).toBe(false);
  });
});

describe("reading and writing are separate", () => {
  it("an agent that only reads a channel never answers there", async () => {
    a.owner.aiReaders = "share";
    // The Manager reads #leadership but isn't assigned there.
    await turnOn(a.owner, manager, secret);
    await say(a.owner, secret, "LEADERSHIP-NOTE-9: budget is 5,000.");
    const asked = await say(a.owner, secret, "@Agent Manager what's the budget?");
    await work();
    expect(jobFor(asked)).toEqual([]);
    expect(h.ctx.db.prepare("SELECT outcome FROM ai_reader_events WHERE message_id = ?").get(asked)).toEqual({ outcome: "ignored" });
  });

  it("the Manager reads other channels for people who can see them, never for others", async () => {
    a.owner.aiReaders = "share";
    a.member.aiReaders = "share";
    await turnOn(a.owner, manager, a.channel);
    await a.owner.req("PUT", `/v1/conversations/${a.channel}/ai/readers/${readerOf(manager, a.channel).id}/choice`, { choice: "share" });
    await say(a.owner, a.channel, "@Agent Manager summarise #leadership for me");
    await work();
    expect(prompts.find((p) => p.system.includes("You coordinate"))!.user).toMatch(/Latest messages in #leadership:[\s\S]*LEADERSHIP-NOTE-9/);
    prompts.length = 0;
    await say(a.member, a.channel, "@Agent Manager summarise #leadership for me");
    await work();
    const plan = prompts.find((p) => p.system.includes("You coordinate"))!.user;
    expect(plan).not.toMatch(/LEADERSHIP-NOTE-9/);
    expect(plan).toMatch(/Channels you can read: #work/);
  });

  it("reading every channel of the community creates a reader, with its notice, in each one", async () => {
    const before = h.ctx.workforce.readers.ofInstall(general).length;
    const r = await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/agents/${general}/read-scope`, { scope: "all", reason: REASON });
    const channels = (h.ctx.db.prepare("SELECT COUNT(*) n FROM conversations WHERE org_id = ? AND type = 'CHANNEL' AND archived_at IS NULL").get(a.orgId) as { n: number }).n;
    expect(r.readers).toHaveLength(channels);
    expect(h.ctx.workforce.readers.ofInstall(general).length).toBe(channels);
    expect(channels).toBeGreaterThan(before);
    // A member can't grant it.
    expect((await failure(a.member.req("POST", `/v1/orgs/${a.orgId}/ai/agents/${general}/read-scope`, { scope: "all", reason: REASON }))).status).toBe(403);
  });
});

describe("a direct conversation with an agent", () => {
  it("every message there is for the agent, and only its person sees the answers", async () => {
    a.member.aiReaders = "share";
    const d = await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/agents/${general}/direct`);
    expect(d.reader).toMatchObject({ mode: "direct", installId: general });
    expect((await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/agents/${general}/direct`)).conversationId).toBe(d.conversationId);
    const asked = await say(a.member, d.conversationId, "what is 2+2?");
    await work();
    const [job] = jobFor(asked);
    expect(job).toMatchObject({ state: "completed", requested_by: a.member.userId });
    expect((await posts(a.member, d.conversationId)).some((p) => p.jobId === job!.id && p.kind === "result")).toBe(true);
    expect((await failure(a.owner.req("GET", `/v1/conversations/${d.conversationId}/ai/posts`))).status).toBe(404);
  });
});

describe("switching off", () => {
  it("revokes the device, erases what it kept, and senders can't wrap to it any more", async () => {
    a.member.aiReaders = "share";
    const r = readerOf(general, a.channel);
    const device = h.ctx.db.prepare("SELECT id, signing_key signingKey, encryption_key encryptionKey, certificate FROM devices WHERE id = ?").get(r.device_id) as { id: string; signingKey: string; encryptionKey: string; certificate: string };
    expect(h.ctx.workforce.readers.context(r, 5).length).toBeGreaterThan(0);
    expect((await failure(a.member.req("POST", `/v1/orgs/${a.orgId}/ai/agents/${general}/readers/${r.id}/off`, { reason: REASON }))).status).toBe(403);
    await a.owner.req("POST", `/v1/orgs/${a.orgId}/ai/agents/${general}/readers/${r.id}/off`, { reason: REASON });
    const off = h.ctx.workforce.readers.row(r.id)!;
    expect(off).toMatchObject({ state: "off", reader_key: null, device_keys: null });
    expect(h.ctx.db.prepare("SELECT COUNT(*) n FROM ai_channel_context WHERE reader_id = ?").get(r.id)).toEqual({ n: 0 });
    expect((h.ctx.db.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(r.device_id) as { revoked_at: number | null }).revoked_at).not.toBeNull();
    expect((await a.member.conversationKeys(a.channel)).some((u) => u.agent?.readerId === r.id)).toBe(false);
    const keys = await a.member.conversationKeys(a.channel);
    const people = keys.filter((u) => !u.agent).flatMap((u) => a.member.verifiedDevices(u)).filter((x) => x.id !== a.member.deviceId);
    const env = await a.member.encrypt(a.channel, { type: "text", text: "hi" }, "message", [...people, device]);
    expect((await failure(a.member.req("POST", "/v1/messages", env))).body.error.code).toBe("device_mismatch");
    expect((await posts(a.member, a.channel)).some((p) => /can no longer read this conversation/.test(p.body))).toBe(true);
  });

  it("the platform setting stops every reader at once", async () => {
    a.member.aiReaders = "share";
    await setting(false);
    expect((await a.member.conversationKeys(a.channel)).some((u) => u.agent)).toBe(false);
    expect(h.ctx.workforce.readers.active()).toEqual([]);
    await setting(true);
  });
});
