import { z } from "zod/v4";
import {
  AiAnswerBody,
  AiApprovalParams,
  AiChannelBody,
  AiChannelParams,
  AiConversationParams,
  AiDecisionBody,
  AiDeliverablesQuery,
  AiFileParams,
  AiInstallBody,
  AiInstallParams,
  AiInstallPatch,
  AiActiveHours,
  AiAutonomy,
  AiHookBody,
  AiHookParams,
  AiInvokers,
  AiJobBody,
  AiJobParams,
  AiJobsQuery,
  AiOrgParams,
  AiPostsQuery,
  AiReviseBody,
  AiDiscoverQuery,
  AiConversationReaderParams,
  AiInstallReaderParams,
  AiReadScopeBody,
  AiReaderChoiceBody,
  AiReaderOffBody,
  AiReaderOnBody,
  AiTaskActionBody,
  AiTaskBody,
  AiTaskParams,
  AiTaskPriority,
  AiTaskSettingsBody,
  AiTaskStateName,
  AiTasksQuery,
  AiTriggerBody,
  AiTriggerKind,
  AiTriggerParams,
  AiTriggerPatch,
  AiUploadQuery,
} from "./aiWorkforce.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";
import type { ErrorCode } from "../../errors.js";

/**
 * Answers of AI Workforce's community routes (docs/AI_WORKFORCE.md §11), as modules/workforce/views.ts and routes.ts
 * build them. Content (briefs, outputs, posts) is only in answers for people who may see it; shared channel messages
 * are never in any answer, only their count.
 */
const str = z.string();
const nstr = z.string().nullable();
const ntime = zTime.nullable();
const int = z.number().int();

const Activation = z.enum(["mention", "command", "explicit"]);
const ExecutionMode = z.enum(["review", "auto"]);
const JobState = z.enum(["queued", "planning", "running", "awaiting_input", "awaiting_approval", "completed", "failed", "cancelled"]);

export const AiPermissions = z.strictObject({ canUse: z.boolean(), canManage: z.boolean(), canApprove: z.boolean() });

export const AiInstallView = z.strictObject({
  id: str,
  agentId: str,
  version: int,
  state: z.enum(["active", "disabled", "uninstalled"]),
  displayName: str,
  avatar: z.strictObject({ sha256: str }).nullable(),
  avatarColor: nstr,
  description: str,
  roleTitle: str,
  language: nstr,
  style: str,
  instructions: str,
  tools: z.array(str),
  executionMode: ExecutionMode,
  effectiveMode: ExecutionMode,
  maxJobsPerDay: int.nullable(),
  maxConcurrent: int.nullable(),
  invokers: AiInvokers,
  autonomy: AiAutonomy,
  maxRuntimeSec: int.nullable(),
  maxAttempts: int.nullable(),
  activeHours: AiActiveHours.nullable(),
  rev: int,
  skill: z.strictObject({ id: str, version: int, name: str, category: str }).nullable(),
  badge: z.literal("AI"),
  createdAt: zTime,
  updatedAt: zTime,
});

/** A catalog entry as clients show it (service.agentSummary). */
export const AiAgentDefinition = z.strictObject({
  id: str,
  version: int,
  name: str,
  description: str,
  roleTitle: str,
  category: str,
  capabilities: z.array(str),
  examples: z.array(str),
  avatarColor: str,
  skill: z.strictObject({
    id: str,
    version: int,
    tools: z.array(str),
    requiredTools: z.array(str),
    modelCategories: z.array(str),
    requiredModelCategories: z.array(str),
    files: z.strictObject({ min: zCount, max: zCount, maxBytes: zCount, types: z.array(str) }),
    readsMessages: z.boolean(),
    limits: z.record(str, z.number()),
    approvals: z.array(str),
    errors: z.array(str),
    /** The skill's input as JSON Schema (null when it can't be expressed). */
    inputSchema: z.unknown(),
  }),
  integrations: z.array(z.strictObject({ tool: str, label: str, connected: z.boolean() })),
  defaults: z.strictObject({ executionMode: ExecutionMode, maxJobsPerDay: int.nullable() }),
});

