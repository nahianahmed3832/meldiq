package com.meldiq.android.data.ai

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * AI Workforce (server docs/AI_WORKFORCE.md §11): what /v1/orgs/:orgId/ai/… and /v1/conversations/:id/ai/… answer.
 * Field names follow the server's views (`modules/workforce/views.ts`); fields the app doesn't use are left out (the
 * JSON reader ignores them). What people send agents and what agents make isn't end-to-end encrypted, and every screen
 * that shows or sends it says so ([AiOverview.notice]).
 */
@Serializable
data class AiPermissions(val canUse: Boolean = false, val canManage: Boolean = false, val canApprove: Boolean = false)

@Serializable
data class AiInvokers(val everyone: Boolean = true, val roles: List<String> = emptyList())

@Serializable
data class AiSkillRef(val id: String, val version: Int, val name: String, val category: String)

@Serializable
data class AiAvatarRef(val sha256: String)

/** One community's copy of an agent: its own name, avatar, behaviour, tools and limits. */
@Serializable
data class AiInstall(
    val id: String,
    val agentId: String,
    val version: Int,
    val state: String,
    val displayName: String,
    val avatar: AiAvatarRef? = null,
    val avatarColor: String? = null,
    val description: String = "",
    val roleTitle: String = "",
    val language: String? = null,
    val style: String = "balanced",
    val instructions: String = "",
    val tools: List<String> = emptyList(),
    val executionMode: String = "review",
    val effectiveMode: String = "review",
    val maxJobsPerDay: Int? = null,
    val maxConcurrent: Int? = null,
    val invokers: AiInvokers = AiInvokers(),
    /** How much it does on its own (API 0.36.0, [AiAutonomy]); older servers don't send it. */
    val autonomy: String = AiAutonomy.ASSISTED,
    /** An installation can only tighten the skill's own limits; null: the skill's. */
    val maxRuntimeSec: Int? = null,
    val maxAttempts: Int? = null,
    /** When triggers may run (continuous autonomy); null: any time. */
    val activeHours: AiActiveHours? = null,
    /** Monthly AI budget here in micro-USD (null: none of its own), and what it cost this month (API 0.41.0). */
    val maxCostMicroPerMonth: Long? = null,
    val costMicroThisMonth: Long = 0,
    val rev: Int,
    val skill: AiSkillRef? = null,
    /** Always shown with the name, so an agent can't pass for a person. */
    val badge: String = "AI",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
) {
    val active: Boolean get() = state == "active"
}

@Serializable
data class AiActiveHours(val from: String, val to: String, val timeZone: String)

@Serializable
data class AiMediaEngine(val available: Boolean = false, val detail: String = "")

@Serializable
data class AiOverview(
    val enabled: Boolean = false,
    val paused: Boolean = false,
    val aiRequestsOn: Boolean = false,
    val approvalFloor: String = "standard",
    val mediaEngine: AiMediaEngine = AiMediaEngine(),
    val permissions: AiPermissions = AiPermissions(),
    val agents: List<AiInstall> = emptyList(),
    val notice: String = "",
)

@Serializable
data class AiFileLimits(val min: Int = 0, val max: Int = 0, val maxBytes: Long = 0, val types: List<String> = emptyList())

@Serializable
data class AiSkill(
    val id: String,
    val version: Int,
    val tools: List<String> = emptyList(),
    val requiredTools: List<String> = emptyList(),
    val files: AiFileLimits = AiFileLimits(),
    /** Whether a channel request may share recent messages with it (agents that read text). */
    val readsMessages: Boolean = false,
    val approvals: List<String> = emptyList(),
    /** What the skill does when something's missing or fails, as people read it. */
    val errors: List<String> = emptyList(),
    /** The skill's own limits (maxRuntimeSec, maxAttempts, …): an installation can only tighten them. */
    val limits: Map<String, JsonElement> = emptyMap(),
    /** The skill's input as JSON Schema; the Ask sheet shows its top-level options ([SkillForm]). */
    val inputSchema: JsonElement? = null,
)

@Serializable
data class AiIntegration(val tool: String, val label: String, val connected: Boolean = false)

