import { z } from "zod/v4";
import { ApiError } from "../../../../shared/errors.js";
import { untrusted } from "../../prompting.js";
import { defineSkill, type SkillContext, type SkillOutcome } from "../../types.js";
import { Brief, deliver, finish, MB, post, sharedSource, Summary, TEXT_MIMES, VIDEO_MIMES, AUDIO_MIMES, IMAGE_MIMES } from "../common.js";
import { CAPABILITY_IDS, CAPABILITY_SPECS, type CapabilityId, missingLines, SKILL_PROVIDES } from "../../capabilityCatalog.js";

/**
 * Agent Manager: understands a request, and either answers it, asks one question, or plans steps for the community's
 * own agents and delegates them through the tool gateway (as the person who asked, never with more). Before planning,
 * a quick model call names the capabilities the request needs and the skill library checks which agents can do each
 * one now (skillLibrary.ts): what nobody can do is reported with its exact blocker, never planned. It reports only
 * what the delegated jobs' records say: their states, their validated outputs and the files they stored.
 */
const Input = z.strictObject({ brief: Brief });
type Input = z.infer<typeof Input>;

export const MAX_STEPS = 6;
/** Channels named in a request whose latest messages it reads, and how many of each. */
const MAX_NAMED_CHANNELS = 3;
const CHANNEL_CONTEXT = 40;

/** Longest a person step may take: the request waits for it (taskService.ts MAX_DUE_HOURS). */
const MAX_TASK_HOURS = 168;

/**
 * One step: an agent's ("agent", the default) or a person's ("person": a task for someone the community lets the
 * Manager assign work to; the server chooses who, by the role named and their workload).
 */
const Step = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,20}$/),
  kind: z.enum(["agent", "person"]).default("agent"),
  installId: z.string().default(""),
  task: z.string().min(1).max(4000),
  title: z.string().max(120).default(""),
  deliverables: z.string().max(1000).default(""),
  dueInHours: z.number().min(1).max(MAX_TASK_HOURS).default(48),
  role: z.string().max(60).nullable().default(null),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  dependsOn: z.array(z.string()).max(MAX_STEPS).default([]),
});
const Plan = z.object({
  mode: z.enum(["answer", "ask", "delegate"]),
  answer: z.string().max(8000).nullable().default(null),
  question: z.string().max(1000).nullable().default(null),
  steps: z.array(Step).max(MAX_STEPS).default([]),
});
type Plan = z.infer<typeof Plan>;

const SKILL_ID = "manager.orchestrate";
/**
 * What the Manager does itself (plan, and answer from its own model): never looked for among the other agents, which
 * discovery searches (it leaves out the asking install), so a plain question is never reported as nobody's job.
 */
const OWN_CAPABILITIES: ReadonlySet<CapabilityId> = new Set(SKILL_PROVIDES[SKILL_ID] ?? []);

/** The capabilities a request needs, from the skill library's list (what the Manager does itself is left out). */
const Needs = z.object({ capabilities: z.array(z.enum(CAPABILITY_IDS as [CapabilityId, ...CapabilityId[]])).max(8) });

const StepResult = z.strictObject({
  label: z.string(),
  kind: z.enum(["agent", "person"]),
  agentId: z.string(),
  /** The agent's job, or the person's task ("tsk_…"). */
  jobId: z.string(),
  /** For a person step: who it was assigned to. */
  assignee: z.string().nullable(),
  state: z.string(),
  fileIds: z.array(z.string()),
  error: z.string().nullable(),
});
const Output = z.strictObject({
  mode: z.enum(["answer", "delegate"]),
  steps: z.array(StepResult),
  answer: z.string(),
  reportFileId: z.string().nullable(),
  /** What the request needed that no agent here can do now, each with its blocker. */
  missing: z.array(z.string()).max(8),
  summary: Summary,
});
type Output = z.infer<typeof Output>;

const Checkpoint = z.object({
  phase: z.literal("waiting"),
  missing: z.array(z.string()).default([]),
  steps: z.array(z.object({ key: z.string(), kind: z.enum(["agent", "person"]).default("agent"), jobId: z.string(), label: z.string(), agentName: z.string() })),
});
const AskCheckpoint = z.object({ phase: z.literal("asked"), question: z.string(), answer: z.string().optional() });

/**
 * Checks a plan against the team: known agents only, at most MAX_STEPS, keys unique, and every dependency on an
 * earlier step, so the steps can't form a cycle. Returns the steps in order, or why it's refused.
 */
