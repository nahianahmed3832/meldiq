import { z } from "zod/v4";
import type { Readable } from "node:stream";
import type { AppContext } from "../../app/context.js";
import { ApiError } from "../../shared/errors.js";
import { namesOf } from "../accounts/index.js";
import { ROUTING_CATEGORIES } from "../ai/index.js";
import { conversationMemberIds } from "../messaging/index.js";
import { orgMemberIds } from "../organizations/index.js";
import { refusal, scopesFor } from "../quotas/index.js";
import { channelRefusal, type Deps, effectiveMode, mayApprove, requireInvoke, reviewForced, useRefusal } from "./access.js";
import { AGENTS, findAgent } from "./catalog/index.js";
import { type AiFileRow, INPUT_MIMES, MAX_INPUT_BYTES, sniffMatches } from "./files.js";
import { type JobRow, JobStore, MAX_DEPTH, MAX_JOBS_PER_ROOT } from "./jobs.js";
import { mediaEngine } from "./media.js";
import { readsMessages, type SharedMessage, sharedNote } from "./sharedMessages.js";
import { type Activation, type Autonomy, type Install, type Invokers, modeOf } from "./store.js";
import { ActiveHours } from "./triggers.js";
import { modelsReady, unroutedCategories } from "./readiness.js";
import { TOOL_INFO } from "./toolInfo.js";
import type { AgentDef, ToolKey } from "./types.js";

/**
 * AI Workforce for communities (docs/AI_WORKFORCE.md): the catalog as one community sees it, installing and
 * customising agents, channel assignments, asking agents for work, approvals, revisions and deliverables. The routes
 * check who may call each operation; everything here checks what the operation itself may do.
 */
const RESERVED_NAMES = /\b(meldiq|admin|administrator|moderator|mod|owner|system|staff|official|support team|security|everyone|here)\b/i;
export const STYLES = ["balanced", "concise", "detailed", "friendly", "formal"] as const;
const LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const DAY_MS = 86_400_000;
/** How long a job may wait for people (approvals, answers) before it's closed. */
const WAIT_MS = 7 * DAY_MS;
const JOB_RETENTION_MS = 30 * DAY_MS;
const AVATAR_BYTES = 512 * 1024;
const UPLOADS_AT_ONCE = 3;
const PENDING_INPUT_BYTES = 2 * 1024 * 1024 * 1024;

const normal = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export interface JobRequest {
  orgId: string;
  installId: string;
  userId: string;
  input: unknown;
  conversationId: string | null;
  threadRoot: string | null;
  fileIds: string[];
  idempotencyKey: string | null;
  /** What to show in the channel as the request (the brief); only when the job comes from a channel. */
  requestText: string | null;
  /** Messages of the channel the person's app decrypted and chose to share (AiJobBody.channelMessages). */
  channelMessages?: SharedMessage[] | null;
  /** Started by a trigger (automation.ts), not a person in the moment: which, what it hands on, handoffs deep. */
  origin?: { triggerId: string; sourceJobId: string | null; chain: number } | null;
}

export class Workforce {
  constructor(private readonly d: Deps) {}

  private get ctx(): AppContext {
    return this.d.ctx;
  }

  /** Throws unless agents can be used at all right now. */
  private requireOn(orgId: string): void {
    if (!this.d.settings.enabled()) throw new ApiError(503, "ai_workforce_disabled", "AI Workforce isn't switched on on this server.");
    if (!this.d.store.entitlement(orgId).enabled) throw new ApiError(409, "agent_unavailable", "AI agents aren't included for this community.");
  }

  // ───────────── Catalog ─────────────

  /** Whether [def] may be installed in [orgId] (published, available to it); the reason when not. */
  availability(orgId: string, def: AgentDef): string | null {
    const st = this.d.store.templateState(def.id, def.version);
    if (st.status !== "published") return st.status === "retired" ? "This version is retired." : "Not published on this platform.";
    const ent = this.d.store.entitlement(orgId);
    if (!ent.enabled) return "AI agents aren't included for this community.";
    if (ent.categories && !ent.categories.includes(def.category)) return "This kind of agent isn't included for this community.";
    if (ent.agents ? !ent.agents.includes(def.id) : st.availability === "entitled") return "This agent isn't included for this community.";
    return null;
  }

  /** What's missing for [def] to do its work here: model capabilities, the media engine, outside connections. */
  async setup(orgId: string, def: AgentDef): Promise<{ ready: boolean; missing: string[]; unavailableActions: string[] }> {
    const ent = this.d.store.entitlement(orgId);
    const allowed = ent.models ? new Set(ent.models) : null;
    const missing: string[] = [];
    if (!this.ctx.ai.enabled) missing.push("AI requests are switched off on this platform.");
    for (const c of def.skill.requiredCategories) {
      if (this.ctx.ai.routing.route(c, allowed).ordered.length === 0) missing.push(`No verified model for ${c.replace("_", " ")} is configured.`);
    }
    if (def.skill.requiredTools.some((t) => t.startsWith("media."))) {
      const m = await mediaEngine();
      if (!m.available) missing.push(`The media engine isn't available (${m.detail}).`);
    }
    const policies = this.d.store.toolPolicies();
    for (const t of def.skill.requiredTools) if (policies[t] === "disabled") missing.push(`${TOOL_INFO[t].label} is turned off on this platform.`);
    const unavailableActions = def.integrations.map((i) => `${i.label}: needs a ${TOOL_INFO[i.tool].integration ?? "connection"}, which isn't available.`);
    return { ready: missing.length === 0, missing, unavailableActions };
  }

