import type { Deps } from "./access.js";
import type { ApprovalRow } from "./approvals.js";
import { findAgent } from "./catalog/index.js";
import type { AiFileRow } from "./files.js";
import type { JobRow } from "./jobs.js";
import type { PostRow } from "./posts.js";
import type { Install } from "./store.js";

/** What the API answers about AI Workforce records. Content (briefs, outputs) only in views for people who may see it. */
export function fileView(f: AiFileRow) {
  return {
    id: f.id,
    role: f.role,
    jobId: f.job_id,
    installId: f.install_id,
    agentId: f.agent_id,
    skillVersion: f.skill_version,
    kind: f.kind,
    name: f.name,
    mime: f.mime,
    size: f.size,
    sha256: f.sha256,
    version: f.artifact_version,
    supersedes: f.supersedes,
    approvalState: f.approval_state,
    createdAt: f.created_at,
    expiresAt: f.expires_at,
  };
}

/** [costMicroThisMonth]: budget.ts spentThisMonth. */
export function installView(i: Install, mode: "review" | "auto", costMicroThisMonth: number) {
  const def = findAgent(i.agentId, i.version);
  return {
    id: i.id,
    agentId: i.agentId,
    version: i.version,
    state: i.state,
    displayName: i.displayName,
    avatar: i.avatar ? { sha256: i.avatar.sha256 } : null,
    avatarColor: i.avatarColor,
    description: i.description,
    roleTitle: i.roleTitle,
    language: i.language,
    style: i.style,
    instructions: i.instructions,
    tools: i.tools,
    executionMode: i.executionMode,
    effectiveMode: mode,
    maxJobsPerDay: i.maxJobsPerDay,
    maxConcurrent: i.maxConcurrent,
    maxCostMicroPerMonth: i.maxCostMicroPerMonth,
    costMicroThisMonth,
    invokers: i.invokers,
    autonomy: i.autonomy,
    maxRuntimeSec: i.maxRuntimeSec,
    maxAttempts: i.maxAttempts,
    activeHours: i.activeHours,
    rev: i.rev,
    skill: def ? { id: def.skill.id, version: def.skill.version, name: def.name, category: def.category } : null,
    /** Always shown with the name, so an agent can't pass for a person. */
    badge: "AI",
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

export function approvalView(a: ApprovalRow) {
  return { id: a.id, jobId: a.job_id, action: a.action, fileId: a.artifact_id, fileSha256: a.artifact_sha, summary: a.summary, state: a.state, requestedAt: a.requested_at, decidedBy: a.decided_by, decidedAt: a.decided_at, note: a.note };
}

export function jobSummary(d: Deps, j: JobRow) {
  const install = d.store.install(j.install_id);
  return {
    id: j.id,
    agent: { installId: j.install_id, agentId: j.agent_id, version: j.version, displayName: install?.displayName ?? j.agent_id, badge: "AI" },
    skillId: j.skill_id,
    state: j.state,
    progress: j.progress,
    note: j.progress_note,
    requestedBy: j.requested_by,
    conversationId: j.conversation_id,
    parentJobId: j.parent_job_id,
    rootJobId: j.root_job_id,
    depth: j.depth,
    revision: j.revision,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    error: j.error_code ? { code: j.error_code, message: j.error_detail ?? "" } : null,
    createdAt: j.created_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
    updatedAt: j.updated_at,
  };
}

/** A job with its input, output, files, approvals, delegated steps and events: for people who may see the job. */
export function jobDetail(d: Deps, j: JobRow) {
  return {
    ...jobSummary(d, j),
    input: JSON.parse(j.input) as unknown,
    output: j.output ? (JSON.parse(j.output) as unknown) : null,
    files: d.files.ofJobs([j.id]).map(fileView),
    /** How many channel messages were shared with the request (never the messages: no route returns them). */
    sharedMessages: d.shared.count(j.id),
    approvals: d.approvals.ofJob(j.id).map(approvalView),
    steps: d.jobs.children(j.id).map((c) => jobSummary(d, c)),
    events: d.jobs.events(j.id).map((e) => ({ at: e.at, kind: e.kind, detail: e.detail })),
  };
}

export function postView(d: Deps, p: PostRow) {
  const install = d.store.install(p.install_id);
  const fileIds = JSON.parse(p.file_ids) as string[];
  return {
    id: p.id,
    conversationId: p.conversation_id,
    threadRoot: p.thread_root,
    kind: p.kind,
    body: p.body,
    jobId: p.job_id,
    approvalId: p.approval_id,
    authorId: p.author_id,
    agent: { installId: p.install_id, displayName: install?.displayName ?? "AI agent", avatarColor: install?.avatarColor ?? null, hasAvatar: !!install?.avatar, skill: install ? (findAgent(install.agentId, install.version)?.name ?? null) : null, badge: "AI" },
    files: fileIds.flatMap((id) => {
      const f = d.files.row(id);
      return f ? [fileView(f)] : [];
    }),
    encrypted: false,
    createdAt: p.created_at,
  };
}