export function checkPlan(plan: Plan, team: ReadonlySet<string>, people = false): { ok: true; steps: Plan["steps"] } | { ok: false; why: string } {
  if (plan.mode !== "delegate") return { ok: true, steps: [] };
  if (plan.steps.length === 0) return { ok: false, why: "no steps" };
  const kinds = new Map<string, "agent" | "person">();
  for (const step of plan.steps) {
    // A step parsed without a kind is an agent's (the schema's default).
    const s = { ...step, kind: step.kind ?? "agent" };
    if (s.kind === "agent" && !team.has(s.installId)) return { ok: false, why: `${s.installId} isn't an agent you can use here` };
    if (s.kind === "person" && !people) return { ok: false, why: "no one may be given work for this request" };
    if (s.kind === "person" && !s.title.trim()) return { ok: false, why: `person step ${s.key} has no title` };
    if (kinds.has(s.key)) return { ok: false, why: `step ${s.key} appears twice` };
    for (const d of s.dependsOn) {
      if (!kinds.has(d)) return { ok: false, why: `step ${s.key} depends on ${d}, which isn't an earlier step` };
      // A person's task opens when agent steps finish; it can't wait for another person's (no task waits on a task).
      if (s.kind === "person" && kinds.get(d) === "person") return { ok: false, why: `person step ${s.key} can only wait for agent steps` };
    }
    kinds.set(s.key, s.kind);
  }
  return { ok: true, steps: plan.steps };
}

/**
 * What the request needs that no agent can do now. Best effort: without a quick-replies model, or when its answer
 * isn't usable, the plan goes ahead without it (the team list already holds only agents that can work).
 */
async function unavailable(ctx: SkillContext, brief: string): Promise<string[]> {
  if (!ctx.models.available("fast")) return [];
  try {
    const catalog = CAPABILITY_IDS.filter((c) => !OWN_CAPABILITIES.has(c)).map((c) => `${c}: ${CAPABILITY_SPECS[c].label}`).join("\n");
    const needs = await ctx.models.json("fast", Needs, {
      system: `Which of these capabilities does the request need? Only ones it clearly needs; usually one to three.\n${catalog}\nAnswer with JSON only: {"capabilities": [ids]}`,
      prompt: untrusted("request", brief),
      maxOutputTokens: 200,
    });
    const others = needs.capabilities.filter((c) => !OWN_CAPABILITIES.has(c));
    return others.length ? missingLines(await ctx.discover(others)) : [];
  } catch {
    return [];
  }
}

const withMissing = (text: string, missing: readonly string[]) => (missing.length ? `${text}\n\nNot available here yet:\n${missing.map((m) => `- ${m}`).join("\n")}` : text);