/** A catalog entry as the platform publishes it (the template every community's copy starts from). */
@Serializable
data class AiAgentDef(
    val id: String,
    val version: Int,
    val name: String,
    val description: String = "",
    val roleTitle: String = "",
    val category: String = "",
    val capabilities: List<String> = emptyList(),
    val examples: List<String> = emptyList(),
    val avatarColor: String? = null,
    val skill: AiSkill,
    val integrations: List<AiIntegration> = emptyList(),
)

@Serializable
data class AiSetup(val ready: Boolean = true, val missing: List<String> = emptyList(), val unavailableActions: List<String> = emptyList())

@Serializable
data class AiInstalledRef(val installId: String, val state: String, val version: Int, val upgradeAvailable: Boolean = false)

@Serializable
data class AiCatalogEntry(
    val agent: AiAgentDef,
    val available: Boolean = false,
    val unavailableReason: String? = null,
    val setup: AiSetup = AiSetup(),
    val installed: AiInstalledRef? = null,
)

@Serializable
data class AiCatalog(val agents: List<AiCatalogEntry> = emptyList())

@Serializable
data class AiTool(
    val key: String,
    val label: String,
    val description: String = "",
    val risk: String = "internal",
    val platformMode: String = "allowed",
    val granted: Boolean = false,
    val required: Boolean = false,
    val connected: Boolean = true,
)

@Serializable
data class AiAssignment(val installId: String, val conversationId: String, val activation: String = "mention", val addedBy: String? = null, val addedAt: Long = 0)

@Serializable
data class AiUpgrade(val version: Int)

@Serializable
data class AiAgentDetail(
    val agent: AiInstall,
    val definition: AiAgentDef? = null,
    val upgrade: AiUpgrade? = null,
    val setup: AiSetup? = null,
    val channels: List<AiAssignment> = emptyList(),
    val tools: List<AiTool> = emptyList(),
    val permissions: AiPermissions = AiPermissions(),
)

@Serializable
data class AiAgentRes(val agent: AiInstall)

@Serializable
data class AiChannelsRes(val channels: List<AiAssignment> = emptyList())

/** A file an agent was given or made. Downloads need the session ([AiWorkforceApi.download]). */
@Serializable
data class AiFile(
    val id: String,
    val role: String = "artifact",
    val jobId: String? = null,
    val kind: String? = null,
    val name: String,
    val mime: String,
    val size: Long,
    val sha256: String = "",
    val version: Int = 1,
    val supersedes: String? = null,
    val approvalState: String = "none",
    val createdAt: Long = 0,
    val expiresAt: Long? = null,
)

@Serializable
data class AiFileRes(val file: AiFile)

@Serializable
data class AiJobAgent(val installId: String, val agentId: String, val version: Int = 1, val displayName: String, val badge: String = "AI")

@Serializable
data class AiJobError(val code: String, val message: String = "")

@Serializable
data class AiJobSummary(
    val id: String,
    val agent: AiJobAgent,
    val skillId: String = "",
    val state: String,
    /** 0–100 as the job reports it; shown only while the job works. */
    val progress: Int = 0,
    val note: String? = null,
    val requestedBy: String = "",
    val conversationId: String? = null,
    val parentJobId: String? = null,
    val rootJobId: String? = null,
    val depth: Int = 0,
    val revision: Int = 0,
    val attempts: Int = 0,
    val maxAttempts: Int = 0,
    val error: AiJobError? = null,
    val createdAt: Long = 0,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val updatedAt: Long = 0,
)

@Serializable
data class AiApproval(
    val id: String,
    val jobId: String,
    val action: String = "",
    val fileId: String? = null,
    val fileSha256: String? = null,
    val summary: String = "",
    val state: String = "pending",
    val requestedAt: Long = 0,
    val decidedBy: String? = null,
    val decidedAt: Long? = null,
    val note: String? = null,
)

@Serializable
data class AiJobEvent(val at: Long, val kind: String, val detail: JsonObject? = null)