const AiSetup = z.strictObject({ ready: z.boolean(), missing: z.array(str), unavailableActions: z.array(str) });
const AiAssignment = z.strictObject({ installId: str, conversationId: str, activation: Activation, addedBy: str, addedAt: zTime });

export const AiFileView = z.strictObject({
  id: str,
  role: z.enum(["input", "artifact", "avatar"]),
  jobId: nstr,
  installId: nstr,
  agentId: nstr,
  skillVersion: int.nullable(),
  kind: nstr,
  name: str,
  mime: str,
  size: zCount,
  sha256: str,
  version: int,
  supersedes: nstr,
  approvalState: z.enum(["not_required", "pending", "approved", "rejected", "superseded"]),
  createdAt: zTime,
  expiresAt: zTime,
});

export const AiApprovalView = z.strictObject({
  id: str,
  jobId: str,
  action: str,
  fileId: nstr,
  fileSha256: nstr,
  summary: str,
  state: z.enum(["pending", "approved", "rejected", "invalidated"]),
  requestedAt: zTime,
  decidedBy: nstr,
  decidedAt: ntime,
  note: nstr,
});

export const AiJobSummary = z.strictObject({
  id: str,
  agent: z.strictObject({ installId: str, agentId: str, version: int, displayName: str, badge: z.literal("AI") }),
  skillId: str,
  state: JobState,
  progress: z.number(),
  note: nstr,
  requestedBy: str,
  conversationId: nstr,
  parentJobId: nstr,
  rootJobId: str,
  depth: zCount,
  revision: zCount,
  attempts: zCount,
  maxAttempts: zCount,
  error: z.strictObject({ code: str, message: str }).nullable(),
  createdAt: zTime,
  startedAt: ntime,
  finishedAt: ntime,
  updatedAt: zTime,
});

export const AiJobDetail = AiJobSummary.extend({
  input: z.unknown(),
  output: z.unknown(),
  files: z.array(AiFileView),
  /** How many channel messages were shared with the request; the messages themselves are never returned. */
  sharedMessages: zCount,
  approvals: z.array(AiApprovalView),
  steps: z.array(AiJobSummary),
  events: z.array(z.strictObject({ at: zTime, kind: str, detail: z.unknown() })),
});

export const AiPostView = z.strictObject({
  id: str,
  conversationId: str,
  threadRoot: nstr,
  kind: z.enum(["request", "ack", "progress", "result", "approval", "error"]),
  body: str,
  jobId: nstr,
  approvalId: nstr,
  authorId: nstr,
  agent: z.strictObject({ installId: str, displayName: str, avatarColor: nstr, hasAvatar: z.boolean(), skill: nstr, badge: z.literal("AI") }),
  files: z.array(AiFileView),
  /** Agent posts are stored on the server: never end-to-end encrypted, and clients say so. */
  encrypted: z.literal(false),
  createdAt: zTime,
});

/** One check of an agent's readiness: "ok" only when a job would pass it; who can fix a missing one. */
export const AiReadiness = z.strictObject({
  ready: z.boolean(),
  checks: z.array(z.strictObject({ key: str, label: str, status: z.enum(["ok", "missing", "advice"]), detail: str, fixBy: z.enum(["operator", "community"]).nullable() })),
});

/** A capability's availability in a community (skill library, docs/AI_WORKFORCE_2_PLAN.md phase 1). */
export const AiDiscovered = z.strictObject({
  capability: str,
  label: str,
  status: z.enum(["ready", "blocked", "not_installed", "unavailable"]),
  providers: z.array(z.strictObject({ installId: str, agentId: str, name: str, ready: z.boolean(), blockers: z.array(str) })),
  installable: z.array(z.strictObject({ agentId: str, name: str })),
});

