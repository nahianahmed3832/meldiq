import type { z } from "zod/v4";
import type { ChatImage, RoutingCategory, TranscriptSegment } from "../ai/index.js";
import type { CapabilityId, Discovered } from "./capabilityCatalog.js";

/**
 * The contracts of AI Workforce (docs/AI_WORKFORCE.md §3): tools, skills and agents. A skill is executable code with a
 * typed input and output; it reaches models and tools only through the SkillContext it's given, so the tool gateway
 * and the model gateway see (and can refuse) everything it does.
 */

/** Every tool an agent can be granted. External ones have no connector yet (§7). */
export const TOOL_KEYS = [
  "files.read",
  "files.write",
  "channel.post",
  "media.probe",
  "media.render",
  "media.extract_audio",
  "web.fetch",
  "agents.delegate",
  "tasks.assign",
  "social.publish",
  "ads.manage",
  "email.send",
  "calendar.write",
  "crm.write",
  "support.reply_external",
  "repository.write",
  "website.update",
  "deploy.production",
  "payments.execute",
] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];
export const isToolKey = (k: string): k is ToolKey => (TOOL_KEYS as readonly string[]).includes(k);

export type ToolRisk = "internal" | "consequential" | "external";
export type ToolMode = "allowed" | "approval" | "disabled";

export const AGENT_CATEGORIES = [
  "coordination",
  "productivity",
  "knowledge",
  "engineering",
  "project",
  "content",
  "creative",
  "media",
  "marketing",
  "commerce",
  "support",
  "sales",
  "data",
  "people",
  "finance",
  "documentation",
  "communication",
  "language",
] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/** A file a skill may read: what the person submitted, or what an earlier step of the same request produced. */
export interface FileRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

export interface ReadFile extends FileRef {
  bytes: Buffer;
}

export interface WrittenFile extends FileRef {
  version: number;
}

export interface MediaInfo {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
}

/** A video edit the server turns into ffmpeg arguments itself (media.ts): never a command line from a model. */
export interface EditPlan {
  clips: { fileId: string; startSec: number; endSec: number }[];
  captions: TranscriptSegment[];
  title: string | null;
  brandText: string | null;
}

/** Tool arguments and results, by tool. */
/** A person step of the Agent Manager's plan (taskService.ts chooses who; the plan never names a person). */
export interface TaskAssignArgs {
  title: string;
  instructions: string;
  deliverables: string;
  dueInHours: number;
  priority: "low" | "normal" | "high" | "urgent";
  /** A role to prefer among the people the Manager may assign work to (matched by name); otherwise the least loaded. */
  role: string | null;
  /** Agent steps (job ids) that must complete first; their deliverables become the task's references. */
  dependsOn: string[];
}

export interface ToolSignatures {
  "files.read": { args: { fileId: string }; result: ReadFile };
  "files.write": { args: { name: string; mime: string; bytes: Buffer; kind: string; supersedes?: string | null; pendingApproval?: boolean }; result: WrittenFile };
  "channel.post": { args: { kind: "ack" | "progress" | "result" | "approval" | "error"; body: string; fileIds?: string[]; approvalId?: string | null }; result: { posted: boolean; postId: string | null } };
  "media.probe": { args: { fileId: string }; result: MediaInfo };
  "media.render": {
    args: { plan: EditPlan; quality: "preview" | "final"; name: string; approvalId?: string | null; previewFileId?: string | null; supersedes?: string | null };
    result: WrittenFile & { durationSec: number; captions: "burned" | "track" | "none"; overlay: boolean };
  };
  "media.extract_audio": { args: { fileId: string }; result: { bytes: Buffer; mime: "audio/mpeg"; seconds: number } };
  "web.fetch": { args: { url: string }; result: { url: string; status: number; contentType: string; text: string; truncated: boolean } };
  "agents.delegate": { args: { installId: string; input: unknown; dependsOn: string[]; label: string }; result: { jobId: string } };
  "tasks.assign": { args: TaskAssignArgs; result: { taskId: string; assigneeName: string } };
  "social.publish": { args: ExternalArgs; result: never };
  "ads.manage": { args: ExternalArgs; result: never };
  "email.send": { args: ExternalArgs; result: never };
  "calendar.write": { args: ExternalArgs; result: never };
  "crm.write": { args: ExternalArgs; result: never };
  "support.reply_external": { args: ExternalArgs; result: never };
  "repository.write": { args: ExternalArgs; result: never };
  "website.update": { args: ExternalArgs; result: never };
  "deploy.production": { args: ExternalArgs; result: never };
  "payments.execute": { args: ExternalArgs; result: never };
}

/** An action in an outside service: what it would do, and the draft file it would use. */
export interface ExternalArgs {
  summary: string;
  draftFileId?: string | null;
  approvalId?: string | null;
}

export type ChatInput = { system?: string; prompt: string; images?: ChatImage[]; maxOutputTokens?: number };

/** What a skill sees of models: categories, never providers or keys. */
export interface SkillModels {
  text(category: Extract<RoutingCategory, "reasoning" | "fast">, req: ChatInput): Promise<string>;
  /** A JSON answer validated against [schema]; one repair attempt when it doesn't validate. */
  json<T>(category: Extract<RoutingCategory, "reasoning" | "fast" | "vision">, schema: z.ZodType<T>, req: ChatInput): Promise<T>;
  vision(req: ChatInput & { images: ChatImage[] }): Promise<string>;
  transcribe(audio: { bytes: Buffer; mime: string; name: string; seconds: number; language?: string }): Promise<{ text: string; segments: TranscriptSegment[]; timing: "provider" | "model" | "none" }>;
  image(prompt: string, size?: "1024x1024" | "1536x1024" | "1024x1536"): Promise<{ bytes: Buffer; mime: string }>;
  speech(text: string, voice?: string): Promise<{ bytes: Buffer; mime: string }>;
  embed(texts: string[]): Promise<number[][]>;
  /** Whether a category has a verified model for this community right now (for graceful degradation). */
  available(category: RoutingCategory): boolean;
}

