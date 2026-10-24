import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../../shared/errors.js";
import { conversationMemberIds } from "../messaging/index.js";
import { refusal, scopesFor } from "../quotas/index.js";
import { channelRefusal, type Deps, invokeRefusal, mayApprove, reviewForced } from "./access.js";
import { ARTIFACT_MIMES, type AiFileRow } from "./files.js";
import type { JobRow } from "./jobs.js";
import { checkPlan, extractAudio, probe, render } from "./media.js";
import type { Install } from "./store.js";
import { TOOL_INFO } from "./toolInfo.js";
import type { AgentDef, MediaInfo, ToolKey, ToolSignatures } from "./types.js";
import { fetchPage } from "./webFetch.js";

/**
 * The tool gateway (docs/AI_WORKFORCE.md §6). Every agent action comes through here and is checked, in order, at the
 * moment it runs: the platform's ceiling, the community's entitlement, the installation's grants, the skill's
 * declaration, the requester's current permissions and channel access, the outside connection, approval, quota. The
 * Agent Manager goes through the same gateway as the person who asked: it gains nothing they don't have.
 */
export const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;
/** The most a skill may read into memory at once (files.read); video and audio go through the media engine instead. */
export const READ_LIMIT = 50 * 1024 * 1024;

export interface RunEnv {
  job: JobRow;
  install: Install;
  agent: AgentDef;
  mode: "review" | "auto";
  signal: AbortSignal;
  /** Where submitted files are copied for the media engine during this run. */
  tempDir: string;
  materialized: Map<string, string>;
  written: string[];
}

export type CreateChild = (parent: JobRow, installId: string, input: unknown, dependsOn: string[], label: string) => Promise<JobRow>;

export class ToolGateway {
  constructor(
    private readonly d: Deps,
    private readonly createChild: CreateChild,
  ) {}

  private audit(env: RunEnv, key: ToolKey, outcome: "allowed" | "denied" | "failed", detail: string): void {
    this.d.jobs.event(env.job.id, "tool", { tool: key, outcome, detail: detail.slice(0, 200) });
    if (TOOL_INFO[key].risk !== "internal" || outcome !== "allowed") {
      this.d.ctx.audit({ actorId: env.job.requested_by, orgId: env.job.org_id, action: `ai.tool.${outcome}`, target: `${env.install.id}:${key}`, detail: `job ${env.job.id}: ${detail.slice(0, 200)}` });
    }
  }

  private deny(env: RunEnv, key: ToolKey, status: 403 | 409, code: "tool_not_allowed" | "agent_not_assigned" | "integration_not_configured", message: string): never {
    this.audit(env, key, "denied", code);
    throw new ApiError(status, code, message);
  }

  /** The checks every call passes before anything happens. */
  private admit(env: RunEnv, key: ToolKey): void {
    const policy = this.d.store.toolPolicies()[key];
    if (policy === "disabled") this.deny(env, key, 403, "tool_not_allowed", `${TOOL_INFO[key].label} is turned off for agents on this platform.`);
    const ent = this.d.store.entitlement(env.job.org_id);
    if (ent.tools && !ent.tools.includes(key)) this.deny(env, key, 403, "tool_not_allowed", `${TOOL_INFO[key].label} isn't included for this community.`);
    if (!env.agent.skill.tools.includes(key)) this.deny(env, key, 403, "tool_not_allowed", `${env.agent.name} doesn't use ${TOOL_INFO[key].label}.`);
    const live = this.d.store.install(env.install.id);
    if (!live || live.state !== "active") this.deny(env, key, 403, "tool_not_allowed", "This agent was disabled or removed.");
    if (!live.tools.includes(key)) this.deny(env, key, 403, "tool_not_allowed", `This community hasn't allowed ${env.install.displayName} to ${TOOL_INFO[key].label.toLowerCase()}.`);
    const who = invokeRefusal(this.d.ctx, live, env.job.requested_by);
    if (who) this.deny(env, key, 403, "agent_not_assigned", `The person who asked can't use this agent anymore: ${who}`);
    if (env.job.conversation_id) {
      // Posting in the channel needs the right to post there, as the person who asked.
      const ch = channelRefusal(this.d.ctx, env.job.org_id, env.job.conversation_id, env.job.requested_by, key === "channel.post");
      if (ch) this.deny(env, key, 403, "agent_not_assigned", `The person who asked lost access to the channel: ${ch}`);
      if (!this.d.store.assignment(live.id, env.job.conversation_id)) this.deny(env, key, 403, "agent_not_assigned", "The agent was taken out of this channel.");
    }
    const info = TOOL_INFO[key];
    if (info.risk === "external") this.deny(env, key, 409, "integration_not_configured", `${info.label} needs a ${info.integration ?? "connection"}, and none exists on this server.`);
  }