/** A skill of the platform's library: what it provides, takes and gives (JSON Schema), its tools, models and limits. */
export const AiSkillCard = z.strictObject({
  id: str,
  version: zCount,
  source: z.literal("platform"),
  agents: z.array(z.strictObject({ id: str, name: str })),
  provides: z.array(z.strictObject({ id: str, label: str })),
  input: z.unknown(),
  output: z.unknown(),
  tools: z.array(z.strictObject({ key: str, label: str, risk: str, required: z.boolean() })),
  models: z.array(z.strictObject({ category: str, label: str, required: z.boolean() })),
  files: z.strictObject({ min: zCount.optional(), max: zCount, maxBytes: zCount, mimes: z.array(str) }),
  limits: z.strictObject({ maxRuntimeSec: zCount, maxModelCalls: zCount, maxAttempts: zCount, maxOutputFiles: zCount }),
  approvals: z.array(str),
  errors: z.array(str),
  tests: z.array(str),
});

const Person = z.strictObject({ id: str, name: str });
const TaskActions = z.strictObject({
  accept: z.boolean(),
  start: z.boolean(),
  block: z.boolean(),
  submit: z.boolean(),
  approve: z.boolean(),
  return: z.boolean(),
  cancel: z.boolean(),
  reassign: z.boolean(),
});

/** A human task in a list. */
export const AiTaskSummary = z.strictObject({
  id: str,
  title: str,
  state: AiTaskStateName,
  priority: AiTaskPriority,
  /** Due and not handed in. */
  overdue: z.boolean(),
  dueAt: ntime,
  assignee: Person,
  createdBy: Person,
  /** The agent that created it (the Agent Manager), or null when a person did. */
  agent: z.strictObject({ installId: str, name: str }).nullable(),
  jobId: nstr,
  updatedAt: zTime,
});

/** A human task: what to do, its state and history fields, what was handed in, and what the viewer may do. */
export const AiTaskView = AiTaskSummary.extend({
  instructions: str,
  deliverables: str,
  conversationId: nstr,
  blockedReason: nstr,
  submissionNote: nstr,
  returnReason: nstr,
  returns: zCount,
  reminders: zCount,
  escalatedAt: ntime,
  cancelReason: nstr,
  rev: zCount,
  createdAt: zTime,
  openedAt: ntime,
  acceptedAt: ntime,
  submittedAt: ntime,
  doneAt: ntime,
  doneBy: Person.nullable(),
  /** What the assignee handed in. */
  files: z.array(AiFileView),
  /** Agents' deliverables it was given to work from. */
  references: z.array(AiFileView),
  can: TaskActions,
});

export const AiTaskEvent = z.strictObject({ at: zTime, actor: Person.nullable(), kind: str, detail: z.record(str, z.unknown()) });

/** The workforce report: tasks by state, overdue, and active work per person (for people who manage agents). */
export const AiTaskReport = z.strictObject({
  byState: z.record(str, zCount),
  overdue: zCount,
  byAssignee: z.array(z.strictObject({ person: Person, active: zCount, overdue: zCount })),
});

export const AiTaskSettings = z.strictObject({
  roles: z.array(str),
  users: z.array(str),
  updatedAt: ntime,
  /** Who that makes eligible now, with the named roles each holds. */
  eligible: z.array(z.strictObject({ id: str, name: str, roles: z.array(str) })),
});

/** An agent reading a conversation: who switched it on, why and when (never what it read). */
export const AiReaderView = z.strictObject({
  readerId: str,
  installId: str,
  /** The agent's bot identity (it appears as this user in key lists, with only its device here). */
  agentUserId: str,
  name: str,
  conversationId: str,
  conversationName: nstr,
  mode: z.enum(["channel", "direct"]),
  state: z.enum(["on", "off"]),
  since: zTime,
  turnedOnBy: Person,
  reason: str,
});
export const AiConversationReaders = z.strictObject({
  /** Whether the platform lets agents read at all right now. */
  readingEnabled: z.boolean(),
  /** Readers on here, with the person's own choice for each (null: not chosen yet; their app pauses sending until they do). */
  readers: z.array(AiReaderView.extend({ myChoice: z.enum(["share", "keep"]).nullable() })),
});

export const AiTriggerView = z.strictObject({
  id: str,
  installId: str,
  kind: AiTriggerKind,
  enabled: z.boolean(),
  label: str,
  brief: str,
  conversationId: nstr,
  config: z.unknown(),
  sourceInstallId: nstr,
  runAs: str,
  nextRunAt: ntime,
  lastFiredAt: ntime,
  lastJobId: nstr,
  lastError: nstr,
  failures: zCount,
  rev: int,
  createdAt: zTime,
  updatedAt: zTime,
});