async function plan(ctx: SkillContext, input: Input, answer: string | null): Promise<SkillOutcome<Output>> {
  const team = ctx.team();
  const people = ctx.people();
  ctx.progress(10, "Understanding the request");
  const missing = await unavailable(ctx, input.brief);
  const canAssign = people !== null && people.eligible > 0;
  const peopleLine = !people
    ? "People: you can't give work to people for this request (the person asking doesn't manage AI agents)."
    : !people.eligible
      ? "People: nobody may be given work by you yet in this community."
      : `People you may give tasks to: ${people.eligible}${people.roles.length ? ` (roles: ${people.roles.join(", ")})` : ""}. For work only people can do (photos and video shoots, physical stock checks, packing and dispatch, a judgement or sign-off), add {"key","kind":"person","title","task": the instructions,"deliverables": what they must hand in,"dueInHours","role": one of those roles or null,"priority","dependsOn":[earlier agent steps]}. An agent step that needs what a person hands in lists that step in its dependsOn. Never name a person: the server chooses who.`;
  const roster = team.map((t) => `- installId ${t.installId}: ${t.name} (${t.roleTitle}). ${t.description} Can: ${t.capabilities.slice(0, 5).join("; ")}. Request: ${t.inputHint}`).join("\n");
  const files = ctx.inputs.map((f) => `${f.name} (${f.mime}, ${(f.size / MB).toFixed(1)} MB)`).join(", ");
  // Messages shared from the channel: the coordinator may answer from them, and every step gets them too.
  const shared = sharedSource(ctx, 30_000);
  // Other channels it reads (for the person asking), and the latest messages of those the request names ("#marketing").
  const readable = ctx.channels();
  const brief = input.brief.toLowerCase();
  const named = readable.filter((c) => brief.includes(`#${c.name.toLowerCase()}`)).slice(0, MAX_NAMED_CHANNELS);
  const elsewhere = named
    .map((c) => {
      const lines = ctx.readChannel(c.conversationId, CHANNEL_CONTEXT).map((m) => `${new Date(m.at).toISOString().slice(0, 16)} ${m.author}: ${m.text}`);
      return lines.length ? `\n\nLatest messages in #${c.name}:\n${untrusted(`#${c.name}`, lines.join("\n").slice(0, 20_000))}` : "";
    })
    .join("");
  const p = await ctx.models.json("reasoning", Plan, {
    system: [
      "You coordinate a team of AI agents. Use the smallest workflow that does the job:",
      '- "answer": you can answer yourself (questions, short advice). Put it in "answer".',
      '- "ask": something essential is missing. Put one question in "question".',
      '- "delegate": specialists are needed. Give "steps": [{"key","installId","task","dependsOn":[earlier keys]}]. Use only the listed installIds; each task is a complete, self-contained request for that agent; the files and channel messages sent with the request are available to every step.',
      peopleLine,
      `At most ${MAX_STEPS} steps. Never invent agents or capabilities. Answer with JSON only.`,
      ...(missing.length ? ["Not available here (no agent can do these now; don't plan them, and don't claim they were done):", ...missing.map((m) => `- ${m}`)] : []),
    ].join("\n"),
    prompt: `Team:\n${roster || "(no other agents you can use)"}\n\nChannels you can read: ${readable.map((c) => `#${c.name}`).join(", ") || "none"}${elsewhere}\n\nFiles sent with the request: ${files || "none"}${shared ? `\n\nChannel messages shared with the request:\n${untrusted(shared.name, shared.text)}` : ""}\n\nRequest:\n${untrusted("request", input.brief)}${answer ? `\n\nThe person's answer to your question:\n${untrusted("answer", answer)}` : ""}`,
    maxOutputTokens: 2000,
  });
  if (p.mode === "ask" && p.question && !answer) {
    await post(ctx, "progress", p.question);
    return { kind: "await_input", question: p.question, checkpoint: { phase: "asked", question: p.question } };
  }
  if (p.mode !== "delegate") {
    const text = withMissing(p.answer?.trim() || "I can't help with this using the agents available here.", missing);
    const output: Output = { mode: "answer", steps: [], answer: text, reportFileId: null, missing, summary: text.slice(0, 300) };
    return finish(ctx, output, output.summary, [], text);
  }
  const checked = checkPlan(p, new Set(team.map((t) => t.installId)), canAssign);
  if (!checked.ok) throw new ApiError(502, "provider_error", `The plan couldn't be used (${checked.why}).`);
  ctx.progress(25, "Handing out the work");
  const byKey = new Map<string, string>();
  const steps: z.infer<typeof Checkpoint>["steps"] = [];
  for (const s of checked.steps) {
    const dependsOn = s.dependsOn.map((d) => byKey.get(d)!);
    if (s.kind === "person") {
      const { taskId, assigneeName } = await ctx.tool("tasks.assign", { title: s.title, instructions: s.task, deliverables: s.deliverables, dueInHours: s.dueInHours, priority: s.priority, role: s.role, dependsOn });
      const label = `${assigneeName}: ${s.title.slice(0, 60)}`;
      byKey.set(s.key, taskId);
      steps.push({ key: s.key, kind: "person", jobId: taskId, label, agentName: assigneeName });
      ctx.event("assigned_task", { key: s.key, taskId });
      continue;
    }
    const member = team.find((t) => t.installId === s.installId)!;
    const label = `${member.name}: ${s.task.slice(0, 60)}`;
    const { jobId } = await ctx.tool("agents.delegate", { installId: s.installId, input: { brief: s.task }, dependsOn, label });
    byKey.set(s.key, jobId);
    steps.push({ key: s.key, kind: "agent", jobId, label, agentName: member.name });
    ctx.event("delegated_step", { key: s.key, jobId, agent: member.agentId });
  }
  await post(ctx, "progress", `I've split this into ${steps.length} step${steps.length === 1 ? "" : "s"}:\n${steps.map((s, i) => `${i + 1}. ${s.label}`).join("\n")}`);
  return { kind: "wait_children", jobIds: steps.map((s) => s.jobId), checkpoint: { phase: "waiting", missing, steps } };
}