  async call<K extends ToolKey>(env: RunEnv, key: K, args: ToolSignatures[K]["args"]): Promise<ToolSignatures[K]["result"]> {
    if (env.signal.aborted) throw new ApiError(409, "job_cancelled", "The job was cancelled.");
    this.admit(env, key);
    try {
      const result = await this.exec(env, key, args);
      this.audit(env, key, "allowed", "ok");
      return result as ToolSignatures[K]["result"];
    } catch (e) {
      if (e instanceof ApiError && e.code !== "job_cancelled") this.audit(env, key, "failed", e.code);
      throw e;
    }
  }

  /** The job tree's ids: files of any step of the same request may be read (handoffs between agents). */
  private treeJobIds(env: RunEnv): string[] {
    return (this.d.ctx.db.prepare("SELECT id FROM ai_jobs WHERE root_job_id = ?").all(env.job.root_job_id) as { id: string }[]).map((r) => r.id);
  }

  /**
   * A file this run may use: one of its request's (what people handed in for its tasks included), or (when [handedOn])
   * a finished file of the job a handoff trigger passed on (automation.ts). Handed-on files can be read, never posted
   * elsewhere.
   */
  private fileOfTree(env: RunEnv, fileId: string, handedOn = true): AiFileRow {
    const row = this.d.files.row(fileId);
    const fromSource = handedOn && !!row?.job_id && row.job_id === env.job.source_job_id && row.role === "artifact";
    if (row && row.org_id === env.job.org_id && row.task_id && row.role === "input" && this.fromTaskOfTree(env, row.task_id)) return row;
    if (!row || row.org_id !== env.job.org_id || !row.job_id || (!fromSource && !this.treeJobIds(env).includes(row.job_id)) || row.role === "avatar") {
      throw new ApiError(404, "not_found", "That file isn't part of this request.");
    }
    return row;
  }

  /** Whether [taskId] is a person's task of this run's request (what they handed in belongs to the request). */
  private fromTaskOfTree(env: RunEnv, taskId: string): boolean {
    const t = this.d.tasks.get(taskId);
    return t !== null && t.org_id === env.job.org_id && t.job_id !== null && this.treeJobIds(env).includes(t.job_id);
  }

  /** Copies a file to this run's temporary folder (for the media engine) once. */
  private async localPath(env: RunEnv, row: AiFileRow): Promise<string> {
    const have = env.materialized.get(row.id);
    if (have) return have;
    const p = path.join(env.tempDir, `${row.id}.bin`);
    const s = await this.d.files.stream(row);
    if (!s) throw new ApiError(404, "not_found", "The file's bytes are missing.");
    await pipeline(s, fs.createWriteStream(p));
    env.materialized.set(row.id, p);
    return p;
  }

