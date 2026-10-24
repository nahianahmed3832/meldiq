import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENTS } from "../src/modules/workforce/catalog/index.js";
import { CAPABILITY_IDS, CAPABILITY_SPECS, SKILL_PROVIDES, skillLibrary } from "../src/modules/workforce/skillLibrary.js";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { type Answer, chatText, type FakeCall, fakeProviders, openAiChat } from "./support/fakeAi.js";
import { type Harness, startServer } from "./support/harness.js";
import { type Community, community, configurePlatform, failure, install } from "./support/workforce.js";

/**
 * The shared skill library and discovery (docs/AI_WORKFORCE_2_PLAN.md, phase 1): every skill declares what it
 * provides; discovery says which of a community's agents can do a capability now, or the exact blocker (an outside
 * connection, a model route, an agent to install); the Agent Manager checks the request's needs first and reports what
 * nobody can do instead of planning it. The provider is a fake (support/fakeAi.ts).
 */
const mailer = new MemoryMailer();
let h: Harness;
let admin: ConsoleAdmin;
let a: Community;
let manager: string;
const prompts: { system: string; user: string }[] = [];

function answer(call: FakeCall): Answer | null {
  if (call.url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "gpt-test" }] } };
  if (!call.url.endsWith("/v1/chat/completions")) return null;
  const { system, user } = chatText(call);
  prompts.push({ system, user });
  if (user.includes("Reply with the single word")) return openAiChat("pong");
  if (system.includes("Which of these capabilities does the request need")) return openAiChat(JSON.stringify({ capabilities: ["text.write", "social.publish"] }));
  if (system.includes("You coordinate a team of AI agents")) return openAiChat(JSON.stringify({ mode: "answer", answer: "Here is the launch post draft." }));
  return openAiChat("Ready.");
}

beforeAll(async () => {
  fakeProviders(answer);
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex"), AI_WORKFORCE_TICK_MS: "0" }, { mailer });
  admin = await consoleAdmin(h, mailer, "super_admin", "slsuper");
  await configurePlatform(admin, { models: [{ model: "gpt-test", capabilities: ["text"] }], agents: ["general_assistant", "content_writer", "agent_manager", "social_media_manager", "graphic_designer"] });
  a = await community(h, "Skills");
  await install(a, "general_assistant");
  await install(a, "content_writer");
  await install(a, "social_media_manager");
  await install(a, "graphic_designer");
  manager = await install(a, "agent_manager");
}, 120_000);

afterAll(async () => h.close());

type Found = { capability: string; status: string; providers: { name: string; ready: boolean; blockers: string[] }[]; installable: { agentId: string }[] };
const discover = async (caps: string) => (await a.member.req("GET", `/v1/orgs/${a.orgId}/ai/skills/discover?capabilities=${caps}`)).capabilities as Found[];

describe("the library", () => {
  it("every skill declares what it provides, and an outside capability only where the skill can use its tool", () => {
    for (const agent of AGENTS) expect(SKILL_PROVIDES[agent.skill.id], agent.skill.id).toBeTruthy();
    for (const [skill, caps] of Object.entries(SKILL_PROVIDES)) {
      const def = AGENTS.find((x) => x.skill.id === skill)!.skill;
      for (const c of caps) {
        const tool = (CAPABILITY_SPECS[c] as { tool?: string }).tool;
        if (tool) expect(def.tools, `${skill} provides ${c}`).toContain(tool);
      }
    }
    expect(new Set(Object.values(SKILL_PROVIDES).flat()).size).toBe(CAPABILITY_IDS.length);
  });

  it("each skill's card carries its inputs and outputs as JSON Schema, tools, models and limits", async () => {
    const cards = skillLibrary();
    expect(cards).toHaveLength(new Set(AGENTS.map((x) => x.skill.id)).size);
    const video = cards.find((c) => c.id === "video.edit")!;
    expect(video.agents.map((x) => x.id)).toEqual(["product_video_editor"]);
    expect(video.provides.map((p) => p.id)).toEqual(["video.edit", "audio.transcribe", "social.publish"]);
    expect(video.input).toMatchObject({ type: "object" });
    expect(video.tools.find((t) => t.key === "media.render")).toMatchObject({ required: true });
    const viaApi = await a.member.req("GET", `/v1/orgs/${a.orgId}/ai/skills`);
    expect(viaApi.skills).toHaveLength(cards.length);
    expect(viaApi.capabilities).toHaveLength(CAPABILITY_IDS.length);
  });
});

describe("discovery", () => {
  it("says who can do it now, what blocks the rest, and what to install", async () => {
    const [write, publish, image, video, payments] = await discover("text.write,social.publish,image.generate,video.edit,payments.execute");
    expect(write).toMatchObject({ capability: "text.write", status: "ready", providers: [{ name: "Content Writer", ready: true, blockers: [] }] });
    // Social publishing: the Social Media Manager is installed, but no social account is connected.
    expect(publish!.status).toBe("blocked");
    expect(publish!.providers.find((p) => p.name === "Social Media Manager")!.blockers).toEqual([
      "Publish to social media: needs a Social media account connection, which isn't connected yet.",
    ]);
    expect(publish!.installable.map((x) => x.agentId)).toEqual(["product_video_editor"]);
    // Images need an image-generation route; nothing else is missing for the Graphic Designer.
    expect(image).toMatchObject({ status: "blocked", providers: [{ name: "Graphic and Image Designer", ready: false }] });
    expect(image!.providers[0]!.blockers).toEqual(["No verified model for image generation (a platform operator sets it up in the AI Control Center)."]);
    expect(video).toMatchObject({ status: "not_installed", providers: [], installable: [{ agentId: "product_video_editor" }] });
    expect(payments!.providers).toEqual([]);
    expect(payments!.status).toBe("not_installed");
  });

  it("refuses unknown capabilities and people outside the community", async () => {
    expect((await failure(a.member.req("GET", `/v1/orgs/${a.orgId}/ai/skills/discover?capabilities=text.write,teleport`))).body.error.message).toMatch(/Unknown capabilities: teleport/);
    const outsider = await h.client("skilloutsider");
    expect((await failure(outsider.req("GET", `/v1/orgs/${a.orgId}/ai/skills`))).status).toBe(404);
  });
});

describe("the Agent Manager", () => {
  it("checks what the request needs first, and reports what no agent here can do instead of planning it", async () => {
    prompts.length = 0;
    const job = (await a.member.req("POST", `/v1/orgs/${a.orgId}/ai/jobs`, { installId: manager, input: { brief: "Write the launch post and publish it on Instagram." } })).job;
    await h.ctx.workforce.runtime.runUntilIdle();
    const done = (await a.member.req("GET", `/v1/orgs/${a.orgId}/ai/jobs/${job.id}`)).job;
    expect(done.state).toBe("completed");
    expect(done.output.missing).toEqual([
      "Publish to social media: Social Media Manager can't yet (Publish to social media: needs a Social media account connection, which isn't connected yet.)",
    ]);
    expect(done.output.answer).toMatch(/Here is the launch post draft\.\n\nNot available here yet:\n- Publish to social media/);
    const planPrompt = prompts.find((p) => p.system.includes("You coordinate a team of AI agents"))!;
    expect(planPrompt.system).toMatch(/Not available here .*\n- Publish to social media/);
    // One quick classification call before the plan, on the quick-replies route.
    expect(prompts.findIndex((p) => p.system.includes("Which of these capabilities"))).toBeLessThan(prompts.indexOf(planPrompt));
  });
});
