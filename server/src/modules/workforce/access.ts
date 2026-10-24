import type { TaskService } from "./taskService.js";
import type { TaskStore } from "./taskStore.js";
import type { AppContext } from "../../app/context.js";
import { ApiError } from "../../shared/errors.js";
import type { AiFiles } from "./files.js";
import type { Approvals } from "./approvals.js";
import type { JobStore } from "./jobs.js";
import type { AgentPosts } from "./posts.js";
import type { SharedMessageStore } from "./sharedMessages.js";
import type { TriggerStore } from "./triggers.js";
import type { Install, TemplatePolicy, WorkforceStore } from "./store.js";
import { TOOL_INFO } from "./toolInfo.js";
import type { ToolKey } from "./types.js";

/** The platform settings AI Workforce obeys at run time (docs/AI_WORKFORCE.md §9), read fresh each time. */
export interface WorkforceSettings {
  enabled(): boolean;
  paused(): boolean;
  maxConcurrency(): number;
  approvalFloor(): "standard" | "strict";
}

export interface Deps {
  ctx: AppContext;
  store: WorkforceStore;
  jobs: JobStore;
  files: AiFiles;
  approvals: Approvals;
  posts: AgentPosts;
  shared: SharedMessageStore;
  triggers: TriggerStore;
  /** Human tasks (taskStore.ts) and their rules (taskService.ts). */
  tasks: TaskStore;
  taskService: TaskService;
  settings: WorkforceSettings;
  clock: () => number;
}

/** Whether [userId] may use AI agents in [orgId] at all right now: a member, not banned or timed out, holding `ai.use`. */
export function useRefusal(ctx: AppContext, orgId: string, userId: string): string | null {
  const role = ctx.authz.orgRole(orgId, userId);
  if (!role) return "You're not a member of this community.";
  if (ctx.authz.isBanned(orgId, userId)) return "You're banned from this community.";
  if (role !== "OWNER" && ctx.authz.timeoutUntil(orgId, userId) !== null) return "You're timed out in this community.";
  if (!ctx.authz.can(orgId, userId, "ai.use")) return "Your roles don't allow asking AI agents in this community.";
  return null;
}

/**
 * Whether [userId] may ask [install] for work right now: useRefusal's checks and, when the installation names roles,
 * one of them (people with `ai.manage` always may). Checked when a job is created and again before every tool call.
 */
export function invokeRefusal(ctx: AppContext, install: Install, userId: string): string | null {
  const why = useRefusal(ctx, install.orgId, userId);
  if (why) return why;
  if (install.invokers.everyone || ctx.authz.can(install.orgId, userId, "ai.manage")) return null;
  const mine = new Set(ctx.authz.assignedRoles(install.orgId, userId).map((r) => r.id));
  return install.invokers.roles.some((r) => mine.has(r)) ? null : "This agent only works for some roles, and you don't hold them.";
}

export function requireInvoke(ctx: AppContext, install: Install, userId: string): void {
  const why = invokeRefusal(ctx, install, userId);
  if (why) throw new ApiError(403, "agent_not_assigned", why);
}

/**
 * Whether [userId] can see channel [conversationId] of [orgId] right now and, with [post], post there (the request and
 * the agent's answers appear in the channel as theirs to ask: read-only members and announcement channels refuse).
 */
export function channelRefusal(ctx: AppContext, orgId: string, conversationId: string, userId: string, post = false): string | null {
  const conv = ctx.authz.conversation(conversationId);
  if (!conv || conv.org_id !== orgId || conv.type !== "CHANNEL" || conv.archived_at) return "That isn't an open channel of this community.";
  if (!ctx.authz.isMember(conversationId, userId) || !ctx.authz.canViewChannel(conv, userId)) return "You're not in that channel.";
  if (post && !ctx.authz.canPost(conv, userId)) return "You can't post in that channel, so you can't ask an agent there.";
  return null;
}

/**
 * Whether [userId] may approve [action] of a job [requester] asked for: holders of `ai.approve`; and the requester, for
 * internal actions of their own job (a final export they asked for), only when [requesterMay]: neither the platform's
 * strict policy nor the agent's template forces review. Checked when deciding and again when the approved action runs.
 * Actions in outside services always need `ai.approve`.
 */
export function mayApprove(ctx: AppContext, orgId: string, userId: string, action: string, requester: string, requesterMay: boolean): boolean {
  if (!ctx.authz.orgRole(orgId, userId) || ctx.authz.isBanned(orgId, userId)) return false;
  if (ctx.authz.can(orgId, userId, "ai.approve")) return true;
  const internal = action === "deliver" || (action in TOOL_INFO && TOOL_INFO[action as ToolKey].risk === "internal");
  return requesterMay && internal && userId === requester && ctx.authz.can(orgId, userId, "ai.use");
}

/** Whether review is forced on [install] by the platform's strict policy or its template (requesters can't self-approve then). */
export function reviewForced(policy: TemplatePolicy, floor: "standard" | "strict"): boolean {
  return floor === "strict" || policy.forceReview === true;
}

/** Review unless the installation chose automatic and neither the platform nor the template forces review. */
export function effectiveMode(install: Install, policy: TemplatePolicy, floor: "standard" | "strict"): "review" | "auto" {
  return reviewForced(policy, floor) ? "review" : install.executionMode;
}