async function report(ctx: SkillContext, cp: z.infer<typeof Checkpoint>): Promise<SkillOutcome<Output>> {
  ctx.progress(85, "Collecting the results");
  const records = new Map(ctx.children().map((c) => [c.jobId, c]));
  // People's tasks, as their records say: done counts as completed, with what they handed in.
  const tasks = new Map(ctx.tasks().map((t) => [t.taskId, t]));
  const steps: z.infer<typeof StepResult>[] = cp.steps.map((s) => {
    if (s.kind === "person") {
      const t = tasks.get(s.jobId);
      const state = t?.state === "done" ? "completed" : (t?.state ?? "missing");
      return { label: s.label, kind: "person", agentId: "", jobId: s.jobId, assignee: t?.assignee ?? null, state, fileIds: t?.fileIds ?? [], error: t ? (t.state === "cancelled" ? "the task was cancelled" : null) : "no record of this task" };
    }
    const r = records.get(s.jobId);
    return { label: s.label, kind: "agent", agentId: r?.agentId ?? "", jobId: s.jobId, assignee: null, state: r?.state ?? "missing", fileIds: r?.state === "completed" ? r.fileIds : [], error: r?.error ?? (r ? null : "no record of this step") };
  });
  const done = steps.filter((s) => s.state === "completed");
  // The summary is written from the steps' validated outputs; which steps ran and which files exist comes from records.
  const material = cp.steps
    .map((s) => {
      if (s.kind === "person") {
        const t = tasks.get(s.jobId);
        const out = t?.state === "done" ? `handed in${t.note ? `: ${t.note.slice(0, 2000)}` : ""}${t.fileIds.length ? ` (${t.fileIds.length} files)` : ""}` : `not done (${t?.state ?? "missing"})`;
        return `Task "${s.label}":\n${untrusted(s.agentName, out)}`;
      }
      const r = records.get(s.jobId);
      const out = r?.state === "completed" ? JSON.stringify(r.output).slice(0, 6000) : `did not complete (${r?.error ?? r?.state ?? "missing"})`;
      return `Step "${s.label}":\n${untrusted(s.agentName, out)}`;
    })
    .join("\n\n");
  let answer = "";
  if (done.length && ctx.models.available("fast")) {
    answer = await ctx.models.text("fast", {
      system: "Summarise for the person what the steps produced, in a few short paragraphs. Mention failures plainly. Don't claim anything the material doesn't show. Don't list files; they're listed separately.",
      prompt: material,
      maxOutputTokens: 800,
    });
  }
  const lines = steps.map((s) => `- ${s.state === "completed" ? "Done" : s.state === "failed" ? "Failed" : s.state === "cancelled" ? "Cancelled" : s.state}: ${s.label}${s.error ? ` (${s.error})` : ""}${s.fileIds.length ? ` · ${s.fileIds.length} file${s.fileIds.length === 1 ? "" : "s"}` : ""}`);
  const gaps = cp.missing.length ? `\n## Not available here yet\n\n${cp.missing.map((m) => `- ${m}`).join("\n")}\n` : "";
  const markdown = `# Request report\n\n${answer ? `${answer}\n\n` : ""}## Steps\n\n${lines.join("\n")}\n${gaps}`;
  const file = await deliver(ctx, "report.md", "text/markdown", markdown);
  // Deliverables are what agents made; what people handed in stays with their step (its fileIds).
  const fileIds = [...done.filter((s) => s.kind === "agent").flatMap((s) => s.fileIds), file.id];
  const summary = `${done.length} of ${steps.length} steps completed${steps.length > done.length ? `; ${steps.length - done.length} didn't` : ""}.`;
  const output: Output = { mode: "delegate", steps, answer: answer || summary, reportFileId: file.id, missing: cp.missing, summary };
  return finish(ctx, output, summary, fileIds, withMissing(`${summary}\n${lines.join("\n")}${answer ? `\n\n${answer}` : ""}`, cp.missing));
}

export const managerSkill = defineSkill<Input, Output>({
  id: SKILL_ID,
  version: 1,
  input: Input,
  output: Output,
  tools: ["files.read", "files.write", "channel.post", "agents.delegate", "tasks.assign"],
  requiredTools: ["agents.delegate", "files.write"],
  categories: ["reasoning", "fast"],
  requiredCategories: ["reasoning"],
  files: { max: 10, maxBytes: 500 * MB, mimes: [...TEXT_MIMES, ...VIDEO_MIMES, ...AUDIO_MIMES, ...IMAGE_MIMES] },
  limits: { maxRuntimeSec: 300, maxModelCalls: 6, maxAttempts: 2, maxOutputFiles: 2 },
  approvals: ["It can't approve anything: approvals its steps need go to people with ai.approve."],
  errors: [
    "A plan naming an agent the person can't use, a forward dependency or too many steps is refused (the job retries once, then fails).",
    "A step that fails is reported as failed; the others still report.",
    "Delegation is one level deep: delegated agents can't delegate, so requests can't loop.",
    "People get tasks only when the person asking may manage AI agents and the community named who may be assigned work; the server chooses who, never the model.",
    "A person's task is done only when someone other than them accepts what they handed in; a cancelled task is reported as such.",
  ],
  tests: ["ai_workforce_manager.test.ts"],
  async run(ctx, input) {
    const waiting = Checkpoint.safeParse(ctx.checkpoint);
    if (waiting.success) return report(ctx, waiting.data);
    const asked = AskCheckpoint.safeParse(ctx.checkpoint);
    return plan(ctx, input, asked.success ? (asked.data.answer ?? null) : null);
  },
});