/** Counts from job records, never content. Null averageMs: nothing finished this week (not zero). */
export const AiActivity = z.strictObject({
  now: z.strictObject({ running: zCount, queued: zCount, waiting: zCount }),
  week: z.strictObject({ completed: zCount, failed: zCount, cancelled: zCount, averageMs: zCount.nullable(), retries: zCount }),
  lastSuccessAt: ntime,
  lastFailure: z.strictObject({ at: zTime, code: nstr, message: str }).nullable(),
  nextRunAt: ntime,
  triggers: z.array(AiTriggerView),
});

const Agent = z.strictObject({ agent: AiInstallView });
const Job = z.strictObject({ job: AiJobSummary });
const Channels = z.strictObject({ channels: z.array(AiAssignment) });

const tag = "ai-workforce";
const COMMON: readonly ErrorCode[] = ["not_found", "forbidden", "ai_workforce_disabled"];
const errs = (...codes: ErrorCode[]): readonly ErrorCode[] => [...COMMON, ...codes];

const TASK_ACTION_SUMMARY = {
  accept: "The assignee takes the task on.",
  start: "The assignee starts (or resumes) work.",
  block: "The assignee can't go on; reason required.",
  submit: "The assignee hands in a note and/or files (uploaded first) for review.",
  approve: "A reviewer (the creator or Manage AI agents; never the assignee) accepts what was handed in: the task is done.",
  return: "A reviewer sends the work back with what needs changing.",
  cancel: "The creator or Manage AI agents withdraws the task.",
  reassign: "The creator or Manage AI agents gives the task to someone else.",
} as const;

const jobAction = (action: "cancel" | "retry" | "revise" | "answer", summary: string, body?: z.ZodType) =>
  route({ method: "POST", url: `/v1/orgs/:orgId/ai/jobs/:jobId/${action}`, tag, summary, auth: true, params: AiJobParams, body, response: Job, errors: errs("conflict", "job_not_retryable", "quota_exceeded", "ai_paused", "ai_not_configured") });

