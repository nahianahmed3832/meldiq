import { z } from "zod/v4";

/**
 * AI Workforce for communities (docs/AI_WORKFORCE.md): request shapes of /v1/orgs/:orgId/ai/* and
 * /v1/conversations/:id/ai/*. The routes validate with these; skill inputs are validated again by each skill's own
 * schema. Content sent here is not end-to-end encrypted, and the apps say so before sending it.
 */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const AiOrgParams = z.strictObject({ orgId: id });
export const AiInstallParams = z.strictObject({ orgId: id, installId: id });
// ───────────── Human tasks (migration 052; docs/AI_WORKFORCE_2_PLAN.md, phase 4) ─────────────

export const AiTaskParams = z.strictObject({ orgId: id, taskId: id });
export const AiTaskPriority = z.enum(["low", "normal", "high", "urgent"]);
export const AiTaskStateName = z.enum(["waiting", "open", "accepted", "in_progress", "blocked", "submitted", "done", "cancelled"]);
/** A task a person with "Manage AI agents" gives someone. */
export const AiTaskBody = z.strictObject({
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(4000),
  deliverables: z.string().trim().max(1000).default(""),
  assigneeId: id,
  dueAt: z.number().int().positive().nullable().default(null),
  priority: AiTaskPriority.default("normal"),
  conversationId: id.nullable().default(null),
});
/** Any change to a task: the rev it was read at, and what that change needs (a reason, a note, files, a person). */
export const AiTaskActionBody = z.strictObject({
  rev: z.number().int().nonnegative(),
  reason: z.string().max(1000).optional(),
  note: z.string().max(4000).optional(),
  fileIds: z.array(id).max(20).optional(),
  assigneeId: id.optional(),
});
export const AiTasksQuery = z.strictObject({
  scope: z.enum(["mine", "created", "all"]).default("mine"),
  state: AiTaskStateName.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
/** Who the Agent Manager may give work to: members of these roles, and these people. */
export const AiTaskSettingsBody = z.strictObject({ roles: z.array(id).max(50), users: z.array(id).max(200) });

// ───────────── Agents reading conversations (docs/AI_WORKFORCE_2_PLAN.md phase 5) ─────────────

export const AiConversationReaderParams = z.strictObject({ id, readerId: id });
export const AiInstallReaderParams = z.strictObject({ orgId: id, installId: id, readerId: id });
export const AiReaderChoiceBody = z.strictObject({ choice: z.enum(["share", "keep"]) });
const zReaderReason = z.string().trim().min(8, "Say why, in a few words (at least 8 characters)").max(500);
/** Let the agent read one channel, from now on. */
export const AiReaderOnBody = z.strictObject({ conversationId: id, reason: zReaderReason });
/** Readers in every channel a scope covers: the agent's assigned channels, or every open channel of the community. */
export const AiReadScopeBody = z.strictObject({ scope: z.enum(["assigned", "all"]), reason: zReaderReason });
export const AiReaderOffBody = z.strictObject({ reason: zReaderReason });

/** Capability ids, comma-separated (skill library ids like "video.edit,social.publish"). */
export const AiDiscoverQuery = z.strictObject({ capabilities: z.string().trim().min(1).max(600) });
export const AiChannelParams = z.strictObject({ orgId: id, installId: id, conversationId: id });
export const AiJobParams = z.strictObject({ orgId: id, jobId: id });
export const AiApprovalParams = z.strictObject({ orgId: id, approvalId: id });
export const AiFileParams = z.strictObject({ orgId: id, fileId: id });
export const AiConversationParams = z.strictObject({ id });

export const AiInstallBody = z.strictObject({
  agentId: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  displayName: z.string().max(60).optional(),
  description: z.string().max(500).optional(),
  roleTitle: z.string().max(60).optional(),
});

export const AiInvokers = z.strictObject({ everyone: z.boolean(), roles: z.array(id).max(50) });

/** How much an agent does on its own (docs/AI_WORKFORCE.md §5b); the server enforces each level. */
export const AiAutonomy = z.enum(["manual", "assisted", "guarded", "continuous"]);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** When an agent's triggers may start work, in a time zone (a window across midnight works too). */
export const AiActiveHours = z.strictObject({ from: hhmm, to: hhmm, timeZone: z.string().min(1).max(64) });

export const AiInstallPatch = z.strictObject({
  rev: z.number().int().nonnegative(),
  state: z.enum(["active", "disabled"]).optional(),
  displayName: z.string().max(60).optional(),
  description: z.string().max(500).optional(),
  roleTitle: z.string().max(60).optional(),
  avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  language: z.string().max(10).nullable().optional(),
  style: z.enum(["balanced", "concise", "detailed", "friendly", "formal"]).optional(),
  instructions: z.string().max(2000).optional(),
  tools: z.array(z.string().max(40)).max(30).optional(),
  executionMode: z.enum(["review", "auto"]).optional(),
  maxJobsPerDay: z.number().int().min(0).max(10_000).nullable().optional(),
  maxConcurrent: z.number().int().min(1).max(16).nullable().optional(),
  invokers: AiInvokers.optional(),
  upgradeTo: z.number().int().positive().optional(),
  autonomy: AiAutonomy.optional(),
  /** Within the skill's own limits (null: the skill's). */
  maxRuntimeSec: z.number().int().min(10).max(3600).nullable().optional(),
  maxAttempts: z.number().int().min(1).max(5).nullable().optional(),
  activeHours: AiActiveHours.nullable().optional(),
});

export const AiTriggerParams = z.strictObject({ orgId: id, installId: id, triggerId: id });
export const AiTriggerKind = z.enum(["schedule", "webhook", "after_agent"]);
/**
 * A trigger: work the agent starts with nobody present, as the person who sets it up. schedule config:
 * {every: "hour"|"day"|"week", at: "HH:MM", weekday: 0–6, timeZone}; after_agent: sourceInstallId (another agent of
 * the community whose finished requests are handed on); webhook: none (the secret is returned once).
 */
export const AiTriggerBody = z.strictObject({
  kind: AiTriggerKind,
  label: z.string().trim().min(1).max(80),
  brief: z.string().trim().min(1).max(4000),
  conversationId: id.nullable().default(null),
  config: z.record(z.string(), z.unknown()).default({}),
  sourceInstallId: id.nullable().default(null),
});
export const AiTriggerPatch = z.strictObject({
  rev: z.number().int().positive(),
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).max(80).optional(),
  brief: z.string().trim().min(1).max(4000).optional(),
  conversationId: id.nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export const AiHookParams = z.strictObject({ triggerId: id });
/** What an outside system POSTs to a webhook trigger: text added to the trigger's request as untrusted material. */
export const AiHookBody = z.object({ text: z.string().max(8000).default("") });

export const AiChannelBody = z.strictObject({ activation: z.enum(["mention", "command", "explicit"]).default("mention") });

export const AiUploadQuery = z.strictObject({ name: z.string().min(1).max(200), type: z.string().min(3).max(100) });

/** Limits on channel messages shared with a request (the web and Android apps pick within the same limits). */
export const AI_SHARED_MAX = 150;
export const AI_SHARED_CHARS = 30_000;
export const AI_SHARED_MESSAGE_CHARS = 2_000;

/** One channel message the person's app decrypted and chose to share: who wrote it (display name), its text, when. */
export const AiSharedMessage = z.strictObject({
  author: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(AI_SHARED_MESSAGE_CHARS),
  at: z.number().int().positive(),
});
export const AiSharedMessages = z
  .array(AiSharedMessage)
  .min(1)
  .max(AI_SHARED_MAX)
  .refine((ms) => ms.reduce((n, m) => n + m.author.length + m.text.length + 2, 0) <= AI_SHARED_CHARS, `At most ${AI_SHARED_CHARS} characters of messages.`);

export const AiJobBody = z.strictObject({
  installId: id,
  input: z.record(z.string(), z.unknown()),
  conversationId: id.nullable().default(null),
  threadRoot: z.string().max(100).nullable().default(null),
  fileIds: z.array(id).max(20).default([]),
  idempotencyKey: z.string().min(8).max(100).nullable().default(null),
  /** What the channel shows as the request (the brief as the person wrote it). */
  requestText: z.string().max(8000).nullable().default(null),
  /**
   * Recent messages of [conversationId], decrypted and picked in the person's app after a notice that they leave
   * end-to-end encryption. Only with a channel request, and only for agents that read text.
   */
  channelMessages: AiSharedMessages.nullable().default(null),
});

export const AiJobsQuery = z.strictObject({
  scope: z.enum(["mine", "all"]).default("mine"),
  state: z.enum(["queued", "planning", "running", "awaiting_input", "awaiting_approval", "completed", "failed", "cancelled"]).optional(),
  installId: id.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const AiReviseBody = z.strictObject({ note: z.string().trim().min(1).max(2000) });
export const AiAnswerBody = z.strictObject({ text: z.string().trim().min(1).max(4000) });
export const AiDecisionBody = z.strictObject({ decision: z.enum(["approved", "rejected"]), note: z.string().max(1000).nullable().default(null) });
export const AiPostsQuery = z.strictObject({ since: z.coerce.number().int().nonnegative().optional(), before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const AiDeliverablesQuery = z.strictObject({ installId: id.optional(), before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