  private async exec(env: RunEnv, key: ToolKey, raw: unknown): Promise<unknown> {
    const d = this.d;
    switch (key) {
      case "files.read": {
        const a = raw as ToolSignatures["files.read"]["args"];
        const row = this.fileOfTree(env, a.fileId);
        if (row.size > READ_LIMIT) throw new ApiError(413, "too_large", "That file is too large to read whole; media goes through the media engine.");
        const { bytes } = await d.files.read(row.id, Math.min(env.agent.skill.files.maxBytes, READ_LIMIT));
        return { id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, bytes };
      }
      case "files.write": {
        const a = raw as ToolSignatures["files.write"]["args"];
        return this.write(env, a);
      }
      case "channel.post": {
        const a = raw as ToolSignatures["channel.post"]["args"];
        if (!env.job.conversation_id) return { posted: false, postId: null };
        for (const id of a.fileIds ?? []) this.fileOfTree(env, id, false);
        const post = d.posts.add({
          orgId: env.job.org_id,
          conversationId: env.job.conversation_id,
          threadRoot: env.job.thread_root,
          installId: env.install.id,
          jobId: env.job.id,
          kind: a.kind,
          body: a.body,
          fileIds: a.fileIds,
          approvalId: a.approvalId,
        });
        d.ctx.hub.sendToUsers(conversationMemberIds(d.ctx, env.job.conversation_id), { t: "ai.posts", conversationId: env.job.conversation_id });
        return { posted: true, postId: post.id };
      }
      case "media.probe": {
        const a = raw as ToolSignatures["media.probe"]["args"];
        return probe(await this.localPath(env, this.fileOfTree(env, a.fileId)), env.signal);
      }
      case "media.extract_audio": {
        const a = raw as ToolSignatures["media.extract_audio"]["args"];
        const p = await this.localPath(env, this.fileOfTree(env, a.fileId));
        const info = await probe(p, env.signal);
        if (!info.hasAudio) throw new ApiError(400, "bad_request", "That file has no sound.");
        return { bytes: await extractAudio(p, env.signal), mime: "audio/mpeg", seconds: info.durationSec };
      }
      case "media.render":
        return this.render(env, raw as ToolSignatures["media.render"]["args"]);
      case "web.fetch": {
        const a = raw as ToolSignatures["web.fetch"]["args"];
        return fetchPage(a.url, { signal: env.signal });
      }
      case "agents.delegate": {
        const a = raw as ToolSignatures["agents.delegate"]["args"];
        const child = await this.createChild(env.job, a.installId, a.input, a.dependsOn, a.label);
        return { jobId: child.id };
      }
      case "tasks.assign": {
        const a = raw as ToolSignatures["tasks.assign"]["args"];
        const r = this.d.taskService.createForJob(env.job, env.install.id, a);
        return { taskId: r.task.id, assigneeName: r.assigneeName };
      }
      default:
        // External tools stop in admit(); nothing reaches here.
        throw new ApiError(409, "integration_not_configured", "No connection to that service exists.");
    }
  }

  private async write(env: RunEnv, a: ToolSignatures["files.write"]["args"]) {
    return this.storeArtifact(env, { name: a.name, mime: a.mime, kind: a.kind, supersedes: a.supersedes ?? null, pendingApproval: !!a.pendingApproval }, { bytes: a.bytes });
  }

  /**
   * A deliverable, from bytes or from a file on disk (a render: never read into memory). Checked (type, size, the
   * job's file count, the file it replaces), with the `ai.file_bytes` quota reserved while it's stored.
   */
  private async storeArtifact(
    env: RunEnv,
    m: { name: string; mime: string; kind: string; supersedes: string | null; pendingApproval: boolean },
    source: { bytes: Buffer } | { file: string; size: number },
  ) {
    const d = this.d;
    const size = "bytes" in source ? source.bytes.length : source.size;
    if (!ARTIFACT_MIMES.has(m.mime)) throw new ApiError(400, "bad_request", `Agents can't make ${m.mime} files.`);
    if (size === 0 || size > MAX_ARTIFACT_BYTES) throw new ApiError(413, "too_large", "A deliverable is 1 byte to 200 MB.");
    if (env.written.length >= env.agent.skill.limits.maxOutputFiles) throw new ApiError(400, "bad_request", "This job made as many files as it may.");
    if (m.supersedes) this.fileOfTree(env, m.supersedes, false);
    let reservation: string | null = null;
    if (d.ctx.quotas.hasPolicies("ai.file_bytes")) {
      // Agents' files count for the community and the platform (a person's own uploads count for them).
      const scopes = scopesFor(env.job.requested_by, env.job.org_id).filter((s) => s.type !== "user");
      const q = d.ctx.quotas.check("ai.file_bytes", scopes, size, { reserve: true, measured: { org: d.files.bytesUsed(env.job.org_id), global: d.files.bytesUsed(null) } });
      if (!q.allowed) throw refusal(q);
      reservation = q.reservationId;
    }
    const meta = {
      orgId: env.job.org_id,
      role: "artifact" as const,
      jobId: env.job.id,
      installId: env.install.id,
      agentId: env.agent.id,
      skillVersion: env.agent.version,
      conversationId: env.job.conversation_id,
      uploadedBy: null,
      kind: m.kind,
      name: m.name,
      mime: m.mime,
      supersedes: m.supersedes,
      approvalState: m.pendingApproval ? ("pending" as const) : ("not_required" as const),
    };
    try {
      const row = "bytes" in source ? await d.files.store({ ...meta, bytes: source.bytes }) : await d.files.storeFile(meta, source.file);
      env.written.push(row.id);
      return { id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, version: row.artifact_version };
    } finally {
      if (reservation) d.ctx.quotas.release(reservation);
    }
  }