  async catalog(orgId: string) {
    const installs = this.d.store.installsOf(orgId);
    const latest = new Map<string, AgentDef>();
    for (const a of AGENTS) if (this.d.store.templateState(a.id, a.version).status === "published" && (latest.get(a.id)?.version ?? 0) < a.version) latest.set(a.id, a);
    return Promise.all(
      [...latest.values()].map(async (def) => {
        const install = installs.find((i) => i.agentId === def.id) ?? null;
        return {
          agent: agentSummary(def),
          available: this.availability(orgId, def) === null,
          unavailableReason: this.availability(orgId, def),
          setup: await this.setup(orgId, def),
          installed: install ? { installId: install.id, state: install.state, version: install.version, upgradeAvailable: install.version < def.version } : null,
        };
      }),
    );
  }

  // ───────────── Installing and customising ─────────────

  private checkName(orgId: string, name: string): string {
    const n = name.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, "").trim();
    if (n.length < 2 || n.length > 40) throw new ApiError(400, "name_not_allowed", "An agent's name is 2–40 characters.");
    if (RESERVED_NAMES.test(n)) throw new ApiError(400, "name_not_allowed", "That name would look like a staff or system account.");
    const taken = namesOf(this.ctx.db, orgMemberIds(this.ctx.db, orgId)).some((u) => normal(u.displayName) === normal(n) || normal(u.username) === normal(n));
    if (taken) throw new ApiError(400, "name_not_allowed", "A member of this community has that name, so an agent can't use it.");
    return n;
  }

  /** Tools an installation may hold: the skill's, minus what the platform or the community's entitlement rules out. */
  grantable(orgId: string, def: AgentDef): ToolKey[] {
    const policies = this.d.store.toolPolicies();
    const ent = this.d.store.entitlement(orgId);
    return def.skill.tools.filter((t) => policies[t] !== "disabled" && (!ent.tools || ent.tools.includes(t)));
  }

  install(orgId: string, agentId: string, actor: string, identity: { displayName?: string; description?: string; roleTitle?: string }): Install {
    this.requireOn(orgId);
    const def = findAgent(agentId);
    if (!def) throw new ApiError(404, "not_found", "No such agent in the catalog.");
    const why = this.availability(orgId, def);
    if (why) throw new ApiError(409, "agent_unavailable", why);
    // Internal tools by default; actions in outside services only when an admin grants them.
    const tools = this.grantable(orgId, def).filter((t) => TOOL_INFO[t].risk === "internal");
    const install = this.d.store.createInstall(
      orgId,
      def,
      tools,
      {
        displayName: this.checkName(orgId, identity.displayName ?? def.name),
        description: (identity.description ?? def.description).slice(0, 500),
        roleTitle: (identity.roleTitle ?? def.roleTitle).slice(0, 60),
        avatarColor: def.avatarColor,
      },
      actor,
    );
    this.ctx.audit({ actorId: actor, orgId, action: "ai.agent_install", target: install.id, detail: `${def.id}@${def.version}` });
    return install;
  }

  private ownInstall(orgId: string, installId: string): Install {
    const i = this.d.store.install(installId);
    if (!i || i.orgId !== orgId || i.state === "uninstalled") throw new ApiError(404, "not_found", "No such agent in this community.");
    return i;
  }

  update(
    orgId: string,
    installId: string,
    actor: string,
    rev: number,
    p: Partial<{
      state: "active" | "disabled";
      displayName: string;
      description: string;
      roleTitle: string;
      avatarColor: string | null;
      language: string | null;
      style: (typeof STYLES)[number];
      instructions: string;
      tools: ToolKey[];
      executionMode: "review" | "auto";
      maxJobsPerDay: number | null;
      maxConcurrent: number | null;
      invokers: Invokers;
      upgradeTo: number;
      autonomy: Autonomy;
      maxRuntimeSec: number | null;
      maxAttempts: number | null;
      activeHours: ActiveHours | null;
    }>,
  ): Install {
    const cur = this.ownInstall(orgId, installId);
    let def = findAgent(cur.agentId, cur.version);
    if (!def) throw new ApiError(409, "agent_unavailable", "This agent's version no longer exists.");
    let version: number | undefined;
    if (p.upgradeTo !== undefined && p.upgradeTo !== cur.version) {
      const next = findAgent(cur.agentId, p.upgradeTo);
      if (!next || p.upgradeTo < cur.version) throw new ApiError(400, "bad_request", "That isn't a newer version of this agent.");
      const why = this.availability(orgId, next);
      if (why) throw new ApiError(409, "agent_unavailable", why);
      def = next;
      version = next.version;
    }
    const grantable = this.grantable(orgId, def);
    let tools = p.tools;
    if (tools) {
      const extra = tools.filter((t) => !grantable.includes(t));
      if (extra.length) throw new ApiError(403, "tool_not_allowed", `This agent can't be given: ${extra.map((t) => TOOL_INFO[t].label).join(", ")}.`);
    } else if (version !== undefined) {
      // An upgrade keeps the grants the new version still has.
      tools = cur.tools.filter((t) => grantable.includes(t));
    }
    if (p.language !== undefined && p.language !== null && !LANGUAGE.test(p.language)) throw new ApiError(400, "bad_request", "A language is a code like en, fr or pt-BR.");
    if (p.avatarColor !== undefined && p.avatarColor !== null && !/^#[0-9A-Fa-f]{6}$/.test(p.avatarColor)) throw new ApiError(400, "bad_request", "A colour is #RRGGBB.");
    if (p.invokers) for (const r of p.invokers.roles) if (!this.ctx.authz.roleGrant(r, orgId)) throw new ApiError(400, "bad_request", "A role isn't one of this community's.");
    if (p.maxRuntimeSec != null && p.maxRuntimeSec > def.skill.limits.maxRuntimeSec) throw new ApiError(400, "bad_request", `${cur.displayName} runs for at most ${def.skill.limits.maxRuntimeSec} seconds.`);
    if (p.maxAttempts != null && p.maxAttempts > def.skill.limits.maxAttempts) throw new ApiError(400, "bad_request", `${cur.displayName} tries at most ${def.skill.limits.maxAttempts} times.`);
    const hours = p.activeHours ? ActiveHours.safeParse(p.activeHours) : null;
    if (hours && !hours.success) throw new ApiError(400, "bad_request", `Active hours: ${hours.error.issues[0]?.message ?? "not valid"}`);
    const activeHours = hours?.success ? hours.data : p.activeHours;
    // Autonomy decides review; an older client's executionMode moves autonomy to the matching level.
    const autonomy: Autonomy | undefined =
      p.autonomy ??
      (p.executionMode === undefined
        ? undefined
        : p.executionMode === "auto"
          ? cur.autonomy === "continuous"
            ? "continuous"
            : "guarded"
          : cur.autonomy === "manual"
            ? "manual"
            : "assisted");
    const next = this.d.store.updateInstall(installId, rev, {
      state: p.state,
      version,
      displayName: p.displayName === undefined ? undefined : this.checkName(orgId, p.displayName),
      description: p.description?.slice(0, 500),
      roleTitle: p.roleTitle?.slice(0, 60),
      avatarColor: p.avatarColor,
      language: p.language,
      style: p.style,
      instructions: p.instructions?.slice(0, 2000),
      tools,
      executionMode: autonomy ? modeOf(autonomy) : undefined,
      maxJobsPerDay: p.maxJobsPerDay,
      maxConcurrent: p.maxConcurrent,
      invokers: p.invokers,
      autonomy,
      maxRuntimeSec: p.maxRuntimeSec,
      maxAttempts: p.maxAttempts,
      activeHours,
    });
    const changed = Object.keys(p).filter((k) => p[k as keyof typeof p] !== undefined);
    this.ctx.audit({ actorId: actor, orgId, action: "ai.agent_update", target: installId, detail: changed.join(",") });
    if (p.state === "disabled") for (const id of this.d.jobs.activeIdsOfInstall(installId)) this.d.jobs.requestCancel(id, "agent_disabled");
    return next;
  }

  async setAvatar(orgId: string, installId: string, actor: string, bytes: Buffer): Promise<Install> {
    const cur = this.ownInstall(orgId, installId);
    if (bytes.length === 0 || bytes.length > AVATAR_BYTES) throw new ApiError(413, "too_large", "An avatar can be up to 512 KB.");
    const mime = ["image/png", "image/jpeg", "image/webp"].find((m) => sniffMatches(bytes, m));
    if (!mime) throw new ApiError(400, "bad_request", "An avatar is a PNG, JPEG or WebP image.");
    const file = await this.d.files.store({ orgId, role: "avatar", installId, uploadedBy: actor, name: "avatar", mime, bytes });
    const old = this.d.store.installRow(installId)?.avatar_blob;
    this.d.store.setAvatar(installId, file.id, file.sha256);
    if (old) await this.d.files.remove(old);
    this.ctx.audit({ actorId: actor, orgId, action: "ai.agent_avatar", target: cur.id, detail: null });
    return this.d.store.install(installId)!;
  }

  async avatar(orgId: string, installId: string): Promise<AiFileRow | null> {
    const row = this.d.store.installRow(installId);
    if (!row || row.org_id !== orgId || !row.avatar_blob) return null;
    return this.d.files.row(row.avatar_blob);
  }

  uninstall(orgId: string, installId: string, actor: string): void {
    const cur = this.ownInstall(orgId, installId);
    for (const id of this.d.jobs.activeIdsOfInstall(installId)) this.d.jobs.requestCancel(id, "agent_removed");
    this.d.store.uninstall(cur.id);
    // Its triggers go (and handoffs from it); past jobs and their records stay.
    this.d.triggers.removeOfInstall(cur.id);
    this.ctx.audit({ actorId: actor, orgId, action: "ai.agent_uninstall", target: installId, detail: cur.agentId });
  }

  // ───────────── Channels ─────────────

  assign(orgId: string, installId: string, conversationId: string, activation: Activation, actor: string): void {
    const i = this.ownInstall(orgId, installId);
    const why = channelRefusal(this.ctx, orgId, conversationId, actor);
    if (why) throw new ApiError(403, "agent_not_assigned", why);
    this.d.store.assign(i.id, orgId, conversationId, activation, actor);
    this.ctx.audit({ actorId: actor, orgId, action: "ai.agent_channel_add", target: installId, detail: `${conversationId}:${activation}` });
    this.ctx.hub.sendToUsers(conversationMemberIds(this.ctx, conversationId), { t: "conv.updated", conversationId });
  }

  unassign(orgId: string, installId: string, conversationId: string, actor: string): void {
    this.ownInstall(orgId, installId);
    if (!this.d.store.unassign(installId, conversationId)) throw new ApiError(404, "not_found", "The agent isn't in that channel.");
    this.ctx.audit({ actorId: actor, orgId, action: "ai.agent_channel_remove", target: installId, detail: conversationId });
    this.ctx.hub.sendToUsers(conversationMemberIds(this.ctx, conversationId), { t: "conv.updated", conversationId });
  }

  /** Agents a person can ask in one channel (for the composer): assigned, active, and allowed for them. */
  channelAgents(conversationId: string, userId: string): { install: Install; activation: Activation; canInvoke: boolean }[] {
    const conv = this.ctx.authz.conversation(conversationId);
    if (!conv?.org_id || channelRefusal(this.ctx, conv.org_id, conversationId, userId)) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
    return this.d.store.agentsInChannel(conversationId).flatMap((a) => {
      const install = this.d.store.install(a.installId);
      if (!install) return [];
      let canInvoke = true;
      try {
        requireInvoke(this.ctx, install, userId);
      } catch {
        canInvoke = false;
      }
      return [{ install, activation: a.activation, canInvoke }];
    });
  }

  // ───────────── Inputs ─────────────

  /** Uploads in progress, per person: their count and declared bytes (they count against the limits below). */
  private readonly uploads = new Map<string, { count: number; bytes: number }>();

  /**
   * A file a person sends to an agent, streamed in: at most [declared] bytes (its Content-Length) and MAX_INPUT_BYTES.
   * Limits that hold even with no quota set: UPLOADS_AT_ONCE per person, and PENDING_INPUT_BYTES of inputs not yet sent
   * with a request (they're removed after a day). An operator's `ai.file_bytes` quota is reserved for the whole upload,
   * so parallel uploads see each other.
   */
  async upload(orgId: string, userId: string, name: string, mime: string, declared: number, body: Readable): Promise<AiFileRow> {
    this.requireOn(orgId);
    const why = useRefusal(this.ctx, orgId, userId);
    if (why) throw new ApiError(403, "agent_not_assigned", why);
    if (!(INPUT_MIMES as readonly string[]).includes(mime)) throw new ApiError(400, "bad_request", "Agents can't read that kind of file.");
    if (!Number.isFinite(declared) || declared <= 0) throw new ApiError(400, "bad_request", "Send the file's size (Content-Length).");
    if (declared > MAX_INPUT_BYTES) throw new ApiError(413, "too_large", "A file for an agent is at most 500 MB.");
    const flight = this.uploads.get(userId) ?? { count: 0, bytes: 0 };
    if (flight.count >= UPLOADS_AT_ONCE) throw new ApiError(429, "quota_exceeded", `At most ${UPLOADS_AT_ONCE} uploads to agents at once.`);
    if (this.d.files.pendingInputBytes(userId) + flight.bytes + declared > PENDING_INPUT_BYTES) {
      throw new ApiError(429, "quota_exceeded", "You have too many files waiting to be sent to an agent. Send them with a request, or wait a day.");
    }
    let reservation: string | null = null;
    if (this.ctx.quotas.hasPolicies("ai.file_bytes")) {
      const q = this.ctx.quotas.check("ai.file_bytes", scopesFor(userId, orgId), declared, {
        reserve: true,
        measured: { user: this.d.files.bytesUploadedBy(userId), org: this.d.files.bytesUsed(orgId), global: this.d.files.bytesUsed(null) },
      });
      if (!q.allowed) throw refusal(q);
      reservation = q.reservationId;
    }
    this.uploads.set(userId, { count: flight.count + 1, bytes: flight.bytes + declared });
    try {
      return await this.d.files.storeStream({ orgId, role: "input", uploadedBy: userId, name, mime }, body, declared, (head, size) => {
        if (size === 0) throw new ApiError(400, "bad_request", "The file is empty.");
        if (!sniffMatches(head, mime)) throw new ApiError(400, "bad_request", "The file's contents don't match its type.");
      });
    } finally {
      // Stored or not, the file is now measured from its row: the reservation is given back either way.
      if (reservation) this.ctx.quotas.release(reservation);
      const cur = this.uploads.get(userId)!;
      if (cur.count <= 1) this.uploads.delete(userId);
      else this.uploads.set(userId, { count: cur.count - 1, bytes: cur.bytes - declared });
    }
  }

  // ───────────── Jobs ─────────────

  /**
   * Asks an agent for work. Every check and the quota accounting happen in one synchronous transaction with the
   * insert, so parallel requests can't both pass a limit only one of them fits.
   */
  createJob(r: JobRequest): JobRow {
    this.requireOn(r.orgId);
    if (this.d.settings.paused()) throw new ApiError(503, "ai_paused", "New AI jobs are paused by the platform's operators.");
    if (!this.ctx.ai.enabled) throw new ApiError(503, "ai_disabled", "AI is switched off on this server.");
    const install = this.ownInstall(r.orgId, r.installId);
    if (install.state !== "active") throw new ApiError(409, "agent_unavailable", "This agent is disabled in this community.");
    const def = findAgent(install.agentId, install.version);
    const template = this.d.store.templateState(install.agentId, install.version);
    if (!def || (template.status !== "published" && template.status !== "retired")) throw new ApiError(409, "agent_unavailable", "This agent is turned off on the platform.");
    requireInvoke(this.ctx, install, r.userId);
    if (r.conversationId) {
      const why = channelRefusal(this.ctx, r.orgId, r.conversationId, r.userId, true);
      if (why) throw new ApiError(403, "agent_not_assigned", why);
      if (!this.d.store.assignment(install.id, r.conversationId)) throw new ApiError(403, "agent_not_assigned", `${install.displayName} isn't assigned to that channel.`);
    }
    const shared = r.channelMessages?.length ? r.channelMessages : null;
    if (shared && !r.conversationId) throw new ApiError(400, "bad_request", "Messages can only be shared with a request made in their channel.");
    if (shared && !readsMessages(def)) throw new ApiError(400, "bad_request", `${install.displayName} doesn't read messages.`);
    // A replay of the same request (same key) is the job it already created.
    if (r.idempotencyKey) {
      const same = this.d.jobs.byIdempotency(r.orgId, r.userId, r.idempotencyKey);
      if (same) return same;
    }
    const missingTools = def.skill.requiredTools.filter((t) => !install.tools.includes(t));
    if (missingTools.length) throw new ApiError(409, "agent_unavailable", `${install.displayName} needs these to be allowed first: ${missingTools.map((t) => TOOL_INFO[t].label).join(", ")}.`);
    const parsed = def.skill.input.safeParse(r.input);
    if (!parsed.success) throw new ApiError(400, "bad_request", `The request doesn't match what this agent takes: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`);
    if (r.fileIds.length > def.skill.files.max) throw new ApiError(400, "bad_request", `${install.displayName} takes at most ${def.skill.files.max} files.`);
    if (r.fileIds.length < (def.skill.files.min ?? 0)) throw new ApiError(400, "bad_request", `${install.displayName} needs ${def.skill.files.min === 1 ? "a file" : `${def.skill.files.min} files`} with the request (${def.skill.files.mimes.slice(0, 4).join(", ")}).`);
    for (const id of r.fileIds) {
      const f = this.d.files.row(id);
      if (!f || f.org_id !== r.orgId || f.uploaded_by !== r.userId || f.role !== "input" || f.job_id) throw new ApiError(400, "bad_request", "A file isn't yours, belongs to another request, or is gone. Upload it again.");
      if (!def.skill.files.mimes.includes(f.mime)) throw new ApiError(400, "bad_request", `${install.displayName} can't read ${f.mime} files.`);
      if (f.size > def.skill.files.maxBytes) throw new ApiError(413, "too_large", `${f.name} is larger than ${install.displayName} accepts.`);
    }
    // Checked last: a request that couldn't be accepted anyway says what's wrong with it first.
    this.requireRoutes(r.orgId, def);
    const job = this.ctx.db.transaction(() => {
      this.admitQuota(install, r.userId, template.policy.maxJobsPerDay ?? null);
      const t = this.d.clock();
      const row = this.d.jobs.insert({
        orgId: r.orgId,
        installId: install.id,
        agentId: def.id,
        version: def.version,
        skillId: def.skill.id,
        requestedBy: r.userId,
        conversationId: r.conversationId,
        threadRoot: r.threadRoot,
        input: parsed.data,
        parentJobId: null,
        rootJobId: null,
        depth: 0,
        dependsOn: [],
        maxAttempts: Math.min(def.skill.limits.maxAttempts, install.maxAttempts ?? Infinity),
        idempotencyKey: r.idempotencyKey,
        deadlineAt: t + WAIT_MS,
        expiresAt: t + JOB_RETENTION_MS,
        triggerId: r.origin?.triggerId ?? null,
        sourceJobId: r.origin?.sourceJobId ?? null,
        chain: r.origin?.chain ?? 0,
      });
      this.d.files.attach(r.fileIds, row.id, r.orgId, r.userId);
      if (shared) this.d.shared.add({ jobId: row.id, orgId: r.orgId, conversationId: r.conversationId!, sharedBy: r.userId, messages: shared });
      return row;
    })();
    this.ctx.audit({ actorId: r.userId, orgId: r.orgId, action: "ai.job_create", target: job.id, detail: `${install.id}:${def.id}${shared ? `:shared=${shared.length}` : ""}` });
    if (r.conversationId) {
      // The channel sees that its messages went to the agent, not only the person who shared them.
      const body = [r.requestText, shared ? sharedNote(shared.length) : null].filter(Boolean).join("\n\n");
      if (body) this.d.posts.add({ orgId: r.orgId, conversationId: r.conversationId, threadRoot: r.threadRoot, installId: install.id, jobId: job.id, kind: "request", body, fileIds: r.fileIds, authorId: r.userId });
      this.ctx.hub.sendToUsers(conversationMemberIds(this.ctx, r.conversationId), { t: "ai.posts", conversationId: r.conversationId });
    }
    this.notify(job);
    return job;
  }

  /** Quotas for one new job: jobs per day, active jobs, the installation's and the template's daily caps. Synchronous. */
  private admitQuota(install: Install, userId: string, templateDaily: number | null): void {
    const q = this.ctx.quotas;
    const scopes = scopesFor(userId, install.orgId);
    const ent = this.d.store.entitlement(install.orgId);
    if (ent.maxActiveJobs !== null && this.d.jobs.activeCount({ orgId: install.orgId }) >= ent.maxActiveJobs) {
      throw new ApiError(429, "quota_exceeded", "This community has as many agent jobs running or waiting as it may. Try again when one finishes.");
    }
    const today = this.d.clock() - DAY_MS;
    const installToday = (this.ctx.db.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE install_id = ? AND created_at >= ?").get(install.id, today) as { n: number }).n;
    for (const cap of [install.maxJobsPerDay, templateDaily]) {
      if (cap !== null && installToday >= cap) throw new ApiError(429, "quota_exceeded", `${install.displayName} has done as many jobs today as it may here.`);
    }
    if (q.hasPolicies("ai.active_jobs")) {
      const d = q.check("ai.active_jobs", scopes, 1, {
        measured: { user: this.d.jobs.activeCount({ userId }), org: this.d.jobs.activeCount({ orgId: install.orgId }), global: this.d.jobs.activeCount({}) },
      });
      if (!d.allowed) throw refusal(d);
    }
    const jobs = q.check("ai.jobs", scopes, 1, { reserve: true });
    if (!jobs.allowed) throw refusal(jobs);
    if (jobs.reservationId) q.commit(jobs.reservationId, 1);
  }

  /** A delegated step (the Agent Manager's tool agents.delegate): the same checks, as the person who asked. */
  createChild(parent: JobRow, installId: string, input: unknown, dependsOn: string[], label: string): JobRow {
    const target = this.ownInstall(parent.org_id, installId);
    if (target.state !== "active") throw new ApiError(409, "agent_unavailable", `${target.displayName} is disabled in this community.`);
    const def = findAgent(target.agentId, target.version);
    const template = this.d.store.templateState(target.agentId, target.version);
    if (!def || (template.status !== "published" && template.status !== "retired")) throw new ApiError(409, "agent_unavailable", `${target.displayName} is turned off on the platform.`);
    // No coordinator delegates to a coordinator (or itself): delegation can't loop.
    if (def.skill.tools.includes("agents.delegate") || target.id === parent.install_id) throw new ApiError(400, "bad_request", "An agent can't delegate to a coordinator.");
    if (parent.depth + 1 > MAX_DEPTH) throw new ApiError(400, "bad_request", "Delegation can't go deeper.");
    if (target.autonomy === "manual") throw new ApiError(409, "agent_unavailable", `${target.displayName} only takes requests from people (manual autonomy).`);
    if (!modelsReady(this.d, parent.org_id, def)) throw new ApiError(409, "agent_unavailable", `${target.displayName} has no verified model for its work yet.`);
    if (this.d.jobs.countInRoot(parent.root_job_id) >= MAX_JOBS_PER_ROOT) throw new ApiError(429, "quota_exceeded", "This request has started as many steps as it may.");
    requireInvoke(this.ctx, target, parent.requested_by);
    const missingTools = def.skill.requiredTools.filter((t) => !target.tools.includes(t));
    if (missingTools.length) throw new ApiError(409, "agent_unavailable", `${target.displayName} needs these to be allowed first: ${missingTools.map((t) => TOOL_INFO[t].label).join(", ")}.`);
    // Steps of the same plan: its agent jobs, and the tasks it gave people (a step can wait for what they hand in).
    const siblings = new Set([...this.d.jobs.children(parent.id).map((c) => c.id), ...this.d.tasks.list({ orgId: parent.org_id, jobId: parent.id }, 50).map((t) => t.id)]);
    if (!dependsOn.every((id) => siblings.has(id))) throw new ApiError(400, "bad_request", "A step can only depend on steps of the same plan.");
    const parsed = def.skill.input.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "bad_request", `That step's request doesn't fit ${target.displayName}: ${parsed.error.issues[0]?.message ?? ""}`);
    // A delegated agent posts in the channel only if it's assigned there itself.
    const conversationId = parent.conversation_id && this.d.store.assignment(target.id, parent.conversation_id) ? parent.conversation_id : null;
    const child = this.ctx.db.transaction(() => {
      this.admitQuota(target, parent.requested_by, template.policy.maxJobsPerDay ?? null);
      const t = this.d.clock();
      return this.d.jobs.insert({
        orgId: parent.org_id,
        installId: target.id,
        agentId: def.id,
        version: def.version,
        skillId: def.skill.id,
        requestedBy: parent.requested_by,
        conversationId,
        threadRoot: parent.thread_root,
        input: parsed.data,
        parentJobId: parent.id,
        rootJobId: parent.root_job_id,
        depth: parent.depth + 1,
        dependsOn,
        maxAttempts: Math.min(def.skill.limits.maxAttempts, target.maxAttempts ?? Infinity),
        idempotencyKey: null,
        deadlineAt: t + WAIT_MS,
        expiresAt: t + JOB_RETENTION_MS,
      });
    })();
    this.d.jobs.event(child.id, "delegated", { by: parent.id, labelChars: label.length });
    this.notify(child);
    return child;
  }

  private notify(job: JobRow, approvers = false): void {
    const users = new Set([job.requested_by]);
    if (approvers) for (const u of this.ctx.authz.workspaceMembersWith(job.org_id, "ai.approve")) users.add(u);
    this.ctx.hub.sendToUsers(users, { t: "ai.job", orgId: job.org_id, jobId: job.id });
  }

  /** The job if [userId] may see it: who asked, people with ai.manage, and members of its channel. */
  visibleJob(orgId: string, jobId: string, userId: string): JobRow {
    const j = this.d.jobs.get(jobId);
    const ok =
      j !== null &&
      j.org_id === orgId &&
      this.ctx.authz.orgRole(orgId, userId) !== null &&
      (j.requested_by === userId || this.ctx.authz.can(orgId, userId, "ai.manage") || (j.conversation_id !== null && channelRefusal(this.ctx, orgId, j.conversation_id, userId) === null));
    if (!ok) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
    return j;
  }

  /**
   * Refuses a request no model could serve, instead of queueing a job that can only fail: each kind of work the agent
   * can't do without needs a verified model this community may use.
   */
  private requireRoutes(orgId: string, def: AgentDef): void {
    const missing = unroutedCategories(this.d, orgId, def);
    if (!missing.length) return;
    const labels = missing.map((c) => ROUTING_CATEGORIES[c].label.toLowerCase()).join(" and ");
    throw new ApiError(503, "ai_not_configured", `${def.name} can't work yet: no verified model for ${labels}. A platform operator sets one up in the AI Control Center.`, { categories: missing });
  }

  /** Who may steer a job (cancel, retry, revise, answer): who asked, or people with ai.manage. */
  private steerable(orgId: string, jobId: string, userId: string): JobRow {
    const j = this.visibleJob(orgId, jobId, userId);
    if (j.requested_by !== userId && !this.ctx.authz.can(orgId, userId, "ai.manage")) throw new ApiError(403, "forbidden", "Only the person who asked, or someone who manages agents, can do that.");
    return j;
  }

  cancel(orgId: string, jobId: string, userId: string): JobRow {
    const cur = this.steerable(orgId, jobId, userId);
    const j = this.d.jobs.requestCancel(jobId, cur.requested_by === userId ? "cancelled_by_requester" : "cancelled_by_manager");
    this.d.approvals.invalidateJob(jobId);
    this.ctx.audit({ actorId: userId, orgId, action: "ai.job_cancel", target: jobId, detail: null });
    this.notify(j);
    return j;
  }

  retry(orgId: string, jobId: string, userId: string): JobRow {
    const cur = this.steerable(orgId, jobId, userId);
    if (cur.parent_job_id) throw new ApiError(409, "job_not_retryable", "Retry the whole request instead of one of its steps.");
    if (!JobStore.retryable(cur)) throw new ApiError(409, "job_not_retryable", "Only a failed job, or one you cancelled yourself, can be retried.");
    this.requireOn(orgId);
    if (this.d.settings.paused()) throw new ApiError(503, "ai_paused", "New AI jobs are paused by the platform's operators.");
    if (!this.ctx.ai.enabled) throw new ApiError(503, "ai_disabled", "AI is switched off on this server.");
    // A retry is admitted like a new job: the agent must still be usable, and every limit applies.
    const install = this.ownInstall(orgId, cur.install_id);
    if (install.state !== "active") throw new ApiError(409, "agent_unavailable", "This agent is disabled in this community.");
    const template = this.d.store.templateState(install.agentId, install.version);
    if (template.status !== "published" && template.status !== "retired") throw new ApiError(409, "agent_unavailable", "This agent is turned off on the platform.");
    requireInvoke(this.ctx, install, cur.requested_by);
    const def = findAgent(install.agentId, install.version);
    if (def) this.requireRoutes(orgId, def);
    const j = this.ctx.db.transaction(() => {
      this.admitQuota(install, cur.requested_by, template.policy.maxJobsPerDay ?? null);
      return this.d.jobs.retry(jobId);
    })();
    this.ctx.audit({ actorId: userId, orgId, action: "ai.job_retry", target: jobId, detail: null });
    this.notify(j);
    return j;
  }

  /** People who can approve: holders of ai.approve; the requester, for internal actions of their own job, unless review is forced. */
  decide(orgId: string, approvalId: string, userId: string, decision: "approved" | "rejected", note: string | null): JobRow {
    const a = this.d.approvals.get(approvalId);
    if (!a || a.org_id !== orgId) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
    const job = this.visibleJob(orgId, a.job_id, userId);
    const forced = reviewForced(this.d.store.templateState(job.agent_id, job.version).policy, this.d.settings.approvalFloor());
    if (!mayApprove(this.ctx, orgId, userId, a.action, job.requested_by, !forced)) throw new ApiError(403, "forbidden", forced && job.requested_by === userId ? "Review is required here: someone with \"Approve AI agent actions\" decides." : "You can't approve this.");
    if (job.state !== "awaiting_approval") throw new ApiError(409, "approval_stale", "The job isn't waiting for this approval anymore.");
    if (a.artifact_id) {
      const f = this.d.files.row(a.artifact_id);
      if (!f || f.sha256 !== a.artifact_sha || f.approval_state === "superseded") throw new ApiError(409, "approval_stale", "The file changed since approval was asked.");
    }
    this.d.approvals.decide(approvalId, decision, userId, note);
    if (a.artifact_id) this.d.files.setApproval(a.artifact_id, decision);
    this.ctx.audit({ actorId: userId, orgId, action: decision === "approved" ? "ai.approval_grant" : "ai.approval_reject", target: approvalId, detail: `${a.job_id}:${a.action}` });
    if (decision === "rejected") {
      const j = this.d.jobs.requestCancel(job.id, "approval_rejected");
      this.notify(j);
      return j;
    }
    const resumed = this.d.jobs.resume(job.id, "awaiting_approval", {});
    this.notify(resumed);
    return resumed;
  }

  /** A change request on a result waiting for approval: its approval is void and the agent works on a new version. */
  revise(orgId: string, jobId: string, userId: string, note: string): JobRow {
    const job = this.steerable(orgId, jobId, userId);
    if (job.state !== "awaiting_approval") throw new ApiError(409, "job_not_retryable", "Only a result waiting for approval can be revised.");
    if (job.revision >= 10) throw new ApiError(409, "job_not_retryable", "This request has been revised as often as it may. Start a new one.");
    this.d.approvals.invalidateJob(jobId);
    // The note is content: it travels in the checkpoint (the skill reads it), never in the events operators can see.
    this.d.jobs.event(jobId, "revision_requested", {});
    const cp = job.checkpoint ? (JSON.parse(job.checkpoint) as Record<string, unknown>) : {};
    const j = this.d.jobs.resume(jobId, "awaiting_approval", { revision: true, checkpoint: { ...cp, revisionNote: note.slice(0, 2000) } });
    this.ctx.audit({ actorId: userId, orgId, action: "ai.job_revise", target: jobId, detail: null });
    this.notify(j);
    return j;
  }

  answer(orgId: string, jobId: string, userId: string, text: string): JobRow {
    const job = this.steerable(orgId, jobId, userId);
    if (job.state !== "awaiting_input") throw new ApiError(409, "job_not_retryable", "This job isn't waiting for an answer.");
    const cp = job.checkpoint ? (JSON.parse(job.checkpoint) as Record<string, unknown>) : {};
    const j = this.d.jobs.resume(jobId, "awaiting_input", { checkpoint: { ...cp, answer: text.slice(0, 4000) } });
    this.notify(j);
    return j;
  }

  /** Whether [userId] may download [file]: its uploader or requester, people with ai.manage, members of its channel. */
  canRead(file: AiFileRow, userId: string): boolean {
    if (this.ctx.authz.orgRole(file.org_id, userId) === null) return false;
    if (file.role === "avatar") return true;
    if (file.uploaded_by === userId || this.ctx.authz.can(file.org_id, userId, "ai.manage")) return true;
    const job = file.job_id ? this.d.jobs.get(file.job_id) : null;
    const root = job ? this.d.jobs.get(job.root_job_id) : null;
    if (job?.requested_by === userId || root?.requested_by === userId) return true;
    // Human tasks: what was handed in, for whoever may see the task; agents' deliverables it refers to, for its assignee.
    const task = file.task_id ? this.d.tasks.get(file.task_id) : null;
    if (task && (task.assignee_id === userId || task.created_by === userId)) return true;
    const referenced = this.ctx.db
      .prepare("SELECT 1 FROM ai_tasks WHERE org_id = ? AND assignee_id = ? AND state <> 'cancelled' AND instr(reference_files, ?) > 0 LIMIT 1")
      .get(file.org_id, userId, JSON.stringify(file.id));
    if (referenced) return true;
    return file.conversation_id !== null && channelRefusal(this.ctx, file.org_id, file.conversation_id, userId) === null;
  }

  mode(install: Install): "review" | "auto" {
    return effectiveMode(install, this.d.store.templateState(install.agentId, install.version).policy, this.d.settings.approvalFloor());
  }
}