export interface SkillContext {
  job: {
    id: string;
    orgId: string;
    rootJobId: string;
    depth: number;
    revision: number;
    requestedBy: string;
    conversationId: string | null;
    /** Instructions given with a revision request (the latest one). */
    revisionNote: string | null;
  };
  agent: { installId: string; agentId: string; displayName: string; roleTitle: string; language: string | null; style: string; instructions: string; mode: "review" | "auto" };
  /** The skill's own state from its previous phase (after an approval, an answer or delegated work). */
  checkpoint: unknown;
  /** The files the person submitted with this request (and, for delegated steps, the coordinator's). */
  inputs: FileRef[];
  /**
   * Channel messages the person's app decrypted and chose to share with the request (for delegated steps, the ones
   * shared with the coordinator's request), oldest first; null when none were shared or they've expired (7 days).
   */
  sharedMessages: readonly { author: string; text: string; at: number }[] | null;
  signal: AbortSignal;
  models: SkillModels;
  tool<K extends ToolKey>(key: K, args: ToolSignatures[K]["args"]): Promise<ToolSignatures[K]["result"]>;
  /** Asks a person with `ai.approve` to approve [action] for exactly this file version or payload. */
  requestApproval(a: { action: ToolKey | "deliver"; summary: string; fileId?: string | null; payload?: unknown }): string;
  /**
   * The community's other agents the person who asked may use (for the Agent Manager): active, not coordinators,
   * their required tools granted. Nothing about agents they can't use.
   */
  team(): { installId: string; agentId: string; name: string; roleTitle: string; description: string; capabilities: string[]; inputHint: string }[];
  /**
   * The skill library's answer for [needs]: which of the community's agents (not this one) can do each capability now
   * for the person who asked, and the exact blocker otherwise (skillLibrary.ts).
   */
  discover(needs: readonly CapabilityId[]): Promise<Discovered[]>;
  /**
   * Who the Agent Manager may give work to for this request: null when the person who asked can't assign work (they
   * need "Manage AI agents"); otherwise how many people are eligible and their roles' names (taskService.ts).
   */
  people(): { eligible: number; roles: string[] } | null;
  /** Tasks this job created: their state, assignee's name, the note and files they submitted (never anything else). */
  tasks(): { taskId: string; title: string; state: string; assignee: string; note: string | null; fileIds: string[] }[];
  /** Reads jobs this job delegated (the Agent Manager): their state and validated output, never anything else. */
  children(): { jobId: string; agentId: string; label: string; state: string; output: unknown; fileIds: string[]; error: string | null }[];
  progress(percent: number, note: string): void;
  event(kind: string, detail?: Record<string, unknown>): void;
}

export type SkillOutcome<O> =
  | { kind: "done"; output: O; summary: string; fileIds: string[] }
  | { kind: "await_approval"; approvalId: string; checkpoint: unknown; summary: string }
  | { kind: "await_input"; question: string; checkpoint: unknown }
  | { kind: "wait_children"; jobIds: string[]; checkpoint: unknown };

export interface SkillDef<I = unknown, O = unknown> {
  id: string;
  version: number;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /** Tools the skill may call; the installation grants a subset. */
  tools: readonly ToolKey[];
  /** Tools without which it can't do its job (the install must grant them). */
  requiredTools: readonly ToolKey[];
  /** Model categories it uses, and those it can't work without. */
  categories: readonly RoutingCategory[];
  requiredCategories: readonly RoutingCategory[];
  /** Files it takes: at least [min] (0: none needed), at most [max], of these types. */
  files: { min?: number; max: number; maxBytes: number; mimes: readonly string[] };
  limits: { maxRuntimeSec: number; maxModelCalls: number; maxAttempts: number; maxOutputFiles: number };
  /** In plain words: which actions need approval and when. */
  approvals: readonly string[];
  /** In plain words: what it does when something's missing or fails. */
  errors: readonly string[];
  /** The tests that cover it (test/ai_workforce_*.test.ts). */
  tests: readonly string[];
  run(ctx: SkillContext, input: I): Promise<SkillOutcome<O>>;
}

export interface AgentDef {
  /** Immutable id; the version changes with any change to the skill or its contract. */
  id: string;
  version: number;
  name: string;
  description: string;
  roleTitle: string;
  category: AgentCategory;
  /** What it can genuinely do with the services this server has. */
  capabilities: readonly string[];
  /** Outside services it would need for some actions; none is connected (§7). */
  integrations: readonly { tool: ToolKey; label: string }[];
  avatarColor: string;
  examples: readonly string[];
  /** For the Agent Manager: what to put in this agent's request besides the brief. */
  inputHint: string;
  skill: SkillDef;
  defaults: { executionMode: "review" | "auto"; maxJobsPerDay: number | null };
}

/**
 * A skill as the runtime holds it: the input is parsed against the skill's own schema before its code runs, and the
 * output is checked against its output schema before the job completes (runtime.ts), so neither is trusted.
 */
export function defineSkill<I, O>(def: SkillDef<I, O>): SkillDef {
  return {
    ...def,
    run: (ctx, input) => def.run(ctx, def.input.parse(input)),
  } as SkillDef;
}