  private async render(env: RunEnv, a: ToolSignatures["media.render"]["args"]) {
    const d = this.d;
    // A final export in review mode needs the person's approval of exactly the preview they saw.
    if (a.quality === "final" && env.mode === "review") {
      if (!a.previewFileId) throw new ApiError(409, "approval_required", "A final export needs an approved preview.");
      const preview = this.fileOfTree(env, a.previewFileId, false);
      d.approvals.require(a.approvalId, { jobId: env.job.id, action: "media.render", artifactId: preview.id, artifactSha: preview.sha256 });
      if (preview.approval_state === "superseded") throw new ApiError(409, "approval_stale", "The approved preview was replaced by a newer one.");
      // The person who approved must still be allowed to approve.
      const approval = d.approvals.get(a.approvalId!)!;
      const forced = reviewForced(d.store.templateState(env.agent.id, env.agent.version).policy, d.settings.approvalFloor());
      if (!approval.decided_by || !mayApprove(d.ctx, env.job.org_id, approval.decided_by, approval.action, env.job.requested_by, !forced)) {
        throw new ApiError(409, "approval_stale", "The person who approved can't approve this anymore.");
      }
    }
    const sources = new Map<string, MediaInfo>();
    const paths = new Map<string, string>();
    for (const c of a.plan.clips) {
      if (sources.has(c.fileId)) continue;
      const row = this.fileOfTree(env, c.fileId);
      const p = await this.localPath(env, row);
      sources.set(c.fileId, await probe(p, env.signal));
      paths.set(c.fileId, p);
    }
    const { outputSec } = checkPlan(a.plan, sources);
    const seconds = Math.ceil(outputSec);
    const reservation = d.ctx.quotas.check("ai.media_seconds", scopesFor(env.job.requested_by, env.job.org_id), seconds, { reserve: true, detail: env.job.id });
    if (!reservation.allowed) throw refusal(reservation);
    try {
      const outFile = path.join(env.tempDir, `render-${env.written.length}-${a.quality}.mp4`);
      const out = await render(a.plan, sources, paths, a.quality, outFile, env.signal);
      if (reservation.reservationId) d.ctx.quotas.commit(reservation.reservationId, seconds);
      d.jobs.event(env.job.id, "media_rendered", { quality: a.quality, seconds, captions: out.captions, overlay: out.overlay });
      const written = await this.storeArtifact(
        env,
        { name: a.name, mime: "video/mp4", kind: a.quality, supersedes: a.supersedes ?? null, pendingApproval: a.quality === "preview" && env.mode === "review" },
        { file: outFile, size: out.size },
      );
      return { ...written, durationSec: out.durationSec, captions: out.captions, overlay: out.overlay };
    } catch (e) {
      if (reservation.reservationId) d.ctx.quotas.release(reservation.reservationId);
      throw e;
    }
  }
}