/** The skill's input as JSON Schema, for clients that build forms from it; null when a schema can't be expressed. */
function inputSchemaOf(def: AgentDef): unknown {
  try {
    return z.toJSONSchema(def.skill.input, { io: "input", unrepresentable: "any" });
  } catch {
    return null;
  }
}

/** What clients show about a catalog entry. */
export function agentSummary(def: AgentDef) {
  return {
    id: def.id,
    version: def.version,
    name: def.name,
    description: def.description,
    roleTitle: def.roleTitle,
    category: def.category,
    capabilities: [...def.capabilities],
    examples: [...def.examples],
    avatarColor: def.avatarColor,
    skill: {
      id: def.skill.id,
      version: def.skill.version,
      tools: [...def.skill.tools],
      requiredTools: [...def.skill.requiredTools],
      modelCategories: [...def.skill.categories],
      requiredModelCategories: [...def.skill.requiredCategories],
      files: { min: def.skill.files.min ?? 0, max: def.skill.files.max, maxBytes: def.skill.files.maxBytes, types: [...def.skill.files.mimes] },
      /** Whether a channel request may share recent messages with it (agents that read text). */
      readsMessages: readsMessages(def),
      limits: { ...def.skill.limits },
      approvals: [...def.skill.approvals],
      errors: [...def.skill.errors],
      inputSchema: inputSchemaOf(def),
    },
    integrations: def.integrations.map((i) => ({ tool: i.tool, label: i.label, connected: false })),
    defaults: { ...def.defaults },
  };
}
