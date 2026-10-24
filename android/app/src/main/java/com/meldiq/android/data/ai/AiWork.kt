package com.meldiq.android.data.ai

import kotlinx.serialization.Serializable

/**
 * The work overview and the community's Full System Check (API 0.41.0, server workCenter.ts and workforce/health): what
 * needs this person, what agents and people are doing, what finished and failed, the estimated AI cost; and a check of
 * every agent, model, trigger, queue, task and approval with safe smoke tests. Statuses, counts and ids only.
 */
@Serializable
data class AiWorkOwner(val kind: String, val id: String, val name: String)

@Serializable
data class AiWorkItem(
    /** job · task */
    val kind: String,
    val id: String,
    val title: String,
    val owner: AiWorkOwner,
    val requestedBy: AiPerson,
    val state: String,
    val at: Long,
    val reason: String? = null,
    /** approve · answer · do · review · open */
    val action: String = "open",
    val jobId: String? = null,
    val taskId: String? = null,
    val approvalId: String? = null,
    val dueAt: Long? = null,
    val progress: Int? = null,
    val deliverables: Int? = null,
    val costMicro: Long? = null,
    val error: String? = null,
)

@Serializable
data class AiWorkTotals(val attention: Int = 0, val active: Int = 0, val finished: Int = 0, val failed: Int = 0, val requests: Int = 0, val modelRequests: Int = 0, val costMicro: Long = 0)

@Serializable
data class AiWorkHealth(val id: String, val worst: String, val at: Long, val failed: Int = 0, val warning: Int = 0)

@Serializable
data class AiWorkOverview(
    /** mine (your requests and tasks) · all (managers: the community's) */
    val scope: String = "mine",
    val attention: List<AiWorkItem> = emptyList(),
    val active: List<AiWorkItem> = emptyList(),
    val finished: List<AiWorkItem> = emptyList(),
    val failed: List<AiWorkItem> = emptyList(),
    val totals: AiWorkTotals = AiWorkTotals(),
    val health: AiWorkHealth? = null,
    val days: Int = 7,
)

@Serializable
data class AiCheckLinks(val jobs: List<String> = emptyList(), val tasks: List<String> = emptyList(), val installId: String? = null, val triggers: List<String> = emptyList())

@Serializable
data class AiCheckItem(
    val key: String,
    /** configuration · runtime · smoke */
    val level: String,
    val title: String,
    /** healthy · warning · failed · not_configured · not_tested */
    val status: String,
    val severity: String = "info",
    val evidence: String = "",
    val at: Long = 0,
    val impacts: List<String> = emptyList(),
    val cause: String? = null,
    val remediation: String? = null,
    /** platform_operator · community_admin */
    val owner: String? = null,
    val verified: Boolean = false,
    val links: AiCheckLinks = AiCheckLinks(),
)

@Serializable
data class AiCheckCounts(val healthy: Int = 0, val warning: Int = 0, val failed: Int = 0, val not_configured: Int = 0, val not_tested: Int = 0) {
    fun of(status: String) = when (status) {
        "healthy" -> healthy
        "warning" -> warning
        "failed" -> failed
        "not_configured" -> not_configured
        else -> not_tested
    }
}

@Serializable
data class AiCheckSummary(val id: String, val scope: String = "community", val requestedBy: String = "", val startedAt: Long = 0, val finishedAt: Long = 0, val worst: String, val summary: AiCheckCounts = AiCheckCounts())

@Serializable
data class AiCheckReport(
    val id: String,
    val scope: String = "community",
    val orgId: String? = null,
    val requestedBy: String = "",
    val startedAt: Long = 0,
    val finishedAt: Long = 0,
    val worst: String,
    val summary: AiCheckCounts = AiCheckCounts(),
    val items: List<AiCheckItem> = emptyList(),
)

@Serializable
data class AiCheckRes(val report: AiCheckReport)

@Serializable
data class AiChecksRes(val latest: AiCheckReport? = null, val history: List<AiCheckSummary> = emptyList())

object AiWorkRules {
    val CHECK_STATUSES = listOf("failed", "warning", "not_configured", "not_tested", "healthy")
    private val ATTENTION = setOf("failed", "warning", "not_configured")

    fun attention(r: AiCheckReport) = r.items.filter { it.status in ATTENTION }
    fun untested(r: AiCheckReport) = r.items.filter { it.status == "not_tested" }
    fun healthy(r: AiCheckReport) = r.items.filter { it.status == "healthy" }

    /** An estimated cost in micro-USD as dollars: small amounts keep their cents' fractions (as Meldiq Web). */
    fun cost(micro: Long): String {
        if (micro == 0L) return "$0"
        val usd = micro / 1_000_000.0
        return "$" + when {
            usd >= 1 -> "%.2f".format(java.util.Locale.ROOT, usd)
            usd >= 0.01 -> "%.3f".format(java.util.Locale.ROOT, usd)
            else -> "%.4f".format(java.util.Locale.ROOT, usd)
        }
    }

    /** A budget typed in dollars as micro-USD; blank or unreadable is no budget (null). */
    fun budgetMicro(usd: String): Long? = usd.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it >= 0 }?.let { Math.round(it * 1_000_000) }

    /** The report as a file to save or share; the server already left out content and secrets. */
    fun reportName(r: AiCheckReport) = "meldiq-system-check-" + java.time.Instant.ofEpochMilli(r.startedAt).toString().replace(Regex("[:.]"), "-") + ".json"
}