export const aiWorkforceRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/ai",
    tag,
    summary: "AI agents in a community: whether they're on, the person's permissions, the installed agents and the notice.",
    auth: true,
    params: AiOrgParams,
    response: z.strictObject({
      enabled: z.boolean(),
      paused: z.boolean(),
      aiRequestsOn: z.boolean(),
      approvalFloor: str,
      mediaEngine: z.strictObject({ available: z.boolean(), detail: str }),
      permissions: AiPermissions,
      agents: z.array(AiInstallView),
      notice: str,
    }),
    errors: errs(),
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/ai/catalog",
    tag,
    summary: "The agents the platform published, with what each needs to work here and whether it's installed.",
    auth: true,
    params: AiOrgParams,
    response: z.strictObject({
      agents: z.array(
        z.strictObject({
          agent: AiAgentDefinition,
          available: z.boolean(),
          unavailableReason: nstr,
          setup: AiSetup,
          installed: z.strictObject({ installId: str, state: z.enum(["active", "disabled", "uninstalled"]), version: int, upgradeAvailable: z.boolean() }).nullable(),
        }),
      ),
    }),
    errors: errs(),
  }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/agents", tag, summary: "Install an agent (ai.manage).", auth: true, params: AiOrgParams, body: AiInstallBody, response: Agent, status: 201, errors: errs("agent_unavailable", "name_not_allowed", "conflict") }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/ai/agents/:installId",
    tag,
    summary: "One installed agent: its settings, definition, setup, channels and grantable tools.",
    auth: true,
    params: AiInstallParams,
    response: z.strictObject({
      agent: AiInstallView,
      definition: AiAgentDefinition.nullable(),
      upgrade: z.strictObject({ version: int }).nullable(),
      setup: AiSetup.nullable(),
      channels: z.array(AiAssignment),
      tools: z.array(z.strictObject({ key: str, label: str, description: str, risk: str, platformMode: str, granted: z.boolean(), required: z.boolean(), connected: z.boolean() })),
      permissions: AiPermissions,
    }),
    errors: errs(),
  }),
  route({ method: "PATCH", url: "/v1/orgs/:orgId/ai/agents/:installId", tag, summary: "Change an agent's settings, tools, limits or version (ai.manage).", auth: true, params: AiInstallParams, body: AiInstallPatch, response: Agent, errors: errs("name_not_allowed", "conflict", "agent_unavailable", "tool_not_allowed", "invalid_policy") }),
  route({ method: "PUT", url: "/v1/orgs/:orgId/ai/agents/:installId/avatar", tag, summary: "Set an agent's avatar (PNG, JPEG or WebP, at most 512 KB; ai.manage).", auth: true, params: AiInstallParams, binary: "request", response: Agent, errors: errs("too_large") }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/agents/:installId/avatar", tag, summary: "An agent's avatar image.", auth: true, params: AiInstallParams, binary: "response", response: z.unknown(), errors: errs() }),
  route({ method: "DELETE", url: "/v1/orgs/:orgId/ai/agents/:installId", tag, summary: "Uninstall an agent: its jobs are cancelled and its channels removed (ai.manage).", auth: true, params: AiInstallParams, response: z.strictObject({ removed: z.literal(true) }), errors: errs() }),
  route({ method: "PUT", url: "/v1/orgs/:orgId/ai/agents/:installId/channels/:conversationId", tag, summary: "Assign an agent to a channel, or change how it's asked there (ai.manage).", auth: true, params: AiChannelParams, body: AiChannelBody, response: Channels, errors: errs("agent_not_assigned") }),
  route({ method: "DELETE", url: "/v1/orgs/:orgId/ai/agents/:installId/channels/:conversationId", tag, summary: "Remove an agent from a channel (ai.manage).", auth: true, params: AiChannelParams, response: Channels, errors: errs() }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/files", tag, summary: "Upload a file for a request (raw bytes; not end-to-end encrypted).", auth: true, params: AiOrgParams, query: AiUploadQuery, binary: "request", response: z.strictObject({ file: AiFileView }), status: 201, errors: errs("agent_not_assigned", "too_large", "quota_exceeded") }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/ai/jobs",
    tag,
    summary: "Ask an agent for work, optionally from a channel with files and the channel's recent messages the person chose to share.",
    auth: true,
    params: AiOrgParams,
    body: AiJobBody,
    response: z.strictObject({ job: AiJobDetail }),
    status: 202,
    errors: errs("agent_unavailable", "agent_not_assigned", "quota_exceeded", "too_large", "ai_paused", "ai_disabled", "ai_not_configured"),
  }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/jobs", tag, summary: "Requests: the person's own, or all they may see (root jobs, newest first).", auth: true, params: AiOrgParams, query: AiJobsQuery, response: z.strictObject({ jobs: z.array(AiJobSummary), next: ntime }), errors: errs() }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/jobs/:jobId", tag, summary: "One request with its input, output, files, approvals, steps and events.", auth: true, params: AiJobParams, response: z.strictObject({ job: AiJobDetail }), errors: errs() }),
  jobAction("cancel", "Cancel a request (the requester or ai.manage)."),
  jobAction("retry", "Retry a failed or cancelled request; admitted like a new one."),
  jobAction("revise", "Ask for a revision of a finished request, with a note.", AiReviseBody),
  jobAction("answer", "Answer the question an agent asked.", AiAnswerBody),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/approvals", tag, summary: "Pending approvals of requests the person can see.", auth: true, params: AiOrgParams, response: z.strictObject({ approvals: z.array(AiApprovalView) }), errors: errs() }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/approvals/:approvalId", tag, summary: "Approve or reject what an agent asked permission for (ai.approve, or the requester when allowed).", auth: true, params: AiApprovalParams, body: AiDecisionBody, response: Job, errors: errs("approval_stale", "conflict") }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/deliverables", tag, summary: "Files agents made in requests the person can see, newest first.", auth: true, params: AiOrgParams, query: AiDeliverablesQuery, response: z.strictObject({ files: z.array(AiFileView), next: ntime }), errors: errs() }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/files/:fileId", tag, summary: "Download a file of a request (ranges allowed).", auth: true, params: AiFileParams, binary: "response", response: z.unknown(), errors: errs("quota_exceeded") }),
  route({
    method: "GET",
    url: "/v1/conversations/:id/ai/agents",
    tag,
    summary: "The agents assigned to a channel, how each is asked there, and whether the person may ask them.",
    auth: true,
    params: AiConversationParams,
    response: z.strictObject({ agents: z.array(AiInstallView.extend({ activation: Activation, canInvoke: z.boolean() })), permissions: AiPermissions }),
    errors: errs(),
  }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/tasks", tag, summary: "Tasks for people: assigned to the person (mine), created by them, or all (Manage AI agents, with the workforce report).", auth: true, params: AiOrgParams, query: AiTasksQuery, response: z.strictObject({ tasks: z.array(AiTaskSummary), next: ntime, report: AiTaskReport.nullable() }), errors: errs() }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/tasks", tag, summary: "Give someone a task (Manage AI agents). Stored on the server, not end-to-end encrypted.", auth: true, params: AiOrgParams, body: AiTaskBody, response: z.strictObject({ task: AiTaskView }), status: 201, errors: errs("bad_request") }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/tasks/settings", tag, summary: "Who the Agent Manager may give work to (Manage AI agents).", auth: true, params: AiOrgParams, response: z.strictObject({ settings: AiTaskSettings }), errors: errs() }),
  route({ method: "PUT", url: "/v1/orgs/:orgId/ai/tasks/settings", tag, summary: "Set who the Agent Manager may give work to: roles and people (Manage AI agents).", auth: true, params: AiOrgParams, body: AiTaskSettingsBody, response: z.strictObject({ settings: AiTaskSettings }), errors: errs("bad_request") }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/tasks/:taskId", tag, summary: "One task with its history, what was handed in and what the person may do.", auth: true, params: AiTaskParams, response: z.strictObject({ task: AiTaskView, events: z.array(AiTaskEvent) }), errors: errs() }),
  ...(["accept", "start", "block", "submit", "approve", "return", "cancel", "reassign"] as const).map((action) =>
    route({ method: "POST", url: `/v1/orgs/:orgId/ai/tasks/:taskId/${action}`, tag, summary: TASK_ACTION_SUMMARY[action], auth: true, params: AiTaskParams, body: AiTaskActionBody, response: z.strictObject({ task: AiTaskView }), errors: errs("conflict", "bad_request") }),
  ),
  route({ method: "GET", url: "/v1/conversations/:id/ai/readers", tag, summary: "Agents reading this conversation, and the person's own choice for each.", auth: true, params: AiConversationParams, response: AiConversationReaders, errors: errs() }),
  route({ method: "PUT", url: "/v1/conversations/:id/ai/readers/:readerId/choice", tag, summary: "Share your messages with a reader here, or keep them out (your apps then wrap, or don't).", auth: true, params: AiConversationReaderParams, body: AiReaderChoiceBody, response: AiConversationReaders, errors: errs() }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/agents/:installId/readers", tag, summary: "Where an agent reads (Manage AI agents).", auth: true, params: AiInstallParams, response: z.strictObject({ readingEnabled: z.boolean(), readers: z.array(AiReaderView) }), errors: errs() }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/agents/:installId/readers", tag, summary: "Let an agent read a channel from now on (Manage AI agents and managing that channel; members are told and choose).", auth: true, params: AiInstallParams, body: AiReaderOnBody, response: z.strictObject({ reader: AiReaderView }), status: 201, errors: errs("ai_reading_not_allowed", "agent_unavailable") }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/agents/:installId/read-scope", tag, summary: "Let an agent read its assigned channels, or every open channel of the community (each channel is told).", auth: true, params: AiInstallParams, body: AiReadScopeBody, response: z.strictObject({ readers: z.array(AiReaderView) }), errors: errs("ai_reading_not_allowed", "agent_unavailable") }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/agents/:installId/readers/:readerId/off", tag, summary: "Stop an agent reading a conversation: its key is deleted and what it kept is erased.", auth: true, params: AiInstallReaderParams, body: AiReaderOffBody, response: z.strictObject({ reader: AiReaderView }), errors: errs() }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/agents/:installId/direct", tag, summary: "The person's direct conversation with an agent (created on first use; what they write there is read by it).", auth: true, params: AiInstallParams, response: z.strictObject({ conversationId: str, reader: AiReaderView }), errors: errs("ai_reading_not_allowed", "agent_not_assigned") }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/skills", tag, summary: "The skill library, and which capabilities this community's agents can do now (with the exact blocker otherwise).", auth: true, params: AiOrgParams, response: z.strictObject({ skills: z.array(AiSkillCard), capabilities: z.array(AiDiscovered) }), errors: errs() }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/skills/discover", tag, summary: "For the capabilities named (comma-separated ids), which agents here can do each now, or what's missing.", auth: true, params: AiOrgParams, query: AiDiscoverQuery, response: z.strictObject({ capabilities: z.array(AiDiscovered) }), errors: errs("bad_request") }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/agents/:installId/readiness", tag, summary: "Whether an agent can work now: each check, what's missing and who can fix it.", auth: true, params: AiInstallParams, response: z.strictObject({ readiness: AiReadiness }), errors: errs() }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/agents/:installId/activity", tag, summary: "What an agent did lately and what's next (counts only).", auth: true, params: AiInstallParams, response: z.strictObject({ activity: AiActivity }), errors: errs() }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/agents/:installId/test", tag, summary: "Test an agent with a real short request through the normal path (ai.manage).", auth: true, params: AiInstallParams, response: z.strictObject({ job: AiJobDetail }), status: 202, errors: errs("agent_unavailable", "quota_exceeded", "ai_paused", "ai_disabled", "ai_not_configured") }),
  route({ method: "GET", url: "/v1/orgs/:orgId/ai/agents/:installId/triggers", tag, summary: "An agent's triggers (ai.manage).", auth: true, params: AiInstallParams, response: z.strictObject({ triggers: z.array(AiTriggerView) }), errors: errs() }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/ai/agents/:installId/triggers",
    tag,
    summary: "Add a trigger: a schedule, a webhook (its secret is returned once) or a handoff from another agent (ai.manage).",
    auth: true,
    params: AiInstallParams,
    body: AiTriggerBody,
    response: z.strictObject({ trigger: AiTriggerView, secret: nstr, hookUrl: nstr }),
    status: 201,
    errors: errs("agent_not_assigned", "conflict"),
  }),
  route({ method: "PATCH", url: "/v1/orgs/:orgId/ai/agents/:installId/triggers/:triggerId", tag, summary: "Change or switch a trigger on or off (ai.manage).", auth: true, params: AiTriggerParams, body: AiTriggerPatch, response: z.strictObject({ trigger: AiTriggerView }), errors: errs("agent_not_assigned", "conflict") }),
  route({ method: "DELETE", url: "/v1/orgs/:orgId/ai/agents/:installId/triggers/:triggerId", tag, summary: "Remove a trigger (ai.manage).", auth: true, params: AiTriggerParams, response: z.strictObject({ removed: z.literal(true) }), errors: errs() }),
  route({ method: "POST", url: "/v1/orgs/:orgId/ai/agents/:installId/triggers/:triggerId/run", tag, summary: "Run a trigger's request now, as the admin asking (ai.manage).", auth: true, params: AiTriggerParams, response: z.strictObject({ job: AiJobDetail }), status: 202, errors: errs("agent_unavailable", "quota_exceeded") }),
  route({
    method: "POST",
    url: "/v1/ai/hooks/:triggerId",
    tag,
    summary: "An outside system starts a webhook trigger (Authorization: Bearer <its secret>; optional Idempotency-Key).",
    auth: false,
    params: AiHookParams,
    body: AiHookBody,
    response: z.strictObject({ jobId: nstr, started: z.boolean(), detail: str }),
    status: 202,
    errors: ["not_found"],
  }),
  route({ method: "GET", url: "/v1/conversations/:id/ai/posts", tag, summary: "What agents posted in a channel (not end-to-end encrypted).", auth: true, params: AiConversationParams, query: AiPostsQuery, response: z.strictObject({ posts: z.array(AiPostView) }), errors: errs() }),
];