@Serializable
data class AiJobDetail(
    val id: String,
    val agent: AiJobAgent,
    val state: String,
    val progress: Int = 0,
    val note: String? = null,
    val requestedBy: String = "",
    val conversationId: String? = null,
    val parentJobId: String? = null,
    val revision: Int = 0,
    val error: AiJobError? = null,
    val createdAt: Long = 0,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val input: JsonElement? = null,
    val output: JsonElement? = null,
    val files: List<AiFile> = emptyList(),
    /** How many channel messages were shared with the request (never the messages themselves). */
    val sharedMessages: Int = 0,
    val approvals: List<AiApproval> = emptyList(),
    val steps: List<AiJobSummary> = emptyList(),
    val events: List<AiJobEvent> = emptyList(),
)

@Serializable
data class AiJobRes(val job: AiJobDetail)

@Serializable
data class AiJobSummaryRes(val job: AiJobSummary)

@Serializable
data class AiJobsPage(val jobs: List<AiJobSummary> = emptyList(), val next: Long? = null)

@Serializable
data class AiApprovalsRes(val approvals: List<AiApproval> = emptyList())

@Serializable
data class AiFilesPage(val files: List<AiFile> = emptyList(), val next: Long? = null)

@Serializable
data class AiPostAgent(val installId: String, val displayName: String, val avatarColor: String? = null, val hasAvatar: Boolean = false, val skill: String? = null, val badge: String = "AI")

/** What an agent (or a request to it) put in a channel. Kept by the server: not end-to-end encrypted. */
@Serializable
data class AiPost(
    val id: String,
    val conversationId: String,
    val threadRoot: String? = null,
    /** request · ack · progress · result · approval · error */
    val kind: String,
    val body: String = "",
    val jobId: String? = null,
    val approvalId: String? = null,
    val authorId: String? = null,
    val agent: AiPostAgent,
    val files: List<AiFile> = emptyList(),
    val createdAt: Long = 0,
)

@Serializable
data class AiPostsRes(val posts: List<AiPost> = emptyList())

/** An agent assigned to a channel, how it's asked there, and whether this person may ask it. */
@Serializable
data class AiChannelAgent(
    val id: String,
    val agentId: String,
    val state: String = "active",
    val displayName: String,
    val avatar: AiAvatarRef? = null,
    val avatarColor: String? = null,
    val description: String = "",
    val roleTitle: String = "",
    val skill: AiSkillRef? = null,
    val activation: String = "mention",
    val canInvoke: Boolean = false,
)

@Serializable
data class AiChannelAgentsRes(val agents: List<AiChannelAgent> = emptyList(), val permissions: AiPermissions = AiPermissions())

// ───────────── Requests ─────────────

@Serializable
data class AiInstallReq(val agentId: String, val displayName: String? = null)

@Serializable
data class AiChannelReq(val activation: String)

/** One channel message this phone decrypted and the person chose to share: author's display name, text, time. */
@Serializable
data class AiSharedMessage(val author: String, val text: String, val at: Long)

@Serializable
data class AiJobReq(
    val installId: String,
    val input: JsonObject,
    val conversationId: String? = null,
    val threadRoot: String? = null,
    val fileIds: List<String> = emptyList(),
    val idempotencyKey: String,
    val requestText: String? = null,
    val channelMessages: List<AiSharedMessage>? = null,
)

@Serializable
data class AiReviseReq(val note: String)

@Serializable
data class AiAnswerReq(val text: String)

@Serializable
data class AiDecisionReq(val decision: String, val note: String? = null)

@Serializable
data class AiOkRes(val removed: Boolean = false)

/** Job states as the server names them, and how the app says them. */
object AiJobStates {
    const val QUEUED = "queued"
    const val PLANNING = "planning"
    const val RUNNING = "running"
    const val AWAITING_INPUT = "awaiting_input"
    const val AWAITING_APPROVAL = "awaiting_approval"
    const val COMPLETED = "completed"
    const val FAILED = "failed"
    const val CANCELLED = "cancelled"

    val ACTIVE = setOf(QUEUED, PLANNING, RUNNING, AWAITING_INPUT, AWAITING_APPROVAL)

    fun active(state: String) = state in ACTIVE

    /** A progress bar only while the job works on its own (not while it waits for a person). */
    fun showsProgress(state: String) = state == QUEUED || state == PLANNING || state == RUNNING

    /** Retry is for a request that ended without finishing; delegated steps are retried through their request. */
    fun canRetry(state: String, parentJobId: String?) = (state == FAILED || state == CANCELLED) && parentJobId == null
}
